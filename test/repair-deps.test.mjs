/**
 * `repair-deps` closes a real bypass: the `npm-install-failed` rule used to emit
 * a raw `command` action running `npm install`, which skipped BOTH the
 * declared-dependency allowlist and the lockfile-honouring repair. So a failed
 * install anywhere would autonomously re-resolve every dependency.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Applier, installArgv } from '../src/act/apply.mjs';
import { repairArgv } from '../src/act/deps.mjs';
import { evaluate } from '../src/analyze/rules.mjs';

function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'wd-repair-'));
  for (const [name, content] of Object.entries(files)) {
    const p = join(root, name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  mkdirSync(join(root, '.watchdog'), { recursive: true });
  return root;
}

const applierFor = (root) => new Applier({ projectRoot: root, dataDir: join(root, '.watchdog'), autonomy: 'autonomous' });

test('the npm-install-failed rule no longer emits a raw command', () => {
  const f = evaluate('npm ERR! code ELIFECYCLE')[0];
  assert.equal(f.ruleId, 'npm-install-failed');
  assert.equal(f.fix.kind, 'repair-deps', 'a raw command here would bypass both guards');
  assert.equal(f.fix.argv, undefined, 'no bare npm install argv may be embedded');
});

test('repair uses the lockfile and never bare npm install', () => {
  // The trailing flags matter as much as the verb: `npm ci` alone executes every
  // postinstall script in the tree with the user's privileges.
  assert.deepEqual(repairArgv(project({ 'package.json': '{}', 'package-lock.json': '{}' })), [
    'npm',
    'ci',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ]);
  assert.deepEqual(repairArgv(project({ 'package.json': '{}', 'yarn.lock': '' })), [
    'yarn',
    'install',
    '--frozen-lockfile',
    '--ignore-scripts',
  ]);
  assert.deepEqual(repairArgv(project({ 'package.json': '{}', 'pnpm-lock.yaml': '' })), [
    'pnpm',
    'install',
    '--frozen-lockfile',
    '--ignore-scripts',
  ]);
});

test('no generated install can run a lifecycle script', () => {
  // The invariant, asserted across every shape the argv builders can produce.
  // A future flag added to one ecosystem and forgotten in another would otherwise
  // silently reopen the vector.
  const shapes = [
    repairArgv(project({ 'package.json': '{}', 'package-lock.json': '{}' })),
    repairArgv(project({ 'package.json': '{}', 'yarn.lock': '' })),
    repairArgv(project({ 'package.json': '{}', 'pnpm-lock.yaml': '' })),
    installArgv('left-pad', project({ 'package.json': '{"dependencies":{"left-pad":"^1.0.0"}}', 'package-lock.json': '{}' }), 'node'),
    installArgv('left-pad', project({ 'package.json': '{"dependencies":{"left-pad":"^1.0.0"}}' }), 'node'),
  ];
  for (const argv of shapes) {
    assert.ok(argv.length, 'shape produced no command at all');
    assert.ok(
      argv.includes('--ignore-scripts') || argv.includes('--only-binary=:all:'),
      `${argv.join(' ')} can run install scripts`,
    );
    assert.ok(!argv.includes('--ignore-scripts=false'), `${argv.join(' ')} re-enables scripts explicitly`);
  }
});

test('python installs refuse to build from source, since pip has no ignore-scripts', () => {
  const root = project({
    'package.json': '{}',
    'requirements.txt': 'requests==2.31.0\n',
    '.venv/Scripts/python.exe': '',
  });
  const argv = installArgv('requests', root, 'python');
  assert.ok(argv.includes('--only-binary=:all:'), `expected a wheels-only install, got ${argv.join(' ')}`);
});

test('python install no longer passes the venv interpreter as an absolute path', () => {
  // Regression from the typed command policy: it refuses absolute executables on
  // purpose, so an absolute path here meant every Python install was refused.
  const root = project({
    'package.json': '{}',
    'requirements.txt': 'requests==2.31.0\n',
    '.venv/Scripts/python.exe': '',
  });
  const argv = installArgv('requests', root, 'python');
  assert.ok(argv.length, 'expected a command');
  assert.ok(!argv[0].includes('/') && !argv[0].includes('\\'), `${argv[0]} is a path`);
  assert.equal(argv[0], 'python');
});

test('repair refuses when there is no lockfile', () => {
  assert.deepEqual(repairArgv(project({ 'package.json': '{}' })), []);
  const root = project({ 'package.json': '{}' });
  return applierFor(root)
    .applyAsync({ kind: 'repair-deps' }, { cwd: root })
    .then((r) => {
      assert.equal(r.status, 'skipped');
      assert.match(r.why, /no lockfile/);
    });
});

test('the refusal explains why re-resolving is unsafe', async () => {
  const root = project({ 'package.json': '{}' });
  const r = await applierFor(root).applyAsync({ kind: 'repair-deps' }, { cwd: root });
  assert.match(r.why, /re-resolve/);
  assert.match(r.why, /lockfile/);
});

test('repair is serialised with other commands, not run on the event loop', () => {
  const root = project({ 'package.json': '{}', 'package-lock.json': '{}' });
  const a = applierFor(root);
  // The sync entry point must refuse rather than block.
  assert.equal(a.apply({ kind: 'repair-deps' }, { cwd: root }).status, 'deferred');
});

test('no rule can emit a raw command action any more', () => {
  // This is the invariant that closes the bypass class, not just this one rule.
  for (const line of [
    "Cannot find module 'x'",
    "ModuleNotFoundError: No module named 'y'",
    'npm ERR! code E404',
  ]) {
    for (const f of evaluate(line)) {
      if (!f.fix) continue;
      assert.notEqual(f.fix.kind, 'command', `${f.ruleId} still emits a raw command: ${JSON.stringify(f.fix)}`);
    }
  }
});
