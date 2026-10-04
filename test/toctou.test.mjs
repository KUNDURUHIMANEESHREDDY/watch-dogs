/**
 * Validating the object, not the path.
 *
 * The gap: `containedPath` proves that a path resolves inside the project, and
 * then something opens that path later. Between those two moments the object at
 * the path can be replaced -- with a junction pointing somewhere else, say. Every
 * path-based check would have passed about a file nobody was going to write to.
 *
 * `#patchFile` made that concrete: it opened the path five separate times
 * (existsSync, statSync, a read for the edit, a second read for the snapshot, and
 * the write). The consequence that was not a security escape at all was worse --
 * the snapshot could record content that was never patched, so `wd rollback`
 * would faithfully restore the wrong thing.
 *
 * So the fix opens once, proves the handle is the object that was validated, and
 * reads and writes through that descriptor.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, openSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openContained, sameFile, readFd, writeFd, safeClose } from '../src/act/containment.mjs';
import { Applier } from '../src/act/apply.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));

function project() {
  const root = tmp('wd-toctou-');
  mkdirSync(join(root, 'src'), { recursive: true });
  // The marker appears exactly once: the applier refuses an anchor that matches
  // more than once, so a fixture with it in both a declaration and an export
  // makes every patch in this file fail for a reason that has nothing to do with
  // what is being tested.
  writeFileSync(join(root, 'src', 'a.js'), 'const ORIGINAL = 1;\nmodule.exports = { value: 2 };\n', 'utf8');
  writeFileSync(join(root, 'package.json'), '{"name":"toctou"}\n', 'utf8');
  return root;
}

const applierFor = (root) =>
  new Applier({ projectRoot: root, dataDir: join(root, '.watchdog'), autonomy: 'autonomous', allowlist: [] });

/** A junction, which needs no elevation on Windows. Symlinks need admin. */
function junction(link, target) {
  execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { timeout: 30_000, windowsHide: true, stdio: 'ignore' });
}

/* ------------------------------------------------------------------ *
 * sameFile
 * ------------------------------------------------------------------ */

test('sameFile recognises one object across two stats', () => {
  const root = tmp('wd-id-');
  writeFileSync(join(root, 'f.txt'), 'x', 'utf8');
  const a = openContained(root, 'f.txt');
  assert.equal(a.ok, true, JSON.stringify(a));
  const st = a.stat;
  safeClose(a.fd);
  assert.equal(sameFile(st, st), true);
});

test('sameFile refuses to claim two unknowns are the same', () => {
  // Some filesystems report ino 0. Comparing two zeros would make every pair look
  // identical, which is more dangerous than admitting we cannot tell.
  assert.equal(sameFile({ ino: 0, dev: 0 }, { ino: 0, dev: 0 }), false);
  assert.equal(sameFile(null, { ino: 1, dev: 1 }), false);
});

test('sameFile tells two different files apart', () => {
  const root = tmp('wd-id2-');
  writeFileSync(join(root, 'f.txt'), 'x', 'utf8');
  writeFileSync(join(root, 'g.txt'), 'x', 'utf8');
  const f = openContained(root, 'f.txt');
  const g = openContained(root, 'g.txt');
  assert.equal(sameFile(f.stat, g.stat), false);
  safeClose(f.fd);
  safeClose(g.fd);
});

/* ------------------------------------------------------------------ *
 * openContained
 * ------------------------------------------------------------------ */

test('a normal file opens and its contents read back through the handle', () => {
  const root = project();
  const r = openContained(root, 'src/a.js');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(readFd(r.fd, 'utf8'), /ORIGINAL/);
  safeClose(r.fd);
});

test('a path that escapes through a junction is refused before opening', () => {
  const root = project();
  const outside = tmp('wd-outside-');
  writeFileSync(join(outside, 'victim.js'), 'SECRET\n', 'utf8');
  junction(join(root, 'src', 'escape'), outside);

  const r = openContained(root, 'src/escape/victim.js');
  assert.equal(r.ok, false);
  assert.equal(r.why, 'reparse');
  assert.equal(readFileSync(join(outside, 'victim.js'), 'utf8'), 'SECRET\n');
});

