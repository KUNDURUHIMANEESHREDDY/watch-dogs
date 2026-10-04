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
import { loadConfig, DEFAULTS, deepMerge } from '../src/core/config.mjs';

/** Project with a package.json so findProjectRoot terminates. */
const project = () => {
  const root = mkdtempSync(join(tmpdir(), 'wd-rollback-'));
  writeFileSync(join(root, 'package.json'), '{"name":"rb"}\n', 'utf8');
  return root;
};

/** The global layer holds live credentials; these tests must not read it. */
function withIsolatedHome(fn) {
  const orig = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  const home = mkdtempSync(join(tmpdir(), 'wd-home-'));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

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

/**
 * Prove a refusal was caused by the validation and not by a missing file.
 *
 * A test that asserts `status === 'refused'` passes for the wrong reason if the
 * target never existed, so each hostile case re-runs the same rollback after
 * repairing the entry and requires it to actually roll back.
 */
function assertRefusalIsReal(a, root, id, repair) {
  const refused = a.rollback(id);
  assert.equal(refused.status, 'refused', `expected a refusal, got ${JSON.stringify(refused)}`);

  const rec = JSON.parse(readFileSync(join(journalDir(root), `${id}.json`), 'utf8'));
  assert.equal(rec.outcome, 'ok', 'the entry was mutated despite being refused');
  writeEntry(root, id, repair(rec));
  const repaired = a.rollback(id);
  assert.equal(repaired.status, 'rolled-back', `the refusal was not caused by the tampering: ${JSON.stringify(repaired)}`);
}

test('loading one project does not change what the next project gets', () => {
  // DEFAULTS is frozen, which looks immutable but is only one level deep. The
  // merge used to share DEFAULTS.paths by reference, so `merged.paths.data = ...`
  // wrote through into the default and the second project inherited the first
  // project's data directory.
  withIsolatedHome(() => {
    const a = project();
    const b = project();
    const first = loadConfig({ cwd: a, projectRoot: a });
    const second = loadConfig({ cwd: b, projectRoot: b });

    assert.equal(first.paths.data, join(a, '.watchdog'));
    assert.equal(second.paths.data, join(b, '.watchdog'), 'the second project inherited the first data dir');
    assert.notEqual(DEFAULTS.paths.data, join(a, '.watchdog'), 'DEFAULTS was mutated');
  });
});

test('a merged config does not alias the defaults', () => {
  withIsolatedHome(() => {
    const root = project();
    const cfg = loadConfig({ cwd: root, projectRoot: root });

    cfg.analyze.llm.enabled = false;
    cfg.analyze.llm.cli = 'tampered';
    cfg.ignore.push('**/secret/**');

    assert.equal(DEFAULTS.analyze.llm.enabled, true, 'a nested default was mutated through the result');
    assert.equal(DEFAULTS.analyze.llm.cli, 'opencode');
    assert.ok(!DEFAULTS.ignore.includes('**/secret/**'), 'the default ignore list was mutated');
  });
});

test('two deepMerge results never share a nested object', () => {
  const base = { a: { b: { c: 1 } }, list: [1, 2] };
  const one = deepMerge(base, {});
  const two = deepMerge(base, {});
  one.a.b.c = 99;
  one.list.push(3);
  assert.equal(two.a.b.c, 1, 'nested objects are shared between results');
  assert.deepEqual(base.list, [1, 2], 'an array was shared with the base');
  assert.equal(base.a.b.c, 1, 'the base was mutated');
});

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

  assertRefusalIsReal(a, root, r.journalId, (r2) => ({ ...r2, abs: join(root, 'src', 'a.js'), before: 'ORIGINAL\n' }));
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

  // Repairing the entry must make it work, proving the refusal was about the
  // missing relative path and not about anything incidental.
  writeEntry(root, r.journalId, { ...readEntry(root, r.journalId), rel: 'src/a.js' });
  assert.equal(a.rollback(r.journalId).status, 'rolled-back');
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

  writeEntry(root, r.journalId, { ...readEntry(root, r.journalId), abs: join(root, 'src', 'a.js') });
  assert.equal(a.rollback(r.journalId).status, 'rolled-back');
});

test('the journal directory is not itself a way out', () => {
  // Sanity: the entry we tamper with is a real one this program wrote, so the
  // refusal is caused by the validation and not by a missing file.
  const { root, a } = setup();
  const r = applyRealEdit(a, root);
  assert.ok(existsSync(join(journalDir(root), `${r.journalId}.json`)));
  assert.equal(a.rollback(r.journalId).status, 'rolled-back');
});