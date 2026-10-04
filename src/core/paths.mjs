/**
 * One path, one meaning.
 *
 * The watchdog watches terminals in many directories, and a finding from a
 * session in `packages/api` names a file relative to *that* directory. But the
 * staged copy is made from the project root, so the same string means two
 * different files depending on who is reading it:
 *
 *     verify:   join(stage, f.path)          stage mirrors projectRoot
 *     apply:    openContained(ctx.cwd, ...)  ctx.cwd is the session directory
 *
 * For a project with both `src/index.js` and `packages/api/src/index.js`, a
 * proposal of `src/index.js` was verified against one and written to the other.
 *
 * So a path is converted to a project-root-relative path exactly once, before it
 * is verified, and that same string is used for the write. Resolution against a
 * session directory happens once, at the edge, and is never repeated downstream.
 */
import { resolve, relative, isAbsolute, sep } from 'node:path';

/**
 * Rewrite a path so it means the same file when resolved against the project root.
 *
 * @param {string} p           the path as proposed, relative to `fromDir`
 * @param {string} fromDir     what it is relative to -- usually the session cwd
 * @param {string} projectRoot what it must become relative to
 * @returns {string|null} project-root-relative path, or null if it leaves the project
 */
export function toProjectRelative(p, fromDir, projectRoot) {
  if (typeof p !== 'string') return null;
  const trimmed = p.trim();
  if (!trimmed || trimmed.includes('\0')) return null;

  // An absolute path is taken at face value and then re-expressed relative to the
  // root, so a proposal that named one absolute path does not silently change
  // meaning on the way through.
  const abs = isAbsolute(trimmed)
    ? resolve(trimmed)
    : resolve(fromDir ?? projectRoot, trimmed);

  const rel = relative(resolve(projectRoot), abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;

  return rel.split(sep).join('/');
}

/**
 * Every path in a proposal, canonicalised. Entries that escape are dropped, and
 * the caller is told so it can refuse rather than apply a partial set.
 *
 * @returns {{files: object[], rejected: {path: string, why: string}[]}}
 */
export function canonicalizeFix(fix, fromDir, projectRoot) {
  const files = [];
  const rejected = [];

  for (const f of fix?.files ?? []) {
    if (!f || typeof f.path !== 'string' || typeof f.find !== 'string' || typeof f.replace !== 'string') {
      rejected.push({ path: String(f?.path ?? '(missing)'), why: 'malformed entry' });
      continue;
    }
    const rel = toProjectRelative(f.path, fromDir, projectRoot);
    if (!rel) {
      rejected.push({ path: f.path, why: 'resolves outside the project root' });
      continue;
    }
    files.push({ ...f, path: rel, proposedPath: f.path });
  }

  return { files, rejected };
}