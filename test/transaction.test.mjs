/**
 * A proposal is judged as a whole, so it is applied as a whole.
 *
 * Verification evaluates the entire proposed edit set at once. Applying it file
 * by file could leave the repository in a state that passed no check: three files
 * proposed, one written, two refused, and the result is a mixture. Recording that
 * outcome faithfully is not the same as avoiding it -- the record was accurate and
 * the repository was still wrong.
 *
 * So the write is two-phase. Preflight opens and validates every target through
 * the validated handle, checks the anchor, checks the preimage and syntax-checks
 * the result, writing nothing. Only if every file passes does anything get
 * written.
 *
 * The case that actually occurs is the cheap one: the model proposed a manifest
 * and two sources, the manifest is refused by the file-class policy, and with
 * preflight nothing needed undoing.
 *
 * What this is not: a durable transaction. A crash between two writes is still a
 * torn edit, and closing that needs atomic file replacement rather than anything
 * a method like this can do.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Applier } from '../src/act/apply.mjs';

/** Two ordinary sources plus one file the file-class policy protects. */
function project() {
  const root = mkdtempSync(join(tmpdir(), 'wd-tx-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.js'), 'const A = 1;\nmodule.exports = { A };\n', 'utf8');
  writeFileSync(join(root, 'src', 'b.js'), 'const B = 1;\nmodule.exports = { B };\n', 'utf8');
  writeFileSync(join(root, 'src', 'c.js'), 'const C = 1;\nmodule.exports = { C };\n', 'utf8');
  return root;
}

const applierFor = (root) =>
  new Applier({ projectRoot: root, dataDir: join(root, '.watchdog'), autonomy: 'autonomous', allowlist: [] });

const read = (root, p) => readFileSync(join(root, ...p.split('/')), 'utf8');

/* ------------------------------------------------------------------ *
 * The refusal case, which is the one that happens
 * ------------------------------------------------------------------ */

test('one refused file means nothing at all is written', async () => {
  const root = project();
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'on: push\n', 'utf8');

  const before = { a: read(root, 'src/a.js'), b: read(root, 'src/b.js'), c: read(root, 'src/c.js') };

  const tx = applierFor(root).applyAll(
    [
      { kind: 'patch-file', path: 'src/a.js', find: 'const A = 1;', replace: 'const A = 2;' },
      // A CI workflow: refused by the file-class policy for a model-proposed edit.
      { kind: 'patch-file', path: '.github/workflows/ci.yml', find: 'on: push', replace: 'on: pull_request' },
      { kind: 'patch-file', path: 'src/b.js', find: 'const B = 1;', replace: 'const B = 2;' },
    ],
    { cwd: root, source: 'llm' },
  );

  assert.equal(tx.written, 0, 'something was written despite a refusal');
  assert.notEqual(tx.status, 'all_applied');
  assert.equal(tx.results.filter((r) => r.status === 'refused').length, 1);
  assert.equal(tx.results.filter((r) => r.status === 'applied').length, 0);

  // The two permitted files are byte-identical to before.
  assert.equal(read(root, 'src/a.js'), before.a, 'src/a.js was written despite the refusal');
  assert.equal(read(root, 'src/b.js'), before.b, 'src/b.js was written despite the refusal');
  assert.equal(readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8'), 'on: push\n');
});

test('the refusal explains that a partial edit was avoided', () => {
  const root = project();
  const tx = applierFor(root).applyAll(
    [
      { kind: 'patch-file', path: 'src/a.js', find: 'const A = 1;', replace: 'const A = 2;' },
      { kind: 'patch-file', path: 'src/missing.js', find: 'x', replace: 'y' },
    ],
    { cwd: root, source: 'llm' },
  );
  assert.equal(tx.written, 0);
  const skipped = tx.results.filter((r) => r.status === 'skipped');
  // Both the file that failed and the one that was held back are reported: the
  // first for its own reason, the second because the transaction did not proceed.
  assert.equal(skipped.length, 2, JSON.stringify(tx.results));
  assert.ok(
    skipped.some((r) => /never verified/i.test(r.why ?? '')),
    'nothing says what the transaction was avoiding',
  );
  assert.match(skipped[0].why, /never verified/i, 'the reason does not say what the transaction was avoiding');
});

/* ------------------------------------------------------------------ *
 * The success case
 * ------------------------------------------------------------------ */

test('when every file passes, all of them are written', () => {
  const root = project();
  const tx = applierFor(root).applyAll(
    [
      { kind: 'patch-file', path: 'src/a.js', find: 'const A = 1;', replace: 'const A = 2;' },
      { kind: 'patch-file', path: 'src/b.js', find: 'const B = 1;', replace: 'const B = 2;' },
      { kind: 'patch-file', path: 'src/c.js', find: 'const C = 1;', replace: 'const C = 2;' },
    ],
    { cwd: root, source: 'llm' },
  );

  assert.equal(tx.status, 'all_applied');
  assert.equal(tx.written, 3);
  assert.equal(tx.results.length, 3);
  assert.match(read(root, 'src/a.js'), /A = 2/);
  assert.match(read(root, 'src/b.js'), /B = 2/);
  assert.match(read(root, 'src/c.js'), /C = 2/);
  assert.equal(applierFor(root).listJournal().filter((j) => j.outcome === 'ok').length, 3);
});

