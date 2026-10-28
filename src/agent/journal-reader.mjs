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
 * Read a bounded journal snapshot for the local control center.
 *
 * Applier journal filenames begin with a base-36 timestamp, so lexical order
 * retains the newest candidate files. Oversized/corrupt entries are omitted:
 * this is an observability snapshot and must not make the health UI unavailable.
 */
function readBoundedRegularFile(path, maxBytes) {
  const initial = lstatSync(path);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > maxBytes) return null;

  // O_NOFOLLOW prevents a journal path from being swapped to a symlink between
  // validation and open on supported POSIX platforms. Windows uses a normal
  // open and must always take the post-open path/device/inode verification path.
  const supportsNoFollowOpen = process.platform !== 'win32' && Boolean(constants.O_NOFOLLOW);
  const flags = supportsNoFollowOpen
    ? constants.O_RDONLY | constants.O_NOFOLLOW
    : 'r';
  const fd = openSync(path, flags);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes) return null;
    if (!supportsNoFollowOpen) {
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
    }

    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

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
  for (const name of files) {
    const path = join(dir, name);
    try {
      const contents = readBoundedRegularFile(path, MAX_JOURNAL_ENTRY_BYTES);
      if (contents === null) continue;
      const entry = JSON.parse(contents);
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
