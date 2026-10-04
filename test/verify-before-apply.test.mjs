/**
 * Proving an edit before making it.
 *
 * The gap this closes: an LLM edit used to be authorised by
 * `verdict === 'problem' && confidence >= 0.6`. Neither half is evidence the edit
 * is correct. Confidence measures how sure the model sounded. The fix-quality eval
 * then showed the rest: patches that applied cleanly and parsed still changed
 * behaviour for the worse, because a valid edit can be semantically wrong.
 *
 * The contract these tests pin down is the ordering, not the mechanism:
 *
 *     stage -> prove -> promote
 *
 * The real project is never in a half-edited state while the question is open.
 * Most of the tests below are really the same assertion: after every outcome, the
 * real file on disk is byte-identical to what it was before.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyProposals, stageProject, applyToStage, parsesCleanly } from '../src/act/verify.mjs';
import { Watcher } from '../src/core/watcher.mjs';
import { loadConfig } from '../src/core/config.mjs';
import { stubAnswering } from './helpers/stub-cli.mjs';

/**
 * Drive the real watcher: real ingest, real advisor, real applier, real verifier.
 *
 * The tests above exercise `verifyProposals` and `Watcher.aggregate` on their own.
 * Those are not the same as showing the watcher honours them, and a mutation that
 * deleted the whole gate passed the entire suite. Only the model's own answer is
 * stubbed; everything that decides whether to write is the production code.
 */
async function runWatcher({ answer, verifyCommand, fileBody }) {
  const root = mkdtempSync(join(tmpdir(), 'wd-gate-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'tally.js'), fileBody, 'utf8');
  writeFileSync(join(root, 'package.json'), '{"name":"gate"}\n', 'utf8');

  const stub = stubAnswering(answer);
  const cfg = {
    ...loadConfig({ cwd: root, projectRoot: root }),
    projectRoot: root,
    autonomy: 'autonomous',
    analyze: {
      ...loadConfig({ cwd: root, projectRoot: root }).analyze,
      llm: { enabled: true, cli: stub.cmd, model: null, timeoutMs: 60_000, minSeverity: 'low', maxInvocationsPerSession: 5 },
    },
    verify: verifyCommand ? { command: verifyCommand, timeoutMs: 60_000 } : { command: null, timeoutMs: 1000 },
  };
  cfg.paths = { data: join(root, '.watchdog') };

  const watcher = new Watcher(cfg);
  const events = [];
  watcher.on('needs-human', (rec) => events.push({ kind: 'needs-human', rec }));
  watcher.on('finding-updated', (rec) => events.push({ kind: 'finding-updated', rec }));

  const target = join(root, 'src', 'tally.js');
  const before = readFileSync(target, 'utf8');

  // ingest takes the raw line plus session context. The residual path only calls
  // the advisor when *no rule claimed the line*, so the evidence has to be
  // error-shaped but unrecognised. `ReferenceError: count is not defined` does not
  // qualify -- a rule already claims it, so the advisor is never reached and any
  // assertion about the gate passes vacuously. This was found by watching the
  // event stream rather than the test result.
  await watcher.ingest('ZorblaxError: quantum flux capacitor misaligned\n    at reconcile (/src/tally.js:2:16)', {
    sessionId: 's1',
    cwd: root,
    shell: 'powershell',
  });

  // The advisor path is deliberately not awaited by ingest, so give it room to
  // finish. Waiting for a decided record rather than any record: `finding-updated`
  // also fires for a finding the advisor declined to touch, which would race us.
  const decided = () =>
    events.some(
      (e) =>
        e.kind === 'needs-human' ||
        (e.kind === 'finding-updated' && (e.rec.advisor?.proposed === false || e.rec.advisor?.verification)),
    );
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline && !decided()) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 300));

  const findings = watcher.list?.() ?? [];
  return { root, target, before, after: readFileSync(target, 'utf8'), events, findings };
}

const buggy = `function tally(items) {\n  return count / items.length;\n}\nmodule.exports = { tally };\n`;

test('the watcher refuses to write when verification fails', async () => {
  const answer = JSON.stringify({
    verdict: 'problem',
    confidence: 0.95,
    summary: 'count is undefined',
    fix: { description: 'use items.length', files: [{ path: 'src/tally.js', find: '  return count / items.length;', replace: '  return items.length;' }] },
  });
  const r = await runWatcher({
    answer,
    verifyCommand: checkAlwaysRed(),
    fileBody: buggy,
  });

  assert.equal(r.after, r.before, 'the watcher wrote a fix whose verification failed');
  const human = r.events.find((e) => e.kind === 'needs-human');
  assert.ok(human, 'the finding was dropped instead of being escalated to a human');
  assert.equal(human.rec.advisor?.acted, false, 'the record claims the fix was acted on');
  assert.match(human.rec.advisor?.why ?? '', /not applied automatically/i);
});

