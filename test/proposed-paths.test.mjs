/**
 * Resolving the file paths a model proposes.
 *
 * The model never sees the file tree. It answers with a bare basename --
 * "tally.js" for a file that actually lives at "src/tally.js" -- and the fix was
 * then dropped because the path did not resolve. Measured on the sandbox corpus,
 * roughly half of all proposed fixes were lost purely to that.
 *
 * The rule is: improve a path only when the answer is unambiguous, and never
 * discard a proposal to do it. Dropping here would lose fixes whose target
 * legitimately does not exist yet, and the applier already refuses a path that is
 * not there.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProposedPath } from '../src/analyze/advisor.mjs';

const project = () => mkdtempSync(join(tmpdir(), 'wd-paths-'));

test('a path that already resolves is left exactly as it is', () => {
  const root = project();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'tally.js'), '', 'utf8');
  assert.equal(resolveProposedPath('src/tally.js', root), 'src/tally.js');
});

test('a bare basename is resolved when exactly one file has that name', () => {
  const root = project();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'tally.js'), '', 'utf8');
  assert.equal(resolveProposedPath('tally.js', root), 'src/tally.js');
});

test('an ambiguous basename is left alone rather than guessed', () => {
  // Two candidates means picking one would apply a plausible-looking edit to
  // whichever file happened to sort first. The applier refuses it, which is a
  // visible failure rather than a wrong-file edit.
  const root = project();
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'src', 'tally.js'), '', 'utf8');
  writeFileSync(join(root, 'lib', 'tally.js'), '', 'utf8');
  assert.equal(resolveProposedPath('tally.js', root), 'tally.js');
});

test('a name that matches nothing is left alone', () => {
  const root = project();
  writeFileSync(join(root, 'readme.md'), '', 'utf8');
  assert.equal(resolveProposedPath('brand-new.js', root), 'brand-new.js');
});

test('node_modules and dotfiles are never searched', () => {
  // A match inside node_modules is never the target, and there will always be a
  // package called something the model names.
  const root = project();
  mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), '', 'utf8');
  assert.equal(resolveProposedPath('index.js', root), 'index.js', 'a dependency file was treated as the target');

  const root2 = project();
  mkdirSync(join(root2, 'src'), { recursive: true });
  writeFileSync(join(root2, '.hidden.js'), '', 'utf8');
  assert.equal(resolveProposedPath('hidden.js', root2), 'hidden.js');
});

test('build output directories are skipped', () => {
  const root = project();
  for (const dir of ['dist', 'build']) {
    mkdirSync(join(root, dir, 'pkg'), { recursive: true });
    writeFileSync(join(root, dir, 'pkg', 'app.js'), '', 'utf8');
  }
  assert.equal(resolveProposedPath('app.js', root), 'app.js', 'a build artefact was treated as the source');
});

test('no working directory means no resolution at all', () => {
  assert.equal(resolveProposedPath('tally.js', undefined), 'tally.js');
});

test('the search is bounded and does not walk a deep tree', () => {
  const root = project();
  let dir = root;
  for (let i = 0; i < 12; i++) {
    dir = join(dir, `d${i}`);
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(dir, 'deep.js'), '', 'utf8');
  const started = Date.now();
  const r = resolveProposedPath('deep.js', root);
  assert.ok(Date.now() - started < 2000, 'the search is unbounded');
  // Whether it found it depends on the depth cap; what matters is that it returns
  // rather than hanging, and never returns something outside the project.
  assert.ok(r === 'deep.js' || r.endsWith('deep.js'), `unexpected result ${r}`);
});

test('resolution never returns a path outside the project', () => {
  const root = project();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.js'), '', 'utf8');
  for (const bad of ['../a.js', '../../a.js', 'src/../../a.js']) {
    const r = resolveProposedPath(bad, root);
    assert.ok(!r.startsWith('..'), `resolved ${bad} to an escaping path: ${r}`);
  }
});