/**
 * LLM fix-quality evaluation.
 *
 * Why this exists, and what it deliberately does not do.
 *
 * The sandbox's live-model leg asserts that a proposed edit is "applied or safely
 * refused". That passes whether the fix was right or the rails blocked it, so it
 * measures the rails and calls it fix quality. Nothing anywhere checked whether
 * the model's suggestions were correct.
 *
 * This measures three separate things, because they fail independently:
 *
 *   applicability  does the proposed `find` string actually occur in the target?
 *                   A patch whose anchor is not in the file cannot apply, and for
 *                   a model that cannot read files this is the usual outcome.
 *   correctness    after applying the patch, does the failure go away? Verified
 *                   by running the code, not by reading the diff.
 *   triage         does it say problem vs noise correctly, against known truth.
 *
 * It reports rather than gates. The model in use is non-deterministic -- the same
 * prompt returns different verdicts on different runs -- so a pass/fail on a
 * single sample would be theatre. Every number here is a distribution over N runs.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Advisor } from '../src/analyze/advisor.mjs';
import { Applier } from '../src/act/apply.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MODEL = process.env.WD_TEST_MODEL || 'opencode/space-bunny-free';
const REPEATS = Number(process.env.WD_REPEATS || 3);
const c = (k, s) => `\x1b[${k}m${s}\x1b[0m`;

const brokenTally = `function tally(items) {
  return count / items.length;
}

module.exports = { tally };
`;

/**
 * A bug with an unambiguous intended fix.
 *
 * This exists because correctness cannot be measured on an ambiguous bug. With
 * `count` undefined, redefining it as items.length and redefining it as
 * items.filter(Boolean).length both stop the crash, and nothing in the evidence
 * says which the author meant. Every fix therefore "works" and the metric is
 * meaningless.
 *
 * A misspelled identifier has exactly one repair: the name is already bound one
 * character away, and the ReferenceError names it. So a fix that differs from
 * `countd` -> `count` is wrong in a way that can be detected.
 */
const typoTally = `function tally(items) {
  const count = items.length;
  return countd / count;
}

module.exports = { tally };
`;

const noisyBuild = `Build completed with 0 errors
webpack compiled successfully
Done in 4.21s
`;

/**
 * Each case carries ground truth: what the right answer is, and how to tell
 * whether a proposed fix actually worked.
 *
 * `verify` runs the code in the copy and reports whether the failure is gone.
 * That is the only assertion here that cannot be argued with.
 */
const CASES = [
  {
    id: 'undefined-variable-with-source',
    title: 'Possible undefined variable',
    // Source in the evidence: what the existing sandbox leg does.
    evidence: brokenTally,
    truth: 'problem',
    expectFiles: ['src/tally.js'],
    // A correct fix makes the function return a number instead of throwing.
    verify: (root) => runProbe(root, 'src/tally.js', 'tally', [1, 2, 3], 'number'),
  },
  {
    id: 'undefined-variable-trace-only',
    title: 'ReferenceError: count is not defined',
    // What production actually has: terminal output, not the file.
    evidence: ['ReferenceError: count is not defined', '    at tally (/app/src/tally.js:2:16)', '    at main (/app/src/index.js:6:9)'].join('\n'),
    truth: 'problem',
    expectFiles: ['src/tally.js'],
    verify: (root) => runProbe(root, 'src/tally.js', 'tally', [1, 2, 3], 'number'),
  },
  {
    id: 'misspelled-identifier',
    title: 'ReferenceError: countd is not defined',
    evidence: [
      'ReferenceError: countd is not defined',
      '    at tally (/app/src/tally.js:3:10)',
      '    at main (/app/src/index.js:6:9)',
    ].join('\n'),
    truth: 'problem',
    expectFiles: ['src/tally.js'],
    // tally([1,2,3]) must be 3/3 = 1. This is the one case where "correct" is
    // knowable rather than merely "no longer throws".
    verify: (root) => runProbe(root, 'src/tally.js', 'tally', [1, 2, 3], '1', /^RESULT:1$/),
    seed: 'typo',
  },
  {
    id: 'noise-successful-build',
    title: 'Possible undefined variable',
    evidence: noisyBuild,
    truth: 'noise',
    expectFiles: [],
    // Nothing should have been proposed, so there is nothing to verify. The
    // measurement is whether it stayed quiet.
    verify: null,
  },
];

