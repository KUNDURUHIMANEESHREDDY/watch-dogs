/**
 * Dependency repair is not autonomous, and the reason is the undo.
 *
 * An audit asked for "an isolated dependency-install execution environment" and
 * treated its absence as a blocker. That framing does not survive contact with the
 * code:
 *
 *   - repairArgv is `npm ci --ignore-scripts`, not `npm install`. `ci` reproduces the
 *     lockfile; it does not resolve, so it cannot pull a version the project did not
 *     already pin.
 *   - Every install carries `--ignore-scripts` (or `--only-binary=:all:` for Python),
 *     so no third-party code runs. "Package installation is inherently code
 *     execution" is not true of this path.
 *
 * What is actually left is worse than the objection it replaces. `npm ci` deletes
 * node_modules and rebuilds it -- the widest change this program makes -- and a
 * command is journalled as unreversible, so `wd rollback` refuses it by design.
 * Every other autonomous action records a preimage and can be put back.
 *
 * So dependency actions are refused under `autonomous` and permitted under
 * `allowlist`, where the user names the kind. Consent already existed; it just did
 * not apply here, and the loosest tier was implying the tighter ones.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Applier } from '../src/act/apply.mjs';
import { REFUSAL } from '../src/act/guard.mjs';
import { repairArgv, NO_SCRIPTS } from '../src/act/deps.mjs';

function project() {
  const root = mkdtempSync(join(tmpdir(), 'wd-irrev-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'p', dependencies: { left: 'pad' } }, null, 2), 'utf8');
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({ name: 'p', lockfileVersion: 3, requires: true, packages: {} }, null, 2),
    'utf8',
  );
  writeFileSync(join(root, 'src', 'a.js'), 'const A = 1;\nmodule.exports = { A };\n', 'utf8');
  return root;
}

const forAutonomy = (root, autonomy, allowlist = []) =>
  new Applier({ projectRoot: root, dataDir: join(root, '.watchdog'), autonomy, allowlist });

test('the premise: an autonomous repair carries no undo', async () => {
  // Stated as a test because the refusal below rests entirely on it. If a dependency
  // action ever becomes reversible, this fails and the refusal should be revisited.
  const root = project();
  const a = forAutonomy(root, 'autonomous');

  const r = await a.applyAsync({ kind: 'repair-deps' }, { cwd: root, source: 'rule' });

  // It must not have run, so nothing may be journalled as applied.
  assert.equal(r.status, 'refused');
  assert.equal(
    a.listJournal().filter((j) => j.outcome === 'ok').length,
    0,
    'a repair was journalled as having succeeded',
  );

  // And the rollback path says so in its own words.
  const rec = a.listJournal().find((j) => j.type === 'command');
  assert.ok(rec, 'the refusal was not journalled');
  assert.match(rec.detail ?? '', /irreversible_without_opt_in/);
});

test('dependency repair is refused under autonomous, naming the real reason', async () => {
  const root = project();
  const r = await forAutonomy(root, 'autonomous').applyAsync({ kind: 'repair-deps' }, { cwd: root, source: 'rule' });

  assert.equal(r.status, 'refused');
  assert.equal(r.code, REFUSAL.IRREVERSIBLE);

  // The message must not blame script execution. It does not happen here, and saying
  // it does would teach the reader the wrong model of their own risk.
  assert.doesNotMatch(r.why, /postinstall|install script/i, 'the refusal blames a risk that --ignore-scripts removes');
  assert.match(r.why, /no undo/i, 'the refusal does not say why it is refused');
  assert.match(r.why, /wd rollback/i, 'and does not point at the thing that cannot undo it');
  assert.ok(r.examples?.length, 'and offers no way forward');
});

test('installing a single declared package is refused under autonomous too', async () => {
  const root = project();
  const r = await forAutonomy(root, 'autonomous').applyAsync(
    { kind: 'install-deps', package: 'left-pad', ecosystem: 'node' },
    { cwd: root, source: 'rule' },
  );

  assert.equal(r.status, 'refused');
  assert.equal(r.code, REFUSAL.IRREVERSIBLE);
});

test('allowlist mode permits it once the user names the kind', async () => {
  // Consent must be reachable, or the refusal is just a removal. `allowlist` requires
  // the kind to be listed by name, which is stricter than confirming a prompt: it is a
  // standing decision recorded in config.
  const root = project();
  const a = forAutonomy(root, 'allowlist', ['repair-deps']);

  const r = await a.applyAsync({ kind: 'repair-deps' }, { cwd: root, source: 'rule' });

  assert.notEqual(r.code, REFUSAL.IRREVERSIBLE, 'naming the kind did not permit the action');
});

test('allowlist mode still refuses a kind that was not named', async () => {
  const root = project();
  const r = await forAutonomy(root, 'allowlist', ['patch-file']).applyAsync(
    { kind: 'repair-deps' },
    { cwd: root, source: 'rule' },
  );

  assert.equal(r.status, 'suggested');
  assert.match(r.why, /not on the allowlist/);
});

test('suggest mode is unaffected', async () => {
  const root = project();
  const r = await forAutonomy(root, 'suggest').applyAsync({ kind: 'repair-deps' }, { cwd: root, source: 'rule' });

  assert.equal(r.status, 'suggested');
  assert.match(r.why, /"suggest"/);
});

test('an ordinary shell command is still permitted under autonomous', async () => {
  // The refusal must be narrow. If it caught every command, the product would refuse
  // all work in its most permissive mode and the boundary would mean nothing.
  const root = project();
  const r = await forAutonomy(root, 'autonomous').applyAsync(
    { kind: 'command', argv: ['node', '--version'] },
    { cwd: root, source: 'rule' },
  );

  assert.notEqual(r.code, REFUSAL.IRREVERSIBLE);
  assert.notEqual(r.status, 'refused', 'a permitted command was refused under autonomous');
});

test('a refused autonomous repair is journalled, so the attempt is visible', async () => {
  const root = project();
  const a = forAutonomy(root, 'autonomous');

  await a.applyAsync({ kind: 'repair-deps' }, { cwd: root, source: 'llm' });

  const rec = a.listJournal().find((j) => j.type === 'command');
  assert.ok(rec, 'the refusal left no record');
  assert.equal(rec.outcome, 'refused');
});

test('the installs themselves really are script-free and lockfile-pinned', () => {
  // The refusal's argument is that no untrusted code executes. If that ever stops
  // being true the argument weakens, so it is asserted rather than assumed.
  const root = project();
  const argv = repairArgv(root);

  assert.deepEqual(argv.slice(0, 2), ['npm', 'ci'], 'repair is no longer a lockfile reproduction');
  assert.ok(argv.includes('--ignore-scripts'), 'the npm repair no longer disables install scripts');
  assert.ok(NO_SCRIPTS.npm.includes('--ignore-scripts'));
  assert.ok(NO_SCRIPTS.python.includes('--only-binary=:all:'), 'python repair would build from source');
  assert.ok(NO_SCRIPTS.pnpm.includes('--ignore-scripts'));
  assert.ok(NO_SCRIPTS.yarn.includes('--ignore-scripts'));
});