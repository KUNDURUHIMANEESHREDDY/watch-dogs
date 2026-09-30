/**
 * Regression tests for the two autostart bugs that had no coverage.
 *
 * Both were found by hand, both are easy to reintroduce, and one of them
 * (read-only flags mutating the system) is the kind of bug that only shows up
 * after it has already changed someone's machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { coverageVerdict, autostartStatus, removeAutostart, launcherPath } from '../src/install/autostart.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WD = join(ROOT, 'bin', 'wd.js');

// Redirect the launcher into a temp dir before anything reads it, and before any
// subprocess is spawned. Two things go wrong otherwise: the suite unregisters the
// user's real autostart as a side effect of running, and because Node runs test
// files concurrently, this file and autostart.test.mjs race on the real Startup
// folder and fail intermittently for a reason that has nothing to do with the
// code under test. A static import is fine -- only the *call* below matters, and
// that happens after this assignment.
const SANDBOX_STARTUP = mkdtempSync(join(tmpdir(), 'wd-startup-cli-'));
process.env.WD_STARTUP_DIR = SANDBOX_STARTUP;

const LAUNCHER = launcherPath();

function runWd(args) {
  return execFileSync(process.execPath, [WD, ...args], {
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

// ---------------------------------------------------------------- bug 1
//
// `wd autostart --status` used to INSTALL the autostart, because parseFlags
// never captured --status/--remove so the read-only flag fell through to the
// install branch. A read-only flag that writes to the machine is the worst
// possible default: the user asked a question and got a change.

test('--status is read-only and never writes the launcher', (t) => {
  removeAutostart();
  assert.equal(existsSync(LAUNCHER), false, 'precondition: nothing installed');

  const out = runWd(['autostart', '--status']);
  assert.match(out, /registered at logon:\s+no/);
  assert.equal(existsSync(LAUNCHER), false, 'a read-only flag created the launcher');
});

test('--status never creates or removes anything, run repeatedly', () => {
  const before = autostartStatus();
  runWd(['autostart', '--status']);
  runWd(['autostart', '--status']);
  runWd(['autostart', '--status']);
  const after = autostartStatus();
  assert.deepEqual(after.installed, before.installed, 'installed state changed on a read-only flag');
  assert.deepEqual(
    after.entries.map((e) => e.mechanism),
    before.entries.map((e) => e.mechanism),
  );
});

test('--remove is idempotent and creates nothing', () => {
  const out = runWd(['autostart', '--remove']);
  assert.ok(/nothing was registered|removed/.test(out), out);
  assert.equal(existsSync(LAUNCHER), false);
});

// ---------------------------------------------------------------- bug 4
//
// "registered at logon" and "alive right now" are separate claims. The
// combination registered=false / alive=true previously printed nothing at all,
// so a user running now but unprotected at next logoff was never told.

test('coverageVerdict covers all four combinations distinctly', () => {
  const covered = coverageVerdict({ registered: true, beatState: 'running' });
  assert.equal(covered.level, 'ok');
  assert.match(covered.headline, /Covered/);

  const registeredDead = coverageVerdict({ registered: true, beatState: 'stale' });
  assert.equal(registeredDead.level, 'bad');
  assert.match(registeredDead.headline, /NOT being covered/);

  // This is the combination that used to be silent.
  const runningUnregistered = coverageVerdict({ registered: false, beatState: 'running' });
  assert.equal(runningUnregistered.level, 'warn');
  assert.match(runningUnregistered.headline, /RUNNING NOW, BUT NOT AT NEXT LOGON/);
  assert.ok(runningUnregistered.lines.some((l) => /wd autostart/.test(l)), 'should tell the user how to fix it');

  const nothing = coverageVerdict({ registered: false, beatState: 'never-started' });
  assert.equal(nothing.level, 'warn');
  assert.match(nothing.headline, /Nothing is watching/);
});

test('every coverage combination produces a non-empty message', () => {
  for (const registered of [true, false]) {
    for (const beatState of ['running', 'stale', 'dead', 'never-started']) {
      const v = coverageVerdict({ registered, beatState });
      assert.ok(v.headline && v.headline.length > 5, `empty headline for ${registered}/${beatState}`);
      assert.ok(['ok', 'warn', 'bad'].includes(v.level), `bad level for ${registered}/${beatState}`);
    }
  }
});

test('no combination ever claims to be covered while not running', () => {
  for (const beatState of ['stale', 'dead', 'never-started']) {
    const v = coverageVerdict({ registered: true, beatState });
    assert.notEqual(v.level, 'ok', `${beatState} must never read as covered`);
    assert.doesNotMatch(v.headline, /^Covered/);
  }
});

test('the running-but-unregistered state names the fix', () => {
  const v = coverageVerdict({ registered: false, beatState: 'running' });
  assert.match(v.lines.join(' '), /autostart/);
  assert.match(v.lines.join(' '), /logoff|reboot/i);
});

test('the CLI actually prints the verdict for an unregistered live daemon', (t) => {
  // Drive the real CLI in a temp project with a fabricated fresh heartbeat, so
  // the "running but not registered" branch is reached for real.
  const project = mkdtempSync(join(tmpdir(), 'wd-proj-'));
  mkdirSync(join(project, '.watchdog'), { recursive: true });
  writeFileSync(join(project, 'package.json'), '{"name":"p"}\n');
  writeFileSync(
    join(project, '.watchdog', 'daemon.json'),
    JSON.stringify({ v: 1, pid: process.pid, startedAt: new Date().toISOString(), lastBeat: new Date().toISOString(), beats: 1 }),
  );
  removeAutostart();

  const out = execFileSync(process.execPath, [WD, 'autostart', '--status'], {
    cwd: project,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.match(out, /RUNNING NOW, BUT NOT AT NEXT LOGON/);
  assert.match(out, /actually running:\s+RUNNING/);
  assert.match(out, /registered at logon:\s+no/);
  void t;
});

// ---------------------------------------------------------------- cleanup

test('cleanup: nothing left registered', () => {
  removeAutostart();
  assert.equal(existsSync(LAUNCHER), false, 'a launcher was left behind');
  void homedir;
  void readFileSync;
});
