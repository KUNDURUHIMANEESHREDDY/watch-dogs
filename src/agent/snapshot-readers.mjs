import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
} from 'node:fs';
import { join } from 'node:path';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_FINDINGS_TOTAL_BYTES = 4 * 1024 * 1024;
const DEFAULT_FINDINGS_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_FINDING_LINE_BYTES = 64 * 1024;
const MAX_FINDING_LINES_PER_FILE = 2000;
const DEFAULT_LOG_BYTES = 64 * 1024;
const DEFAULT_LOG_LINES = 80;
const DEFAULT_LOG_LINE_CHARS = 4096;
const MAX_DIRECTORY_NAMES = 100;

function positiveLimit(value, maximum, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(name + ' must be between 1 and ' + maximum);
  }
  return value;
}

/**
 * Read a regular file through a verified descriptor and a fixed byte budget.
 * Tail mode drops the first partial line when the file is larger than the
 * budget. Symlinks, FIFOs, replaced paths and non-regular files are omitted.
 */
export function readBoundedRegularFile(path, maxBytes, { tail = false } = {}) {
  positiveLimit(maxBytes, MAX_FILE_BYTES, 'maxBytes');
  let fd;
  try {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile()) return null;
    if (!tail && before.size > maxBytes) return null;

    const flags = constants.O_RDONLY
      | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_NONBLOCK ?? 0);
    fd = openSync(path, flags);
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || (!tail && opened.size > maxBytes)
    ) return null;

    // Verify that the path still names the descriptor we opened. Reads below
    // use the descriptor, never the path, so a later rename cannot redirect it.
    const current = lstatSync(path);
    if (
      current.isSymbolicLink()
      || !current.isFile()
      || current.dev !== opened.dev
      || current.ino !== opened.ino
    ) return null;

    const start = tail ? Math.max(0, opened.size - maxBytes) : 0;
    const length = Math.min(maxBytes, Math.max(0, opened.size - start));
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const count = readSync(fd, buffer, offset, length - offset, start + offset);
      if (count === 0) break;
      offset += count;
    }

    let content = buffer.subarray(0, offset);
    if (tail && start > 0) {
      const newline = content.indexOf(0x0a);
      content = newline < 0 ? Buffer.alloc(0) : content.subarray(newline + 1);
    }
    return { content: content.toString('utf8'), bytes: offset, truncated: start > 0 };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

/** Enumerate at most the requested number of names; never materialize a directory. */
export function readBoundedDirectoryNames(path, limit = MAX_DIRECTORY_NAMES) {
  positiveLimit(limit, MAX_DIRECTORY_NAMES, 'limit');
  let directory;
  try {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isDirectory()) return [];
    directory = opendirSync(path, { bufferSize: Math.min(limit, 32) });
    const openedPath = lstatSync(path);
    if (
      openedPath.isSymbolicLink()
      || !openedPath.isDirectory()
      || openedPath.dev !== before.dev
      || openedPath.ino !== before.ino
    ) return [];
    const names = [];
    while (names.length < limit) {
      const entry = directory.readSync();
      if (entry === null) break;
      names.push(entry.name);
    }
    return names;
  } catch {
    return [];
  } finally {
    if (directory) {
      try { directory.closeSync(); } catch {}
    }
  }
}

function parseTailJsonLines(content, maxLines, maxLineBytes) {
  const records = [];
  let end = content.length;
  while (end > 0 && records.length < maxLines) {
    const newline = content.lastIndexOf('\n', end - 1);
    const start = newline + 1;
    let line = content.slice(start, end);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line && Buffer.byteLength(line, 'utf8') <= maxLineBytes) {
      try {
        records.push(JSON.parse(line));
      } catch {
        // A partial or malformed append-only record is omitted from this snapshot.
      }
    }
    if (newline < 0) break;
    end = newline;
  }
  return records.reverse();
}

/**
 * Read the two rotated findings files under a total byte and record budget.
 * The older rotation is processed first so the active file wins deduplication.
 */
