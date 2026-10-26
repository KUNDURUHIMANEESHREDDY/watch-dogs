import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('log records are single-line, control-safe, and bounded by UTF-8 bytes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'watch-dogs-log-bounds-'));
  const path = join(directory, 'watchdog.log');
  try {
    const { initLog, log } = await import('../src/core/log.mjs?log-line-bounds-test');
    initLog({ level: 'info', file: path });
    const hostile = 'untrusted\nERROR forged-entry\u001b[31mred\u001b[0m\u2028SECOND\u2029THIRD\u0000';
    log.info(hostile, String.fromCodePoint(0x1F642).repeat(100_000));

    const output = readFileSync(path, 'utf8');
    assert.equal(output.trimEnd().split(/\r?\n/).length, 1, 'a message created a forged physical log line');
    assert.ok(Buffer.byteLength(output, 'utf8') <= 64 * 1024 + 1, 'log record exceeded the byte cap');
    assert.match(output, /\\nERROR forged-entry/, 'embedded newline was not escaped');
    assert.match(output, /\\u001b\[31mred\\u001b\[0m/, 'terminal escape sequence was not neutralized');
    assert.match(output, /\\u2028SECOND\\u2029THIRD\\u0000/, 'Unicode separators or control bytes were not escaped');
    assert.doesNotMatch(output, /[\u001b\u2028\u2029\u0000]/, 'raw terminal controls leaked into the log');
    assert.match(output, /\[truncated\]/, 'oversized message lacks a truncation marker');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
