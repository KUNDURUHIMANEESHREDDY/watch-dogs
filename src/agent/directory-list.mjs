import { opendirSync } from 'node:fs';

export const MAX_DIRECTORY_NAMES = 100;

function assertLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DIRECTORY_NAMES) {
    throw new RangeError(`limit must be between 1 and ${MAX_DIRECTORY_NAMES}`);
  }
}

/**
 * Collect a bounded prefix from an already-open directory and always close it.
 * Keeping the iterator separate makes the read/close contract directly testable
 * without relying on directory enumeration order or timing.
 */
export function collectBoundedDirectoryNames(directory, limit = MAX_DIRECTORY_NAMES) {
  assertLimit(limit);
  const names = [];
  try {
    while (names.length < limit) {
      const entry = directory.readSync();
      if (entry === null) break;
      names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return names;
}

/**
 * Enumerate only a bounded prefix of a directory.
 *
 * The control-center snapshot needs a short list of data-file names, not a
 * materialized copy of the entire data directory. Stop reading as soon as the
 * requested number of entries is collected and always close the directory
 * handle.
 */
export function readBoundedDirectoryNames(path, limit = MAX_DIRECTORY_NAMES) {
  assertLimit(limit);
  const directory = opendirSync(path, { bufferSize: Math.min(limit, 32) });
  return collectBoundedDirectoryNames(directory, limit);
}
