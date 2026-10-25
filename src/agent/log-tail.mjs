import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export const MAX_LOG_TAIL_BYTES = 64 * 1024;
export const MAX_LOG_TAIL_LINES = 80;
export const MAX_LOG_LINE_CHARS = 4096;

/**
 * Read a bounded tail of a daemon log without loading the complete file.
 * A partial first line is discarded when the byte window begins mid-record.
 */
export function readBoundedLogTail(path, {
  maxBytes = MAX_LOG_TAIL_BYTES,
  maxLines = MAX_LOG_TAIL_LINES,
  maxLineChars = MAX_LOG_LINE_CHARS,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_LOG_TAIL_BYTES) {
    throw new RangeError(`maxBytes must be between 1 and ${MAX_LOG_TAIL_BYTES}`);
  }
  if (!Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > MAX_LOG_TAIL_LINES) {
    throw new RangeError(`maxLines must be between 1 and ${MAX_LOG_TAIL_LINES}`);
  }
  if (!Number.isSafeInteger(maxLineChars) || maxLineChars < 1 || maxLineChars > MAX_LOG_LINE_CHARS) {
    throw new RangeError(`maxLineChars must be between 1 and ${MAX_LOG_LINE_CHARS}`);
  }

  let fd;
  try {
    fd = openSync(path, 'r');
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size === 0) return [];

    const start = Math.max(0, stats.size - maxBytes);
    const length = Math.min(stats.size, maxBytes);
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');

    if (start > 0) {
      const firstLineEnd = text.indexOf('\n');
      text = firstLineEnd === -1 ? '' : text.slice(firstLineEnd + 1);
    }

    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-maxLines)
      .map((line) => line.length > maxLineChars
        ? `${line.slice(0, maxLineChars)}...[truncated]`
        : line);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}
