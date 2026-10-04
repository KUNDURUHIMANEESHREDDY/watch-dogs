/**
 * A multi-file transaction is identifiable after the fact.
 *
 * This is the prerequisite for transaction-aware crash recovery, and it is shipped
 * on its own deliberately.
 *
 * Windows has no filesystem transaction, so a crash between two promotions leaves a
 * genuinely torn tree. What *is* fixable is the recovery side pretending the pieces
 * were unrelated: `recoverPending` used to settle each pending entry on its own, so
 * one interrupted four-file transaction was indistinguishable from four independent
 * edits, one of which landed. The first reading is the one that quietly produces a
 * mixed tree nobody can explain.
 *
 * Grouping needs an identity to group by, and there was none. Every entry now
 * carries the id of the transaction that wrote it.
 *
 * What is NOT here yet: recovery reading it. `recoverPending` still settles per
 * entry, exactly as before, so a torn transaction is still healed file by file. The
 * change here makes the torn state *identifiable* -- in the journal, for an operator
 * and for the recovery code that will use it -- and nothing more. That is a
 * prerequisite, not a fix, and the tests below say exactly that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Applier } from '../src/act/apply.mjs';

function project(files = 3) {
  const root = mkdtempSync(join(tmpdir(), 'wd-txid-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  for (let i = 0; i < files; i++) {
    writeFileSync(join(root, 'src', `f${i}.js`), `const V${i} = 1;\nmodule.exports = { V${i} };\n`, 'utf8');
  }
  return root;
}

const applierFor = (root) =>
  new Applier({ projectRoot: root, dataDir: join(root, '.watchdog'), autonomy: 'autonomous', allowlist: [] });

const editsFor = (n) =>
  Array.from({ length: n }, (_, i) => ({
    kind: 'patch-file',
    path: `src/f${i}.js`,
    find: `const V${i} = 1;`,
    replace: `const V${i} = 2;`,
  }));

test('every entry from one transaction carries the same id', () => {
  const root = project(3);
  const a = applierFor(root);

  const r = a.applyAll(editsFor(3), { cwd: root, source: 'rule' });

  assert.equal(r.status, 'all_applied', JSON.stringify(r.results));
  const applied = a.listJournal().filter((j) => j.type === 'patch');
  assert.equal(applied.length, 3);

  const ids = new Set(applied.map((j) => j.txId));
  assert.equal(ids.size, 1, `expected one transaction id, got ${[...ids].join(', ')}`);
  assert.ok([...ids][0], 'the id is empty, which would group unrelated entries together');
});

test('two transactions are told apart', () => {
  // The property that makes the id worth having. Without it every pending entry in the
  // journal looks like it might belong to the same interrupted run.
  const root = project(4);
  const a = applierFor(root);

  a.applyAll(editsFor(2), { cwd: root, source: 'rule' });
  a.applyAll(editsFor(4).slice(2), { cwd: root, source: 'rule' });

  const patches = a.listJournal().filter((j) => j.type === 'patch');
  const ids = [...new Set(patches.map((j) => j.txId))];
  assert.equal(patches.length, 4);
  assert.equal(ids.length, 2, `expected two transaction ids, got ${ids.length}`);
});

test('a single-file transaction still gets an id', () => {
  const root = project(1);
  const a = applierFor(root);

  a.applyAll(editsFor(1), { cwd: root, source: 'rule' });

  const patch = a.listJournal().find((j) => j.type === 'patch');
  assert.ok(patch?.txId, 'a one-file transaction has no id');
});

test('recovery does not yet group by it, and this test says so', () => {
  // Written as a test rather than a comment because the gap is easy to forget and
  // easy to overstate. When recovery does group, this assertion is what should fail
  // first, forcing the message below to be rewritten.
  const root = project(3);
  const a = applierFor(root);
  a.applyAll(editsFor(3), { cwd: root, source: 'rule' });

  const rec = a.recoverPending();

  // Nothing is pending, so there is nothing to group. The assertion is that the
  // summary shape exists and is empty, not that grouping has happened.
  assert.ok(Array.isArray(rec.reconciled), 'recoverPending must report what it settled');
  assert.deepEqual(rec.reconciled, [], 'a clean run should have nothing to settle');
  assert.equal(
    rec.transactions,
    undefined,
    'recoverPending now reports transactions, so update this test and the README claim that recovery does not group yet',
  );
});