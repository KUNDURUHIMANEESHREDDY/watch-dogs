import test from 'node:test';
import assert from 'node:assert/strict';
import { LineSplitter, stripAnsi, redact } from '../src/capture/stream.mjs';

test('reassembles lines split across chunk boundaries', () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push('npm ERR! code ELIF'), []);
  // Only the newline-terminated line is complete; the tail stays buffered.
  assert.deepEqual(s.push('ECYCLE\nnpm ERR! code E'), ['npm ERR! code ELIFECYCLE']);
  assert.deepEqual(s.push('404\n'), ['npm ERR! code E404']);
});

test('does not corrupt multibyte characters split across buffers', () => {
  const full = Buffer.from('héllo → wörld\n', 'utf8');
  const s = new LineSplitter();
  const out = [];
  // Feed one byte at a time: the worst case for boundary handling.
  for (const b of full) out.push(...s.push(Buffer.from([b])));
  assert.deepEqual(out, ['héllo → wörld']);
});

test('never splits mid escape sequence', () => {
  const s = new LineSplitter();
  const out = [...s.push('\x1b[3'), ...s.push('1mRED\x1b[0m\n')];
  assert.deepEqual(out, ['RED']);
});

test('strips OSC sequences carrying a title change', () => {
  assert.equal(stripAnsi('\x1b]0;some title\x07visible'), 'visible');
  assert.equal(stripAnsi('\x1b]0;title\x1b\\visible'), 'visible');
});

test('collapses carriage-return progress to its final state', () => {
  const s = new LineSplitter();
  const out = s.push('Downloading 10%\rDownloading 55%\rDownloading 100%\ndone\n');
  assert.deepEqual(out, ['done']);
});

test('keeps the final value of a real progress line', () => {
  const s = new LineSplitter();
  const out = s.push('build 10%\rbuild 20%\rbuild done\n');
  assert.deepEqual(out, ['build done']);
});

test('preserves a deliberate CR-separated block', () => {
  const s = new LineSplitter();
  const out = s.push('first\rsecond\rthird\n');
  assert.deepEqual(out, ['third']);
});

test('bounds a runaway line with no newline', () => {
  const s = new LineSplitter({ maxLineBytes: 16 });
  const out = s.push('x'.repeat(100));
  assert.ok(out.length > 0);
  assert.ok(out.join('').length <= 16 * (out.length + 1));
  assert.match(out[0], /\[truncated\]$/);
});

test('flush emits a trailing line that never got a newline', () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push('no newline here'), []);
  assert.deepEqual(s.flush(), ['no newline here']);
});

test('redacts common secret shapes', () => {
  assert.match(redact('export AWS=AKIAIOSFODNN7EXAMPLE'), /<redacted:aws-key>/);
  assert.match(redact('token: ghp_abcdefghijklmnopqrstuvwxyz0123'), /<redacted:github-token>/);
  assert.match(redact('password: hunter2xyz'), /password: <redacted>/);
  // The scheme is preserved deliberately: redacting the whole value would make
  // the log harder to read without making it any safer.
  assert.match(redact('Authorization: Bearer abc123def456'), /Authorization: Bearer <redacted>/);
  assert.match(redact('sig eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij'), /<redacted:jwt>/);
});

test('leaves ordinary text untouched', () => {
  const s = 'build succeeded in 1.2s, 42 tests passed';
  assert.equal(redact(s), s);
});
