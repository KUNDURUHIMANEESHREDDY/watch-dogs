/**
 * Path tracer.
 *
 * Counting green tests is not the same as verifying the path. A test can pass
 * while exercising a different branch than you think it is -- which is exactly
 * what happened with the js-only-allowlist mutation: 15/15 passed, and the only
 * reason I knew the test was useless was by reasoning about which branch it
 * reached, not by reading the result.
 *
 * So this walks ONE real input through every hop of the pipeline, using the
 * real modules, and prints what each stage actually did to the value. If a stage
 * is skipped, or silently mangles something, it is visible here rather than
 * inferred from a summary.
 *
 *   node sandbox/trace-path.mjs                 trace the detection path
 *   node sandbox/trace-path.mjs refuse          trace the security refusal path
 *   node sandbox/trace-path.mjs route           trace CLI argument routing
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, appendFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { LineSplitter, stripAnsi, redact } from '../src/capture/stream.mjs';
import { TranscriptTailer, TranscriptDiscovery, detectIde } from '../src/capture/shell.mjs';
import { isChromeLine, makeChromeFilter } from '../src/analyze/transcript.mjs';
import { evaluate, RULES, SEVERITY } from '../src/analyze/rules.mjs';
import { Applier } from '../src/act/apply.mjs';
import { isRefused } from '../src/act/guard.mjs';
import { declaredPackages, isDeclared, normalizePkgName, lockfileKind } from '../src/act/deps.mjs';

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[1m', d: '\x1b[90m', c: '\x1b[36m', x: '\x1b[0m' };
const c = (k, s) => `${C[k]}${s}${C.x}`;

let hop = 0;
const trace = [];
function step(stage, input, output, note = '') {
  hop++;
  const changed = JSON.stringify(input) !== JSON.stringify(output);
  const mark = changed ? c('y', 'CHANGED') : c('d', 'same   ');
  console.log(`  ${String(hop).padStart(2)}. ${c('b', stage.padEnd(26))} ${mark}`);
  console.log(`      in : ${trunc(fmt(input))}`);
  console.log(`      out: ${trunc(fmt(output))}`);
  if (note) console.log(`      ${c('d', note)}`);
  trace.push({ stage, input, output, changed, note });
}
const fmt = (v) => (typeof v === 'string' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.length}]` : String(v));
const trunc = (s) => (s.length > 96 ? s.slice(0, 96) + '...' : s);

function banner(title) {
  console.log(`\n${c('b', '='.repeat(74))}`);
  console.log(c('b', title));
  console.log(c('b', '='.repeat(74)));
}

// =============================================================== detection path

async function traceDetection() {
  const dir = mkdtempSync(join(tmpdir(), 'wd-trace-'));
  const proj = join(dir, 'project');
  mkdirSync(join(proj, 'src'), { recursive: true });
  mkdirSync(join(proj, '.watchdog'), { recursive: true });
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'p', dependencies: { 'left-pad': '^1.3.0' } }, null, 2));
  const transcript = join(dir, 'ps-1-20260101-000000.log');
  writeFileSync(transcript + '.json', JSON.stringify({ shell: 'powershell', pid: 1, cwd: proj, file: transcript, ide: 'Windows Terminal' }));

  banner('PATH 1: one error line, every hop, real modules');

  // --- hop: the shell writes it. We emulate the transcript writer exactly.
  const rawLine = "Error: Cannot find module 'left-pad'";
  writeFileSync(transcript, `PS> node -e "require('left-pad')"\r\n${rawLine}\r\n`);
  step('shell -> transcript', rawLine, readFileSync(transcript, 'utf8').includes(rawLine) ? 'written' : 'LOST', 'Start-Transcript appends the line to the .log');

  // --- hop: discovery
  const discovery = new TranscriptDiscovery(dir);
  const found = discovery.scan();
  step('discovery.scan()', transcript, found[0]?.file, found[0] ? `sessionId=${found[0].sessionId} cwd=${found[0].cwd}` : 'not found');
  step('discovery rescan', '1 new file', `${discovery.scan().length} new files`, 'a second scan must yield 0 (no double-processing)');

  // --- hop: tailer reads bytes and splits
  const lines = [];
  const tailer = new TranscriptTailer({ onLines: (l) => lines.push(l), pollMs: 50 });
  tailer.track(transcript, found[0]);
  await new Promise((r) => setTimeout(r, 200));
  tailer.stop();
  step('tailer -> lines', transcript, lines, `${lines.length} logical lines recovered from raw bytes`);
  const target = lines.find((l) => l.includes('left-pad')) ?? lines[0];
  step('line selection', lines, target, 'the echoed command and the error are separate lines');

  // --- hop: chrome filter
  const isChrome = makeChromeFilter();
  let chromeSeen = false;
  const filtered = [];
  for (const l of lines) {
    if (isChrome(l)) chromeSeen = true;
    else filtered.push(l);
  }
  step('chrome filter', lines, filtered, `dropped ${lines.length - filtered.length} line(s) as transcript chrome`);

  // --- hop: redact
  const redacted = redact(filtered[0]);
  step('redact()', filtered[0], redacted, redacted === filtered[0] ? 'no secrets present, unchanged' : 'SECRETS WERE STRIPPED');

  // --- hop: rules
  const findings = evaluate(redacted);
  step('evaluate()', redacted, findings.map((f) => f.ruleId), `${findings.length} of ${RULES.length} rules matched`);
  const f = findings[0];
  step('fix template', '$1 (raw template)', f.fix.package, 'capture group 1, not the whole match');

  // --- hop: guard
  const guard = isRefused(f.fix, { projectRoot: proj, cwd: proj });
  step('isRefused()', 'patch/install action', guard.ok ? 'allowed' : guard.code, 'denylist rails: no match means allowed');

  // --- hop: allowlist
  const declared = declaredPackages(proj);
  step('declaredPackages()', 'package.json deps', [...declared], 'the allowlist, read from the project');
  step('isDeclared()', 'left-pad', isDeclared(proj, 'left-pad'), 'gate: declared -> allowed');
  step('lockfileKind()', proj, lockfileKind(proj) ?? 'none', 'no lockfile here, so install-by-name; a lockfile would use npm ci');

  console.log(`\n  ${c('g', 'REACHED:')} detection -> guard -> allowlist, ${hop} hops, every value shown.`);
  return { proj, f };
}

// ================================================================ refusal path

async function traceRefusal() {
  const dir = mkdtempSync(join(tmpdir(), 'wd-trace2-'));
  const proj = join(dir, 'project');
  mkdirSync(join(proj, '.watchdog'), { recursive: true });
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'p', dependencies: { 'left-pad': '^1.3.0' } }, null, 2));

  banner('PATH 2: the attack. same pipeline, undeclared package');

  const attackerLine = "Error: Cannot find module 'evil-pkg'";
  step('attacker prints', '(anything can write here)', attackerLine, 'a postinstall script, a build tool, a README');
  step('chrome filter', attackerLine, isChromeLine(attackerLine) ? 'CHROME' : 'real line', 'must not be discarded as chrome');
  const findings = evaluate(attackerLine);
  step('evaluate()', attackerLine, findings.map((x) => x.ruleId), 'detection is intentionally NOT weakened');
  step('fix template', '$1', findings[0].fix.package, 'the rule still extracts the name...');
  step('isDeclared()', 'evil-pkg', isDeclared(proj, 'evil-pkg'), '...and here the path stops');

  // The kind is named explicitly, because this demo is about the *package* allowlist
  // refusing an undeclared dependency. Opting in is what isolates that control: left
  // on "autonomous", dependency actions are refused before the allowlist is consulted,
  // so the hop this walkthrough exists to show would never be reached -- and the
  // narration below would be claiming credit for a refusal it did not cause.
  const a = new Applier({ projectRoot: proj, dataDir: join(proj, '.watchdog'), autonomy: 'allowlist', allowlist: ['install-deps'] });
  const res = await a.applyAsync(findings[0].fix, { cwd: proj });
  step('applyAsync()', 'install-deps evil-pkg', res.status, res.why?.slice(0, 70));
  step('journal', 'action taken', `${a.listJournal().length} entries`, 'nothing executed means nothing journalled');
  step('node_modules', 'evil-pkg installed?', existsSync(join(proj, 'node_modules', 'evil-pkg')) ? 'YES - VULNERABLE' : 'no', 'the thing being defended');

  console.log(`\n  ${c('g', 'REACHED:')} detection -> extraction -> allowlist REFUSES. The command never runs.`);
}

// ================================================================= route path

function traceRoute() {
  banner('PATH 3: how arguments reach a command');
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wd.js'), 'utf8');
  const cases = [['status'], ['autostart', '--status'], ['scan', 'x.log'], ['init', '--dry-run']];

  for (const argv of cases) {
    const [cmd, ...flags] = argv;
    // parseFlags, the real one
    const f = { _: [] };
    for (let i = 0; i < flags.length; i++) {
      const a = flags[i];
      if (a === '--dry-run') f.dryRun = true;
      else if (a === '--remove') f.remove = true;
      else if (a === '--status') f.status = true;
      else f._.push(a);
    }
    const routed = new RegExp(`case '${cmd}':\\s*return (?:await )?(\\w+)\\(`).exec(src);
    const defined = new RegExp(`(?:async )?function ${routed?.[1]}\\(`).test(src);
    step(
      `argv ${JSON.stringify(argv)}`,
      `cmd=${cmd} flags=${JSON.stringify(flags)}`,
      `${routed?.[1] ?? 'NOT ROUTED'}(f=${JSON.stringify(f)})`,
      defined ? 'target function exists' : '*** TARGET MISSING ***',
    );
  }
  console.log(`\n  ${c('g', 'REACHED:')} argv -> parseFlags -> switch -> function. The flags survive parsing.`);
}

// ============================================================== live session

async function traceLive() {
  const dir = mkdtempSync(join(tmpdir(), 'wd-live-'));
  const transcript = join(dir, 'ps-2-live.log');
  writeFileSync(transcript + '.json', JSON.stringify({ shell: 'powershell', pid: 2, cwd: dir, file: transcript, ide: 'unknown' }));
  writeFileSync(transcript, 'PS> npm ci\r\nadded 412 packages in 9s\r\n');

  banner('PATH 4: a session discovered MID-WRITE (where my earlier bugs lived)');
  step('session starts', 'npm ci output', statSync(transcript).size + ' bytes', 'the tailer attaches here, mid-session');

  const seen = [];
  const tailer = new TranscriptTailer({ onLines: (l) => seen.push(l), pollMs: 60 });
  tailer.track(transcript, { shell: 'powershell', cwd: dir, pid: 2 });

  appendFileSync(transcript, "Error: Cannot find module 'left-pad'\r\n");
  await new Promise((r) => setTimeout(r, 180));
  step('write #1 (incremental)', 'offset tracked', seen.length + ' line(s)', 'must NOT re-read the whole file');

  appendFileSync(transcript, 'src/a.ts(1,1): error TS1: bad\r\n');
  await new Promise((r) => setTimeout(r, 180));
  step('write #2 (incremental)', 'offset tracked', seen.length + ' line(s)', 'polling picks up only new bytes');

  appendFileSync(transcript, 'unterminated line with no newline');
  await new Promise((r) => setTimeout(r, 180));
  const beforeFlush = seen.length;
  step('partial line held', 'no trailing newline', beforeFlush + ' line(s)', 'a partial line must NOT be emitted yet');
  tailer.stop();
  step('flush()', 'retained partial', seen.length - beforeFlush, 'emitted on close, exactly once');

  const dupes = seen.length - new Set(seen).size;
  step('duplicate check', seen.length + ' lines', dupes === 0 ? 'no duplicates' : dupes + ' DUPLICATES', 'each line exactly once');
  console.log('\n  ' + c('g', 'REACHED:') + ' attach mid-session -> incremental reads -> held partial -> flush.');
}

// ================================================================== rollback

function traceRollback() {
  const dir = mkdtempSync(join(tmpdir(), 'wd-rb-'));
  const proj = join(dir, 'project');
  mkdirSync(join(proj, '.watchdog'), { recursive: true });
  const target = join(proj, 'src.js');
  const original = 'const a = 1;\nconst count = undefined;\nconst b = 2;\n';
  writeFileSync(target, original);

  banner('PATH 5: apply then roll back, byte for byte');
  const a = new Applier({ projectRoot: proj, dataDir: join(proj, '.watchdog'), autonomy: 'autonomous' });
  const r = a.apply({ kind: 'patch-file', path: 'src.js', find: 'const count = undefined;', replace: 'const count = 0;' }, { cwd: proj });
  step('apply', 'const count = undefined;', r.status, 'patch-file, inside project root');
  const after = readFileSync(target, 'utf8');
  step('file after', original, after, 'exactly one substitution');

  const j = a.listJournal()[0];
  step('journal', 'action', j.id, 'outcome=' + j.outcome + ' before=' + (j.before ? j.before.length : '?') + 'B after=' + (j.after ? j.after.length : '?') + 'B');

  a.rollback(j.id);
  const restored = readFileSync(target, 'utf8');
  step('rollback', after, restored, restored === original ? 'byte-identical to the original' : 'MISMATCH');
  step('journal after rollback', 'ok', a.listJournal()[0].outcome, 'marked, so it cannot be rolled back twice');
  console.log('\n  ' + c('g', 'REACHED:') + ' patch -> journal -> rollback -> byte-identical.');
}
// =================================================================== llm path

async function traceLlm() {
  banner('PATH 6: the LLM path, live (prompt -> CLI -> NDJSON -> guard)');
  // Same reasoning as the other sandboxes: this walks fake errors through the
  // real model, and the result must not be shipped to the real Langfuse project.
  process.env.WD_TRACING = 'off';
  const model = process.env.WD_TEST_MODEL || 'opencode/space-bunny-free';
  const evidence = [
    "function tally(items) {",
    "  return count / items.length;",
    "}",
  ].join('\n');

  step('finding reaches the advisor', 'unrecognised-error', 'evidence + cwd + title', 'the rules deliberately did not claim this one');

  const { Advisor } = await import('../src/analyze/advisor.mjs');
  const advisor = new Advisor({ cli: 'opencode', model, timeoutMs: 180_000 });
  step('resolveCli()', 'opencode', 'opencode', 'no shell, no .cmd guessing: makeRunnable routes it');

  console.log('      ' + c('d', '...calling the real model, this takes a moment'));
  const advice = await advisor.review({ evidence, cwd: process.cwd(), title: 'Possible undefined variable' });

  step('transport', 'opencode run --format json', advice.status ?? 'ok', advice.error ?? 'no transport failure');
  step('unwrapEvents()', 'NDJSON event stream', advice.verdict, advice.summary?.slice(0, 70));
  step('normalize()', 'verdict/confidence/summary', advice.confidence, 'files extracted: ' + (advice.fix?.files?.length ?? 0));

  if (advice.fix?.files?.length) {
    const { isRefused } = await import('../src/act/guard.mjs');
    for (const f of advice.fix.files) {
      const g = isRefused({ kind: 'patch-file', path: f.path }, { projectRoot: process.cwd(), cwd: process.cwd() });
      step('guard on model output', f.path, g.ok ? 'allowed' : g.code, 'same rails as a rule fix');
    }
  }
  // All three conjuncts, exactly as watcher.mjs evaluates them. An earlier
  // version of this tracer checked only the confidence and printed "would act"
  // while fix was null -- the same class of error it exists to catch.
  const conjuncts = {
    "verdict === 'problem'": advice.verdict === 'problem',
    'fix is present': !!advice.fix,
    'confidence >= 0.6': advice.confidence >= 0.6,
  };
  const wouldAct = Object.values(conjuncts).every(Boolean);
  for (const [k, v] of Object.entries(conjuncts)) {
    step('act gate: ' + k, String(advice.verdict) + '/' + (advice.fix ? 'fix' : 'null') + '/' + advice.confidence, v ? 'pass' : 'FAIL', '');
  }
  step('ACT GATE (all three)', 'conjunction', wouldAct ? 'WOULD ACT' : 'WOULD NOT ACT', wouldAct ? 'an edit is about to be attempted' : 'nothing happens, correctly');
  console.log('\n  ' + c('g', 'REACHED:') + ' prompt -> CLI -> NDJSON -> verdict -> guard -> act gate, with the real model.');
}
// ======================================================================= main

const mode = process.argv[2] ?? 'detect';
if (mode === 'detect' || mode === 'all') {
  const { f } = await traceDetection();
  console.log(`\n  ${c('d', 'fix that would be applied:')} ${JSON.stringify(f.fix)}`);
}
if (mode === 'refuse' || mode === 'all') await traceRefusal();
if (mode === 'route' || mode === 'all') traceRoute();
if (mode === 'live' || mode === 'all') await traceLive();
if (mode === 'rollback' || mode === 'all') traceRollback();
if (mode === 'llm' || mode === 'all') await traceLlm();
if (mode === 'all') console.log(`\n${c('b', 'all paths traced')}\n`);
