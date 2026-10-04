/**
 * Filesystem containment.
 *
 * The guard and the applier both used `relative(root, target)` to decide whether
 * a path was inside the project. That is a purely lexical comparison, and it is
 * not a security boundary: a junction or symlink placed inside the project
 * resolves to somewhere else entirely.
 *
 *   project/src/escape -> C:\elsewhere        (junction)
 *   relative(root, project\src\escape\f.txt) = src\escape\f.txt   passes
 *   realpath(...)                             = C:\elsewhere\f.txt  escapes
 *
 * Reproduced on this machine with `mklink /J`, which needs no elevation.
 *
 * Two limits worth stating plainly, because a boundary that looks stronger than
 * it is worse than a known weak one:
 *
 *   - A legitimate junction used by the project itself would be refused, because
 *     its real target is outside the root. That is the correct direction to fail:
 *     the guard is not trying to be clever about intent, only to refuse.
 *
 * And one that is now closed, which used to be the gap described above:
 *
 *   - Validating a path and then opening it later is not the same as validating
 *     the thing you opened. Between the realpath check and the write, the object
 *     at that path can be replaced. `openContained` below closes that by checking
 *     the identity of the object it actually holds a handle to.
 *
 * Hardlinks remain invisible: a hardlink inside the project to a file outside it
 * reports the in-project path from every API, and its identity is that of the
 * original. Nothing path-based can see it.
 */
import { realpathSync, lstatSync, fstatSync, openSync, closeSync, readFileSync, writeSync, ftruncateSync } from 'node:fs';
import { resolve, relative, isAbsolute, join, dirname, basename } from 'node:path';

/**
 * Resolve a path to its real location, tolerating a tail that does not exist yet.
 *
 * Targets routinely do not exist -- that is the point of a create -- so
 * realpath() is applied to the nearest ancestor that does exist and the missing
 * remainder is re-appended. Plain realpath() would just throw and the caller
 * would be tempted to allow on failure, which is exactly the wrong default.
 */
export function realpathNearest(target) {
  let current = resolve(target);
  const tail = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return tail.length ? join(real, ...tail) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        // Reached the filesystem root without finding anything real. Returning the
        // lexical path is not an escape: the caller's containment check still runs.
        return resolve(target);
      }
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/** The project root's real location. */
export function realProjectRoot(root) {
  try {
    return realpathSync.native(resolve(root));
  } catch {
    return resolve(root);
  }
}

/**
 * Decide whether `target` is inside `root`, both lexically and on disk.
 *
 * @returns {{ok: true, abs: string, real: string}
 *          |{ok: false, why: 'lexical'|'reparse', abs: string, real: string}}
 */
export function containedPath(root, target) {
  const absRoot = resolve(root);
  const abs = isAbsolute(target) ? resolve(target) : resolve(absRoot, target);

  // Cheap and obvious: catches ../ and absolute escapes before touching the disk.
  const rel = relative(absRoot, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, why: 'lexical', abs, real: abs };
  }

  const realRoot = realProjectRoot(absRoot);
  const real = realpathNearest(abs);
  const realRel = relative(realRoot, real);
  if (realRel.startsWith('..') || isAbsolute(realRel)) {
    return { ok: false, why: 'reparse', abs, real };
  }

  return { ok: true, abs, real };
}

/**
 * Are these two stats the same filesystem object?
 *
 * On Windows `ino` is the NTFS file index and is stable across writes to the
 * same file, distinct between files, and -- the property that matters here --
 * equal to the *outside* file's index when read through a junction. So a path
 * swapped to point out of the project produces a handle whose identity no longer
 * matches the one recorded before the open, and the swap is caught.
 */
export function sameFile(a, b) {
  if (!a || !b) return false;
  // Some filesystems report 0 for ino. Comparing two zeros would make every pair
  // look identical, which is worse than admitting we cannot tell.
  if (!a.ino || !b.ino) return false;
  return a.ino === b.ino && a.dev === b.dev;
}

/**
 * Open a file for writing, having proved the handle points inside the project.
 *
 * The point is the ordering. Checking a path and opening it later leaves a window
 * in which the object at that path can be replaced -- with a junction pointing
 * somewhere else, for instance. Every path-based check would then have passed
 * about a file nobody was going to write to.
 *
 * So: validate the path, record which object it refers to *right now*, open it,
 * and then check that the handle we hold is that same object. A swap in between
 * shows up as a mismatch. The path is re-checked afterwards as well, and the
 * caller reads and writes through the returned descriptor rather than reopening,
 * so there is no second resolution to attack.
 *
 * @returns {{ok: true, fd: number, abs: string, real: string, stat: object}
 *          |{ok: false, why: string, detail: string}}
 *
 * `onChecked` is a test seam, called in the gap between recording the path's
 * identity and opening it. That gap is the whole problem, so it cannot be closed
 * by inspection -- only by being able to exercise it. It takes no part in
 * production behaviour.
 */
export function openContained(root, target, { flags = 'r+', onChecked } = {}) {
  const check = containedPath(root, target);
  if (!check.ok) return { ok: false, why: check.why, detail: `path resolves outside the project (${check.why})` };
  const abs = check.abs;

  // Identity of whatever this path refers to at this instant.
  let before;
  try {
    before = lstatSync(abs);
  } catch (e) {
    return { ok: false, why: 'missing', detail: `cannot inspect ${abs}: ${e.message}` };
  }
  if (!before.isFile()) return { ok: false, why: 'not-a-file', detail: 'target is not a regular file' };

  if (typeof onChecked === 'function') onChecked(abs);

  let fd;
  try {
    fd = openSync(abs, flags);
  } catch (e) {
    return { ok: false, why: 'open', detail: `cannot open ${abs}: ${e.message}` };
  }

  const refuse = (why, detail) => {
    safeClose(fd);
    return { ok: false, why, detail };
  };

  let opened;
  try {
    opened = fstatSync(fd);
  } catch (e) {
    return refuse('error', e.message);
  }

  if (!sameFile(before, opened)) {
    return refuse(
      'swapped',
      'the file at this path changed identity between being checked and being opened, so it was not opened for writing',
    );
  }

  // A swap *after* the open is harmless to the bytes -- the descriptor is bound to
  // the object that was validated -- but it still means something else is rewriting
  // this tree concurrently, and the edit was computed from content that may no
  // longer be current. Refusing is the honest answer.
  const recheck = containedPath(root, target);
  if (!recheck.ok) {
    return refuse('moved', `the path moved outside the project while it was being opened (${recheck.why})`);
  }

  // Handed out: the caller owns the descriptor now and must close it.
  return { ok: true, fd, abs, real: check.real, stat: opened };
}

/** Read a whole file through an already-open descriptor. */
export function readFd(fd, encoding = 'utf8') {
  return readFileSync(fd, encoding);
}

/**
 * Replace a whole file's contents through an already-open descriptor.
 *
 * Uses an explicit offset rather than `writeFileSync(fd, ...)`, because the
 * descriptor's position is wherever the last read left it -- at end of file --
 * and writing there after a truncate would append into the hole. Writing at
 * offset 0 leaves no dependence on where the read ended.
 */
export function writeFd(fd, contents) {
  const buf = Buffer.from(contents, 'utf8');
  ftruncateSync(fd, 0);
  let written = 0;
  while (written < buf.length) {
    written += writeSync(fd, buf, written, buf.length - written, written);
  }
  return written;
}

/** Close a descriptor from openContained, ignoring a double close. */
export function safeClose(fd) {
  try {
    closeSync(fd);
  } catch {
    /* already closed */
  }
}