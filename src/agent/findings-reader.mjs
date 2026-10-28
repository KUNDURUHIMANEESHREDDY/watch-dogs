import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_LINES = 5_000;

/**
 * Read a bounded tail of a JSONL file.
 *
 * The gateway only needs recent finding records for its dashboard snapshot.
 * Reading the whole append-only file on every snapshot makes memory and CPU
 * use grow with the lifetime of the watchdog. This helper caps bytes and
 * record count, drops a potentially partial first record, and refuses links
 * and non-regular files.
 */
export function readBoundedJsonlLines(
  path,
  { maxBytes = DEFAULT_MAX_BYTES, maxLines = DEFAULT_MAX_LINES } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('maxBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxLines) || maxLines < 1) {
    throw new RangeError('maxLines must be a positive safe integer');
  }

  const linkStat = lstatSync(path);
  if (!linkStat.isFile() || linkStat.isSymbolicLink()) return [];

  // O_NOFOLLOW closes the lstat/open symlink race on platforms that support it.
  // Windows uses its normal read flag; the lstat and opened-file checks still
  // reject non-regular files there.
  const flags = process.platform === 'win32'
    ? 'r'
    : constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(path, flags);

  try {
    const openedStat = fstatSync(fd);
    if (!openedStat.isFile()) return [];

    // O_NOFOLLOW blocks symlink substitution on supported POSIX platforms,
    // but does not stop a regular-file pathname swap between lstat and open.
    // Verify device/inode identity on every platform; reads then use this fd.
    let currentStat;
    try {
      currentStat = lstatSync(path);
    } catch {
      return [];
    }
    if (
      currentStat.isSymbolicLink()
      || !currentStat.isFile()
      || currentStat.dev !== openedStat.dev
      || currentStat.ino !== openedStat.ino
    ) return [];

    // Keep one extra byte so we can distinguish a tail beginning exactly on a
    // newline from one beginning in the middle of a record.
    const startsMidFile = openedStat.size > maxBytes + 1;
    const start = startsMidFile ? openedStat.size - maxBytes - 1 : 0;
    const length = Math.min(openedStat.size - start, maxBytes + 1);
    const buffer = Buffer.alloc(length);
    let offset = 0;

    while (offset < length) {
      const count = readSync(fd, buffer, offset, length - offset, start + offset);
      if (count === 0) break;
      offset += count;
    }

    let text = buffer.subarray(0, offset).toString('utf8');
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline < 0 ? '' : text.slice(newline + 1);
    }

    return text.split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } finally {
    closeSync(fd);
  }
}
