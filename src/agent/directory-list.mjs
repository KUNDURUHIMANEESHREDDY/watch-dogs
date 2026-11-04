import { opendirSync } from 'node:fs';

export const MAX_DIRECTORY_NAMES = 100;

/**
 * Enumerate only a bounded prefix of a directory.
 *
 * The control-center snapshot needs a short list of data-file names, not a
 * materialized copy of the entire data directory. Stop reading as soon as the
 * requested number of entries is collected and always close the directory
 * handle.
 */
export function readBoundedDirectoryNames(path, limit = MAX_DIRECTORY_NAMES) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DIRECTORY_NAMES) {
    throw new RangeError(`limit must be between 1 and ${MAX_DIRECTORY_NAMES}`);
  }

  const directory = opendirSync(path, { bufferSize: Math.min(limit, 32) });
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
