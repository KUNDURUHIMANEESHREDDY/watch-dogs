/**
 * TranscriptTailer.
 *
 * The tailer has no tests at all, which is how a real duplicate-read bug lived
 * in it unnoticed: priming bytes were emitted and then stored as "not yet read",
 * so every line in the primed window was reported twice. Duplicate findings are
 * not cosmetic here -- each one costs an LLM call and can trigger a second
 * autonomous apply of the same fix.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptTailer } from '../src/capture/shell.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'wd-tail-'));

/** Collects everything the tailer reports. */
function collector() {
  const lines = [];
  return { lines, push: (l) => lines.push(l) };
}

test('a backfilled transcript is not reported twice', () => {
  const d = dir();
  const file = join(d, 'session.log');
  // Deliberately larger than backfillBytes so track() has to prime from a
  // non-zero offset -- the only path that reaches the priming branch.
  const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
  writeFileSync(file, body, 'utf8');

  const c = collector();
  const tailer = new TranscriptTailer({ onLines: c.push, pollMs: 60, backfillBytes: 200, recentMs: 60_000 });
  tailer.track(file, { sessionId: 'ps-1', shell: 'powershell' });
  tailer.poll();

  const unique = new Set(c.lines);
  assert.equal(
    c.lines.length,
    unique.size,
    `${c.lines.length} lines observed, ${unique.size} unique: ${c.lines.length - unique.size} duplicates`,
  );
  assert.ok(c.lines.length > 0, 'nothing was captured at all, so the assertion above is vacuous');
});

test('a session that opens and exits inside one poll window is still captured', () => {
  // This is the reason backfill exists. Starting at EOF would miss it entirely,
  // so the fix for the duplicate must not quietly turn backfill off.
  const d = dir();
  const file = join(d, 'brief.log');
  const body = 'ReferenceError: boom\nsecond line\n';
  writeFileSync(file, body, 'utf8');

  const c = collector();
  const tailer = new TranscriptTailer({ onLines: c.push, pollMs: 60, backfillBytes: 10_000, recentMs: 60_000 });
  tailer.track(file, { sessionId: 'ps-2' });
  tailer.poll();

  assert.ok(
    c.lines.includes('ReferenceError: boom'),
    `a completed session was missed: ${JSON.stringify(c.lines)}`,
  );
});

test('content appended after tracking is reported once, and only once', () => {
  const d = dir();
  const file = join(d, 'live.log');
  writeFileSync(file, 'first\n', 'utf8');

  const c = collector();
  const tailer = new TranscriptTailer({ onLines: c.push, pollMs: 60, backfillBytes: 10_000, recentMs: 60_000 });
  tailer.track(file, { sessionId: 'ps-3' });
  tailer.poll();

  for (let i = 0; i < 4; i++) {
    appendFileSync(file, `appended ${i}\n`, 'utf8');
    tailer.poll();
  }

  for (let i = 0; i < 4; i++) {
    const seen = c.lines.filter((l) => l === `appended ${i}`).length;
    assert.equal(seen, 1, `"appended ${i}" was reported ${seen} times`);
  }
  assert.equal(new Set(c.lines).size, c.lines.length, 'some line was reported more than once');
});

test('a multi-byte character straddling the backfill boundary is not corrupted', () => {
  // Priming exists to keep the splitter from cutting a UTF-8 sequence in half.
  // If the fix advances the offset past bytes it did not fully consume, that
  // protection is gone and a split character leaks into findings.
  const d = dir();
  const file = join(d, 'utf8.log');
  const body = 'a'.repeat(150) + '\n\u00e9\u00e8\u00ea done\n';
  writeFileSync(file, body, 'utf8');

  const c = collector();
  const tailer = new TranscriptTailer({ onLines: c.push, pollMs: 60, backfillBytes: 151, recentMs: 60_000 });
  tailer.track(file, { sessionId: 'ps-4' });
  tailer.poll();

  const joined = c.lines.join('\n');
  assert.ok(!joined.includes('\ufffd'), 'a replacement character was produced, so a UTF-8 sequence was split');
  assert.ok(joined.includes('done'), 'the line after the boundary was lost');
});