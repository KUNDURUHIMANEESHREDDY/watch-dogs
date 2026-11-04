import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_DIRECTORY_NAMES, readBoundedDirectoryNames } from '../src/agent/directory-list.mjs';

test('directory listing stops at the configured maximum without materializing every entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'watchdogs-directory-list-'));
  try {
    for (let index = 0; index < 250; index += 1) {
      writeFileSync(join(root, `entry-${String(index).padStart(3, '0')}.json`), '{}');
    }

    const names = readBoundedDirectoryNames(root);
    assert.equal(names.length, MAX_DIRECTORY_NAMES);
    assert.equal(new Set(names).size, MAX_DIRECTORY_NAMES);
    assert.ok(names.every((name) => name.endsWith('.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('directory listing honors smaller limits and rejects invalid limits', () => {
  const root = mkdtempSync(join(tmpdir(), 'watchdogs-directory-list-limit-'));
  try {
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(join(root, `entry-${index}.json`), '{}');
    }

    assert.equal(readBoundedDirectoryNames(root, 3).length, 3);
    assert.throws(() => readBoundedDirectoryNames(root, 0), /limit/);
    assert.throws(() => readBoundedDirectoryNames(root, MAX_DIRECTORY_NAMES + 1), /limit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