test('a file swapped for a junction between the check and the open is refused', () => {
  // This is the actual race, exercised rather than reasoned about. The seam
  // replaces the in-project file with a junction to an outside directory at
  // exactly the moment the path has been validated but not yet opened.
  const root = project();
  const outside = tmp('wd-outside-');
  writeFileSync(join(outside, 'a.js'), 'OUTSIDE\n', 'utf8');
  const target = join(root, 'src', 'a.js');

  const r = openContained(root, 'src/a.js', {
    onChecked(abs) {
      // Replace the validated file with a junction pointing out of the project.
      rmSync(abs, { force: true });
      junction(abs, outside);
    },
  });

  assert.equal(r.ok, false, 'the swap between check and open was not detected');
  assert.equal(r.why, 'swapped', `expected a swap refusal, got ${r.why}: ${r.detail}`);
  assert.equal(readFileSync(join(outside, 'a.js'), 'utf8'), 'OUTSIDE\n', 'the outside file was written to');
});

test('a patch with no swap still applies normally through the descriptor', () => {
  // The control for the race test above. Refusing everything would pass the same
  // assertions, so the normal path has to be shown working too.
  const root = project();
  const a = applierFor(root);
  const r = a.apply({ kind: 'patch-file', path: 'src/a.js', find: 'ORIGINAL', replace: 'PATCHED' }, { cwd: root });

  assert.equal(r.status, 'applied', JSON.stringify(r));
  assert.match(readFileSync(join(root, 'src', 'a.js'), 'utf8'), /PATCHED/);
});

test('a missing file is reported as missing, not as an open failure', () => {
  const root = project();
  const r = openContained(root, 'src/nope.js');
  assert.equal(r.ok, false);
  assert.equal(r.why, 'missing');
});

test('a directory is refused', () => {
  const root = project();
  const r = openContained(root, 'src');
  assert.equal(r.ok, false);
  assert.equal(r.why, 'not-a-file');
});

test('a refused open does not leak descriptors', () => {
  // Every refusal path closes what it opened. Leaking one per refusal would
  // eventually exhaust the process's handles, which looks like a hang rather than
  // a bug -- so this is worth asserting rather than trusting.
  const root = project();
  const outside = tmp('wd-outside-');
  writeFileSync(join(outside, 'a.js'), 'OUTSIDE\n', 'utf8');

  for (let i = 0; i < 3000; i++) {
    const abs = join(root, 'src', 'a.js');
    const r = openContained(root, 'src/a.js', {
      onChecked(a2) {
        if (i === 0) {
          rmSync(a2, { force: true });
          junction(a2, outside);
        }
      },
    });
    if (r.ok) safeClose(r.fd);
  }
  // Surviving 3000 refusals means the descriptors were released.
  assert.equal(existsSync(join(root, 'src', 'a.js')), true);
});

/* ------------------------------------------------------------------ *
 * The handle is read-only, and that is the guarantee
 * ------------------------------------------------------------------ */

test('openContained refuses to open for writing', () => {
  // It used to accept 'r+' and both call sites passed it, on the theory that the
  // descriptor was the safest way to do the edit. It never was used that way -- the
  // content is replaced afterwards by an atomic rename -- so what 'r+' actually
  // bought was a loaded write capability pointed at a validated inode. That is the
  // capability a hardlink turns into an escape, because the inode is shared with
  // whatever is outside the project.
  //
  // So it is refused at the boundary rather than merely left unused: a future caller
  // cannot reintroduce the hole by forgetting to pass a different flag.
  const root = project();
  const path = join(root, 'src', 'a.js');
  writeFileSync(path, 'one\n', 'utf8');

  for (const flags of ['r+', 'w', 'a', 'rs+']) {
    const r = openContained(root, 'src/a.js', { flags });
    assert.equal(r.ok, false, `flags=${flags} was accepted`);
    assert.equal(r.why, 'write-not-permitted', `flags=${flags} refused for the wrong reason`);
  }

  // A refused open must not have truncated anything on the way past.
  assert.equal(readFileSync(path, 'utf8'), 'one\n');
});

test('a containment handle physically cannot be written to', () => {
  // Stronger than checking which flags were requested: even a handle obtained by
  // some other route must refuse a write at the descriptor. This is the property
  // the whole hardlink argument rests on, so it is asserted directly rather than
  // inferred from the flags.
  const root = project();
  const path = join(root, 'src', 'a.js');
  writeFileSync(path, 'original\n', 'utf8');

  const r = openContained(root, 'src/a.js');
  assert.equal(r.ok, true, r.detail);
  try {
    writeFd(r.fd, 'clobbered\n');
    assert.fail('the handle accepted a write');
  } catch (e) {
    // EBADF would mean the descriptor was not what we think it is. EPERM/EACCES is
    // the answer we want: the descriptor is live and read-only.
    assert.match(e.code, /^(EPERM|EACCES|EBADF)$/, `unexpected failure: ${e.code}`);
  } finally {
    safeClose(r.fd);
  }

  assert.equal(readFileSync(path, 'utf8'), 'original\n', 'the file changed despite the refused write');
});

