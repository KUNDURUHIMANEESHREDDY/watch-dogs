import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_LOG_LINE_CHARS,
  MAX_LOG_TAIL_BYTES,
  MAX_LOG_TAIL_LINES,
  readBoundedLogTail,
} from '../src/agent/log-tail.mjs';

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'watchdogs-log-tail-'));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('log tail returns only complete lines in a bounded byte window', () => {
  withTempDir((dir) => {
    const path = join(dir, 'daemon.log');
    writeFileSync(path, Array.from({ length: 200 }, (_, i) => `entry-${i}\n`).join(''));
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
    writeFileSync(path, `normal\n${'x'.repeat(20_000)}\n`);
    const lines = readBoundedLogTail(path);
    assert.equal(lines.length, 2);
    assert.equal(lines[0], 'normal');
    assert.equal(lines[1], `${'x'.repeat(MAX_LOG_LINE_CHARS)}...[truncated]`);
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

test('truncated log lines stay within the configured character cap including the marker', () => {
  withTempDir((dir) => {
    const path = join(dir, 'daemon.log');
    writeFileSync(path, 'x'.repeat(100) + '\n');
    for (const maxLineChars of [8, 16, 32]) {
      const lines = readBoundedLogTail(path, { maxLineChars });
      assert.equal(lines.length, 1);
      assert.ok(lines[0].length <= maxLineChars, `returned ${lines[0].length} chars for cap ${maxLineChars}`);
    }
    assert.equal(readBoundedLogTail(path, { maxLineChars: 16 })[0], `xx...[truncated]`);
  });
});
