/**
 * Hardlinks: the last containment gap, closed by removing the capability.
 *
 * A hardlink inside the project to a file outside it defeats every path-based
 * check, and cannot be caught by one:
 *
 *   project/src/data.js  ->  C:\elsewhere\secret.txt
 *
 * The path is inside the project. realpath agrees. `ino` and `dev` match the
 * outside file, because they *are* the outside file -- a hardlink is not an
 * indirection to be resolved, it is a second name for one inode. There is no
 * portable way to enumerate the other names, so detection could never be complete.
 *
 * The fix is therefore structural rather than detective. Content is replaced by
 * renaming a new file over the directory entry, so the in-project name is
 * repointed and any shared inode keeps its own bytes. Nothing writes through a
 * handle, so there is no primitive for a hardlink to redirect.
 *
 * These tests use real hardlinks, created with `fsutil hardlink create`, which
 * works on this machine without elevation. A mocked link count would test the
 * branch and not the filesystem.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openContained, containedPath, readFd, writeFd, safeClose } from '../src/act/containment.mjs';
import { atomicReplace } from '../src/act/atomic.mjs';

/** Make a hard link, or return null if this filesystem will not. */
function hardlink(from, to) {
  try {
    execFileSync('fsutil', ['hardlink', 'create', to, from], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return null; // not NTFS, or not permitted here
  }
}

/**
 * A project directory plus a file *outside* it that the project will link to.
 * The separation is the whole point: `outside` is a sibling, not a subdirectory.
 */
function scenario() {
  const base = mkdtempSync(join(tmpdir(), 'wd-hardlink-'));
  const root = join(base, 'project');
  const outside = join(base, 'outside');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(outside, { recursive: true });

  const secret = join(outside, 'secret.txt');
  writeFileSync(secret, 'ORIGINAL SECRET\n', 'utf8');

  const link = join(root, 'src', 'data.js');
  const made = hardlink(secret, link);

  return { base, root, outside, secret, link, made };
}

test('a hardlink into the project is refused, not followed', (t) => {
  const s = scenario();
  t.after(() => rmSync(s.base, { recursive: true, force: true }));

  assert.ok(s.made, 'this filesystem refused to make a hardlink, so nothing is proven');

  // Every path-based check passes. This is the trap: a boundary that only consults
  // paths will wave this through.
  const check = containedPath(s.root, 'src/data.js');
  assert.equal(check.ok, true, 'expected the path checks to pass -- that is what makes this hard');
  assert.equal(readFileSync(s.link, 'utf8'), 'ORIGINAL SECRET\n', 'the link really does read the outside file');

  // Containment refuses anyway, because the link count says this inode answers to
  // more than one name and the others cannot be located from here.
  const r = openContained(s.root, 'src/data.js');
  assert.equal(r.ok, false, 'a hardlinked file was opened');
  assert.equal(r.why, 'hardlink');
  assert.match(r.detail, /cannot be determined from inside the project/);
});

test('the refusal happens before anything is opened', (t) => {
  const s = scenario();
  t.after(() => rmSync(s.base, { recursive: true, force: true }));
  assert.ok(s.made);

  // onChecked fires in the gap between checking the path and opening it. If the
  // hardlink refusal happens after that, a descriptor has already been taken.
  let reached = false;
  const r = openContained(s.root, 'src/data.js', {
    onChecked: () => {
      reached = true;
    },
  });
  assert.equal(r.ok, false);
  assert.equal(reached, false, 'a descriptor was taken before the hardlink was noticed');
});

test('ordinary single-name files are unaffected', (t) => {
  const s = scenario();
  t.after(() => rmSync(s.base, { recursive: true, force: true }));

  // The refusal must not be so broad that it refuses normal work. This is the test
  // that would catch a regression from "nlink > 1" to "any file".
  writeFileSync(join(s.root, 'src', 'normal.js'), 'x = 1\n', 'utf8');
  const r = openContained(s.root, 'src/normal.js');
  assert.equal(r.ok, true, r.detail);
  assert.equal(readFd(r.fd, 'utf8'), 'x = 1\n');
  safeClose(r.fd);
});

test('the outside file survives a replacement of the in-project name', (t) => {
  const s = scenario();
  t.after(() => rmSync(s.base, { recursive: true, force: true }));
  assert.ok(s.made);

  // Even if a hardlinked path were somehow reached, the replacement is a rename
  // over the directory entry. The in-project name points at new bytes; the shared
  // inode keeps what it always had. This is the property that makes the gap
  // unreachable rather than merely unlikely.
  atomicReplace(s.link, 'PATCHED BY THE WATCHDOG\n');

  assert.equal(readFileSync(s.link, 'utf8'), 'PATCHED BY THE WATCHDOG\n', 'the project name was not repointed');
  assert.equal(
    readFileSync(s.secret, 'utf8'),
    'ORIGINAL SECRET\n',
    'the outside file was modified through the shared inode',
  );
});

test('two names inside the project are also refused', (t) => {
  const s = scenario();
  t.after(() => rmSync(s.base, { recursive: true, force: true }));

  // The reasoning is not "the other name is outside". It is "the other name cannot
  // be located", which is equally true when both are inside. Refusing is correct
  // here too, and the message must not claim otherwise.
  const first = join(s.root, 'src', 'one.js');
  writeFileSync(first, 'shared\n', 'utf8');
  const second = join(s.root, 'src', 'two.js');
  assert.ok(hardlink(first, second));

  const r = openContained(s.root, 'src/one.js');
  assert.equal(r.ok, false);
  assert.equal(r.why, 'hardlink');
  assert.doesNotMatch(r.detail, /outside/i, 'the message asserts where the other name is, which nobody checked');
});