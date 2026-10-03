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
 *   - Hardlinks are invisible to any path-based check. A hardlink inside the
 *     project to a file outside it reports the in-project path from every API,
 *     including realpath. Catching that needs a file-identity check (inode and
 *     link count), which is out of scope here.
 *   - A legitimate junction used by the project itself would be refused, because
 *     its real target is outside the root. That is the correct direction to fail:
 *     the guard is not trying to be clever about intent, only to refuse.
 */
import { realpathSync } from 'node:fs';
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