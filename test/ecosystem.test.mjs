/**
 * Ecosystem routing for dependency installs.
 *
 * installArgv() checked for a Node lockfile and package.json before it ever
 * looked at Python. In a project containing both -- common, because a repo with
 * a frontend and a script directory has both -- a
 *
 *   ModuleNotFoundError: No module named 'requests'
 *
 * produced `npm install requests`. The npm registry really does host a package
 * by that name, unrelated to the Python one, so the allowlist passed and the
 * watchdog autonomously installed a different package than the one that failed.
 * A cross-ecosystem supply-chain bug, reached with no attacker at all.
 *
 * These assert on the constructed argv rather than on a real install: running
 * pip or npm in a test suite is not something a test should do, and the routing
 * decision is invisible otherwise.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installArgv } from '../src/act/apply.mjs';
import { isDeclared, declaredPackages } from '../src/act/deps.mjs';
import { evaluate } from '../src/analyze/rules.mjs';

const project = (files) => {
  const root = mkdtempSync(join(tmpdir(), 'wd-eco-'));
  for (const [name, body] of Object.entries(files)) {
    const p = join(root, name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }
  return root;
};

const venvPython = (root) => {
  const exe = process.platform === 'win32' ? join(root, '.venv', 'Scripts', 'python.exe') : join(root, '.venv', 'bin', 'python');
  mkdirSync(join(exe, '..'), { recursive: true });
  writeFileSync(exe, '');
  return exe;
};

/**
 * The collision case: the same name declared in BOTH ecosystems.
 *
 * Without a venv, both old and new code refuse, so the test could not tell them
 * apart. With one, the old code ran npm and the new code runs pip -- and the two
 * are different packages that happen to share a name.
 */
const COLLIDING = () =>
  project({
    'package.json': JSON.stringify({ name: 'app', dependencies: { requests: '0.0.1' } }),
    'package-lock.json': JSON.stringify({ name: 'app', lockfileVersion: 3, packages: {} }),
    'requirements.txt': 'requests>=2.31.0\n',
  });

test('a Python error routes to pip even when npm could install the same name', () => {
  const root = COLLIDING();
  venvPython(root);
  const argv = installArgv('requests', root, 'python');
  assert.ok(argv.length > 0, 'expected a python install to be constructed');
  const joined = argv.join(' ').toLowerCase();
  assert.ok(joined.includes('pip'), `expected pip, got: ${argv.join(' ')}`);
  assert.ok(!joined.includes('npm'), `routed a Python error to npm: ${argv.join(' ')}`);
  assert.ok(!joined.includes('pnpm') && !joined.includes('yarn'), `routed to a node manager: ${argv.join(' ')}`);
});

test('a Node error still routes to npm in the same project', () => {
  // The fix must not break the common path, in the very project that caused the bug.
  const root = COLLIDING();
  venvPython(root);
  const argv = installArgv('requests', root, 'node');
  const joined = argv.join(' ').toLowerCase();
  assert.ok(joined.includes('npm') || joined.includes('ci'), `expected a node manager, got: ${argv.join(' ')}`);
});

test('a package declared only in Python does not authorise an npm install', () => {
  // The allowlist half of the bug: union declarations let requirements.txt
  // authorise an install from the npm registry.
  const root = project({
    'package.json': JSON.stringify({ name: 'app', dependencies: { leftPad: '1.3.0' } }),
    'requirements.txt': 'requests>=2.31.0\n',
  });
  assert.equal(isDeclared(root, 'requests', 'python'), true, 'it should be declared for python');
  assert.equal(isDeclared(root, 'requests', 'node'), false, 'it must not be declared for node');
  assert.deepEqual(installArgv('requests', root, 'node'), [], 'a python-only name reached the node path');
});

test('the allowlist union is still available for "has this project heard of it"', () => {
  const root = COLLIDING();
  const union = declaredPackages(root);
  assert.ok(union.has('requests'), 'the union should still see the python declaration');
  assert.ok(union.has('requests'), 'and the node one');
});

test('an unknown or missing ecosystem constructs nothing', () => {
  const root = COLLIDING();
  venvPython(root);
  for (const eco of [undefined, null, '', 'rust', 'PYTHON']) {
    assert.deepEqual(installArgv('requests', root, eco), [], `ecosystem ${JSON.stringify(eco)} produced an install`);
  }
});

test('python without a project venv constructs nothing', () => {
  // A global pip install mutates the interpreter rather than the project.
  const root = COLLIDING();
  assert.deepEqual(installArgv('requests', root, 'python'), [], 'constructed a global pip install');
});

test('both rules that emit install-deps declare their ecosystem', () => {
  // A new install-deps rule without the field would be refused at runtime, which
  // is the safe failure but still a regression in usefulness.
  const node = evaluate("Cannot find module 'left-pad'", { sessionId: 's', cwd: process.cwd() });
  assert.equal(node[0]?.fix?.ecosystem, 'node', 'node-module-missing must declare node');

  const py = evaluate("ModuleNotFoundError: No module named 'requests'", { sessionId: 's', cwd: process.cwd() });
  assert.equal(py[0]?.fix?.ecosystem, 'python', 'python-modulenotfound must declare python');
});