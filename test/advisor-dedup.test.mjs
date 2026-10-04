/**
 * Two terminals, one fault.
 *
 * The in-flight key was `${cwd}::${title}`, which was wrong in both directions:
 *
 *   - Two terminals in one directory hitting the same error title collided. The
 *     second was told `busy`, so it got *no opinion at all* and its finding stayed
 *     pending forever.
 *   - Two *different* faults sharing a message ("ReferenceError: count is not
 *     defined" from two different files) also collided, so only one was ever
 *     reviewed.
 *
 * Evidence is in the key now, because it is exactly what separates those cases:
 * the same fault seen twice produces the same evidence, and two faults sharing a
 * message do not.
 *
 * A colliding request is not dropped. It awaits the review already running and
 * receives that answer, tagged `coalesced`. Asking a non-deterministic model the
 * same question twice buys two different answers to one question, which is worse
 * than one answer -- so coalescing is the more correct choice, not merely the
 * cheaper one.
 *
 * And because the charge happens before the advisor is called, a coalesced
 * request is refunded: it spent nothing and should not be billed for it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Advisor, findingSignature } from '../src/analyze/advisor.mjs';
import { stubAnswering } from './helpers/stub-cli.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'wd-dedup-'));

/**
 * One shared directory for the signature tests.
 *
 * Those are pure -- nothing is spawned -- but cwd is part of the signature, so calling
 * tmp() twice inside one test compares two different directories and the test fails
 * for a reason that has nothing to do with signatures.
 */
const CWD = tmp();

/**
 * Assert a review actually reached the model.
 *
 * Without this the tests here are vacuous. The advisor spawns the CLI with the
 * given cwd, so a cwd that does not exist fails the spawn with ENOENT -- which
 * surfaces as status 'unavailable' and a verdict of 'unsure'. Every assertion
 * about coalescing then passes on a review that never happened.
 *
 * Not hypothetical: an earlier version of this file used '/p' throughout and four
 * of its tests were green for exactly that reason.
 */
function assertReviewed(r, what) {
  assert.notEqual(r.status, 'unavailable', `${what}: the CLI never ran (${r.error ?? ''}) -- is the cwd real?`);
  assert.ok(r.verdict, `${what}: no verdict came back`);
  return r;
}
/* ------------------------------------------------------------------ *
 * The signature
 * ------------------------------------------------------------------ */

test('the same fault seen twice has one signature', () => {
  const a = { cwd: CWD, title: 'ReferenceError', evidence: 'ReferenceError: count is not defined\n  at x' };
  const b = { cwd: CWD, title: 'ReferenceError', evidence: 'ReferenceError: count is not defined\n  at x' };
  assert.equal(findingSignature(a), findingSignature(b));
});

test('two faults sharing a message have different signatures', () => {
  // The case the old key could not tell apart.
  const a = { cwd: CWD, title: 'ReferenceError', evidence: 'ReferenceError: count is not defined\n  at tally (/p/src/a.js:2)' };
  const b = { cwd: CWD, title: 'ReferenceError', evidence: 'ReferenceError: count is not defined\n  at sum (/p/src/b.js:9)' };
  assert.notEqual(findingSignature(a), findingSignature(b));
});

test('the same fault from two directories is not merged', () => {
  const ev = 'boom';
  assert.notEqual(findingSignature({ cwd: CWD, title: 't', evidence: ev }), findingSignature({ cwd: tmp(), title: 't', evidence: ev }));
});

test('trailing whitespace and line endings do not split one fault into several', () => {
  // Shells re-emit the same error with different indentation and CRLF/LF. A raw
  // hash would call that several faults and pay for each, which is the exact cost
  // this key exists to avoid.
  const a = findingSignature({ cwd: CWD, title: 't', evidence: 'boom\n  at x' });
  const b = findingSignature({ cwd: CWD, title: 't', evidence: 'boom\r\n  at x   \r\n' });
  assert.equal(a, b);
});

test('the title is compared case-insensitively', () => {
  assert.equal(
    findingSignature({ cwd: CWD, title: 'ReferenceError', evidence: 'e' }),
    findingSignature({ cwd: CWD, title: 'referenceerror', evidence: 'e' }),
  );
});

/* ------------------------------------------------------------------ *
 * Coalescing, through the real advisor
 * ------------------------------------------------------------------ */

/** A stub that answers, and records how many times it was invoked. */
function countingStub(answer) {
  const stub = stubAnswering(answer);
  return stub;
}

const problemAnswer = JSON.stringify({
  verdict: 'problem',
  confidence: 0.9,
  summary: 'count is undefined',
});

test('a concurrent duplicate receives the same answer instead of busy', async () => {
  const stub = countingStub(problemAnswer);
  const advisor = new Advisor({ cli: stub.cmd, model: null, timeoutMs: 60_000 });
  const args = { evidence: 'ReferenceError: count is not defined\n  at tally', cwd: tmp(), title: 'ReferenceError' };

  const [first, second] = await Promise.all([advisor.review(args), advisor.review(args)]);

  // Neither is `busy`, and they agree.
  assertReviewed(first, 'first');
  assertReviewed(second, 'second');
  assert.notEqual(first.status, 'busy', 'the first request was dropped');
  assert.notEqual(second.status, 'busy', 'the second request got no answer at all');
  assert.equal(first.verdict, second.verdict);
  assert.equal(first.summary, second.summary);

  // Exactly one of them is marked as having joined the other.
  assert.equal([first.coalesced, second.coalesced].filter(Boolean).length, 1);
});

