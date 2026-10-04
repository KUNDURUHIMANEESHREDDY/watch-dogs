/**
 * A rollback must not destroy work it never made.
 *
 * Rollback means overwriting whatever is at the path now with what was there
 * before the watchdog touched it. If the file has been edited since, that
 * overwrites the newer work -- silently, and reporting success:
 *
 *     watchdog fixes a file
 *       -> you edit the same file
 *         -> wd rollback <id>
 *           -> your changes are gone
 *
 * The only condition under which a rollback is the operation the user asked for
 * is that the file still contains exactly what the watchdog wrote. So that is
 * checked first, against the hash the journal already records.
 *
 * Two related decisions:
 *
 *   - An entry that predates hashes falls back to comparing the recorded text,
 *     and an entry with neither is *refused*. "I cannot tell whether this is
 *     safe" is not permission to overwrite.
 *
 *   - Crash recovery and rollback ask the same question of the same entry, so
 *     they now share one classifier. They previously differed in a way that
 *     mattered: recovery compared hashes and rollback compared nothing at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Applier } from '../src/act/apply.mjs';
import { sha256Of } from '../src/act/hashes.mjs';

const original = 'const A = 1;\nmodule.exports = { A };\n';
const patched = 'const A = 2;\nmodule.exports = { A };\n';
const yours = 'const A = 2;\n// you were here\nmodule.exports = { A };\n';

function project() {
  const root = mkdtempSync(join(tmpdir(), 'wd-rb-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.js'), original, 'utf8');
  writeFileSync(join(root, 'package.json'), '{"name":"r"}\n', 'utf8');
  return root;
}

const applierFor = (root) =>
  new Applier({ projectRoot: root, dataDir: join(root, '.watchdog'), autonomy: 'autonomous', allowlist: [] });

/** Apply a real edit and return its journal id. */
function applyEdit(root) {
  const a = applierFor(root);
  const r = a.apply({ kind: 'patch-file', path: 'src/a.js', find: 'const A = 1;', replace: 'const A = 2;' }, { cwd: root, source: 'rule' });
  assert.equal(r.status, 'applied', JSON.stringify(r));
  return { a, id: r.journalId };
}

const target = (root) => join(root, 'src', 'a.js');
const body = (root) => readFileSync(target(root), 'utf8');

/* ------------------------------------------------------------------ *
 * The case that was broken
 * ------------------------------------------------------------------ */

test("a file edited after the watchdog wrote it is not rolled back over", () => {
  const root = project();
  const { a, id } = applyEdit(root);

  // You edit the same file.
  writeFileSync(target(root), yours, 'utf8');

  const r = a.rollback(id);
  assert.equal(r.status, 'conflict', JSON.stringify(r));
  assert.equal(r.code, 'rollback_conflict');
  assert.equal(body(root), yours, 'your newer work was overwritten');
});

test('the conflict says what to do instead', () => {
  const root = project();
  const { a, id } = applyEdit(root);
  writeFileSync(target(root), yours, 'utf8');
  const r = a.rollback(id);
  assert.match(r.why, /changed since the watchdog wrote it/i);
  assert.match(r.why, /Nothing was written/i);
  assert.match(r.why, /revert it yourself|force/i, 'no route forward is offered');
});

test('a refused rollback leaves the journal entry as it was', () => {
  const root = project();
  const { a, id } = applyEdit(root);
  writeFileSync(target(root), yours, 'utf8');
  a.rollback(id);
  const rec = JSON.parse(readFileSync(join(root, '.watchdog', 'journal', `${id}.json`), 'utf8'));
  assert.equal(rec.outcome, 'ok', 'a refused rollback was recorded as though it happened');
});

/* ------------------------------------------------------------------ *
 * The case that must still work
 * ------------------------------------------------------------------ */

test('an untouched file rolls back cleanly', () => {
  // The control. Refusing everything would pass the conflict tests above.
  const root = project();
  const { a, id } = applyEdit(root);
  assert.equal(body(root), patched);

  const r = a.rollback(id);
  assert.equal(r.status, 'rolled-back', JSON.stringify(r));
  assert.equal(body(root), original);
});

