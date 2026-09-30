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
import { Applier } from '../src/act/apply.mjs';
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

test('repair uses the lockfile, never bare npm install', () => {
  assert.deepEqual(repairArgv(project({ 'package.json': '{}', 'package-lock.json': '{}' })), ['npm', 'ci']);
  assert.deepEqual(repairArgv(project({ 'package.json': '{}', 'yarn.lock': '' })), ['yarn', 'install', '--frozen-lockfile']);
  assert.deepEqual(repairArgv(project({ 'package.json': '{}', 'pnpm-lock.yaml': '' })), ['pnpm', 'install', '--frozen-lockfile']);
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
