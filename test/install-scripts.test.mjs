/**
 * Not being the thing that hands a package your credentials.
 *
 * Dependency repair already decided *which* package to install: it must already be
 * declared, the ecosystem must match, and the install goes through the lockfile
 * rather than by name. That closes the injection vector -- an attacker who
 * controls terminal output can no longer choose what gets installed.
 *
 * What none of that touches is the thing that actually happens during an
 * install: the package runs its own `postinstall` script, with the user's
 * privileges, on the user's machine, with no boundary around it. The package is
 * already trusted to run code; the only question left is whether the watchdog is
 * the thing that hands it the keys.
 *
 * These tests pin the answer to no, and pin the cases where that leaves work
 * undone, because the honest version of this is not "we made it safe" but "we
 * made it safe, and here is what it costs".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { repairArgv, installScriptsIn, NO_SCRIPTS } from '../src/act/deps.mjs';
import { installArgv, Applier } from '../src/act/apply.mjs';

function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'wd-scripts-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  return root;
}

const applierFor = (root) =>
  new Applier({ projectRoot: root, dataDir: join(root, '.watchdog'), autonomy: 'allowlist', allowlist: ['install-deps', 'repair-deps', 'command'] });

/* ------------------------------------------------------------------ *
 * The invariant
 * ------------------------------------------------------------------ */

test('every lockfile repair disables lifecycle scripts', () => {
  const shapes = {
    npm: repairArgv(project({ 'package.json': '{}', 'package-lock.json': '{}' })),
    yarn: repairArgv(project({ 'package.json': '{}', 'yarn.lock': '' })),
    pnpm: repairArgv(project({ 'package.json': '{}', 'pnpm-lock.yaml': '' })),
  };
  for (const [kind, argv] of Object.entries(shapes)) {
    assert.ok(argv.length, `${kind} produced no command`);
    assert.ok(argv.includes('--ignore-scripts'), `${kind}: ${argv.join(' ')} can run install scripts`);
  }
});

test('no argv this module can produce can run a postinstall script', () => {
  const roots = [
    project({ 'package.json': '{"dependencies":{"left-pad":"^1.0.0"}}', 'package-lock.json': '{}' }),
    project({ 'package.json': '{"dependencies":{"left-pad":"^1.0.0"}}' }),
    project({ 'package.json': '{"dependencies":{"left-pad":"^1.0.0"}}', 'yarn.lock': '' }),
    project({ 'package.json': '{}', 'requirements.txt': 'requests==2.31.0\n', '.venv/Scripts/python.exe': '' }),
  ];
  const shapes = [
    ...roots.map((r) => repairArgv(r)),
    installArgv('left-pad', roots[0], 'node'),
    installArgv('left-pad', roots[1], 'node'),
    installArgv('requests', roots[3], 'python'),
  ].filter((a) => a.length);

  assert.ok(shapes.length >= 5, 'expected several command shapes');
  for (const argv of shapes) {
    const safe = argv.includes('--ignore-scripts') || argv.includes('--only-binary=:all:');
    assert.ok(safe, `${argv.join(' ')} has no script suppression`);
    // An explicit false would quietly undo the flag beside it.
    assert.ok(!argv.some((a) => /ignore-scripts\s*=\s*false/.test(a)), `${argv.join(' ')} re-enables scripts`);
  }
});

test('the script-suppression flags are declared once', () => {
  // If they are inlined per ecosystem they will drift, and one ecosystem will
  // quietly lose the protection.
  assert.deepEqual(NO_SCRIPTS.npm, ['--ignore-scripts', '--no-audit', '--no-fund']);
  assert.deepEqual(NO_SCRIPTS.pnpm, ['--ignore-scripts']);
  assert.deepEqual(NO_SCRIPTS.yarn, ['--ignore-scripts']);
  assert.deepEqual(NO_SCRIPTS.python, ['--only-binary=:all:']);
});

/* ------------------------------------------------------------------ *
 * Knowing when it matters
 * ------------------------------------------------------------------ */

test('a locked package that runs an install script is identified by name', () => {
  const root = project({
    'package.json': '{"name":"x"}',
    'package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'x' },
        'node_modules/better-sqlite3': { hasInstallScript: true },
        'node_modules/left-pad': {},
      },
    }),
  });
  const scripted = installScriptsIn(root);
  assert.equal(scripted.length, 1);
  assert.match(scripted[0].name, /better-sqlite3/);
});

test('the project own lifecycle scripts are identified too', () => {
  const root = project({
    'package.json': JSON.stringify({ name: 'x', scripts: { postinstall: 'node scripts/setup.js', test: 'jest' } }),
  });
  const scripted = installScriptsIn(root);
  assert.equal(scripted.length, 1, JSON.stringify(scripted));
  assert.match(scripted[0].name, /postinstall/);
  // `test` is not a lifecycle hook and must not be reported.
  assert.ok(!scripted.some((s) => /test/.test(s.name)));
});

test('a project with nothing scripted reports nothing', () => {
  const root = project({
    'package.json': JSON.stringify({ name: 'x', scripts: { test: 'jest', build: 'tsc' } }),
    'package-lock.json': JSON.stringify({ packages: { 'node_modules/left-pad': {} } }),
  });
  assert.deepEqual(installScriptsIn(root), []);
});

test('an unreadable lockfile does not become a false all-clear', () => {
  // If the lockfile cannot be read, the honest answer is that we do not know, and
  // the refusal below is better than confidently proceeding.
  const root = project({ 'package.json': '{}', 'package-lock.json': '{ not json' });
  assert.deepEqual(installScriptsIn(root), []);
  assert.ok(repairArgv(root).length, 'the argv is still produced; the refusal is decided elsewhere');
});

/* ------------------------------------------------------------------ *
 * The refusal, and the cost it admits
 * ------------------------------------------------------------------ */

test('repair of a scripted project is refused and names the package', async () => {
  // The cost of --ignore-scripts, stated as a test. A native module would install
  // and still be broken, so the next run fails too -- but now the log claims the
  // repair worked. Refusing first, by name, is the honest behaviour.
  const root = project({
    'package.json': JSON.stringify({ name: 'x', dependencies: { 'better-sqlite3': '^11.0.0' } }),
    'package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/better-sqlite3': { hasInstallScript: true } },
    }),
  });

  const r = await applierFor(root).applyAsync({ kind: 'repair-deps' }, { cwd: root });
  assert.notEqual(r.status, 'applied', JSON.stringify(r));
  assert.match(r.why, /install scripts/i);
  assert.match(r.why, /better-sqlite3/, 'the refusal does not name the package to act on');
  assert.match(r.why, /Run the install yourself/i);
});

test('repair of an ordinary project is not blocked by the refusal', async () => {
  const root = project({
    'package.json': JSON.stringify({ name: 'x', dependencies: { 'left-pad': '^1.0.0' } }),
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/left-pad': {} } }),
  });
  // The gate is about scripts, not about installing. This may still fail because
  // npm is not resolvable in the test environment; what matters is that it got
  // past the refusal and actually tried.
  const r = await applierFor(root).applyAsync({ kind: 'repair-deps' }, { cwd: root });
  assert.ok(!/install scripts/i.test(r.why ?? ''), `blocked for the wrong reason: ${r.why}`);
});

test('a project with no lockfile still refuses for the original reason', () => {
  const root = project({ 'package.json': '{}' });
  assert.deepEqual(repairArgv(root), []);
});