export function readFindings(dataDir, limit = 200, options = {}) {
  positiveLimit(limit, 200, 'limit');
  const maxTotalBytes = positiveLimit(
    options.maxTotalBytes ?? DEFAULT_FINDINGS_TOTAL_BYTES,
    DEFAULT_FINDINGS_TOTAL_BYTES,
    'maxTotalBytes',
  );
  const maxFileBytes = positiveLimit(
    options.maxFileBytes ?? DEFAULT_FINDINGS_FILE_BYTES,
    DEFAULT_FINDINGS_FILE_BYTES,
    'maxFileBytes',
  );
  const maxLineBytes = positiveLimit(
    options.maxLineBytes ?? DEFAULT_FINDING_LINE_BYTES,
    DEFAULT_FINDING_LINE_BYTES,
    'maxLineBytes',
  );

  const base = join(dataDir, 'findings.jsonl');
  const records = [];
  let remaining = maxTotalBytes;
  for (const path of [base + '.1', base]) {
    if (remaining <= 0) break;
    const file = readBoundedRegularFile(path, Math.min(maxFileBytes, remaining), { tail: true });
    if (!file) continue;
    remaining -= file.bytes;
    records.push(...parseTailJsonLines(file.content, MAX_FINDING_LINES_PER_FILE, maxLineBytes));
  }

  // The watcher may persist one signature more than once as advisor/applier
  // state changes. Keep the last valid record in append order.
  const latest = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object' || !record.ruleId || !record.evidence) continue;
    const key = record.signature || record.ruleId + '::' + (record.sessionId || '') + '::' + record.evidence;
    latest.set(key, record);
  }
  return [...latest.values()]
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
    .slice(-limit)
    .map(record => ({
      id: String(record.signature || record.ruleId + '::' + (record.at || '')),
      ruleId: record.ruleId,
      title: record.title || record.ruleId,
      severity: record.severity || 'unknown',
      confidence: record.confidence || 'unknown',
      evidence: record.evidence,
      at: record.at || null,
      shell: record.shell || null,
      cwd: record.cwd || null,
      sessionId: record.sessionId || null,
      advisor: record.advisor ? {
        pending: Boolean(record.advisor.pending),
        verdict: record.advisor.verdict || null,
        requiresHuman: Boolean(record.advisor.requiresHuman),
        why: typeof record.advisor.why === 'string' ? record.advisor.why.slice(0, 240) : null,
        verification: record.advisor.verification ? {
          verdict: record.advisor.verification.verdict || 'unknown',
          evidence: record.advisor.verification.evidence || 'unknown',
          why: typeof record.advisor.verification.why === 'string'
            ? record.advisor.verification.why.slice(0, 240)
            : null,
        } : null,
      } : null,
      applied: record.applied ? {
        status: record.applied.status || 'unknown',
        summary: typeof record.applied.summary === 'string' ? record.applied.summary.slice(0, 240) : null,
      } : null,
      requiresHuman: Boolean(record.advisor?.requiresHuman),
      suppressed: record.suppressed || null,
    }));
}

/** Read a bounded tail of daemon.log, retaining only complete recent lines. */
export function readBoundedLogLines(dataDir, options = {}) {
  const maxBytes = positiveLimit(options.maxBytes ?? DEFAULT_LOG_BYTES, DEFAULT_LOG_BYTES, 'maxBytes');
  const maxLines = positiveLimit(options.maxLines ?? DEFAULT_LOG_LINES, DEFAULT_LOG_LINES, 'maxLines');
  const maxLineChars = positiveLimit(
    options.maxLineChars ?? DEFAULT_LOG_LINE_CHARS,
    DEFAULT_LOG_LINE_CHARS,
    'maxLineChars',
  );
  const path = join(dataDir, 'daemon.log');
  const file = readBoundedRegularFile(path, maxBytes, { tail: true });
  if (!file) return [];
  const lines = [];
  let end = file.content.length;
  while (end > 0 && lines.length < maxLines) {
    const newline = file.content.lastIndexOf('\n', end - 1);
    const start = newline + 1;
    const line = file.content.slice(start, end);
    if (line) lines.push(line.slice(0, maxLineChars));
    if (newline < 0) break;
    end = newline;
  }
  return lines.reverse().map((line, index) => ({ id: index, line }));
}
