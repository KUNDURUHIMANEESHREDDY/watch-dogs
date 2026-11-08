/**
 * Import smoke test. Every module must at least parse and load, and the CLI must
 * respond to its own --help. Unit tests that only import the modules they exercise
 * will happily miss a syntax error in the rest of the tree, which is exactly how
 * a broken `detectIde` shipped past a green test run once already.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Windows ESM requires a file:// URL; a bare absolute path is rejected.
const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const MODULES = [
  'src/core/log.mjs',
  'src/core/config.mjs',
  'src/core/exec.mjs',
  'src/core/watcher.mjs',
  'src/capture/stream.mjs',
  'src/capture/shell.mjs',
  'src/capture/procwatch.mjs',
  'src/capture/conpty.mjs',
  'src/analyze/rules.mjs',
  'src/analyze/advisor.mjs',
  'src/act/guard.mjs',
  'src/act/apply.mjs',
  'src/install/install.mjs',
  'bin/wd.js',
];

test('every module parses and loads', async () => {
  for (const m of MODULES) {
    await assert.doesNotReject(() => load(m), `module failed to load: ${m}`);
  }
});

const CLI_COMMANDS = [['--help'], ['rules'], ['rails'], ['doctor']];

for (const args of CLI_COMMANDS) {
  test(`CLI responds to \`wd ${args.join(' ')}\``, () => {
    const stdout = execFileSync(process.execPath, [join(ROOT, 'bin', 'wd.js'), ...args], {
      encoding: 'utf8',
      timeout: 90_000,
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.ok(stdout.trim().length > 0, `wd ${args.join(' ')} produced no output`);
  });
}

test('detectIde identifies an IDE terminal from env alone', async () => {
  const { detectIde } = await load('src/capture/shell.mjs');
  assert.equal(detectIde({ VSCODE_PID: '1234' }), 'VS Code / Cursor');
  assert.equal(detectIde({ WT_PROFILE_ID: 'abc' }), 'Windows Terminal');
  assert.equal(detectIde({ GOORU_IDE: 'x' }), 'GoLand');
  assert.equal(detectIde({}), 'unknown');
});

test('wd status discovers transcript sidecars and distinguishes PID presence from exited sessions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wd-session-status-'));
  try {
    const liveFile = join(dir, 'ps-active.log');
    const exitedFile = join(dir, 'ps-exited.log');
    writeFileSync(liveFile, 'active transcript\n', 'utf8');
    writeFileSync(exitedFile, 'completed transcript\n', 'utf8');
    writeFileSync(liveFile + '.json', JSON.stringify({
      shell: 'powershell', pid: process.pid, cwd: ROOT, ide: 'VS Code / Cursor',
    }), 'utf8');
    writeFileSync(exitedFile + '.json', JSON.stringify({
      shell: 'powershell', pid: 2147483647, cwd: ROOT, ide: 'Windows Terminal',
    }), 'utf8');

    const stdout = execFileSync(process.execPath, [join(ROOT, 'bin', 'wd.js'), 'status'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, WD_TRANSCRIPT_DIR: dir, NO_COLOR: '1' },
    });

    assert.match(stdout, /2 discovered, 1 PID present/);
    assert.match(stdout, /pid-present\s+powershell/);
    assert.match(stdout, /exited\s+powershell/);
    assert.match(stdout, /session=ps-active/);
    assert.match(stdout, /session=ps-exited/);
    assert.match(stdout, /PID presence is best-effort/);

    // Doctor and status must use the same transcript-sidecar source; otherwise
    // the diagnostic command can contradict the session summary users just saw.
    const doctorOutput = execFileSync(process.execPath, [join(ROOT, 'bin', 'wd.js'), 'doctor'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, WD_TRANSCRIPT_DIR: dir, NO_COLOR: '1' },
    });
    assert.match(doctorOutput, /2 discovered; 1 PID present/);
    assert.match(doctorOutput, /pid-present\s+powershell/);
    assert.match(doctorOutput, /exited\s+powershell/);
    assert.match(doctorOutput, /session=ps-active/);
    assert.match(doctorOutput, /session=ps-exited/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wd status keeps PID-present sessions visible beyond the history display limit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wd-session-priority-'));
  try {
    for (let index = 0; index < 6; index++) {
      const file = join(dir, `ps-exited-${index}.log`);
      writeFileSync(file, 'completed transcript\\n', 'utf8');
      writeFileSync(file + '.json', JSON.stringify({
        shell: 'powershell', pid: 2147483647, cwd: ROOT, ide: 'Windows Terminal',
      }), 'utf8');
    }

    const liveFile = join(dir, 'ps-live-after-limit.log');
    writeFileSync(liveFile, 'active transcript\\n', 'utf8');
    writeFileSync(liveFile + '.json', JSON.stringify({
      shell: 'powershell', pid: process.pid, cwd: ROOT, ide: 'VS Code / Cursor',
    }), 'utf8');

    const stdout = execFileSync(process.execPath, [join(ROOT, 'bin', 'wd.js'), 'status'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, WD_TRANSCRIPT_DIR: dir, NO_COLOR: '1' },
    });

    assert.match(stdout, /7 discovered, 1 PID present/);
    assert.match(stdout, /session=ps-live-after-limit/);
    assert.doesNotMatch(stdout, /session=ps-exited-5/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transcript discovery refreshes a sidecar created after the log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wd-late-sidecar-'));
  try {
    const log = join(dir, 'ps-late.log');
    writeFileSync(log, '');
    const { TranscriptDiscovery } = await load('src/capture/shell.mjs');
    const discovery = new TranscriptDiscovery(dir);
    const first = discovery.scan();
    assert.equal(first.length, 1);
    assert.equal(first[0].pid, null);
    assert.equal(first[0].cwd, null);

    writeFileSync(log + '.json', JSON.stringify({
      shell: 'powershell', pid: process.pid, cwd: dir, ide: 'VS Code / Cursor',
    }));
    const refreshed = discovery.scan();
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0].pid, process.pid);
    assert.equal(refreshed[0].cwd, dir);
    assert.deepEqual(discovery.scan(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transcript discovery retries a sidecar updated in place', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wd-partial-sidecar-'));
  try {
    const log = join(dir, 'ps-partial.log');
    writeFileSync(log, '');
    writeFileSync(log + '.json', '{');
    const { TranscriptDiscovery } = await load('src/capture/shell.mjs');
    const discovery = new TranscriptDiscovery(dir);
    assert.equal(discovery.scan()[0].pid, null);

    // Updating an existing sidecar does not change the directory mtime.
    writeFileSync(log + '.json', JSON.stringify({
      shell: 'powershell', pid: process.pid, cwd: dir, ide: 'Windows Terminal',
    }));
    const refreshed = discovery.scan();
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0].pid, process.pid);
    assert.equal(refreshed[0].cwd, dir);
    assert.equal(refreshed[0].ide, 'Windows Terminal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tailer refresh updates metadata for an already tracked transcript', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wd-tailer-refresh-'));
  try {
    const log = join(dir, 'ps-refresh.log');
    writeFileSync(log, '');
    const { TranscriptTailer } = await load('src/capture/shell.mjs');
    const delivered = [];
    const tailer = new TranscriptTailer({
      onLines: (line, meta) => delivered.push({ line, meta }),
      pollMs: 60_000,
    });
    try {
      tailer.track(log, { sessionId: 'ps-refresh', pid: null, cwd: null });
      assert.equal(tailer.refresh(log, {
        sessionId: 'ps-refresh', pid: process.pid, cwd: dir, ide: 'VS Code / Cursor',
      }), true);
      appendFileSync(log, 'metadata refreshed\n');
      tailer.poll();
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0].line, 'metadata refreshed');
      assert.equal(delivered[0].meta.pid, process.pid);
      assert.equal(delivered[0].meta.cwd, dir);
    } finally {
      tailer.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PID-present sessions are stably prioritized before display limits', async () => {
  const { prioritizePidPresentSessions } = await load('src/capture/shell.mjs');
  const sessions = [
    { sessionId: 'exited-a', status: 'exited' },
    { sessionId: 'live-a', status: 'pid-present' },
    { sessionId: 'unknown-a', status: 'unknown' },
    { sessionId: 'live-b', status: 'pid-present' },
    { sessionId: 'exited-b', status: 'exited' },
  ];
  assert.deepEqual(
    prioritizePidPresentSessions(sessions).map(session => session.sessionId),
    ['live-a', 'live-b', 'exited-a', 'unknown-a', 'exited-b'],
  );
});

test('config loads and defaults to a valid autonomy', async () => {
  const { loadConfig } = await load('src/core/config.mjs');
  const cfg = loadConfig({ cwd: ROOT });
  assert.ok(['suggest', 'allowlist', 'autonomous'].includes(cfg.autonomy));
  assert.ok(cfg.projectRoot);
  assert.ok(cfg.paths.data.endsWith('.watchdog'));
});

test('a UTF-8 BOM does not throw the whole config away', async () => {
  // Windows PowerShell `Set-Content -Encoding UTF8` and Notepad both emit a BOM,
  // and JSON.parse rejects one. The failure this guards against is total and
  // safety-relevant: a file that says autonomy "suggest" would otherwise be
  // discarded wholesale and the watchdog would run autonomously instead.
  const { loadConfig } = await load('src/core/config.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'wd-bom-'));
  writeFileSync(join(dir, 'package.json'), '{"name":"p"}\n');
  mkdirSync(join(dir, '.watchdog'), { recursive: true });
  writeFileSync(
    join(dir, '.watchdog', 'config.json'),
    '\uFEFF{"autonomy":"suggest","analyze":{"llm":{"model":"pinned/model"}}}',
    'utf8',
  );

  const cfg = loadConfig({ cwd: dir });
  assert.equal(cfg.autonomy, 'suggest', 'autonomy was silently reverted to the default');
  assert.equal(cfg.analyze.llm.model, 'pinned/model', 'the rest of the file was dropped too');
});