/** Lay down a copy of the project with the seeded bug in place. */
function seedProject(which = 'broken') {
  const root = mkdtempSync(join(tmpdir(), 'wd-eval-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'eval-project' }), 'utf8');
  writeFileSync(join(root, 'src', 'tally.js'), which === 'typo' ? typoTally : brokenTally, 'utf8');
  writeFileSync(
    join(root, 'src', 'index.js'),
    'const { tally } = require("./tally");\nmodule.exports = { tally };\n',
    'utf8',
  );
  return root;
}

/**
 * Run a real behavioural check in `root`.
 *
 * `verify` is given the module path, an export name, and arguments; it returns
 * whether the export produces the wanted output.
 *
 * The first version of this took a JS *expression* and wrapped it in
 * console.log(...), which silently produced a syntax error for any expression
 * containing a statement. Every fix was then reported as "did not work" -- the
 * harness was measuring itself. The generated script is now assembled from fixed
 * parts so there is nothing to misplace a brace into.
 */
function runProbe(root, modulePath, exportName, args, expectType, expected = /^RESULT:/) {
  const script = join(root, '__verify.cjs');
  const source = [
    'try {',
    `  const mod = require(${JSON.stringify('./' + modulePath.replace(/\\\\/g, '/'))});`,
    `  const value = mod[${JSON.stringify(exportName)}](${JSON.stringify(args)});`,
    `  console.log('RESULT:' + (typeof value === 'object' ? JSON.stringify(value) : String(value)));`,
    "} catch (e) { console.log('THREW:' + (e && e.message)); }",
  ].join('\n');
  writeFileSync(script, source, 'utf8');
  try {
    const out = execFileSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    // "Fixed" means the call stopped throwing. It does not mean the fix is the
    // right one -- that is only knowable for a bug with an unambiguous repair,
    // which `typo` below has and this one does not.
    const stoppedThrowing = out.startsWith('RESULT:');
    const ok = stoppedThrowing ? expected.test(out) : false;
    return { ok, stoppedThrowing, out, expect: expectType };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.message || ''), expect: expectType };
  } finally {
    try {
      rmSync(script, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Does every proposed `find` string actually occur in its target file? */
function applicability(root, fix) {
  const files = fix?.files ?? [];
  if (!files.length) return { any: false, all: true, detail: 'no files proposed' };
  const problems = [];
  for (const f of files) {
    const abs = join(root, f.path);
    let body;
    try {
      body = readFileSync(abs, 'utf8');
    } catch {
      problems.push(`${f.path}: file does not exist`);
      continue;
    }
    if (typeof f.find !== 'string' || !f.find.length) problems.push(`${f.path}: empty find string`);
    else if (!body.includes(f.find)) problems.push(`${f.path}: find not present in the file`);
  }
  return { any: true, all: problems.length === 0, detail: problems.join('; ') || 'all anchors found' };
}

async function runCase(testCase, advisor) {
  const results = [];
  for (let i = 0; i < REPEATS; i++) {
    const root = seedProject(testCase.seed);
    try {
      const r = await advisor.review({
        evidence: testCase.evidence,
        cwd: root,
        title: testCase.title,
        sessionId: 'eval-session',
      });

      const app = applicability(root, r.fix);
      let correctness = null;
      let appliedStatus = null;

      if (app.any && app.all) {
        // Apply for real, into the copy, then verify by running it.
        const applier = new Applier({ projectRoot: root, dataDir: join(root, '.watchdog'), autonomy: 'autonomous' });
        for (const f of r.fix.files) {
          const res = applier.apply({ kind: 'patch-file', path: f.path, find: f.find, replace: f.replace }, { cwd: root });
          appliedStatus = res?.status ?? 'unknown';
        }
        if (testCase.verify && appliedStatus === 'applied') {
          correctness = testCase.verify(root);
        }
      }

      // Keep the proposed edits so an ineffective fix can be read, not just counted.
      const edits = (r.fix?.files ?? []).map((f) => ({
        path: f.path,
        find: String(f.find ?? '').slice(0, 120),
        replace: String(f.replace ?? '').slice(0, 120),
      }));

      results.push({
        verdict: r.verdict,
        confidence: r.confidence,
        status: r.status ?? 'ok',
        proposed: app.any,
        applicable: app.all,
        applied: appliedStatus,
        correctness,
        detail:
          edits.length && appliedStatus === 'applied' && correctness && !correctness.ok
            ? `${edits.map((e) => `${e.path}: ${JSON.stringify(e.find)} -> ${JSON.stringify(e.replace)}`).join(' | ')} => ${correctness.out}`
            : app.detail,
        edits,
        summary: (r.summary ?? '').slice(0, 120),
      });
    } catch (e) {
      results.push({ verdict: 'error', status: e.message.slice(0, 120) });
    } finally {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
  return results;
}

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : 'n/a');

async function main() {
  console.log(c('1', `\nLLM fix-quality eval   model=${MODEL}  repeats=${REPEATS}\n`));
  const advisor = new Advisor({ cli: 'opencode', model: MODEL, timeoutMs: 180_000 });
  const report = [];

  for (const testCase of CASES) {
    const rows = await runCase(testCase, advisor);
    report.push({ id: testCase.id, rows });

    const proposed = rows.filter((r) => r.proposed);
    const applicable = proposed.filter((r) => r.applicable).length;
    const applied = proposed.filter((r) => r.applied === 'applied').length;
    const correct = proposed.filter((r) => r.correctness?.ok).length;
    const rightVerdict = rows.filter((r) => r.verdict === testCase.truth).length;
    const failures = rows.filter((r) => r.status && r.status !== 'ok');

    console.log(c('1', `  ${testCase.id}`));
    console.log(`    truth              ${testCase.truth}`);
    console.log(`    verdict correct    ${rightVerdict}/${REPEATS}  (${pct(rightVerdict, REPEATS)})`);
    console.log(`    proposed a fix     ${proposed.length}/${REPEATS}  (${pct(proposed.length, REPEATS)})`);
    if (proposed.length) {
      // Denominators are "of those that proposed a fix". Counting a run that
      // proposed nothing as applicable made the first version of this report a
      // ratio of 2/1, which is not a number.
      console.log(`    anchor applicable  ${applicable}/${proposed.length}`);
      console.log(`    actually applied   ${applied}/${proposed.length}`);
      console.log(`    fix WORKED         ${correct}/${proposed.length}`);
    }
    if (failures.length) console.log(`    provider failures  ${failures.length}`);
    const verdicts = rows.map((r) => r.verdict).join(',');
    console.log(c('2', `    verdicts: ${verdicts}`));
    for (const r of rows.filter((x) => x.proposed && !x.applicable).slice(0, 2)) {
      console.log(c('3', `    not applicable: ${r.detail}`));
    }
    // Show what was actually written when a fix applied but did not work. Without
    // this the number 0/3 is a symptom rather than a diagnosis.
    for (const r of rows.filter((x) => x.applied === 'applied' && x.correctness && !x.correctness.ok).slice(0, 3)) {
      console.log(c('3', `    applied but ineffective: ${r.detail}`));
    }
    console.log('');
  }

  // ---- the comparison that actually matters
  const withSource = report.find((r) => r.id.endsWith('with-source'));
  const traceOnly = report.find((r) => r.id.endsWith('trace-only'));
  console.log(c('1', '  the production condition'));
  if (withSource && traceOnly) {
    const a = withSource.rows.filter((r) => r.proposed).length;
    const b = traceOnly.rows.filter((r) => r.proposed).length;
    console.log(`    proposed a fix, source visible : ${a}/${REPEATS}`);
    console.log(`    proposed a fix, trace only     : ${b}/${REPEATS}`);
    if (a > b) {
      console.log(c('3', '    -> fix proposals depend on seeing the file, which the daemon does not send.'));
    }
  }
  console.log('');
  console.log(c('2', '  This reports. It does not gate: the model is non-deterministic and a'));
  console.log(c('2', '  single sample would be theatre. Raise WD_REPEATS for a tighter read.'));
  console.log('');
}

main().catch((e) => {
  console.error('eval crashed:', e);
  process.exit(1);
});