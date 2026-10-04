/**
 * Rollback is not a trusted path.
 *
 * Rollback used to read `abs` from a journal file and hand it straight to
 * writeFileSync, with no guard, no containment and no file-class policy. So the
 * security boundary was:
 *
 *     normal action -> guard
 *     rollback      -> trust the journal
 *
 * A journal entry is a JSON file on disk. Anything able to edit one -- a
 * postinstall script, a compromised dependency, a bug in this program -- could
 * aim a rollback at a file outside the project and have its contents overwritten.
 *
 * These tests plant hostile entries directly and confirm each one is refused.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Applier } from '../src/act/apply.mjs';

const project = () => mkdtempSync(join(tmpdir(), 'wd-rollback-'));

function setup() {
  const root = project();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.js'), 'ORIGINAL\n', 'utf8');
  const data = join(root, '.watchdog');
  const a = new Applier({ projectRoot: root, dataDir: data, autonomy: 'autonomous', allowlist: [] });
  return { root, a };
}

/** Apply a real edit so there is a genuine journal entry to tamper with. */
function applyRealEdit(a, root) {
  return a.apply({ kind: 'patch-file', path: 'src/a.js', find: 'ORIGINAL', replace: 'CHANGED' }, { cwd: root });
}

function journalDir(root) {
  return join(root, '.watchdog', 'journal');
}

function readEntry(root, id) {
  return JSON.parse(readFileSync(join(journalDir(root), `${id}.json`), 'utf8'));
}

function writeEntry(root, id, rec) {
  writeFileSync(join(journalDir(root), `${id}.json`), JSON.stringify(rec), 'utf8');
}

test('the journal records a project-relative path', () => {
  const { root, a } = setup();
  const r = applyRealEdit(a, root);
  assert.equal(r.status, 'applied', JSON.stringify(r));
  const rec = readEntry(root, r.journalId);
  assert.equal(rec.rel, 'src/a.js', 'no relative path recorded, so rollback cannot re-derive the target');
  assert.ok(rec.abs, 'the absolute path is still recorded for display');
});

test('a normal rollback still works', () => {
  const { root, a } = setup();
  const r = applyRealEdit(a, root);
  assert.equal(readFileSync(join(root, 'src', 'a.js'), 'utf8'), 'CHANGED\n');

  const back = a.rollback(r.journalId);
  assert.equal(back.status, 'rolled-back', JSON.stringify(back));
  assert.equal(readFileSync(join(root, 'src', 'a.js'), 'utf8'), 'ORIGINAL\n');
});

test('a journal entry pointing outside the project is refused', () => {
  const { root, a } = setup();
  const outside = join(project(), 'victim.txt');
  writeFileSync(outside, 'SECRET', 'utf8');

  const r = applyRealEdit(a, root);
  const rec = readEntry(root, r.journalId);
  // The attack: keep `rel` innocuous-looking but make abs the real target.
  writeEntry(root, r.journalId, { ...rec, abs: outside, before: 'OVERWRITTEN' });

  const back = a.rollback(r.journalId);
  assert.equal(back.status, 'refused', JSON.stringify(back));
  assert.equal(readFileSync(outside, 'utf8'), 'SECRET', 'the file outside the project was overwritten');
});

test('a traversal in the relative path is refused', () => {
  const { root, a } = setup();
  const outside = join(project(), 'victim.txt');
  writeFileSync(outside, 'SECRET', 'utf8');

  const r = applyRealEdit(a, root);
  const rec = readEntry(root, r.journalId);
  writeEntry(root, r.journalId, { ...rec, rel: '../victim.txt', abs: join(project(), 'victim.txt') });

  const back = a.rollback(r.journalId);
  assert.equal(back.status, 'refused', JSON.stringify(back));
  assert.equal(readFileSync(outside, 'utf8'), 'SECRET');
});

test('an absolute relative-path field is refused', () => {
  const { root, a } = setup();
  const r = applyRealEdit(a, root);
  const rec = readEntry(root, r.journalId);
  writeEntry(root, r.journalId, { ...rec, rel: 'C:/Windows/System32/drivers/etc/hosts', abs: 'C:/Windows/System32/drivers/etc/hosts' });

  const back = a.rollback(r.journalId);
  assert.equal(back.status, 'refused', JSON.stringify(back));
});

test('an entry with no relative path is refused rather than guessed at', () => {
  // Entries written before this change have no `rel`. Guessing where they meant
  // to point would defeat the point of checking.
  const { root, a } = setup();
  const r = applyRealEdit(a, root);
  const rec = readEntry(root, r.journalId);
  delete rec.rel;
  writeEntry(root, r.journalId, rec);

  const back = a.rollback(r.journalId);
  assert.equal(back.status, 'refused', JSON.stringify(back));
  assert.match(back.why, /relative path/);
});

test('a journal aimed at a credential file is refused', () => {
  // Restoring a "change" to .env is still a write to a credential file.
  const { root, a } = setup();
  writeFileSync(join(root, '.env'), 'TOKEN=original\n', 'utf8');
  const r = applyRealEdit(a, root);
  const rec = readEntry(root, r.journalId);
  writeEntry(root, r.journalId, { ...rec, rel: '.env', abs: join(root, '.env') });

  const back = a.rollback(r.journalId);
  assert.equal(back.status, 'refused', JSON.stringify(back));
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'TOKEN=original\n');
});

test('a journal aimed at a git hook is refused', () => {
  const { root, a } = setup();
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
  writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n', 'utf8');
  const r = applyRealEdit(a, root);
  const rec = readEntry(root, r.journalId);
  writeEntry(root, r.journalId, {
    ...rec,
    rel: '.git/hooks/pre-commit',
    abs: join(root, '.git', 'hooks', 'pre-commit'),
  });

  const back = a.rollback(r.journalId);
  assert.equal(back.status, 'refused', JSON.stringify(back));
});

test('a mismatch between abs and rel is treated as tampering', () => {
  // Even a plausible-looking rel is refused when the two fields disagree, because
  // choosing one of them would mean trusting an edited journal.
  const { root, a } = setup();
  const r = applyRealEdit(a, root);
  const rec = readEntry(root, r.journalId);
  writeEntry(root, r.journalId, { ...rec, abs: join(root, 'src', 'other.js') });

  const back = a.rollback(r.journalId);
  assert.equal(back.status, 'refused', JSON.stringify(back));
  assert.match(back.why, /does not match/);
});

test('the journal directory is not itself a way out', () => {
  // Sanity: the entry we tamper with is a real one this program wrote, so the
  // refusal is caused by the validation and not by a missing file.
  const { root, a } = setup();
  const r = applyRealEdit(a, root);
  assert.ok(existsSync(join(journalDir(root), `${r.journalId}.json`)));
  assert.equal(a.rollback(r.journalId).status, 'rolled-back');
});