/**
 * Content hashes for optimistic concurrency control.
 *
 * Verification proves a *version* of a file is fine. Nothing about that result
 * says which version. So between the check and the write, the file can change --
 * a build regenerating it, an IDE autosaving, the developer editing it -- and the
 * anchor can still be present in the new version while the verification result
 * describes the old one.
 *
 * "the anchor is there" is not "the file I checked is the file I am editing". A
 * hash closes that gap: record the preimage before verifying, compare it against
 * the bytes actually read immediately before writing, and refuse when they
 * differ.
 *
 * Hashed over the text the writer reads, not over the path. Hashing a path would
 * re-introduce exactly the problem the previous fix removed -- the file at a path
 * can be a different object by the time it is opened.
 */
import { createHash } from 'node:crypto';

/** @param {string|Buffer} contents @returns {string} lowercase hex sha256 */
export function sha256Of(contents) {
  return createHash('sha256')
    .update(Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), 'utf8'))
    .digest('hex');
}

/** Short form for messages. Never used for comparison. */
export function shortHash(hash) {
  return typeof hash === 'string' && hash.length > 12 ? `${hash.slice(0, 12)}...` : String(hash ?? '');
}