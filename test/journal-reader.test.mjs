import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJournal } from '../src/agent/journal-reader.mjs';

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
      const id = `${(base + i).toString(36)}-${i.toString(36)}`;
      ids.push(id);
      writeFileSync(join(journalDir, `${id}.json`), JSON.stringify({
        id,
        at: new Date(base + i).toISOString(),
        outcome: 'verified',
        type: 'patch',
        abs: join(projectRoot, `file-${i}.js`),
        why: 'x'.repeat(300)
      }));
    }

    const oversizedId = `${(base + 1000).toString(36)}-oversized`;
    writeFileSync(join(journalDir, `${oversizedId}.json`), 'x'.repeat(256 * 1024 + 1));
    const corruptId = `${(base + 1001).toString(36)}-corrupt`;
    writeFileSync(join(journalDir, `${corruptId}.json`), '{not-json');

    const outsideId = `${(base + 1002).toString(36)}-outside`;
    writeFileSync(join(journalDir, `${outsideId}.json`), JSON.stringify({
      id: outsideId,
      at: new Date(base + 1002).toISOString(),
      outcome: 'unknown',
      type: 'patch',
      abs: join(root, 'outside-secret.js'),
      why: 'outside project'
    }));

    // A journal entry must be a regular file, not a symlink that redirects
    // the snapshot reader outside the journal directory.
    const symlinkId = `${(base + 1003).toString(36)}-symlink`;
    const symlinkTarget = join(root, 'symlink-target.json');
    writeFileSync(symlinkTarget, JSON.stringify({
      id: symlinkId,
      at: new Date(base + 1003).toISOString(),
      outcome: 'unknown',
      type: 'patch',
      abs: join(projectRoot, 'safe.js'),
      why: 'must not be read through a symlink'
    }));
    symlinkSync(symlinkTarget, join(journalDir, `${symlinkId}.json`));

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
