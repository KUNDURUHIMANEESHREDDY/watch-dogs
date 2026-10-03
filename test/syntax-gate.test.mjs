/**
 * The syntax gate on applied patches.
 *
 * Found by the fix-quality eval, not by reasoning. The model proposed replacing
 * the bare identifier `count` with `let count = 0;`. The anchor was present, so
 * every existing check passed, the patch applied, and the result was a file that
 * does not parse. In autonomous mode that is the watchdog breaking the user's
 * source while reporting success.
 *
 * "The find string was present" is not evidence that "the result is code".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Applier } from '../src/act/apply.mjs';

const project = () => mkdtempSync(join(tmpdir(), 'wd-syntax-'));

function applierFor(root) {
  return new Applier({
    projectRoot: root,
    dataDir: join(root, '.watchdog'),
    autonomy: 'autonomous',
    allowlist: [],
  });
}

const good = 'function tally(items) {\n  return count / items.length;\n}\n';

test('an edit that would not parse is refused and the file is untouched', () => {
  const root = project();
  mkdirSync(join(root, 'src'), { recursive: true });
  const target = join(root, 'src', 'tally.js');
  writeFileSync(target, good, 'utf8');

  const a = applierFor(root);
  const r = a.apply(
    { kind: 'patch-file', path: 'src/tally.js', find: 'count', replace: 'let count = 0;' },
    { cwd: root },
  );

  assert.equal(r.status, 'skipped', JSON.stringify(r));
  assert.match(r.why, /unparseable|not applied/i);
  assert.equal(readFileSync(target, 'utf8'), good, 'the file was modified despite the refusal');
});

test('a valid edit is still applied', () => {
  const root = project();
  mkdirSync(join(root, 'src'), { recursive: true });
  const target = join(root, 'src', 'tally.js');
  writeFileSync(target, good, 'utf8');

  const a = applierFor(root);
  const r = a.apply(
    { kind: 'patch-file', path: 'src/tally.js', find: 'count /', replace: 'items.length /' },
    { cwd: root },
  );

  assert.equal(r.status, 'applied', JSON.stringify(r));
  assert.match(readFileSync(target, 'utf8'), /items\.length \//);
});

test('files that are not javascript are never blocked by the gate', () => {
  // Refusing everything we cannot verify would block every TypeScript, markdown,
  // json and config edit, which would make the guard useless in practice.
  const cases = [
    ['notes.md', '# title\nsome prose\n', 'prose', 'text'],
    ['config.json', '{"a":1}\n', '"a"', '"b"'],
    ['types.ts', 'export const alpha: number = 1;\n', 'alpha', 'beta'],
  ];
  for (const [name, body, find, replace] of cases) {
    const root = project();
    writeFileSync(join(root, name), body, 'utf8');
    const a = applierFor(root);
    const r = a.apply({ kind: 'patch-file', path: name, find, replace }, { cwd: root });
    assert.equal(r.status, 'applied', `${name} was blocked: ${JSON.stringify(r)}`);
  }
});

test('the refusal leaves nothing journalled as applied', () => {
  const root = project();
  writeFileSync(join(root, 'a.js'), good, 'utf8');
  const a = applierFor(root);
  a.apply({ kind: 'patch-file', path: 'a.js', find: 'count', replace: 'let count = 0;' }, { cwd: root });
  const applied = a.listJournal().filter((j) => j.outcome === 'ok');
  assert.equal(applied.length, 0, 'an unparseable edit was journalled as applied');
});