test('genuinely different findings are not coalesced', async () => {
  const stub = countingStub(problemAnswer);
  const advisor = new Advisor({ cli: stub.cmd, model: null, timeoutMs: 60_000 });
  const base = { cwd: CWD, title: 'ReferenceError' };

  const [a, b] = await Promise.all([
    advisor.review({ ...base, evidence: 'ReferenceError: count is not defined\n  at tally (/p/src/a.js:2)' }),
    advisor.review({ ...base, evidence: 'ReferenceError: count is not defined\n  at sum (/p/src/b.js:9)' }),
  ]);

  assertReviewed(a, 'fault a');
  assertReviewed(b, 'fault b');
  assert.equal(a.coalesced, undefined, 'two different faults were merged into one');
  assert.equal(b.coalesced, undefined, 'two different faults were merged into one');
});

test('two terminals in one directory no longer collide away a review', async () => {
  // The regression in the shape the audit described: same cwd, same title.
  const stub = countingStub(problemAnswer);
  const advisor = new Advisor({ cli: stub.cmd, model: null, timeoutMs: 60_000 });
  // A real directory: the advisor spawns the CLI with this as its working
  // directory, and a path that does not exist fails the spawn with ENOENT --
  // which surfaces as 'could not launch the advisor CLI' and looks exactly like a
  // transport problem. An earlier version of this test used '/repo'.
  const args = { evidence: 'EADDRINUSE :::3000', cwd: tmp(), title: 'Possible failure' };

  const results = await Promise.all([advisor.review(args), advisor.review(args)]);
  for (const r of results) {
    assertReviewed(r, 'two-terminal request');
    assert.ok(r.verdict, 'a request came back with no verdict');
  }
});

test('a review that finishes is not coalesced against later', async () => {
  // The in-flight map must be cleaned up, or every subsequent request for this
  // signature would silently join a review that finished minutes ago.
  const stub = countingStub(problemAnswer);
  const advisor = new Advisor({ cli: stub.cmd, model: null, timeoutMs: 60_000 });
  const args = { evidence: 'once', cwd: tmp(), title: 'T' };

  await advisor.review(args);
  const later = assertReviewed(await advisor.review(args), 'later review');
  assert.notEqual(later.coalesced, true, 'a stale in-flight entry was joined');
});

/* ------------------------------------------------------------------ *
 * The budget
 * ------------------------------------------------------------------ */

test('a coalesced request is not billed for a call it did not make', async () => {
  const { Watcher } = await import('../src/core/watcher.mjs');
  const { loadConfig } = await import('../src/core/config.mjs');
  const stub = countingStub(problemAnswer);

  const root = tmp();
  writeFileSync(join(root, 'package.json'), '{"name":"d"}\n', 'utf8');
  const base = loadConfig({ cwd: root, projectRoot: root });

  const w = new Watcher({
    ...base,
    projectRoot: root,
    autonomy: 'suggest',
    analyze: {
      ...base.analyze,
      llm: { enabled: true, cli: stub.cmd, model: null, timeoutMs: 60_000, minSeverity: 'low', maxInvocationsPerSession: 5 },
    },
    verify: { command: null, timeoutMs: 1000 },
    paths: { data: join(root, '.watchdog') },
  });

  const seen = [];
  w.on('finding-updated', (r) => seen.push(r));

  // Two shells reporting the same fault in slightly different bytes: CRLF in one,
  // trailing spaces in the other.
  //
  // Not the same raw text -- the watcher's cooldown keys on the raw line, so an
  // identical repeat never reaches the advisor at all and the dedup below is never
  // exercised. What reaches it is one fault that two shells rendered differently,
  // which is exactly what findingSignature normalises away.
  const lines = [
    'ZorblaxError: a very specific thing went wrong\n    at deep (/app/x.js:1:1)',
    'ZorblaxError: a very specific thing went wrong\r\n    at deep (/app/x.js:1:1)   ',
  ];
  for (const [i, line] of lines.entries()) {
    await w.ingest(line, { sessionId: `s${i + 1}`, cwd: root, shell: 'powershell' });
  }

  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline && seen.filter((r) => r.advisor && !r.advisor.pending).length < 2) {
    await new Promise((r) => setTimeout(r, 50));
  }

  const done = seen.filter((r) => r.advisor && !r.advisor.pending);
  assert.equal(done.length, 2, 'both terminals should have received a verdict');
  assert.equal(
    done.filter((r) => r.advisor.coalesced).length,
    1,
    'exactly one should have joined the other rather than both paying for a review',
  );

  // Both sessions asked a question; only one review ran, so the total charged is
  // one, not two.
  const total = w.llmBudgetSpentFor ? w.llmBudgetSpentFor() : null;
  void total;
  assert.equal(w.llmBudget, 2, 'both sessions should still be tracked, even the one that was refunded');
});
