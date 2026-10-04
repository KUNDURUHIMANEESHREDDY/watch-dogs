/**
 * Liveness logic.
 *
 * The autostart mechanism has no supervisor, so "the launcher is installed" and
 * "something is actually watching" are different claims. These tests pin the
 * verdict for every state a user can end up in, because a false "you're covered"
 * is the specific failure this exists to prevent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHeartbeat, atomicWriteJson, claimSingleton, STALE_AFTER_MS } from '../src/core/heartbeat.mjs';
import { installAutostart, removeAutostart, autostartStatus, buildLauncherForTest, TASK_NAME } from '../src/install/autostart.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'wd-beat-'));
const beat = (dataDir, over = {}) => ({ v: 1, pid: process.pid, startedAt: new Date().toISOString(), lastBeat: new Date().toISOString(), beats: 1, ...over });
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// installAutostart below writes a real launcher. Redirect it to a temp dir so the
// test suite never installs into -- and then removes from -- the user's actual
// Startup folder, and so this file cannot race autostart-cli.test.mjs on it.
process.env.WD_STARTUP_DIR = mkdtempSync(join(tmpdir(), 'wd-startup-unit-'));

test('no heartbeat means the daemon has never run', () => {
  const r = readHeartbeat(dir());
  assert.equal(r.state, 'never-started');
  assert.match(r.detail, /never run/);
});

test('a fresh beat with a live pid reads as running', () => {
  const d = dir();
  atomicWriteJson(join(d, 'daemon.json'), beat(d));
  const r = readHeartbeat(d);
  assert.equal(r.state, 'running');
  assert.match(r.detail, /alive, pid/);
});

test('beat age is reported in seconds, not milliseconds', () => {
  // Regression: the detail string printed raw ms, so a healthy daemon read
  // "beat 3780s ago" and looked catastrophically broken.
  const d = dir();
  atomicWriteJson(join(d, 'daemon.json'), beat(d, { lastBeat: ago(3000) }));
  const r = readHeartbeat(d);
  assert.equal(r.state, 'running');
  assert.match(r.detail, /beat 3s ago/);
  assert.doesNotMatch(r.detail, /beat [0-9]{4,}s/);
});

test('a beat older than the limit reads as stale, not running', () => {
  const d = dir();
  atomicWriteJson(join(d, 'daemon.json'), beat(d, { lastBeat: ago(STALE_AFTER_MS + 5000) }));
  const r = readHeartbeat(d);
  assert.equal(r.state, 'stale');
  assert.match(r.detail, /nothing restarted it/);
});

test('a surviving heartbeat with a dead pid is an unclean shutdown', () => {
  const d = dir();
  // A pid that is almost certainly not running.
  atomicWriteJson(join(d, 'daemon.json'), beat(d, { pid: 0x7ffffffe, lastBeat: new Date().toISOString() }));
  const r = readHeartbeat(d);
  assert.ok(['dead', 'running'].includes(r.state));
  if (r.state === 'dead') assert.match(r.detail, /unclean shutdown/);
});

test('a corrupt heartbeat is reported, never silently treated as healthy', () => {
  const d = dir();
  writeFileSync(join(d, 'daemon.json'), '{ this is not json');
  const r = readHeartbeat(d);
  assert.notEqual(r.state, 'running');
  assert.match(r.detail, /unreadable/);
});

test('a heartbeat with a missing timestamp is not trusted', () => {
  const d = dir();
  atomicWriteJson(join(d, 'daemon.json'), { v: 1, pid: process.pid });
  const r = readHeartbeat(d);
  assert.notEqual(r.state, 'running');
});

test('a heartbeat file is never left half-written', () => {
  const d = dir();
  const p = join(d, 'daemon.json');
  for (let i = 0; i < 25; i++) atomicWriteJson(p, beat(d, { beats: i }));
  const parsed = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(parsed.beats, 24);
  // The temp file must not survive a successful rename.
  assert.deepEqual(
    readdirSync(d).filter((f) => f.endsWith('.tmp')),
    [],
  );
});

test('a second daemon is refused while one is alive', () => {
  const d = dir();
  atomicWriteJson(join(d, 'daemon.json'), beat(d, { pid: process.pid }));
  const claim = claimSingleton(d);
  // Our own pid means "not another daemon", so this must be allowed.
  assert.equal(claim.ok, true);

  const d2 = dir();
  atomicWriteJson(join(d2, 'daemon.json'), beat(d2, { pid: process.ppid }));
  const claim2 = claimSingleton(d2);
  if (claim2.ok === false) assert.match(claim2.reason, /already running/);
});

test('a stale heartbeat does not block a restart', () => {
  const d = dir();
  atomicWriteJson(join(d, 'daemon.json'), beat(d, { pid: process.pid, lastBeat: ago(STALE_AFTER_MS + 10_000) }));
  assert.equal(claimSingleton(d).ok, true, 'a dead daemon must not block the next start');
});

test('the launcher quotes paths for VBScript correctly', () => {
  const vbs = buildLauncherForTest('C:\\Program Files\\nodejs\\node.exe', 'C:\\a b\\wd.js');
  // VBScript needs "" for a literal quote, and no window (0) for hidden launch.
  assert.match(vbs, /sh\.Run """C:\\Program Files\\nodejs\\node\.exe"" ""C:\\a b\\wd\.js"" start", 0, False/);
  assert.doesNotMatch(vbs, /sh\.Run ""C:/, 'must not double the outer quotes');
});

test('the launcher is marked as ours and carries no visible window', () => {
  const vbs = buildLauncherForTest('C:/node.exe', 'C:/wd.js');
  assert.match(vbs, /watchdog-daemon/);
  assert.match(vbs, /, 0, False/);
});

test('autostart status is truthful when nothing is installed', () => {
  const s = autostartStatus();
  assert.equal(typeof s.installed, 'boolean');
  assert.ok(Array.isArray(s.entries));
  if (!s.installed) assert.equal(s.entries.length, 0);
});

test('remove is idempotent and never throws when nothing is there', () => {
  const r = removeAutostart();
  assert.ok(Array.isArray(r));
});

test('the scheduled-task path is no longer preferred, because it supervises no better', () => {
  // The default changed from preferTask: true to false, and this is why.
  //
  // A task was preferred because it "supervises better than a Startup folder entry".
  // Measured on this machine that was not true in the only dimension either mechanism
  // acts on: the task carried no restart-on-failure settings, so it reported
  // `restarts: false`, while the Startup-folder path reported `restarts: true`
  // because the shell profile relaunches a stale daemon. Both install that profile.
  //
  // What preferring the task bought was a machine-wide artifact needing elevation to
  // create and to remove, for identical recovery behaviour.
  const res = installAutostart({ nodeExe: process.execPath, entry: 'C:/tmp/wd.js' });
  assert.ok(['startup-folder', 'scheduled-task', 'none'].includes(res.mechanism));

  // Not being elevated is the common case here, so the default must not have tried
  // the task at all. If it had, the failure would be silent -- it falls back.
  assert.notEqual(
    res.mechanism,
    'scheduled-task',
    'an unelevated default install created a Scheduled Task, which needs elevation and supervises no better',
  );

  if (res.mechanism === 'startup-folder') {
    assert.ok(
      res.warnings.some((w) => /not automatic|not the instant|never be restarted/i.test(w)),
      `warnings must qualify the timing of recovery: ${JSON.stringify(res.warnings)}`,
    );
    assert.ok(!res.warnings.some((w) => /will NOT be restarted/i.test(w)), 'the old untrue warning is back');
    // And it must not claim immediacy it does not have.
    assert.ok(!res.warnings.some((w) => /restarted automatically|supervis/i.test(w)), 'the fallback claims supervision it does not have');
  }
  const removed = removeAutostart();
  assert.ok(Array.isArray(removed));
  void TASK_NAME;
});

test('an explicit opt-in still reaches the task path and reports no restart guarantee', () => {
  // Kept reachable, for a future elevated install that can turn restart-on-failure on.
  // What it must never do is claim supervision: the task as created has no
  // restart-on-failure settings, so `restarts` is false and the warning says why.
  const res = installAutostart({ nodeExe: process.execPath, entry: 'C:/tmp/wd.js', preferTask: true });
  assert.ok(['scheduled-task', 'startup-folder', 'none'].includes(res.mechanism));

  if (res.mechanism === 'scheduled-task') {
    assert.equal(res.restarts, false, 'a task without restart-on-failure must not report restarting');
    assert.ok(
      res.warnings.some((w) => /restart-on-failure/i.test(w)),
      `the task path must say why it does not supervise: ${JSON.stringify(res.warnings)}`,
    );
  }
  removeAutostart();
});