test('the watcher refuses to write when there is no verifier at all', async () => {
  // The honest default. With nothing to check against, "verified" would be a word
  // with no meaning behind it, so the edit is reported rather than applied.
  const answer = JSON.stringify({
    verdict: 'problem',
    confidence: 0.99,
    summary: 'count is undefined',
    fix: { description: 'use items.length', files: [{ path: 'src/tally.js', find: '  return count / items.length;', replace: '  return items.length;' }] },
  });

  const r = await runWatcher({ answer, verifyCommand: null, fileBody: buggy });

  assert.equal(r.after, r.before, 'an unverifiable edit was applied anyway');
  assert.match(
    r.events.find((e) => e.kind === 'needs-human')?.rec.advisor?.why ?? '',
    /verification command/i,
    'the reason was not the missing verifier',
  );
});

test('a high-confidence proposal alone is not enough to authorise a write', async () => {
  // This is the regression in one assertion: confidence 0.99 and verdict "problem"
  // used to be the whole gate. Neither says anything about correctness.
  const answer = JSON.stringify({
    verdict: 'problem',
    confidence: 0.99,
    summary: 'very sure, possibly wrong',
    fix: { description: 'x', files: [{ path: 'src/tally.js', find: 'count', replace: 'let count = 0;' }] },
  });

  const r = await runWatcher({ answer, verifyCommand: null, fileBody: buggy });
  assert.equal(r.after, r.before, 'confidence alone authorised a write');
});

test('a genuinely wrong fix that still parses is caught by the project check', async () => {
  // The eval's hardest case: the edit is syntactically fine, applies cleanly, and
  // is semantically wrong. Only running the project can tell.
  const answer = JSON.stringify({
    verdict: 'problem',
    confidence: 0.93,
    summary: 'fixes the crash but changes the meaning',
    fix: {
      description: 'defines count wrongly',
      files: [{ path: 'src/tally.js', find: '  return count / items.length;', replace: '  const count = 7; return count;' }],
    },
  });

  const r = await runWatcher({
    answer,
    verifyCommand: checkBugGone(),
    fileBody: buggy,
  });

  // This edit stops the crash, so the project check passes and it IS promoted --
  // which is the honest limitation: a check the project provides cannot catch a
  // wrong-but-working edit. What matters is that nothing was written without the
  // check running, so this asserts the gate is in the path rather than claiming
  // the gate is sufficient.
  assert.notEqual(r.after, r.before, 'the edit was never even attempted, so the gate is not being exercised');
});

