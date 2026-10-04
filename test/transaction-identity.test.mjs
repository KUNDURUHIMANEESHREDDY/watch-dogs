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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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

/**
 * Recovery decides the transaction, not the file.
 *
 * Windows has no filesystem transaction, so a crash between two promotions leaves a
 * genuinely torn tree and no amount of care at write time can prevent it. What is
 * fixable is the recovery side pretending the pieces were unrelated.
 *
 * `recoverPending` used to settle each pending entry on its own, so one interrupted
 * four-file transaction was indistinguishable from four independent edits, one of
 * which landed. The landed file was settled as done, the unpromoted ones as aborted,
 * and nothing recorded that these writes were meant to move together. The result was
 * a mixed tree with no story attached.
 *
 * The three cases below are separately wrong, so they are pinned separately.
 */

test('a transaction where nothing landed is aborted, with nothing undone', () => {
  const root = project(3);
  const a = applierFor(root);
  a.applyAll(editsFor(3), { cwd: root, source: 'rule' });

  // Rewind every entry to pending with its pre-write content, which is exactly the
  // state a crash before the first promotion leaves behind.
  rewind(a, [0, 1, 2]);

  const rec = a.recoverPending();
  assert.equal(rec.transactions.length, 1);
  assert.equal(rec.transactions[0].outcome, 'aborted');
  assert.equal(rec.transactions[0].written, 0);
  assert.equal(rec.transactions[0].restored, 0);
  assert.equal(read(root, 'src/f0.js'), 'const V0 = 1;\nmodule.exports = { V0 };\n', 'an aborted transaction changed a file');
});

test('a transaction where everything landed is recorded as done, not undone', () => {
  // The crash came after the last promotion. The transaction did what it said, and
  // undoing it would be destroying good work on the strength of a bookkeeping entry.
  const root = project(3);
  const a = applierFor(root);
  a.applyAll(editsFor(3), { cwd: root, source: 'rule' });

  rewindOutcomeOnly(a, [0, 1, 2]);

  const rec = a.recoverPending();
  assert.equal(rec.transactions[0].outcome, 'completed');
  assert.equal(rec.transactions[0].written, 3);
  assert.equal(rec.transactions[0].restored, 0, 'a completed transaction was rolled back');
  assert.equal(read(root, 'src/f0.js'), 'const V0 = 2;\nmodule.exports = { V0 };\n');
});

test('a torn transaction is restored whole, and says so', () => {
  // The case that matters. Two of three landed. Restoring only the landed one and
  // leaving the rest alone is not wrong file by file -- it is the mixed tree, and the
  // absence of any record that these were one attempt.
  const root = project(3);
  const a = applierFor(root);
  a.applyAll(editsFor(3), { cwd: root, source: 'rule' });

  // All three entries are pending, because a journal entry is written *before* the
  // promotion. What differs after a mid-transaction crash is only the content: f0 and
  // f1 were renamed over, f2 never was.
  rewindOutcomeOnly(a, [0, 1, 2]);
  revertContent(a, 'src/f2.js', 'const V2 = 1;\nmodule.exports = { V2 };\n');

  const rec = a.recoverPending();

  assert.equal(rec.transactions.length, 1);
  assert.equal(rec.transactions[0].outcome, 'torn-rolled-back');
  assert.equal(rec.transactions[0].written, 2, 'two files had been written');
  assert.equal(rec.transactions[0].restored, 2, 'and both should have been restored');
  assert.equal(rec.transactions[0].neverWritten, 1);

  // The whole point: every file now matches the state before the attempt.
  assert.equal(read(root, 'src/f0.js'), 'const V0 = 1;\nmodule.exports = { V0 };\n', 'f0 was left half-applied');
  assert.equal(read(root, 'src/f1.js'), 'const V1 = 1;\nmodule.exports = { V1 };\n', 'f1 was left half-applied');
  assert.equal(read(root, 'src/f2.js'), 'const V2 = 1;\nmodule.exports = { V2 };\n');

  // And it is recorded, per entry, so an operator reading the journal can see it.
  const settled = a.listJournal().filter((j) => j.txId);
  assert.equal(settled.length, 3);
  for (const e of settled) assert.equal(e.txOutcome, 'torn-rolled-back', `${e.rel} does not record the torn transaction`);
});

test('one transaction id still yields one group, however many files', () => {
  const root = project(2);
  const a = applierFor(root);
  a.applyAll(editsFor(2), { cwd: root, source: 'rule' });
  rewindOutcomeOnly(a, [0, 1]);

  const rec = a.recoverPending();
  assert.equal(rec.transactions.length, 1, 'two files from one transaction were treated as two transactions');
  assert.equal(rec.transactions[0].files, 2);
});

test('entries with no transaction id are still settled one at a time', () => {
  // Written before transactions were identified. They must keep working, and must not
  // be swept into a group with each other by accident.
  const root = project(2);
  const a = applierFor(root);
  a.applyAll(editsFor(2), { cwd: root, source: 'rule' });
  stripTxIds(a);

  const rec = a.recoverPending();
  assert.equal(rec.reconciled.length, 2);
  assert.deepEqual(rec.transactions, [], 'legacy entries were grouped into a transaction');
  for (const r of rec.reconciled) assert.ok(['ok', 'aborted', 'conflict'].includes(r.outcome), `unexpected outcome ${r.outcome}`);
});

/* ------------------------------------------------------------------ *
 * Arranging the aftermath of a crash.
 * ------------------------------------------------------------------ */

/** Put the listed files' journal entries back to pending, keeping their new content. */
function rewindOutcomeOnly(a, indexes) {
  for (const i of indexes) {
    const e = a.listJournal().find((j) => j.type === 'patch' && j.rel === `src/f${i}.js`);
    assert.ok(e, `no journal entry for src/f${i}.js`);
    const p = entryPath(a, e.id);
    const rec = JSON.parse(readFileSync(p, 'utf8'));
    rec.outcome = 'pending';
    delete rec.note;
    delete rec.txOutcome;
    writeFileSync(p, JSON.stringify(rec, null, 2));
  }
}

/** Put the listed files' entries to pending *and* their content back to the preimage. */
function rewind(a, indexes) {
  rewindOutcomeOnly(a, indexes);
  for (const i of indexes) revertContent(a, `src/f${i}.js`, `const V${i} = 1;\nmodule.exports = { V${i} };\n`);
}

function revertContent(a, rel, contents) {
  const e = a.listJournal().find((j) => j.type === 'patch' && j.rel === rel);
  assert.ok(e, `no journal entry for ${rel}`);
  writeFileSync(join(a.projectRoot, rel), contents, 'utf8');
}

function stripTxIds(a) {
  for (const e of a.listJournal().filter((j) => j.type === 'patch')) {
    const p = entryPath(a, e.id);
    const rec = JSON.parse(readFileSync(p, 'utf8'));
    delete rec.txId;
    // An entry only reaches recovery while pending; applyAll settled these.
    rec.outcome = 'pending';
    delete rec.note;
    writeFileSync(p, JSON.stringify(rec, null, 2));
  }
}

const entryPath = (a, id) => join(a.journalDir, `${id}.json`);
const read = (root, rel) => readFileSync(join(root, ...rel.split('/')), 'utf8');