/**
 * Per-session LLM budget.
 *
 * maxInvocationsPerSession was backed by one counter for the whole watcher, so
 * the allowance went to whoever asked first. A terminal running a noisy build
 * could spend all of it and leave every other terminal with silence -- the exact
 * opposite of what the name promises.
 *
 * Driven through the real ingest() path. cli is '', so the advisor answers
 * 'unavailable' immediately and no model is contacted; what is tested is who
 * gets an advisor slot at all.
 *
 * Slots are counted on the 'finding' event rather than by inspecting the
 * returned records. #askAdvisor is fired before the event, and because it awaits
 * the advisor it resolves on a later microtask -- by the time an awaiting caller
 * looks at the record, pending has already flipped to false. Counting at emit
 * time is the only race-free point.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Watcher } from '../src/core/watcher.mjs';

const dataDir = () => mkdtempSync(join(tmpdir(), 'wd-budget-'));

function makeWatcher({ max = 2, minSeverity = 'medium' } = {}) {
  const data = dataDir();
  const w = new Watcher({
    projectRoot: data,
    autonomy: 'suggest',
    allowlist: [],
    capture: { layers: {}, redact: true, maxLineBytes: 65536, shells: [] },
    analyze: {
      llm: { enabled: true, cli: '', model: null, timeoutMs: 500, minSeverity, maxInvocationsPerSession: max },
      cooldownMs: 0,
      maxFindingsPerSession: 500,
    },
    paths: { data },
  });
  // Record every finding the moment it is emitted, while advisor.pending is
  // still true. Only java-stacktrace, todo-left and deprecated-api are
  // non-high-confidence, so these are the only lines that reach the advisor by
  // the rule path at all.
  const granted = [];
  w.on('finding', (rec) => {
    if (rec.advisor?.pending === true) granted.push(rec.sessionId);
  });
  return { w, granted };
}

/** A rule-matched line: java-stacktrace, severity high, confidence medium. */
function ruleLine(i) {
  return `    at com.example.Synthetic.run(Synthetic.java:${40 + i})`;
}

/** Error-shaped but matched by no rule, so it goes to residual triage. */
function residualLine(i) {
  return `FrobnicatorException: unrecognised residual ${i} ${'y'.repeat(30 + i)}`;
}

test('one session exhausting its budget does not silence another', async () => {
  const { w, granted } = makeWatcher({ max: 2 });

  for (let i = 0; i < 6; i++) await w.ingest(ruleLine(i), { sessionId: 'ps-A', shell: 'powershell' });
  await w.ingest(ruleLine(99), { sessionId: 'ps-B', shell: 'powershell' });

  const a = granted.filter((s) => s === 'ps-A').length;
  const b = granted.filter((s) => s === 'ps-B').length;

  assert.equal(a, 2, `session A should be capped at 2, was granted ${a}`);
  assert.equal(b, 1, `session B was starved by session A: granted ${b}`);
});

test('the cap is per session, not a global total', async () => {
  const { w, granted } = makeWatcher({ max: 2 });
  for (const s of ['p1', 'p2', 'p3']) {
    for (let i = 0; i < 3; i++) await w.ingest(ruleLine(i + s.length * 100), { sessionId: s, shell: 'powershell' });
  }
  for (const s of ['p1', 'p2', 'p3']) {
    const n = granted.filter((x) => x === s).length;
    assert.equal(n, 2, `session ${s} was granted ${n}, expected its own cap of 2`);
  }
  assert.equal(granted.length, 6, 'total should be 3 sessions x 2, not 2 overall');
});

test('residual triage draws from the same session budget', async () => {
  // The two call sites share the allowance. If triage bypassed it, an unrecognised
  // error stream would spend unbounded model calls.
  const { w, granted } = makeWatcher({ max: 2 });
  for (let i = 0; i < 5; i++) await w.ingest(residualLine(i), { sessionId: 'ps-res', shell: 'powershell' });
  assert.equal(granted.length, 2, `residual triage was granted ${granted.length} slots, expected the session cap of 2`);
});

test('a session with no budget does not stop another from triaging', async () => {
  const { w, granted } = makeWatcher({ max: 1 });
  for (let i = 0; i < 4; i++) await w.ingest(residualLine(i), { sessionId: 'noisy', shell: 'powershell' });
  await w.ingest(residualLine(99), { sessionId: 'quiet', shell: 'powershell' });
  assert.equal(granted.filter((s) => s === 'noisy').length, 1);
  assert.equal(granted.filter((s) => s === 'quiet').length, 1, 'the quiet terminal got nothing');
});

test('the budget map cannot grow without bound', () => {
  // The daemon watches every terminal on the machine. One retained entry per
  // shell that ever existed is a slow leak in a process that never restarts.
  const { w } = makeWatcher({ max: 1 });
  for (let i = 0; i < 700; i++) {
    w.ingest(ruleLine(i), { sessionId: `s${i}`, shell: 'powershell' });
  }
  assert.ok(w.llmBudget <= 501, `budget tracked ${w.llmBudget} sessions; expected it capped`);
});

test('llmBudget reports sessions, not invocations', () => {
  // The getter used to return a number that was compared against a per-session
  // limit, which is the shape that invites this bug back.
  const { w } = makeWatcher({ max: 5 });
  for (let i = 0; i < 3; i++) w.ingest(ruleLine(i), { sessionId: `s${i}`, shell: 'powershell' });
  assert.equal(w.llmBudget, 3, 'three sessions each granted a slot should report 3 sessions');
});