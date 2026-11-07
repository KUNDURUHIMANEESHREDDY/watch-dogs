import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_JOURNAL_TOTAL_BYTES, readJournal } from '../src/agent/journal-reader.mjs';

test('journal snapshot bounds entry count and skips corrupt or oversized files', () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-dogs-journal-reader-'));
  const dataDir = join(root, '.watchdog');
  const journalDir = join(dataDir, 'journal');
  const projectRoot = join(root, 'project');
  mkdirSync(journalDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });

  try {
    const base = Date.now();
    const ids = [];
    for (let i = 0; i < 205; i += 1) {
      const id = (base + i).toString(36) + '-' + i.toString(36);
      ids.push(id);
      writeFileSync(join(journalDir, id + '.json'), JSON.stringify({
        id,
        at: new Date(base + i).toISOString(),
        outcome: 'verified',
        type: 'patch',
        abs: join(projectRoot, 'file-' + i + '.js'),
        why: 'x'.repeat(300)
      }));
    }

    const oversizedId = (base + 1000).toString(36) + '-oversized';
    writeFileSync(join(journalDir, oversizedId + '.json'), 'x'.repeat(256 * 1024 + 1));
    const corruptId = (base + 1001).toString(36) + '-corrupt';
    writeFileSync(join(journalDir, corruptId + '.json'), '{not-json');

    const outsideId = (base + 1002).toString(36) + '-outside';
    writeFileSync(join(journalDir, outsideId + '.json'), JSON.stringify({
      id: outsideId,
      at: new Date(base + 1002).toISOString(),
      outcome: 'unknown',
      type: 'patch',
      abs: join(root, 'outside-secret.js'),
      why: 'outside project'
    }));

    // A journal entry must be a regular file, not a symlink that redirects
    // the snapshot reader outside the journal directory.
    const symlinkId = (base + 1003).toString(36) + '-symlink';
    const symlinkTarget = join(root, 'symlink-target.json');
    writeFileSync(symlinkTarget, JSON.stringify({
      id: symlinkId,
      at: new Date(base + 1003).toISOString(),
      outcome: 'unknown',
      type: 'patch',
      abs: join(projectRoot, 'safe.js'),
      why: 'must not be read through a symlink'
    }));
    symlinkSync(symlinkTarget, join(journalDir, symlinkId + '.json'));

    const entries = readJournal(dataDir, projectRoot, 500);
    assert.equal(entries.length, 100, 'requested limits are capped at 100');
    assert.equal(entries[0].id, outsideId, 'newest valid entry is first');
    assert.equal(entries[0].target, '[outside project]', 'outside paths are redacted');
    assert.equal(entries.at(-1).id, ids[106], 'only the newest bounded window is returned');
    assert.ok(entries.every(entry => entry.reason.length <= 240));
    assert.ok(!entries.some(entry => entry.id === oversizedId || entry.id === corruptId || entry.id === symlinkId));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('journal reader returns an empty snapshot for a missing journal directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-dogs-journal-missing-'));
  try {
    assert.deepEqual(readJournal(root, root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('journal reader refuses a journal directory that is a symlink', t => {
  const root = mkdtempSync(join(tmpdir(), 'watch-dogs-journal-dir-link-'));
  const dataDir = join(root, '.watchdog');
  const externalJournalDir = join(root, 'external-journal');
  const projectRoot = join(root, 'project');
  const journalDir = join(dataDir, 'journal');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(externalJournalDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });

  try {
    writeFileSync(join(externalJournalDir, '20260101-entry.json'), JSON.stringify({
      id: 'external-entry',
      at: '2026-01-01T00:00:00.000Z',
      outcome: 'verified',
      type: 'patch',
      abs: join(projectRoot, 'file.js'),
      why: 'must not be read from a redirected directory'
    }));

    try {
      symlinkSync(externalJournalDir, journalDir, 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
        t.skip('directory symlinks are unavailable on this runner (' + error.code + ')');
        return;
      }
      throw error;
    }

    assert.deepEqual(readJournal(dataDir, projectRoot), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('journal reader keeps newest results after streaming more than five directory batches', () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-dogs-journal-many-'));
  const dataDir = join(root, '.watchdog');
  const journalDir = join(dataDir, 'journal');
  const projectRoot = join(root, 'project');
  mkdirSync(journalDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });

  try {
    const base = Date.now();
    const ids = [];
    for (let i = 0; i < 1205; i += 1) {
      const id = (base + i).toString(36) + '-' + i.toString(36);
      ids.push(id);
      writeFileSync(join(journalDir, id + '.json'), JSON.stringify({
        id,
        at: new Date(base + i).toISOString(),
        outcome: 'verified',
        type: 'patch',
        abs: join(projectRoot, 'file-' + i + '.js'),
        why: 'bounded journal fixture'
      }));
    }

    const entries = readJournal(dataDir, projectRoot);
    assert.equal(entries.length, 100);
    assert.deepEqual(entries.map(entry => entry.id), ids.slice(-100).reverse());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('journal snapshot enforces an aggregate byte budget and keeps newest entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-dogs-journal-byte-budget-'));
  const dataDir = join(root, '.watchdog');
  const journalDir = join(dataDir, 'journal');
  const projectRoot = join(root, 'project');
  mkdirSync(journalDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });

  try {
    const base = Date.now();
    const reason = 'x'.repeat(100 * 1024);
    const sample = JSON.stringify({
      id: 'entry-000',
      at: new Date(base).toISOString(),
      outcome: 'verified',
      type: 'patch',
      abs: join(projectRoot, 'file.js'),
      why: reason
    });
    const entryBytes = Buffer.byteLength(sample);
    assert.ok(entryBytes < 256 * 1024, 'each fixture must fit the per-entry cap');
    const expectedCount = Math.floor(MAX_JOURNAL_TOTAL_BYTES / entryBytes);
    const ids = [];

    for (let i = 0; i < 50; i += 1) {
      const id = 'entry-' + String(i).padStart(3, '0');
      ids.push(id);
      const contents = JSON.stringify({
        id,
        at: new Date(base + i).toISOString(),
        outcome: 'verified',
        type: 'patch',
        abs: join(projectRoot, 'file.js'),
        why: reason
      });
      assert.equal(Buffer.byteLength(contents), entryBytes);
      writeFileSync(join(journalDir, (base + i).toString(36).padStart(10, '0') + '-' + id + '.json'), contents);
    }

    const entries = readJournal(dataDir, projectRoot, 100);
    assert.equal(entries.length, expectedCount, 'total parsed file bytes must stay within the aggregate budget');
    assert.equal(entries[0].id, ids.at(-1), 'newest entries must be preferred');
    assert.equal(entries.at(-1).id, ids[50 - expectedCount], 'older entries beyond the byte budget must be omitted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('journal reader does not block when a regular entry is replaced with a FIFO before open', t => {
  if (process.platform === 'win32') {
    t.skip('POSIX FIFO semantics are not available on Windows');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'watch-dogs-journal-fifo-'));
  const dataDir = join(root, '.watchdog');
  const journalDir = join(dataDir, 'journal');
  const projectRoot = join(root, 'project');
  const path = join(journalDir, '20261105-entry.json');
  const originalPath = path + '.original';
  const fifoPath = path + '.fifo';
  mkdirSync(journalDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });

  try {
    writeFileSync(path, JSON.stringify({
      id: 'regular-entry',
      at: '2026-11-05T00:00:00.000Z',
      outcome: 'verified',
      type: 'patch',
      abs: join(projectRoot, 'file.js'),
      why: 'regular fixture'
    }));

    try {
      execFileSync('mkfifo', [fifoPath], { stdio: 'ignore' });
    } catch (error) {
      if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) {
        t.skip('mkfifo is unavailable on this runner');
        return;
      }
      throw error;
    }

    let swapped = false;
    const originalOpenSync = fs.openSync;
    const openMock = t.mock.method(fs, 'openSync', (candidatePath, flags, mode) => {
      if (String(candidatePath) === path && !swapped) {
        swapped = true;
        renameSync(path, originalPath);
        renameSync(fifoPath, path);
        assert.equal(typeof flags, 'number');
        assert.notEqual(flags & fs.constants.O_NONBLOCK, 0, 'journal reads must be nonblocking');
      }
      return originalOpenSync(candidatePath, flags, mode);
    });

    syncBuiltinESMExports();
    try {
      assert.deepEqual(readJournal(dataDir, projectRoot), []);
      assert.equal(swapped, true, 'test must replace the path after initial lstat');
    } finally {
      openMock.mock.restore();
      syncBuiltinESMExports();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
