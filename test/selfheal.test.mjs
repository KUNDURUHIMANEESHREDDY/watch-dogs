/**
 * Self-healing.
 *
 * The Startup folder can start the daemon at logon but cannot restart it after a
 * crash, so a dead daemon meant zero coverage until someone noticed -- and the
 * first time it happened the only clue was a stale heartbeat with no log of why.
 * Two things fix that: the daemon records what it does to a file, and every new
 * shell checks the heartbeat and relaunches if it has gone stale.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Heartbeat, readHeartbeat, STALE_AFTER_MS } from '../src/core/heartbeat.mjs';
import { buildProfileBlock } from '../src/install/install.mjs';

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// readHeartbeat takes the data directory, not the project root. Passing the root
// silently reads a path that never exists and reports "never started" no matter
// what the daemon is doing -- which is exactly the mistake this constant prevents.
const DATA_DIR = join(ROOT, '.watchdog');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- the log

test('the daemon logs its startup to a file', async () => {
  const data = mkdtempSync(join(tmpdir(), 'wd-log-'));
  const logFile = join(data, 'daemon.log');
  writeFileSync(logFile, '');
  const { initLog, log } = await import('../src/core/log.mjs');
  initLog({ level: 'debug', file: logFile });
  log.info('daemon starting: pid=1');
  const contents = readFileSync(logFile, 'utf8');
  assert.match(contents, /daemon starting: pid=1/);
  assert.match(contents, /INFO/);
});

test('a broken log path never takes the daemon down', async () => {
  const { initLog, log } = await import('../src/core/log.mjs');
  // A path that cannot be created.
  initLog({ level: 'debug', file: 'NUL:\\nope\\daemon.log' });
  assert.doesNotThrow(() => log.info('still fine'));
  initLog({ level: 'silent' });
});

test('the log rotates so an unattended daemon cannot fill the disk', async () => {
  const { initLog, log } = await import('../src/core/log.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'wd-rot-'));
  const logFile = join(dir, 'daemon.log');
  // Write past the 2MB cap.
  const filler = 'x'.repeat(1024);
  let s = '';
  for (let i = 0; i < 2100; i++) s += filler + '\n';
  writeFileSync(logFile, s);
  assert.ok(statSync(logFile).size > 2 * 1024 * 1024);

  initLog({ level: 'debug', file: logFile });
  log.info('after rotation');
  initLog({ level: 'silent' });

  assert.ok(existsSync(logFile + '.1'), 'the previous file was not rotated aside');
  assert.ok(statSync(logFile).size < 2 * 1024 * 1024, 'the live log is still over the cap');
  assert.match(readFileSync(logFile, 'utf8'), /after rotation/, 'the new entry was lost');
});

// ------------------------------------------------------------- the index

test('the global index records where to relaunch a dead daemon', async () => {
  const data = mkdtempSync(join(tmpdir(), 'wd-idx-'));
  const indexPath = join(homedir(), '.watchdog', 'daemons.json');
  const before = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;

  const beat = new Heartbeat(data, { projectRoot: '/tmp/proj', toolRoot: '/tmp/tool' });
  beat.start();
  beat.stop();

  assert.ok(existsSync(indexPath), 'no global index was written');
  const idx = JSON.parse(readFileSync(indexPath, 'utf8').replace(/^\uFEFF/, ''));
  assert.ok(Array.isArray(idx));
  // stop() must remove its own entry, leaving any pre-existing ones alone.
  assert.ok(!idx.some((e) => e.pid === process.pid), 'stop() left its own entry behind');
  beat.stop();
  if (before === null) unlinkSync(indexPath);
  else writeFileSync(indexPath, before);
});

test('a crashed daemon is pruned from the index instead of lingering', async () => {
  const data = mkdtempSync(join(tmpdir(), 'wd-prune-'));
  const indexPath = join(homedir(), '.watchdog', 'daemons.json');
  const saved = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;

  // A dead entry from long ago, exactly what a crash leaves behind.
  writeFileSync(
    indexPath,
    JSON.stringify([
      {
        pid: 999999,
        heartbeat: 'C:/gone/.watchdog/daemon.json',
        projectRoot: 'C:/gone',
        entry: 'C:/gone/bin/wd.js',
        lastBeat: new Date(Date.now() - 60 * 60_000).toISOString(),
      },
    ]),
  );

  const beat = new Heartbeat(data, { projectRoot: '/tmp/proj', toolRoot: '/tmp/tool' });
  beat.start();

  const idx = JSON.parse(readFileSync(indexPath, 'utf8').replace(/^\uFEFF/, ''));
  assert.ok(
    !idx.some((e) => e.pid === 999999),
    'a long-dead daemon stayed in the index and would win the shell profile\'s restart race',
  );
  assert.ok(idx.some((e) => e.pid === process.pid), 'the live daemon did not register itself');

  beat.stop();
  if (saved === null) unlinkSync(indexPath);
  else writeFileSync(indexPath, saved);
});

// ------------------------------------------------------------- the profile
test('the profile bakes in the real node path, not a placeholder', () => {
  const block = buildProfileBlock('C:/node/node.exe');
  assert.match(block, /C:\/node\/node\.exe/);
  assert.ok(!block.includes('__NODE__'), 'a placeholder leaked into the profile');
});

test('the profile relaunch command quotes the entry path', () => {
  // Start-Process does not quote -ArgumentList elements. A path containing a
  // space (this repo is "watch dog") is truncated at the space and node dies
  // immediately, which is exactly what happened before this was fixed.
  const block = buildProfileBlock('C:/node/node.exe');
  assert.match(block, /-ArgumentList \('"\{0\}" start' -f \$__wdD\.entry\)/);
});

test('the profile relaunches every stale project, not just the first', () => {
  // Restarting a single project would leave the others uncovered while making the
  // machine look healed, which is harder to notice than the original bug.
  const block = buildProfileBlock('C:/node/node.exe');
  const heal = block.slice(block.indexOf('# --- self-heal'));
  assert.ok(!/break\b/.test(heal), 'the loop breaks after the first stale entry');
  assert.match(heal, /foreach/, 'no loop over stale entries');
  assert.match(heal, /\$__wdDone/, 'no per-project de-duplication');
});

test('a dead entry survives in the index so a shell can still recover it', () => {
  // This is the failure that left the machine uncovered for ten hours: the index
  // pruned entries by age, so a daemon that died long ago lost the very record a
  // new shell needed in order to restart it. Recovery and tidiness are different
  // jobs and pruning by age quietly destroyed the first one.
  const data = mkdtempSync(join(tmpdir(), 'wd-keep-'));
  const indexPath = join(homedir(), '.watchdog', 'daemons.json');
  const saved = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;
  const realProject = mkdtempSync(join(tmpdir(), 'wd-real-project-'));

  writeFileSync(
    indexPath,
    JSON.stringify([
      {
        pid: 424242,
        heartbeat: join(realProject, '.watchdog', 'daemon.json'),
        projectRoot: realProject,
        entry: 'C:/tool/bin/wd.js',
        // Dead for an hour: far past any plausible prune window.
        lastBeat: new Date(Date.now() - 60 * 60_000).toISOString(),
      },
    ]),
  );

  const beat = new Heartbeat(data, { projectRoot: realProject, toolRoot: 'C:/tool' });
  beat.start();

  const idx = JSON.parse(readFileSync(indexPath, 'utf8').replace(/^\uFEFF/, ''));
  assert.ok(
    idx.some((e) => e.pid === 424242),
    'an hour-dead entry was pruned, so no shell would ever relaunch that project',
  );

  beat.stop();
  if (saved === null) unlinkSync(indexPath);
  else writeFileSync(indexPath, saved);
});

test('an entry whose project was deleted is pruned', () => {
  // The other half of the rule: a project that no longer exists must not keep
  // getting relaunched on every shell start.
  const data = mkdtempSync(join(tmpdir(), 'wd-drop-'));
  const indexPath = join(homedir(), '.watchdog', 'daemons.json');
  const saved = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;

  writeFileSync(
    indexPath,
    JSON.stringify([
      { pid: 515151, heartbeat: 'C:/gone/.watchdog/daemon.json', projectRoot: 'C:/definitely-not-here', entry: 'C:/gone/bin/wd.js', lastBeat: new Date().toISOString() },
    ]),
  );

  const beat = new Heartbeat(data, { projectRoot: mkdtempSync(join(tmpdir(), 'wd-live-')), toolRoot: 'C:/tool' });
  beat.start();
  const idx = JSON.parse(readFileSync(indexPath, 'utf8').replace(/^\uFEFF/, ''));
  assert.ok(!idx.some((e) => e.pid === 515151), 'an entry for a deleted project was kept');
  beat.stop();
  if (saved === null) unlinkSync(indexPath);
  else writeFileSync(indexPath, saved);
});

test('the profile self-heal block is guarded so it cannot break a shell', () => {
  const block = buildProfileBlock('C:/node/node.exe');
  const heal = block.slice(block.indexOf('# --- self-heal'));
  assert.ok(heal.length > 0, 'no self-heal block present');
  assert.match(heal, /try \{/);
  assert.match(heal, /\} catch \{ \}/, 'the block must swallow its own errors');
  assert.match(heal, /Start-Process/, 'the block must actually relaunch something');
});

test('the profile writes a transcript even when the self-heal fails', () => {
  const block = buildProfileBlock('C:/node/node.exe');
  // The self-heal must come after the transcript starts, so capture is not lost
  // if a relaunch is attempted and misbehaves.
  assert.ok(block.indexOf('Start-Transcript') < block.indexOf('# --- self-heal'));
});

// ------------------------------------------------------------- end to end

test('a dead daemon is relaunched when a new shell opens', { timeout: 180_000 }, async (t) => {
  // Opt-in, because this one has to control the machine: it stops whatever daemon
  // is running. A test that races the live system is worse than no test, so it
  // runs only when asked:  WD_E2E_HEAL=1 npm test
  if (process.env.WD_E2E_HEAL !== '1') return t.skip('set WD_E2E_HEAL=1 to run the end-to-end relaunch test');

  // Establish a genuinely dead state rather than assuming one.
  try {
    await exec(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*wd.js*start*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
      ],
      { timeout: 60_000, windowsHide: true },
    );
  } catch {
    /* nothing was running, which is the state we wanted anyway */
  }
  await sleep(2500);

  const indexPath = join(homedir(), '.watchdog', 'daemons.json');
  if (!existsSync(indexPath)) return t.skip('no registered daemon on this machine');

  // Force the "dead" state by ageing the newest entry beyond the stale window.
  const idx = JSON.parse(readFileSync(indexPath, 'utf8').replace(/^\uFEFF/, ''));
  const newest = idx.reduce((a, b) => (a && a.lastBeat > b.lastBeat ? a : b), null);
  if (!newest) return t.skip('index is empty');
  const saved = JSON.stringify(idx);
  const aged = idx.map((e) => (e === newest ? { ...e, lastBeat: new Date(Date.now() - 10 * 60_000).toISOString() } : e));
  writeFileSync(indexPath, JSON.stringify(aged, null, 2));

  try {
    // Opening a shell runs the profile, which is what triggers the relaunch.
    // One shell is enough: the relaunch is a Start-Process, so it is already
    // detached by the time the shell exits.
    await exec('powershell.exe', ['-NoLogo', '-Command', 'Write-Output heal-probe'], { timeout: 90_000, windowsHide: true });

    // Poll rather than sleep a fixed amount, because node startup plus config load
    // is not bounded.
    let beat = null;
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      beat = readHeartbeat(DATA_DIR);
      if (beat.state === 'running') break;
    }

    const { stdout } = await exec(
      'powershell.exe',
      ['-NoLogo', '-Command', "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*wd.js*start*' } | Measure-Object).Count"],
      { timeout: 60_000, windowsHide: true },
    );
    const alive = Number((stdout || '').trim());
    assert.ok(alive >= 1, 'no daemon is running after a new shell was opened');

    assert.equal(beat.state, 'running', `daemon did not come back: ${beat.detail}`);
    void newest;
  } finally {
    writeFileSync(indexPath, saved);
  }
});
