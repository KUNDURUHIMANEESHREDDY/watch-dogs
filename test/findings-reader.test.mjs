import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBoundedJsonlLines } from '../src/agent/findings-reader.mjs';

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'watchdogs-findings-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('findings reader returns only complete records from a bounded file tail', () => {
  withTempDir((dir) => {
    const path = join(dir, 'findings.jsonl');
    const lines = Array.from({ length: 30 }, (_, id) =>
      JSON.stringify({ id, evidence: 'x'.repeat(12) }));
    writeFileSync(path, lines.join('\n') + '\n');

    const records = readBoundedJsonlLines(path, { maxBytes: 220, maxLines: 5 })
      .map((line) => JSON.parse(line));

    assert.deepEqual(records.map((record) => record.id), [25, 26, 27, 28, 29]);
  });
});

test('findings reader enforces a record-count cap even within the byte limit', () => {
  withTempDir((dir) => {
    const path = join(dir, 'findings.jsonl');
    const lines = Array.from({ length: 10 }, (_, id) => JSON.stringify({ id }));
    writeFileSync(path, lines.join('\n') + '\n');

    assert.deepEqual(
      readBoundedJsonlLines(path, { maxBytes: 1024, maxLines: 2 }).map(JSON.parse),
      [{ id: 8 }, { id: 9 }],
    );
  });
});

test('findings reader rejects invalid limits and ignores symlinks', (t) => {
  withTempDir((dir) => {
    const target = join(dir, 'target.jsonl');
    const link = join(dir, 'linked.jsonl');
    writeFileSync(target, '{"ruleId":"example","evidence":"safe"}\n');
    assert.throws(() => readBoundedJsonlLines(target, { maxBytes: 0 }), /maxBytes/);
    assert.throws(() => readBoundedJsonlLines(target, { maxLines: 0 }), /maxLines/);
    assert.deepEqual(readBoundedJsonlLines(dir), [], 'directories must never be parsed as findings');

    try {
      symlinkSync(target, link);
    } catch (error) {
      if (process.platform === 'win32') {
        t.skip('Creating a symlink is not permitted by this Windows runner.');
        return;
      }
      throw error;
    }
    assert.deepEqual(readBoundedJsonlLines(link), []);
  });
});
