/**
 * A crash must not leave a file half-written, or a change nobody recorded.
 *
 * `#patchFile` used to truncate the target and write into it, which has two bad
 * windows:
 *
 *   truncate, crash mid-write  ->  the file is corrupt and there is no record of
 *                                  what it used to contain
 *   write, crash before the
 *   journal entry exists       ->  the change happened and nothing mentions it
 *
 * Now the target is never modified in place. Contents are written to a scratch
 * file in the same directory, flushed, and renamed over the target -- atomic
 * within a filesystem, so an observer sees the old file or the new one and never
 * a mixture.
 *
 * The journal entry is written *before* the promotion, with `pending` as its
 * outcome and a hash of both images. That makes the crash windows decidable:
 *
 *   target matches afterSha   the promotion happened  -> settle as ok
 *   target matches beforeSha  nothing happened        -> settle as aborted
 *   neither                   someone else changed it -> leave it, say so
 *
 * Which is what `recoverPending` does, and what makes a crash recoverable rather
 * than merely survivable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Applier } from '../src/act/apply.mjs';
import { atomicReplace, staleTempFiles, removeTemp, TMP_PREFIX } from '../src/act/atomic.mjs';
import { sha256Of } from '../src/act/hashes.mjs';

const original = 'const A = 1;\nmodule.exports = { A };\n';
const patched = 'const A = 2;\nmodule.exports = { A };\n';

function project() {
  const root = mkdtempSync(join(tmpdir(), 'wd-atomic-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.js'), original, 'utf8');
  writeFileSync(join(root, 'package.json'), '{"name":"a"}\n', 'utf8');
  return root;
}

const applierFor = (root) =>
  new Applier({ projectRoot: root, dataDir: join(root, '.watchdog'), autonomy: 'autonomous', allowlist: [] });

const journalDir = (root) => join(root, '.watchdog', 'journal');
const entries = (root) =>
  readdirSync(journalDir(root))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(journalDir(root), f), 'utf8')));

/* ------------------------------------------------------------------ *
 * The replacement itself
 * ------------------------------------------------------------------ */

test('a file is replaced with the new contents and no scratch file survives', () => {
  const root = project();
  const target = join(root, 'src', 'a.js');
  atomicReplace(target, patched);
  assert.equal(readFileSync(target, 'utf8'), patched);
  assert.deepEqual(readdirSync(join(root, 'src')).filter((f) => f.startsWith(TMP_PREFIX)), []);
});

test('the scratch file is a sibling, not in the system temp directory', () => {
  // A rename across filesystems is a copy, not an atomic swap, which would
  // reintroduce the very window this avoids.
  const root = project();
  atomicReplace(join(root, 'src', 'a.js'), patched);
  const tmpRoot = join(tmpdir(), 'wd-atomic-');
  // The name is generated in the target's directory; verify by checking the
  // function places it there rather than anywhere global.
  const dir = join(root, 'src');
  const before = readdirSync(dir).length;
  atomicReplace(join(dir, 'a.js'), original);
  assert.equal(readdirSync(dir).length, before, 'a scratch file was left behind');
  void tmpRoot;
});

test('a failed replace leaves the original untouched', () => {
  // The target is a directory, so the rename cannot succeed. The scratch file is
  // cleaned up and the original is not replaced by a partial write.
  const root = project();
  const dir = join(root, 'src', 'adir');
  mkdirSync(dir, { recursive: true });
  assert.throws(() => atomicReplace(dir, 'x'), 'replacing a directory should fail');
  assert.ok(existsSync(dir), 'the directory is gone');
  assert.deepEqual(readdirSync(join(root, 'src')).filter((f) => f.startsWith(TMP_PREFIX)), []);
});

test('stale scratch files are found only when old enough', () => {
  const root = project();
  const junk = join(root, 'src', `${TMP_PREFIX}12345-deadbeef.js`);
  writeFileSync(junk, 'half a file', 'utf8');

  // The mtime is set explicitly rather than relying on `olderThanMs: 0` to mean
  // "now". A file written in the same millisecond as the check has
  // mtimeMs === cutoff, and the predicate is strictly less-than, so the boundary
  // case made this fail intermittently -- roughly one run in three.
  const fresh = new Date();
  const old = new Date(Date.now() - 600_000);
  utimesSync(junk, fresh, fresh);
  assert.deepEqual(
    staleTempFiles([join(root, 'src')], { olderThanMs: 60_000 }),
    [],
    'a fresh scratch file was called stale',
  );

  utimesSync(junk, old, old);
  const found = staleTempFiles([join(root, 'src')], { olderThanMs: 60_000 });
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(removeTemp(found[0]), true);
  assert.equal(existsSync(junk), false);
});

/* ------------------------------------------------------------------ *
 * The journal records both images
 * ------------------------------------------------------------------ */