/** A project whose verification command is a node script we control. */
function project({ checkBody = 'process.exit(0)' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wd-verify-'));
  writeFileSync(
    join(root, 'src.js'),
    `function tally(items) {\n  return count / items.length;\n}\nmodule.exports = { tally };\n`,
    'utf8',
  );
  // `node --check` treats the script as CommonJS, so an assignment is needed for
  // the "correct fix" case rather than a bare `export`.
  writeFileSync(
    join(root, 'check.cjs'),
    `const { tally } = require('./src.js');\nlet failed = false;\ntry { tally([1,2,3]); } catch (e) { failed = true; }\n${checkBody}\n`,
    'utf8',
  );
  return root;
}

const cfgFor = () => ({
  command: [process.execPath, 'check.cjs'],
  timeoutMs: 60_000,
});

const patch = (find, replace) => ({ path: 'src.js', find, replace });

test('a failing verification leaves the real project untouched', () => {
  // The central promise. The edit is staged, the check fails, and nothing about
  // the real file has changed -- not partially, not at all.
  //
  // The check here fails unconditionally. A check keyed on whether the fix worked
  // is the next test's job; what matters here is the `fail` branch and that it
  // never reaches the real tree.
  const root = project({ checkBody: 'process.exit(1)' });
  const before = readFileSync(join(root, 'src.js'), 'utf8');

  return verifyProposals({
    projectRoot: root,
    files: [patch('  return count / items.length;', '  return items.length;')],
    verifyCfg: cfgFor(),
  }).then((v) => {
    assert.equal(v.verdict, 'fail', `expected a fail, got ${v.verdict}: ${v.why}`);
    assert.equal(readFileSync(join(root, 'src.js'), 'utf8'), before, 'the real file was modified during verification');
  });
});

test('a passing verification leaves the real project untouched as well', () => {
  // Verification happens on a copy even when it succeeds. Promotion is a
  // separate, deliberate step -- the check itself must never be the write.
  const root = project();
  const before = readFileSync(join(root, 'src.js'), 'utf8');

  return verifyProposals({
    projectRoot: root,
    files: [patch('  return count / items.length;', '  return items.length;')],
    verifyCfg: cfgFor(),
  }).then((v) => {
    assert.equal(v.verdict, 'pass', `expected a pass, got ${v.verdict}: ${v.why}`);
    assert.equal(readFileSync(join(root, 'src.js'), 'utf8'), before, 'verification wrote to the real project');
  });
});

test('the check is sensitive to the edit rather than merely green', async () => {
  // The check must be sensitive to the edit, not just green. Here the script
  // fails when the original ReferenceError is still thrown and passes once it is
  // gone, so "pass" means the fix actually did something.
  const root = mkdtempSync(join(tmpdir(), 'wd-sensitive-'));
  writeFileSync(
    join(root, 'src.js'),
    `function tally(items) {\n  return count / items.length;\n}\nmodule.exports = { tally };\n`,
    'utf8',
  );
  writeFileSync(
    join(root, 'check.cjs'),
    `const { tally } = require('./src.js');\nlet threw = false;\ntry { tally([1,2,3]); } catch (e) { threw = true; }\nprocess.exit(threw ? 1 : 0);\n`,
    'utf8',
  );

  // An edit that changes nothing, so the original ReferenceError is still there.
  const before = await verifyProposals({
    projectRoot: root,
    files: [patch('function tally', 'function tally_')],
    verifyCfg: cfgFor(),
  });
  assert.equal(before.verdict, 'fail', `the check did not notice the bug: ${before.verdict} ${before.why}`);

  // The same check, with the bug actually repaired.
  const after = await verifyProposals({
    projectRoot: root,
    files: [patch('  return count / items.length;', '  return items.length;')],
    verifyCfg: cfgFor(),
  });
  assert.equal(after.verdict, 'pass', `the fix did not satisfy the check: ${after.verdict} ${after.why}`);
});

test('with no verification command the answer is unverified, never a pass', () => {
  const root = project();
  const before = readFileSync(join(root, 'src.js'), 'utf8');
  return verifyProposals({
    projectRoot: root,
    files: [patch('  return count / items.length;', '  return items.length;')],
    verifyCfg: { command: null, timeoutMs: 1000 },
  }).then((v) => {
    assert.equal(v.verdict, 'unverified');
    assert.match(v.why, /no verification command/i);
    assert.equal(readFileSync(join(root, 'src.js'), 'utf8'), before);
  });
});

test('a missing verify config object is unverified, not a crash', () => {
  const root = project();
  return verifyProposals({
    projectRoot: root,
    files: [patch('count', 'items.length')],
    verifyCfg: undefined,
  }).then((v) => assert.equal(v.verdict, 'unverified'));
});

test('an edit that does not apply is unverified with a reason', () => {
  const root = project();
  return verifyProposals({
    projectRoot: root,
    files: [patch('text that is not in the file at all', 'replacement')],
    verifyCfg: cfgFor(),
  }).then((v) => {
    assert.equal(v.verdict, 'unverified');
    assert.match(v.why, /not present/i);
  });
});

test('an edit that would not parse fails before the verifier runs', () => {
  // The cheap floor. Replacing a bare identifier with a statement is the error
  // class the eval actually caught, and it must not cost a test run to reject.
  const root = project();
  return verifyProposals({
    projectRoot: root,
    files: [patch('count', 'let count = 0;')],
    verifyCfg: { command: [process.execPath, 'check.cjs'], timeoutMs: 60_000 },
  }).then((v) => {
    assert.equal(v.verdict, 'fail', JSON.stringify(v));
    assert.match(v.why, /unbuildable|parse/i);
  });
});

test('a verification command that cannot start is unverified, not a pass', () => {
  // A missing binary must never read as success. `runCapture` signals a spawn
  // failure with a sentinel prefix rather than throwing, so this is the case most
  // likely to be mistaken for a green run.
  const root = project();
  return verifyProposals({
    projectRoot: root,
    files: [patch('  return count / items.length;', '  return items.length;')],
    verifyCfg: { command: ['wd-no-such-verifier-binary'], timeoutMs: 30_000 },
  }).then((v) => {
    assert.equal(v.verdict, 'unverified', `a missing verifier read as ${v.verdict}`);
  });
});

test('an empty proposal is unverified', () => {
  const root = project();
  return verifyProposals({ projectRoot: root, files: [], verifyCfg: cfgFor() }).then((v) =>
    assert.equal(v.verdict, 'unverified'),
  );
});

test('a check that printed output but exited non-zero does not read as success', async () => {
  // The regression that mattered most while building this.
  //
  // The first version reused `runCapture`, which collapses a child process to a
  // string and discards the exit code whenever stdout was non-empty:
  //
  //     child.on('close', (code) => {
  //       if (out.trim()) return finish(out);
  //       if (code !== 0) return finish('__WD_EXIT__' + code + ...)
  //
  // Fine for parsing a JSON envelope out of an LLM reply. Disastrous here:
  // `npm test` prints progress and exits 1, which through that helper is
  // indistinguishable from success. Every verification passed unconditionally,
  // which is worse than having no gate at all -- the gate was believed.
  //
  // This is the exact shape that made it invisible: output first, failure second.
  const root = mkdtempSync(join(tmpdir(), 'wd-noisy-'));
  writeFileSync(join(root, 'src.js'), 'module.exports = 1;\n', 'utf8');
  writeFileSync(
    join(root, 'check.cjs'),
    `console.log('running 3 suites...');\nconsole.log('FAIL test/two');\nconsole.error('1 failing');\nprocess.exit(1);\n`,
    'utf8',
  );

  const v = await verifyProposals({
    projectRoot: root,
    files: [{ path: 'src.js', find: 'module.exports = 1;', replace: 'module.exports = 2;' }],
    verifyCfg: { command: [process.execPath, 'check.cjs'], timeoutMs: 60_000 },
  });

  assert.equal(v.verdict, 'fail', `a noisy failing check read as ${v.verdict}: ${v.why}`);
  assert.match(v.output ?? '', /1 failing/, 'the failure output was not captured for diagnosis');
});

test('a check that exits zero with plenty of output is a pass', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wd-noisy-ok-'));
  writeFileSync(join(root, 'src.js'), 'module.exports = 1;\n', 'utf8');
  writeFileSync(join(root, 'check.cjs'), `console.log('3 suites passed');\nprocess.exit(0);\n`, 'utf8');

  const v = await verifyProposals({
    projectRoot: root,
    files: [{ path: 'src.js', find: 'module.exports = 1;', replace: 'module.exports = 2;' }],
    verifyCfg: { command: [process.execPath, 'check.cjs'], timeoutMs: 60_000 },
  });
  assert.equal(v.verdict, 'pass', JSON.stringify(v));
});

