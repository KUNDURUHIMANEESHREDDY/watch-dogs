import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_JOURNAL_FILES = 200;
const MAX_JOURNAL_ENTRY_BYTES = 256 * 1024;
export const MAX_JOURNAL_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_JOURNAL_RESULTS = 100;

/**
 * Enumerate only a bounded working set of the newest journal filenames.
 *
 * Directory iteration itself is streaming. Sorting the complete directory
 * with readdirSync would allocate an array proportional to the lifetime of
 * the journal, even though the UI only needs a bounded recent snapshot.
 */
function readNewestJournalNames(dir, limit) {
  const handle = opendirSync(dir);
  const names = [];
  try {
    let entry;
    while ((entry = handle.readSync()) !== null) {
      if (!entry.name.endsWith('.json')) continue;
      names.push(entry.name);
      // Keep at most 2 * limit names between trims; memory stays bounded even
      // when the journal directory contains a very large number of entries.
      if (names.length >= limit * 2) {
        names.sort();
        names.splice(0, names.length - limit);
      }
    }
  } finally {
    handle.closeSync();
  }
  return names.sort().slice(-limit);
}

/**
 * Read one regular journal file, bounded by the caller's remaining byte budget.
 * Return the exact number of bytes read so invalid UTF-8 cannot undercount the
 * aggregate budget after replacement-character decoding.
 */
function readBoundedRegularFile(path, maxBytes) {
  const initial = lstatSync(path);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > maxBytes) return null;

  // O_NOFOLLOW blocks symlink substitution on supported POSIX platforms.
  // Verify device/inode identity on every platform as well: O_NOFOLLOW does not
  // prevent the pathname from being replaced with a different regular file
  // between lstat and open. Once identity is checked, reads use the open fd.
  const supportsNoFollowOpen = process.platform !== 'win32' && Boolean(constants.O_NOFOLLOW);
  const flags = supportsNoFollowOpen
    ? constants.O_RDONLY | constants.O_NOFOLLOW
    : 'r';
  const fd = openSync(path, flags);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes) return null;
    let current;
    try {
      current = lstatSync(path);
    } catch {
      return null;
    }
    if (
      current.isSymbolicLink()
      || !current.isFile()
      || current.dev !== opened.dev
      || current.ino !== opened.ino
    ) return null;

    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    return {
      content: buffer.subarray(0, offset).toString('utf8'),
      bytes: offset,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Read a bounded journal snapshot for the local control center.
 *
 * Applier journal filenames begin with a base-36 timestamp, so lexical order
 * retains the newest candidate files. The aggregate byte budget is consumed
 * newest-first: an old backlog cannot crowd out recent activity, and one
 * snapshot can never allocate/parse more than MAX_JOURNAL_TOTAL_BYTES.
 * Oversized/corrupt entries are omitted; this observability snapshot must not
 * make the health UI unavailable.
 */
export function readJournal(dataDir, projectRoot, limit = MAX_JOURNAL_RESULTS) {
  const boundedLimit = Number.isSafeInteger(limit)
    ? Math.max(1, Math.min(limit, MAX_JOURNAL_RESULTS))
    : MAX_JOURNAL_RESULTS;
  const dir = join(dataDir, 'journal');
  let files = [];
  try {
    // Do not follow a journal-directory symlink into an unrelated location.
    // lstat is deliberate here: stat would resolve the link and accept its target.
    const dirStat = lstatSync(dir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return [];
    files = readNewestJournalNames(dir, MAX_JOURNAL_FILES);
  } catch {
    return [];
  }

  const entries = [];
  let remainingBytes = MAX_JOURNAL_TOTAL_BYTES;
  // Filenames are timestamp-prefixed and sorted oldest-to-newest by the
  // directory helper. Consume the budget from newest to oldest so retained
  // history is useful even when older journal files are large.
  for (const name of files.reverse()) {
    if (remainingBytes <= 0) break;
    const path = join(dir, name);
    try {
      const file = readBoundedRegularFile(
        path,
        Math.min(MAX_JOURNAL_ENTRY_BYTES, remainingBytes),
      );
      if (file === null) continue;
      remainingBytes -= file.bytes;
      const entry = JSON.parse(file.content);
      if (!entry || typeof entry !== 'object') continue;

      let target = null;
      if (typeof entry.abs === 'string') {
        const rel = relative(projectRoot, resolve(entry.abs));
        target = rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)
          ? '[outside project]'
          : rel;
      }
      entries.push({
        id: String(entry.id || name.replace(/\.json$/i, '')),
        at: entry.at || null,
        outcome: entry.outcome || 'unknown',
        type: entry.type || 'unknown',
        target,
        source: entry.source || null,
        txOutcome: entry.txOutcome || null,
        reason: typeof entry.why === 'string' ? entry.why.slice(0, 240) : null
      });
    } catch {
      // A corrupt entry must not make the authenticated health snapshot unavailable.
    }
  }
  return entries
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
    .slice(-boundedLimit)
    .reverse();
}