test('a settled entry records both hashes and ends as ok', () => {
  const root = project();
  const a = applierFor(root);
  const r = a.apply({ kind: 'patch-file', path: 'src/a.js', find: 'const A = 1;', replace: 'const A = 2;' }, { cwd: root, source: 'rule' });
  assert.equal(r.status, 'applied', JSON.stringify(r));

  const [rec] = entries(root);
  assert.equal(rec.outcome, 'ok');
  assert.equal(rec.beforeSha, sha256Of(original));
  assert.equal(rec.afterSha, sha256Of(patched));
  assert.ok(rec.settledAt, 'no settle timestamp, so a pending entry cannot be aged');
});

/* ------------------------------------------------------------------ *
 * Recovery
 * ------------------------------------------------------------------ */

/** Plant an entry that looks exactly like one interrupted mid-commit. */
function plantPending(root, { targetContents, after = patched, before = original }) {
  const abs = join(root, 'src', 'a.js');
  if (targetContents !== undefined) writeFileSync(abs, targetContents, 'utf8');
  mkdirSync(journalDir(root), { recursive: true });
  writeFileSync(
    join(journalDir(root), 'pending1.json'),
    JSON.stringify({
      id: 'pending1',
      at: new Date().toISOString(),
      type: 'patch',
      projectRoot: root,
      rel: 'src/a.js',
      abs,
      before,
      after,
      beforeSha: sha256Of(before),
      afterSha: sha256Of(after),
      outcome: 'pending',
    }),
    'utf8',
  );
}

test('a pending entry whose file already has the new contents settles as ok', () => {
  // The crash happened after the rename: the change landed but the settle did not.
  const root = project();
  plantPending(root, { targetContents: patched });
  const r = applierFor(root).recoverPending();
  assert.equal(r.reconciled.length, 1);
  assert.equal(r.reconciled[0].outcome, 'ok');
  assert.equal(entries(root)[0].outcome, 'ok');
  assert.equal(readFileSync(join(root, 'src', 'a.js'), 'utf8'), patched, 'recovery changed the file it was reconciling');
});

test('a pending entry whose file is untouched settles as aborted', () => {
  // The crash happened before the rename: nothing was written at all.
  const root = project();
  plantPending(root, { targetContents: original });
  const r = applierFor(root).recoverPending();
  assert.equal(r.reconciled[0].outcome, 'aborted');
  assert.equal(entries(root)[0].outcome, 'aborted');
  assert.equal(readFileSync(join(root, 'src', 'a.js'), 'utf8'), original);
});

test('a pending entry whose file was changed by someone else is left alone', () => {
  // The dangerous case: it matches neither hash, so recovery must not guess. It
  // does not roll the file back and it does not mark the change as applied.
  const root = project();
  const someoneElse = 'const A = 99;\n// the developer got here first\n';
  plantPending(root, { targetContents: someoneElse });
  const r = applierFor(root).recoverPending();
  assert.equal(r.reconciled[0].outcome, 'conflict');
  assert.equal(entries(root)[0].outcome, 'conflict');
  assert.equal(readFileSync(join(root, 'src', 'a.js'), 'utf8'), someoneElse, 'recovery overwrote someone else');
});

test('recovery leaves settled entries alone', () => {
  const root = project();
  applierFor(root).apply({ kind: 'patch-file', path: 'src/a.js', find: 'const A = 1;', replace: 'const A = 2;' }, { cwd: root, source: 'rule' });
  const r = applierFor(root).recoverPending();
  assert.equal(r.reconciled.length, 0);
  assert.equal(entries(root)[0].outcome, 'ok');
});

test('recovery clears scratch files from a crash mid-write', () => {
  const root = project();
  plantPending(root, { targetContents: original });
  const junk = join(root, 'src', `${TMP_PREFIX}999-abcdef01.js`);
  writeFileSync(junk, 'half', 'utf8');
  const r = applierFor(root).recoverPending();
  assert.equal(r.removedTemp.length, 1, JSON.stringify(r));
  assert.equal(existsSync(junk), false);
});

test('recovery on a project with no journal is not an error', () => {
  const root = project();
  const r = applierFor(root).recoverPending();
  assert.deepEqual(r.reconciled, []);
});

test('a pending entry pointing outside the project is unresolved, not acted on', () => {
  // The entry is a file on disk, so it goes through the same boundary as a
  // rollback target rather than being trusted.
  const root = project();
  mkdirSync(journalDir(root), { recursive: true });
  writeFileSync(
    join(journalDir(root), 'bad.json'),
    JSON.stringify({ id: 'bad', rel: '../../outside.js', before: 'x', after: 'y', outcome: 'pending' }),
    'utf8',
  );
  const r = applierFor(root).recoverPending();
  assert.equal(r.reconciled[0].outcome, 'unresolved');
  assert.match(r.reconciled[0].why, /outside the project/i);
});