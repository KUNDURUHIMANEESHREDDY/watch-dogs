import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readBoundedDirectoryNames,
  readBoundedLogLines,
  readBoundedRegularFile,
  readFindings,
} from '../src/agent/snapshot-readers.mjs';

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'wd-snapshot-readers-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('bounded tail reads a fixed suffix and drops its first partial line', () => {
  withTempDir((dir) => {
    const path = join(dir, 'daemon.log');
    writeFileSync(path, 'discard-this-old-line\none\ntwo\nthree\n');
    const result = readBoundedRegularFile(path, 12, { tail: true });
    assert.ok(result);
    assert.ok(result.bytes <= 12);
    assert.match(result.content, /three/);
    assert.doesNotMatch(result.content, /discard-this-old-line/);
  });
});

test('bounded regular-file reads reject oversized, symlink and non-regular paths', (t) => {
  withTempDir((dir) => {
    const large = join(dir, 'large.jsonl');
    writeFileSync(large, 'x'.repeat(33));
    assert.equal(readBoundedRegularFile(large, 32), null);

    const target = join(dir, 'target.jsonl');
    const link = join(dir, 'linked.jsonl');
    writeFileSync(target, '{"ruleId":"R","evidence":"secret"}\n');
    try {
      symlinkSync(target, link);
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOSYS', 'UNKNOWN'].includes(error?.code)) {
        t.skip('symlink fixture unavailable on this Windows runner: ' + error.code);
        return;
      }
      throw error;
    }
    assert.equal(readBoundedRegularFile(link, 1024), null);
    assert.equal(readBoundedRegularFile(dir, 1024), null);
  });
});

test('descriptor identity rejects a regular-file replacement between lstat and open', (t) => {
  withTempDir((dir) => {
    const path = join(dir, 'findings.jsonl');
    const originalPath = join(dir, 'findings-original.jsonl');
    writeFileSync(path, '{"ruleId":"ORIGINAL","evidence":"original"}\n');

    let swapped = false;
    const originalOpenSync = fs.openSync;
    const openMock = t.mock.method(fs, 'openSync', (candidatePath, ...args) => {
      if (String(candidatePath) === path && !swapped) {
        swapped = true;
        renameSync(path, originalPath);
        writeFileSync(path, '{"ruleId":"REPLACEMENT","evidence":"must not be read"}\n');
      }
      return originalOpenSync(candidatePath, ...args);
    });

    syncBuiltinESMExports();
    try {
      assert.equal(readBoundedRegularFile(path, 1024), null);
      assert.equal(swapped, true);
    } finally {
      openMock.mock.restore();
      syncBuiltinESMExports();
    }
  });
});

test('findings snapshot deduplicates rotated records in favor of the active file', () => {
  withTempDir((dir) => {
    const oldRecord = {
      signature: 'same-finding',
      ruleId: 'PORT_IN_USE',
      evidence: 'old evidence',
      at: '2026-11-01T10:00:00.000Z',
    };
    const currentRecord = {
      ...oldRecord,
      evidence: 'current evidence',
      at: '2026-11-07T10:00:00.000Z',
    };
    writeFileSync(join(dir, 'findings.jsonl.1'), JSON.stringify(oldRecord) + '\n');
    writeFileSync(join(dir, 'findings.jsonl'), JSON.stringify(currentRecord) + '\n');

    const findings = readFindings(dir);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, 'same-finding');
    assert.equal(findings[0].evidence, 'current evidence');
    assert.equal(findings[0].at, currentRecord.at);
  });
});

test('findings snapshot enforces a caller-supplied line and aggregate byte budget', () => {
  withTempDir((dir) => {
    const records = Array.from({ length: 8 }, (_, index) => ({
      signature: 'finding-' + index,
      ruleId: 'RULE',
      evidence: 'x'.repeat(80),
      at: '2026-11-07T10:00:' + String(index).padStart(2, '0') + '.000Z',
    }));
    writeFileSync(join(dir, 'findings.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
    const findings = readFindings(dir, 200, {
      maxTotalBytes: 128,
      maxFileBytes: 128,
      maxLineBytes: 64,
    });
    assert.deepEqual(findings, []);
  });
});

test('dashboard log snapshot is bounded by bytes, lines and line characters', () => {
  withTempDir((dir) => {
    const lines = ['one', 'second-line', 'third-line', 'fourth-line'];
    writeFileSync(join(dir, 'daemon.log'), lines.join('\n') + '\n');
    const result = readBoundedLogLines(dir, {
      maxBytes: 24,
      maxLines: 2,
      maxLineChars: 5,
    });
    assert.ok(result.length <= 2);
    assert.ok(result.every(item => item.line.length <= 5));
    assert.ok(result.some(item => item.line.startsWith('fourth')));
  });
});

test('directory snapshot enumerates no more than the requested names', () => {
  withTempDir((dir) => {
    for (let index = 0; index < 10; index += 1) {
      writeFileSync(join(dir, 'entry-' + index), 'x');
    }
    const names = readBoundedDirectoryNames(dir, 3);
    assert.equal(names.length, 3);
  });
});