test('every applied file is journalled', () => {
  const root = project();
  const a = applierFor(root);
  const tx = a.applyAll(
    [
      { kind: 'patch-file', path: 'src/a.js', find: 'const A = 1;', replace: 'const A = 2;' },
      { kind: 'patch-file', path: 'src/b.js', find: 'const B = 1;', replace: 'const B = 2;' },
    ],
    { cwd: root, source: 'llm' },
  );
  assert.equal(tx.written, 2);
  assert.equal(a.listJournal().filter((j) => j.outcome === 'ok').length, 2);
});

/* ------------------------------------------------------------------ *
 * Each preflight failure blocks the whole set
 * ------------------------------------------------------------------ */

test('a missing anchor blocks every file', () => {
  const root = project();
  const before = read(root, 'src/a.js');
  const tx = applierFor(root).applyAll(
    [
      { kind: 'patch-file', path: 'src/a.js', find: 'const A = 1;', replace: 'const A = 2;' },
      { kind: 'patch-file', path: 'src/b.js', find: 'text that is not in b', replace: 'y' },
    ],
    { cwd: root, source: 'llm' },
  );
  assert.equal(tx.written, 0);
  assert.equal(read(root, 'src/a.js'), before);
});

test('an unparseable result blocks every file', () => {
  // The eval's real failure: replacing a bare identifier with a statement.
  const root = project();
  const tx = applierFor(root).applyAll(
    [
      { kind: 'patch-file', path: 'src/a.js', find: 'const A = 1;', replace: 'const A = 2;' },
      { kind: 'patch-file', path: 'src/b.js', find: 'const B = 1;', replace: 'const B = ;' },
    ],
    { cwd: root, source: 'llm' },
  );
  assert.equal(tx.written, 0);
  assert.ok(tx.results.some((r) => /unparseable/i.test(r.why ?? '')), JSON.stringify(tx.results));
});

test('a stale preimage blocks every file', () => {
  const root = project();
  const tx = applierFor(root).applyAll(
    [
      { kind: 'patch-file', path: 'src/a.js', find: 'const A = 1;', replace: 'const A = 2;', expectPreimage: 'deadbeef'.repeat(8) },
      { kind: 'patch-file', path: 'src/b.js', find: 'const B = 1;', replace: 'const B = 2;' },
    ],
    { cwd: root, source: 'llm' },
  );
  assert.equal(tx.written, 0);
  assert.equal(tx.results[0].status, 'stale');
  assert.match(read(root, 'src/b.js'), /B = 1/, 'the other file was written despite a stale preimage');
});

test('a command cannot be smuggled into a file transaction', () => {
  // A patch plus a shell command is not a thing that can be half-applied.
  const root = project();
  const tx = applierFor(root).applyAll(
    [
      { kind: 'patch-file', path: 'src/a.js', find: 'const A = 1;', replace: 'const A = 2;' },
      { kind: 'command', argv: ['node', '--version'] },
    ],
    { cwd: root, source: 'llm' },
  );
  assert.equal(tx.written, 0);
  assert.match(tx.results[1].why, /cannot include a command/i);
  assert.match(read(root, 'src/a.js'), /A = 1/);
});

/* ------------------------------------------------------------------ *
 * Bounds
 * ------------------------------------------------------------------ */

test('an oversized proposal is refused rather than applied in parts', () => {
  const root = project();
  const many = Array.from({ length: 30 }, (_, i) => ({
    kind: 'patch-file',
    path: 'src/a.js',
    find: 'const A = 1;',
    replace: `const A = ${i + 2};`,
  }));
  const tx = applierFor(root).applyAll(many, { cwd: root, source: 'llm' });
  assert.equal(tx.status, 'refused');
  assert.equal(tx.written, 0);
  assert.match(read(root, 'src/a.js'), /A = 1/);
});

test('an empty proposal is not a transaction', () => {
  const tx = applierFor(project()).applyAll([], { cwd: project() });
  assert.equal(tx.status, 'none');
  assert.equal(tx.written, 0);
});

test('a single-file transaction still works', () => {
  // The common case must not regress into refusing itself.
  const root = project();
  const tx = applierFor(root).applyAll(
    [{ kind: 'patch-file', path: 'src/a.js', find: 'const A = 1;', replace: 'const A = 2;' }],
    { cwd: root, source: 'llm' },
  );
  assert.equal(tx.status, 'all_applied');
  assert.match(read(root, 'src/a.js'), /A = 2/);
});

test('autonomy still gates a transaction, and gates it before anything is opened', () => {
  const root = project();
  const suggest = new Applier({
    projectRoot: root,
    dataDir: join(root, '.watchdog'),
    autonomy: 'suggest',
    allowlist: [],
  });
  const tx = suggest.applyAll(
    [{ kind: 'patch-file', path: 'src/a.js', find: 'const A = 1;', replace: 'const A = 2;' }],
    { cwd: root },
  );
  assert.equal(tx.written, 0);
  assert.match(read(root, 'src/a.js'), /A = 1/);
});