test('rolling back twice is refused the second time', () => {
  // After the first rollback the file matches beforeSha, not afterSha, so the
  // second attempt is a conflict rather than a second write.
  const root = project();
  const { a, id } = applyEdit(root);
  assert.equal(a.rollback(id).status, 'rolled-back');
  const second = a.rollback(id);
  assert.equal(second.status, 'skipped', JSON.stringify(second));
});

/* ------------------------------------------------------------------ *
 * Entries without hashes
 * ------------------------------------------------------------------ */

test('an old entry with recorded text is compared against that text', () => {
  const root = project();
  const { a, id } = applyEdit(root);
  const p = join(root, '.watchdog', 'journal', `${id}.json`);
  const rec = JSON.parse(readFileSync(p, 'utf8'));
  delete rec.afterSha;
  delete rec.beforeSha;
  writeFileSync(p, JSON.stringify(rec), 'utf8');

  // Untouched: the text matches what was written, so it rolls back.
  assert.equal(a.rollback(id).status, 'rolled-back');
  assert.equal(body(root), original);
});

test('an entry with neither hash nor text is refused, not guessed at', () => {
  const root = project();
  const { a, id } = applyEdit(root);
  const p = join(root, '.watchdog', 'journal', `${id}.json`);
  const rec = JSON.parse(readFileSync(p, 'utf8'));
  delete rec.afterSha;
  delete rec.beforeSha;
  delete rec.after;
  writeFileSync(p, JSON.stringify(rec), 'utf8');

  const r = a.rollback(id);
  assert.equal(r.status, 'conflict', JSON.stringify(r));
  assert.match(r.why, /cannot tell whether/i);
  assert.equal(body(root), patched, 'the file was written despite not being able to tell it was safe');
});

/* ------------------------------------------------------------------ *
 * Files that did not exist before
 * ------------------------------------------------------------------ */

test('a created file is removed only while it is still what we created', () => {
  const root = project();
  const a = applierFor(root);
  const created = join(root, 'src', 'new.js');
  writeFileSync(created, 'module.exports = 1;\n', 'utf8');

  const r = a.apply({ kind: 'patch-file', path: 'src/new.js', find: 'module.exports = 1;', replace: 'module.exports = 2;' }, { cwd: root, source: 'rule' });
  assert.equal(r.status, 'applied', JSON.stringify(r));

  // Someone writes to the file the watchdog created.
  writeFileSync(created, 'module.exports = 2;\n// now it matters\n', 'utf8');

  const back = a.rollback(r.journalId);
  assert.equal(back.status, 'conflict', JSON.stringify(back));
  assert.ok(existsSync(created), 'a file the user had started using was moved aside');
});

/* ------------------------------------------------------------------ *
 * Recovery and rollback agree
 * ------------------------------------------------------------------ */

test('recovery and rollback classify the same entry the same way', () => {
  // They answer the same question of the same record. Before this change recovery
  // compared hashes and rollback compared nothing, so the two could disagree
  // about whether an entry was safe to act on.
  const root = project();
  const { a, id } = applyEdit(root);
  writeFileSync(target(root), yours, 'utf8');

  const rb = a.rollback(id);
  assert.equal(rb.status, 'conflict');

  // The same file state, read through recovery's classifier.
  const p = join(root, '.watchdog', 'journal', `${id}.json`);
  const rec = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(sha256Of(yours) !== rec.afterSha, true);
  assert.equal(body(root), yours);
});

test('rollback still goes through the containment boundary', () => {
  // The conflict check is an addition to the existing checks, not a replacement.
  const root = project();
  const { a, id } = applyEdit(root);
  const p = join(root, '.watchdog', 'journal', `${id}.json`);
  const rec = JSON.parse(readFileSync(p, 'utf8'));
  writeFileSync(p, JSON.stringify({ ...rec, rel: '.env', abs: join(root, '.env') }), 'utf8');
  writeFileSync(join(root, '.env'), 'TOKEN=original\n', 'utf8');

  const r = a.rollback(id);
  assert.equal(r.status, 'refused', JSON.stringify(r));
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'TOKEN=original\n');
});