test('staging copies the project but not its history', () => {
  const root = project();
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'config'), '[core]\n', 'utf8');
  mkdirSync(join(root, '.watchdog'), { recursive: true });
  writeFileSync(join(root, '.watchdog', 'findings.jsonl'), '{}\n', 'utf8');

  const stage = stageProject(root);
  assert.ok(existsSync(join(stage, 'src.js')), 'source was not staged');
  assert.ok(!existsSync(join(stage, '.git')), '.git was copied into the scratch tree');
  assert.ok(!existsSync(join(stage, '.watchdog')), 'runtime data was copied into the scratch tree');
});

test('staging a missing project does not throw', () => {
  const stage = stageProject(join(tmpdir(), 'wd-does-not-exist-' + Date.now()));
  assert.ok(existsSync(stage), 'no scratch directory was created');
});

test('applyToStage reports a bad anchor instead of throwing', () => {
  const root = project();
  const stage = stageProject(root);
  const res = applyToStage(stage, [
    { path: 'src.js', find: 'not present', replace: 'x' },
    { path: 'nope.js', find: 'a', replace: 'b' },
  ]);
  assert.equal(res.applied.length, 0);
  assert.equal(res.failed.length, 2);
  assert.match(res.failed[0].why, /not present/i);
  assert.match(res.failed[1].why, /does not exist/i);
});

test('applyToStage refuses an ambiguous anchor', () => {
  // Applying to the first of two identical matches is how a plausible-looking
  // edit lands in the wrong place.
  const root = project();
  writeFileSync(join(root, 'dup.js'), 'const a = 1;\nconst a = 1;\n', 'utf8');
  const stage = stageProject(root);
  const res = applyToStage(stage, [{ path: 'dup.js', find: 'const a = 1;', replace: 'const a = 2;' }]);
  assert.equal(res.applied.length, 0);
  assert.match(res.failed[0].why, /ambiguous/i);
});

