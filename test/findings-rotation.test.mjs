/**
 * Findings log rotation.
 *
 * The in-memory findings list is trimmed by maxFindingsPerSession, so the file
 * was the only thing on disk that grew without bound. The second cost was
 * quieter: `wd findings` read and JSON-parsed the entire file on every call, so
 * an uncapped log made that command slower and hungrier for as long as the
 * daemon ran.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Watcher } from '../src/core/watcher.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WATCHER_SRC = readFileSync(join(ROOT, 'src', 'core', 'watcher.mjs'), 'utf8');
const WD_SRC = readFileSync(join(ROOT, 'bin', 'wd.js'), 'utf8');

/**
 * The cap is configuration, so a small one can be set directly. That is better
 * than injecting a temporary copy of the module: relative imports do not resolve
 * from a temp directory, and rewriting source in a test proves less about the real
 * code path than configuring it does.
 */
function cfgFor(root, data, maxFindingsBytes) {
  return {
    projectRoot: root,
    autonomy: 'suggest',
    capture: { layers: {}, redact: false, maxLineBytes: 65536, shells: [] },
    analyze: {
      // No CLI, so the advisor returns immediately and never spawns anything.
      llm: { enabled: false, cli: '', model: null, timeoutMs: 500, minSeverity: 'medium', maxInvocationsPerSession: 0 },
      cooldownMs: 0,
      maxFindingsPerSession: 10_000,
      maxFindingsBytes,
    },
    paths: { data },
  };
}

const newRoot = (tag) => {
  const root = mkdtempSync(join(tmpdir(), `wd-${tag}-`));
  const data = join(root, '.watchdog');
  mkdirSync(data, { recursive: true });
  return { root, data };
};

/** Feed findings through the real ingest path until the cap must have been hit. */
function feed(w, n, tag) {
  for (let i = 0; i < n; i++) {
    w.ingest(`Cannot find module '${tag}-${i}'`, { sessionId: 'ps-1', shell: 'powershell' });
  }
}

test('the findings log is capped and keeps one previous generation', () => {
  const { root, data } = newRoot('rot');
  const path = join(data, 'findings.jsonl');
  const w = new Watcher(cfgFor(root, data, 4096));

  feed(w, 400, 'left-pad');

  assert.ok(existsSync(path), 'the live log is missing');
  assert.ok(existsSync(path + '.1'), 'nothing was rotated aside');
  assert.ok(statSync(path).size <= 4096 * 2, `the live log is ${statSync(path).size} bytes, well past the cap`);
  assert.match(readFileSync(path, 'utf8'), /left-pad-399/, 'the newest finding was rotated away');
});

test('rotation keeps the previous generation rather than erasing history', () => {
  const { root, data } = newRoot('rot2');
  const w = new Watcher(cfgFor(root, data, 4096));
  feed(w, 400, 'left-pad');
  assert.match(readFileSync(join(data, 'findings.jsonl.1'), 'utf8'), /left-pad-/, 'the rotated generation is empty');
});

test('only one previous generation accumulates', () => {
  const { root, data } = newRoot('rot3');
  const w = new Watcher(cfgFor(root, data, 2048));
  feed(w, 800, 'left-pad');
  assert.ok(!existsSync(join(data, 'findings.jsonl.2')), 'a third generation exists, so rotation is accumulating');
});

test('an invalid cap falls back to the default rather than disabling the cap', () => {
  // 0 would mean "rotate on every append" and NaN would make every comparison
  // false. Neither may leave the log unbounded, which is the failure this whole
  // change exists to remove.
  //
  // Asserted on the guard rather than on behaviour, because the fallback is the
  // 16MB default: reaching it would mean writing 16MB to prove a guard exists.
  assert.match(WATCHER_SRC, /Number\.isFinite\(configured\) && configured > 0/, 'no guard on the configured cap');
  assert.match(WATCHER_SRC, /: DEFAULT_MAX_FINDINGS_BYTES/, 'no fallback to the default');
  assert.match(WATCHER_SRC, /DEFAULT_MAX_FINDINGS_BYTES = 16 \* 1024 \* 1024/, 'the default cap is gone');
});

test('wd findings reads the rotated generation too', () => {
  // Otherwise rotation silently drops findings from the only command that shows
  // them, which is indistinguishable from the watchdog never having run.
  assert.match(WD_SRC, /p \+ '\.1', p/, 'the reader ignores findings.jsonl.1');
});

test('size is measured in bytes, not characters', () => {
  // Multi-byte terminal output is common; counting characters would let the file
  // exceed the cap by the difference.
  assert.match(WATCHER_SRC, /Buffer\.byteLength/, 'byte length is not used');
});

test('rotation cannot take the daemon down', () => {
  // Every failure inside rotation is swallowed. The worst case is a log that grew
  // too large, which is exactly the situation this exists to prevent.
  assert.match(WATCHER_SRC, /catch \(e\) \{\s*\n\s*log\.debug\('findings log rotation failed/, 'rotation can throw');
});