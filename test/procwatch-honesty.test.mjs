/**
 * Layer 2 honesty.
 *
 * This layer never had exit codes. The code claimed it did -- the header talked
 * about "process identity and exit codes" contributing "crash and non-zero-exit
 * findings", and a CRASH_CODES set sat there never referenced by anything.
 *
 * Exit codes are genuinely unobtainable here, not merely unwired: they are
 * delivered to the spawning parent, and for the IDE tasks and scheduler jobs
 * this layer watches, that parent is not us. WMI process-stop tracing returns
 * Access denied without elevation (verified), and ETW needs a native binding.
 *
 * So the fix is to stop claiming it. These tests exist to stop the claim coming
 * back, which is the part that would actually mislead someone reading this
 * project to understand what layer 2 can tell them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/capture/procwatch.mjs', import.meta.url), 'utf8');

test('there is no dead CRASH_CODES left advertising a capability', () => {
  // It was defined, exported, and used by nothing. Dead code that implies a
  // feature is worse than missing code: it survives review as evidence of one.
  assert.ok(!/CRASH_CODES/.test(src), 'CRASH_CODES is back in procwatch.mjs');
});

test('the module does not claim to observe exit codes', () => {
  const header = src.slice(0, src.indexOf('*/'));
  const overclaims = header.match(/has[^.]*exit codes|identity and exit codes|crash and non-zero-exit findings/gi);
  assert.equal(overclaims, null, `the header still claims: ${overclaims}`);
});

test('the limitation is explained where someone would go looking for it', () => {
  // Not just "we do not have codes" but why, so the next person does not spend
  // an afternoon trying WMI again.
  assert.match(src, /Access denied/i, 'the WMI elevation wall is not documented');
  assert.match(src, /ETW/, 'the ETW alternative is not mentioned');
  assert.match(src, /spawned/, 'the spawn boundary is not explained');
});

test('the emitted finding carries exitCode: null rather than omitting it', () => {
  // Explicit null reads as "known to be unavailable". An absent field reads as
  // "nobody thought about it", which is how the original bug looked.
  assert.match(src, /exitCode: null/, 'the finding does not state exitCode: null');
  // Asserted on unbroken fragments: the note is built by concatenating string
  // literals, so a phrase spanning the join would not match the source at all.
  assert.match(src, /did not spawn the/, 'the finding does not say why the code is missing');
  assert.match(src, /exit code available/, 'the finding does not say the code was unavailable');
});

test('lifecycle findings stay severity info', () => {
  // Without an exit code there is nothing to grade, so this must not drift into
  // claiming a problem the layer cannot actually establish.
  assert.match(src, /kind: 'process-exit',\s*\n\s*severity: 'info'/);
});

test('the config comment no longer calls it an exit-code watcher', () => {
  const config = readFileSync(new URL('../src/core/config.mjs', import.meta.url), 'utf8');
  assert.ok(
    !/layer 2:[^\n]*exit-code watcher/i.test(config),
    'config.mjs still describes layer 2 as an exit-code watcher',
  );
});