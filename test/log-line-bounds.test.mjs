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
test('invalid configured log destination falls back to stderr', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'watch-dogs-log-init-'));
  try {
    const { initLog, log } = await import('../src/core/log.mjs?log-init-fallback-test');
    let stderr = '';
    const originalWrite = process.stderr.write;
    process.stderr.write = function (chunk, ...args) {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      return true;
    };
    try {
      // Using an existing directory as the file destination forces the
      // initial append probe to fail before logFile is configured.
      initLog({ level: 'info', file: directory });
      log.error('fallback-visible-diagnostic');
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.match(stderr, /cannot open log file/, 'the invalid destination was not reported');
    assert.match(stderr, /fallback-visible-diagnostic/, 'diagnostics were silently lost instead of falling back to stderr');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
