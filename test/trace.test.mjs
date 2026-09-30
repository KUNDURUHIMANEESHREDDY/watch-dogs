/**
 * Runs the path tracer as a test.
 *
 * Counting green unit tests is not the same as verifying the path: a test can
 * pass while exercising a different branch than you think. So this asserts on
 * the tracer's own output -- every hop walked, and no hop reporting damage.
 *
 * The LLM path is excluded by default because it needs a funded model; set
 * WD_LIVE_LLM=1 to include it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TRACER = join(ROOT, 'sandbox', 'trace-path.mjs');
const USE_LLM = process.env.WD_LIVE_LLM === '1';

function trace(mode) {
  return execFileSync(process.execPath, [TRACER, mode], {
    encoding: 'utf8',
    timeout: 600_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

/** Strip ANSI so assertions read against plain text. */
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const PATHS = [
  ['detect', 'PATH 1'],
  ['refuse', 'PATH 2'],
  ['route', 'PATH 3'],
  ['live', 'PATH 4'],
  ['rollback', 'PATH 5'],
];

for (const [mode, label] of PATHS) {
  test(`${label} traces end to end without reporting damage`, () => {
    const out = plain(trace(mode));
    assert.match(out, new RegExp(label), 'tracer did not run');
    assert.match(out, /REACHED:/, 'the path did not reach its end');

    // Damage markers the tracer knows how to emit.
    for (const bad of ['DUPLICATES', 'MISMATCH', 'VULNERABLE', 'LOST', 'NOT ROUTED', 'TARGET MISSING', 'NO-OP']) {
      assert.ok(!out.includes(bad), `tracer reported "${bad}" in ${mode}:\n${out}`);
    }
  });
}

test('the detection path reaches the allowlist gate with the real rule set', () => {
  const out = plain(trace('detect'));
  // Every hop from a raw transcript file to the allowlist must appear.
  for (const stage of [
    'shell -> transcript',
    'discovery.scan()',
    'tailer -> lines',
    'chrome filter',
    'redact()',
    'evaluate()',
    'fix template',
    'isRefused()',
    'declaredPackages()',
    'isDeclared()',
  ]) {
    assert.ok(out.includes(stage), `hop "${stage}" was not walked`);
  }
  // And the value must survive to the end rather than being mangled.
  assert.match(out, /"left-pad"/, 'the package name did not survive the pipeline');
});

test('the refusal path stops at the allowlist and installs nothing', () => {
  const out = plain(trace('refuse'));
  assert.match(out, /evil-pkg/);
  // The stage label and its value sit on separate lines, so these need dotAll.
  assert.match(out, /isDeclared\(\)[\s\S]*?false/, 'the allowlist did not report it undeclared');
  assert.match(out, /the path stops/);
  assert.match(out, /applyAsync\(\)[\s\S]*?skipped/, 'applyAsync did not skip the install');
  assert.match(out, /node_modules[\s\S]*?\n\s*out: .no./, 'the defended artifact must be reported absent');
});

test('the live path holds partial lines and never duplicates', () => {
  const out = plain(trace('live'));
  assert.match(out, /partial line held/);
  assert.match(out, /a partial line must NOT be emitted yet/);
  assert.match(out, /no duplicates/);
});

test('the rollback path restores byte-identical contents', () => {
  const out = plain(trace('rollback'));
  assert.match(out, /byte-identical to the original/);
  assert.match(out, /rolled-back/, 'the journal must be marked so it cannot be replayed');
});

test('the route path shows flags surviving parseFlags', () => {
  const out = plain(trace('route'));
  // The bug that shipped was --status being dropped by the parser, which turned
  // a read-only flag into an install. Assert the flag survives.
  // The JSON is rendered inside a quoted string, so its quotes are escaped.
  assert.match(out, /status\\":true/, '--status did not survive parseFlags');
  assert.match(out, /dryRun\\":true/, '--dry-run did not survive parseFlags');
  assert.ok(!out.includes('TARGET MISSING'));
});

test.run?.name;
void USE_LLM;
void test;
if (USE_LLM) {
  test('PATH 6: the live LLM path reports all three act-gate conjuncts', () => {
    const out = plain(trace('llm'));
    assert.match(out, /unwrapEvents\(\)/);
    assert.match(out, /normalize\(\)/);
    for (const k of ["verdict === 'problem'", 'fix is present', 'confidence >= 0.6', 'ACT GATE (all three)']) {
      assert.ok(out.includes(k), `act-gate conjunct "${k}" was not shown`);
    }
    assert.match(out, /WOULD ACT|WOULD NOT ACT/);
  });
}