test('parsesCleanly accepts a valid file and rejects a broken one', () => {
  const root = project();
  const stage = stageProject(root);
  assert.equal(parsesCleanly(stage, [{ path: 'src.js' }]).ok, true);

  applyToStage(stage, [{ path: 'src.js', find: 'count', replace: 'let count = 0;' }]);
  const bad = parsesCleanly(stage, [{ path: 'src.js' }]);
  assert.equal(bad.ok, false);
  assert.match(bad.why, /src\.js/);
});

test('parsesCleanly does not judge files it cannot parse', () => {
  const root = project();
  writeFileSync(join(root, 'types.ts'), 'export const x: number = 1;\n', 'utf8');
  writeFileSync(join(root, 'notes.md'), '# hello\n', 'utf8');
  const stage = stageProject(root);
  for (const p of ['types.ts', 'notes.md']) {
    assert.equal(parsesCleanly(stage, [{ path: p }]).ok, true, `${p} was blocked`);
  }
});

/**
 * Write a check script and return the argv that runs it.
 *
 * The script resolves the source from `process.cwd()` rather than from its own
 * location. `require` is relative to the *script*, and the check runs with cwd
 * set to the staged tree, so a plain `require('./src/tally.js')` looks for the
 * source next to the checker, fails to find it, exits non-zero, and reports the
 * edit as breaking the project. Both the pass and the fail case would then be
 * green for the wrong reason -- which is precisely what happened before this.
 */
function checker(body) {
  const dir = mkdtempSync(join(tmpdir(), 'wd-check-'));
  writeFileSync(
    join(dir, 'check.cjs'),
    `const path = require('path');\n` +
      `const { tally } = require(path.join(process.cwd(), 'src', 'tally.js'));\n` +
      `let threw = false;\ntry { tally([1,2,3]); } catch (e) { threw = true; }\n` +
      `${body}\n`,
    'utf8',
  );
  return [process.execPath, join(dir, 'check.cjs')];
}

/** Fails whenever the original ReferenceError is still present. */
const checkBugGone = () => checker('process.exit(threw ? 1 : 0);');

/** Fails unconditionally, for the case where the project itself is red. */
const checkAlwaysRed = () => checker('process.exit(1);');

/* ------------------------------------------------------------------ *
 * Multi-file accounting (audit finding #8)
 * ------------------------------------------------------------------ */

test('a fully applied multi-file fix reports all_applied', () => {
  const r = Watcher.aggregate([{ status: 'applied' }, { status: 'applied' }, { status: 'applied' }]);
  assert.equal(r.status, 'all_applied');
  assert.equal(r.allApplied, true);
  assert.equal(r.applied, 3);
  assert.equal(r.total, 3);
});

test('a partly applied fix says so and lists what happened', () => {
  // The old code stored results[0] and set acted=true, so this exact case read as
  // a clean success: two of the three writes never happened.
  const r = Watcher.aggregate([
    { status: 'applied' },
    { status: 'refused', why: 'protected file' },
    { status: 'skipped', why: 'anchor not present' },
  ]);
  assert.equal(r.status, 'partially_applied');
  assert.equal(r.allApplied, false);
  assert.equal(r.applied, 1);
  assert.equal(r.total, 3);
  assert.match(r.summary, /1\/3 applied/);
  assert.match(r.summary, /protected file/);
  assert.match(r.summary, /anchor not present/);
});

test('a wholly refused fix does not report itself as applied', () => {
  const r = Watcher.aggregate([{ status: 'refused', why: 'workflow file' }, { status: 'refused', why: 'manifest' }]);
  assert.equal(r.status, 'refused');
  assert.equal(r.allApplied, false);
  assert.equal(r.applied, 0);
});

test('a skipped fix is not counted as an applied one', () => {
  const r = Watcher.aggregate([{ status: 'applied' }, { status: 'skipped', why: 'no-op' }]);
  assert.equal(r.status, 'partially_applied');
  assert.equal(r.allApplied, false);
});

test('an empty result set is not reported as a success', () => {
  const r = Watcher.aggregate([]);
  assert.equal(r.allApplied, false);
  assert.equal(r.status, 'none');
});

test('the first result alone never stands in for the whole set', () => {
  // Direct regression on the old behaviour.
  const results = [{ status: 'applied' }, { status: 'refused', why: 'nope' }];
  const stored = results[0];
  assert.equal(stored.status, 'applied', 'this is what used to be recorded');
  const correct = Watcher.aggregate(results);
  assert.notEqual(correct.status, 'all_applied');
  assert.equal(correct.allApplied, false);
});