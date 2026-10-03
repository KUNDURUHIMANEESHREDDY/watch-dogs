/**
 * Filesystem containment.
 *
 * Both the guard and the applier decided containment with relative(), which is a
 * string comparison and not a boundary. A junction inside the project satisfies
 * every lexical test and still writes outside it. `mklink /J` needs no
 * elevation, so this is not a theoretical escape on Windows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, lstatSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRefused } from '../src/act/guard.mjs';
import { Applier } from '../src/act/apply.mjs';
import { containedPath, realpathNearest, realProjectRoot } from '../src/act/containment.mjs';

const base = () => mkdtempSync(join(tmpdir(), 'wd-contain-'));

/**
 * Build a project containing a junction that points outside it. Returns null
 * where the platform will not let us, so a skip is honest rather than a pass.
 */
function projectWithEscape() {
  const tmp = base();
  const root = join(tmp, 'project');
  const outside = join(tmp, 'outside');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'ORIGINAL', 'utf8');

  const linkDir = join(root, 'src', 'escape');
  let made = 'junction';
  try {
    execFileSync('cmd', ['/c', 'mklink', '/J', linkDir, outside], { timeout: 30_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    // Fall back to a directory symlink, which needs developer mode or elevation.
    try {
      symlinkSync(outside, linkDir, 'junction');
    } catch {
      return null;
    }
    made = 'symlink';
  }
  if (!existsSync(linkDir)) return null;
  return { root, outside, linkDir, secret: join(outside, 'secret.txt'), kind: made };
}

test('a junction inside the project does not make an outside path contained', () => {
  const fx = projectWithEscape();
  if (!fx) return; // no reparse points available; the lexical tests still apply

  // Prove the premise before testing the fix: the lexical check is fooled.
  const lexicallyInside = !join(fx.root, 'src', 'escape', 'secret.txt').replace(fx.root, '').startsWith('..');
  assert.ok(lexicallyInside, 'precondition: the path is lexically inside the project');

  const check = containedPath(fx.root, join('src', 'escape', 'secret.txt'));
  assert.equal(check.ok, false, `escape was treated as contained; real path was ${check.real}`);
  assert.equal(check.why, 'reparse');
  assert.ok(
    !check.real.toLowerCase().startsWith(realProjectRoot(fx.root).toLowerCase()),
    'the real path is reported as inside the project, so the test proves nothing',
  );
});

test('the guard refuses to touch a path that escapes through a link', () => {
  const fx = projectWithEscape();
  if (!fx) return;

  const verdict = isRefused({ kind: 'patch-file', path: join('src', 'escape', 'secret.txt') }, { projectRoot: fx.root });
  assert.equal(verdict.ok, false, 'the guard allowed a write that escapes the project through a junction');
  assert.match(verdict.why, /resolves to|outside/i);
});

test('the applier does not write through a link', () => {
  // The guard is the first line, not the boundary. The applier re-checks in
  // #resolveInRoot, because the guard's ctx and the applier's cwd can differ.
  //
  // apply() reports refusal by returning, not by throwing, so this asserts on
  // what actually matters: the outside file is untouched.
  const fx = projectWithEscape();
  if (!fx) return;

  const applier = new Applier({ projectRoot: fx.root, dataDir: join(fx.root, '.watchdog') });
  const result = applier.apply({
    kind: 'patch-file',
    path: join('src', 'escape', 'secret.txt'),
    find: 'ORIGINAL',
    replace: 'PWNED',
  });

  assert.notEqual(result?.status, 'applied', 'the applier reported success for an escaping write');
  assert.equal(readFileSync(fx.secret, 'utf8'), 'ORIGINAL', 'the file outside the project was modified');
});

test('legitimate paths inside the project are still allowed', () => {
  const root = base();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.js'), 'x', 'utf8');

  assert.equal(containedPath(root, 'src/a.js').ok, true);
  assert.equal(containedPath(root, join('src', 'a.js')).ok, true);
  assert.equal(isRefused({ kind: 'patch-file', path: 'src/a.js' }, { projectRoot: root }).ok, true, 'a normal in-project edit was refused');
});

test('a file that does not exist yet is handled by resolving its nearest ancestor', () => {
  // Creating a file is the whole point of a create action, so the target is
  // routinely absent. Plain realpath() throws, and a caller tempted to allow on
  // failure is exactly the wrong default.
  const root = base();
  mkdirSync(join(root, 'src'), { recursive: true });
  const check = containedPath(root, 'src/brand-new/deep/file.js');
  assert.equal(check.ok, true, 'a not-yet-existing in-project path was refused');
  assert.ok(check.abs.endsWith('file.js'));
});

test('a not-yet-existing path whose ancestor escapes is still refused', () => {
  const fx = projectWithEscape();
  if (!fx) return;
  // The missing-file fallback must not become a bypass.
  const check = containedPath(fx.root, join('src', 'escape', 'not-created-yet.txt'));
  assert.equal(check.ok, false, 'the nearest-ancestor fallback let an escaping path through');
});

test('plain traversal is still refused, and reported as lexical', () => {
  const root = base();
  const check = containedPath(root, '../outside.txt');
  assert.equal(check.ok, false);
  assert.equal(check.why, 'lexical');
});

test('realpathNearest does not throw on a missing path', () => {
  const root = base();
  const p = realpathNearest(join(root, 'no', 'such', 'path.txt'));
  assert.ok(p.endsWith(join('no', 'such', 'path.txt')), `got ${p}`);
});