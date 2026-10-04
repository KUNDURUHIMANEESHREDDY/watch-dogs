/**
 * Writing a file so that a crash cannot leave it half-written.
 *
 * `#patchFile` used to truncate the target and write into it. That has two bad
 * windows:
 *
 *   truncate, then a crash mid-write   ->  the file is corrupt, and there is no
 *                                         record of what it used to contain
 *   write, then a crash before the
 *   journal entry exists               ->  the change happened and nothing
 *                                         mentions it
 *
 * Both are fixed by never modifying the target in place. The new contents are
 * written to a temporary file in the *same directory*, flushed, and then renamed
 * over the target. A rename within one filesystem is atomic: an observer sees
 * either the old file or the new one, never a mixture, and a crash leaves the old
 * file untouched.
 *
 * The temporary file has to be in the same directory, not the system temp
 * directory, because a rename across filesystems is a copy rather than an atomic
 * swap -- which would reintroduce exactly the window this is here to close.
 *
 * The journal record is written the same way, so a journal entry is never itself
 * a half-written file.
 */
import {
  openSync, closeSync, writeSync, fsyncSync, renameSync, unlinkSync,
  readFileSync, existsSync, readdirSync, statSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sha256Of } from './hashes.mjs';

/** Prefix for our own scratch files, so recovery can recognise and remove them. */
export const TMP_PREFIX = '.wd-tmp-';

function tmpPathFor(abs) {
  const name = basename(abs);
  // Keep the original extension so anything that sniffs the file during the
  // window -- a watcher, a build tool -- still sees what it expects.
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  return join(dirname(abs), `${TMP_PREFIX}${process.pid}-${randomBytes(4).toString('hex')}${ext}`);
}

/**
 * Replace a file's contents atomically.
 *
 * @returns {{tmp: string}} the scratch path, already renamed away
 * @throws if anything fails; the target is untouched in that case
 */
export function atomicReplace(abs, contents) {
  const tmp = tmpPathFor(abs);
  let fd;
  try {
    // 'wx' fails rather than following an existing file, so a name collision is a
    // hard error instead of someone else's data being overwritten.
    fd = openSync(tmp, 'wx', 0o600);
    const buf = Buffer.from(contents, 'utf8');
    let written = 0;
    while (written < buf.length) written += writeSync(fd, buf, written, buf.length - written, written);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, abs);
    return { tmp };
  } catch (e) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* the scratch file is the only thing at risk, and recovery clears those */
    }
    throw e;
  }
}

/** Write a small record durably and atomically. Used for journal entries. */
export function atomicWriteJson(abs, value) {
  atomicReplace(abs, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Scratch files left behind by a crash.
 *
 * Only files carrying our prefix, only in the directories we are told about, and
 * only ones old enough that no live write could still be using them.
 */
export function staleTempFiles(dirs, { olderThanMs = 60_000 } = {}) {
  const cutoff = Date.now() - olderThanMs;
  const out = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.startsWith(TMP_PREFIX)) continue;
      const abs = join(dir, e.name);
      try {
        const st = statSync(abs);
        if (st.mtimeMs < cutoff) out.push(abs);
      } catch {
        /* vanished between listing and stat */
      }
    }
  }
  return out;
}

/** Remove scratch files that recovery has decided are abandoned. */
export function removeTemp(abs) {
  try {
    unlinkSync(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace a file only if it still contains exactly what was validated.
 *
 * Closing the descriptor in order to rename over it opens a small window: the
 * file could change between the last check and the swap. This re-reads and
 * compares, so a concurrent edit turns the rename into a refusal instead of a
 * silent overwrite. It is the same optimistic check as the preimage hash, applied
 * at the last possible moment.
 *
 * @returns {{ok: true}|{ok: false, why: string}}
 */
export function atomicReplaceIfUnchanged(abs, contents, expected) {
  let current;
  try {
    current = readFileSync(abs, 'utf8');
  } catch (e) {
    return { ok: false, why: `could not re-read ${abs} before replacing it: ${e.message}` };
  }
  if (expected !== undefined && sha256Of(current) !== expected) {
    return {
      ok: false,
      why:
        'the file changed between being validated and being replaced, so nothing was written. ' +
        'Something else is editing this file.',
    };
  }
  try {
    atomicReplace(abs, contents);
    return { ok: true };
  } catch (e) {
    return { ok: false, why: `could not replace ${abs}: ${e.message}` };
  }
}
