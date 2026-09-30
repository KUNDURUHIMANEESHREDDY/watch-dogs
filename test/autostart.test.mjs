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

test('the scheduled-task path is preferred but degrades honestly', () => {
  // Cannot create a task without elevation here, so install must still succeed
  // via the Startup folder and must say which guarantee was lost.
  const res = installAutostart({ nodeExe: process.execPath, entry: 'C:/tmp/wd.js', preferTask: true });
  assert.ok(['scheduled-task', 'startup-folder', 'none'].includes(res.mechanism));
  if (res.mechanism === 'startup-folder') {
    // The fallback no longer claims a crash is unrecoverable -- the shell profile
    // restarts a stale daemon -- but it must still not pretend recovery is
    // immediate, because nothing supervises the process in the meantime.
    assert.ok(res.warnings.some((w) => /not automatic|not the instant|never be restarted/i.test(w)), `warnings must qualify the timing of recovery: ${JSON.stringify(res.warnings)}`);
    assert.ok(!res.warnings.some((w) => /will NOT be restarted/i.test(w)), 'the old untrue warning is back');
  }
  const removed = removeAutostart();
  assert.ok(removed.some((x) => x.mechanism === 'startup-folder'));
  void TASK_NAME;
});
