import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_LOG_LINE_CHARS,
  MAX_LOG_TAIL_BYTES,
  MAX_LOG_TAIL_LINES,
  readBoundedLogTail,
} from '../src/agent/log-tail.mjs';
import { readBoundedDirectoryNames, MAX_DIRECTORY_NAMES } from '../src/agent/directory-list.mjs';

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'watchdogs-log-tail-'));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('log tail returns only complete lines in a bounded byte window', () => {
  withTempDir((dir) => {
    const path = join(dir, 'daemon.log');
    writeFileSync(path, Array.from({ length: 200 }, (_, i) => 'entry-' + i + '\n').join(''));
    const lines = readBoundedLogTail(path, { maxBytes: 256, maxLines: 8 });
    assert.ok(lines.length <= 8);
    assert.ok(lines.length > 0);
    assert.ok(lines.every((line) => /^entry-\d+$/.test(line)));
    assert.equal(lines.at(-1), 'entry-199');
  });
});

test('log tail truncates a single oversized line and never exceeds configured caps', () => {
  withTempDir((dir) => {
    const path = join(dir, 'daemon.log');
    writeFileSync(path, 'normal\n' + 'x'.repeat(20_000) + '\n');
    const lines = readBoundedLogTail(path);
    assert.equal(lines.length, 2);
    assert.equal(lines[0], 'normal');
    assert.equal(lines[1], 'x'.repeat(MAX_LOG_LINE_CHARS - '...[truncated]'.length) + '...[truncated]');
    assert.equal(lines[1].length, MAX_LOG_LINE_CHARS);
    assert.ok(lines.length <= MAX_LOG_TAIL_LINES);
    assert.ok(MAX_LOG_TAIL_BYTES <= 64 * 1024);
  });
});

test('log tail handles missing files and rejects unbounded limits', () => {
  withTempDir((dir) => {
    assert.deepEqual(readBoundedLogTail(join(dir, 'missing.log')), []);
  });
  assert.throws(() => readBoundedLogTail('unused', { maxBytes: MAX_LOG_TAIL_BYTES + 1 }), /maxBytes/);
  assert.throws(() => readBoundedLogTail('unused', { maxLines: MAX_LOG_TAIL_LINES + 1 }), /maxLines/);
});

test('log tail refuses symlinks to files outside the log path', (t) => {
  withTempDir((dir) => {
    const target = join(dir, 'private.txt');
    const link = join(dir, 'daemon.log');
    writeFileSync(target, 'sensitive outside content\n');
    try {
      symlinkSync(target, link);
    } catch (error) {
      // Some Windows runners do not grant symlink creation privileges. Skip
      // only when the OS denies fixture setup; exercise the fallback otherwise.
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOSYS', 'UNKNOWN'].includes(error?.code)) {
        t.skip('symlink fixture unavailable on this Windows runner: ' + error.code);
        return;
      }
      throw error;
    }
    assert.deepEqual(readBoundedLogTail(link), []);
  });
});

test('truncated log lines stay within the configured character cap including the marker', () => {
  withTempDir((dir) => {
    const path = join(dir, 'daemon.log');
    writeFileSync(path, 'x'.repeat(100) + '\n');
    for (const maxLineChars of [8, 16, 32]) {
      const lines = readBoundedLogTail(path, { maxLineChars });
      assert.equal(lines.length, 1);
      assert.ok(lines[0].length <= maxLineChars, 'returned ' + lines[0].length + ' chars for cap ' + maxLineChars);
    }
    assert.equal(readBoundedLogTail(path, { maxLineChars: 16 })[0], 'xx...[truncated]');
  });
});

test('log tail rejects a regular-file replacement between lstat and open', (t) => {
  withTempDir((dir) => {
    const path = join(dir, 'daemon.log');
    const originalPath = join(dir, 'daemon-original.log');
    writeFileSync(path, 'original log content\n');

    let swapped = false;
    const originalOpenSync = fs.openSync;
    const openMock = t.mock.method(fs, 'openSync', (candidatePath, flags, mode) => {
      if (String(candidatePath) === path && !swapped) {
        swapped = true;
        renameSync(path, originalPath);
        writeFileSync(path, 'replacement file must not be read\n');
      }
      return originalOpenSync(candidatePath, flags, mode);
    });

    syncBuiltinESMExports();
    try {
      assert.deepEqual(readBoundedLogTail(path), []);
      assert.equal(swapped, true, 'the test must replace the path after its initial lstat');
    } finally {
      openMock.mock.restore();
      syncBuiltinESMExports();
    }
  });
});

test('log tail does not block when a regular file is replaced with a FIFO before open', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX FIFO semantics are not available on Windows');
    return;
  }

  withTempDir((dir) => {
    const path = join(dir, 'daemon.log');
    const originalPath = join(dir, 'daemon-original.log');
    const fifoPath = join(dir, 'replacement.fifo');
    writeFileSync(path, 'original log content\n');

    try {
      execFileSync('mkfifo', [fifoPath], { stdio: 'ignore' });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.code === 'EPERM') {
        t.skip('mkfifo is unavailable in this runner');
        return;
      }
      throw error;
    }

    let swapped = false;
    const originalOpenSync = fs.openSync;
    const openMock = t.mock.method(fs, 'openSync', (candidatePath, flags, mode) => {
      if (String(candidatePath) === path && !swapped) {
        swapped = true;
        renameSync(path, originalPath);
        renameSync(fifoPath, path);
        assert.equal(typeof flags, 'number');
        assert.notEqual(flags & fs.constants.O_NONBLOCK, 0, 'POSIX log opens must be nonblocking');
      }
      return originalOpenSync(candidatePath, flags, mode);
    });

    syncBuiltinESMExports();
    try {
      assert.deepEqual(readBoundedLogTail(path), []);
      assert.equal(swapped, true, 'the test must replace the path with a FIFO after its initial lstat');
    } finally {
      openMock.mock.restore();
      syncBuiltinESMExports();
    }
  });
});


test('combined gateway snapshot inputs remain bounded across directory and log readers', (t) => {
  withTempDir((root) => {
    const dataDirectory = join(root, 'data');
    mkdirSync(dataDirectory);
    for (let index = 0; index < 250; index += 1) {
      writeFileSync(join(dataDirectory, `entry-${String(index).padStart(3, '0')}.json`), '{}');
    }

    const names = readBoundedDirectoryNames(dataDirectory);
    assert.equal(names.length, MAX_DIRECTORY_NAMES);
    assert.equal(new Set(names).size, MAX_DIRECTORY_NAMES);
    assert.ok(names.every((name) => name.endsWith('.json')));

    const logPath = join(root, 'daemon.log');
    writeFileSync(logPath, Array.from({ length: 120 }, (_, index) => `line-${index}`).join('\n') + '\n');
    const tail = readBoundedLogTail(logPath);
    assert.equal(tail.length, MAX_LOG_TAIL_LINES);
    assert.equal(tail[0], 'line-40');
    assert.equal(tail.at(-1), 'line-119');
  });
});