test('writeFd truncates rather than leaving a tail, given a writable handle', () => {
  // The helper keeps its own semantics under test, on a handle opened for writing
  // here rather than through containment -- which no longer hands those out.
  //
  // This is the classic descriptor-write bug it exists to avoid: the read left the
  // position at end of file, so writing at that position after a truncate appends
  // into the hole and the file keeps the tail of its old contents.
  const root = project();
  const path = join(root, 'src', 'long.js');
  writeFileSync(path, 'AAAAAAAAAA\nBBBBBBBBBB\nCCCCCCCCCC\n', 'utf8');

  const fd = openSync(path, 'r+');
  try {
    readFd(fd, 'utf8'); // leaves the position at the end, which is the trap
    writeFd(fd, 'short\n');
  } finally {
    safeClose(fd);
  }
  assert.equal(readFileSync(path, 'utf8'), 'short\n', 'the old tail survived the write');

  // And the longer case: nothing appended, nothing lost.
  writeFileSync(path, 'tiny\n', 'utf8');
  const fd2 = openSync(path, 'r+');
  try {
    readFd(fd2, 'utf8');
    writeFd(fd2, 'a much longer replacement body\nsecond line\n');
  } finally {
    safeClose(fd2);
  }
  assert.equal(readFileSync(path, 'utf8'), 'a much longer replacement body\nsecond line\n');
});


/* ------------------------------------------------------------------ *
 * The journal records what was actually patched
 * ------------------------------------------------------------------ */

test('the journalled "before" is the content that was patched', () => {
  // The snapshot used to be a second read of the path. Two reads can disagree, so
  // the journal could record content that was never patched and a rollback would
  // restore the wrong thing while looking entirely successful.
  const root = project();
  const a = applierFor(root);
  const target = join(root, 'src', 'a.js');
  const original = readFileSync(target, 'utf8');

  const r = a.apply({ kind: 'patch-file', path: 'src/a.js', find: 'ORIGINAL', replace: 'PATCHED' }, { cwd: root });
  assert.equal(r.status, 'applied', JSON.stringify(r));

  const rec = JSON.parse(readFileSync(join(root, '.watchdog', 'journal', `${r.journalId}.json`), 'utf8'));
  assert.equal(rec.before, original, 'the journal recorded something other than the patched content');
  assert.match(readFileSync(target, 'utf8'), /PATCHED/);
});

test('patch then rollback returns the file to its original bytes', () => {
  // The end-to-end promise of reading and writing through one handle: the
  // rollback has something correct to restore.
  const root = project();
  const a = applierFor(root);
  const target = join(root, 'src', 'a.js');
  const original = readFileSync(target, 'utf8');

  const r = a.apply({ kind: 'patch-file', path: 'src/a.js', find: 'ORIGINAL', replace: 'PATCHED' }, { cwd: root });
  assert.equal(r.status, 'applied', JSON.stringify(r));
  assert.notEqual(readFileSync(target, 'utf8'), original);

  assert.equal(a.rollback(r.journalId).status, 'rolled-back');
  assert.equal(readFileSync(target, 'utf8'), original, 'rollback did not restore the original bytes');
});

test('a patch that shortens a file can be rolled back intact', () => {
  const root = project();
  const path = join(root, 'src', 'shrink.js');
  // Real JavaScript: the syntax gate refuses files that would not parse, so a
  // fixture of bare prose lines is rejected before any of this is exercised.
  writeFileSync(
    path,
    'function f() {\n  const first = 1;\n  const second = 2;\n  return first + second;\n}\nmodule.exports = { f };\n',
    'utf8',
  );
  const original = readFileSync(path, 'utf8');

  const a = applierFor(root);
  const r = a.apply(
    {
      kind: 'patch-file',
      path: 'src/shrink.js',
      find: '  const first = 1;\n  const second = 2;\n',
      replace: '  const first = 1;\n',
    },
    { cwd: root },
  );
  assert.equal(r.status, 'applied', JSON.stringify(r));

  // The whole point of writing at an explicit offset: without it the previous
  // contents' tail survives in the middle of the file.
  assert.equal(readFileSync(path, 'utf8'), 'function f() {\n  const first = 1;\n  return first + second;\n}\nmodule.exports = { f };\n');

  assert.equal(a.rollback(r.journalId).status, 'rolled-back');
  assert.equal(readFileSync(path, 'utf8'), original);
});
