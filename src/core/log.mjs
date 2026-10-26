import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, statSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const COLOR = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
};

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_LOG_LINE_BYTES = 64 * 1024;
let threshold = LEVELS[process.env.WD_LOG_LEVEL] ?? LEVELS.info;
let logFile = null;

export function initLog({ level, file } = {}) {
  if (level) threshold = LEVELS[level] ?? threshold;
  if (!file) return;
  // Creating the log directory must never be able to stop the thing that logs.
  // An un-guarded mkdirSync here means an unwritable path crashes the daemon at
  // startup, which is precisely the failure the log exists to help diagnose.
  try {
    mkdirSync(dirname(file), { recursive: true });
    // Probe the configured destination now. Otherwise an invalid path or an
    // unwritable file is discovered only on the first log write, which is
    // silently swallowed and leaves an unattended daemon without diagnostics.
    const fd = openSync(file, "a");
    try {
      if (!fstatSync(fd).isFile()) throw new Error("log destination is not a regular file");
    } finally {
      closeSync(fd);
    }
    logFile = file;
  } catch (e) {
    logFile = null;
    process.stderr.write(`watchdog: cannot open log file ${file}: ${e.message}\n`);
  }
}

/**
 * Diagnostics go to a file when configured, and to stderr otherwise.
 * stdout is reserved for machine-readable output (--format json), so nothing
 * in this module is ever allowed to touch it.
 */
export const log = {
  debug(...a) {
    emit('debug', a);
  },
  info(...a) {
    emit('info', a);
  },
  warn(...a) {
    emit('warn', a);
  },
  error(...a) {
    emit('error', a);
  },
};

function emit(level, args) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const text = args
    .map((x) => (x instanceof Error ? (x.stack ?? x.message) : typeof x === 'string' ? x : safeJson(x)))
    .join(' ');
  // Keep each record on one physical line and cap it so a single oversized
  // exception or untrusted value cannot bypass file rotation and consume disk.
  // Escape terminal controls and Unicode line separators as well as CR/LF so
  // untrusted text cannot forge terminal colors or visually split a record.
  const singleLineText = escapeLogControls(text);
  const line = truncateUtf8(`${ts} ${level.toUpperCase().padEnd(5)} ${singleLineText}`, MAX_LOG_LINE_BYTES);
  if (logFile) {
    try {
      rotateIfNeeded(logFile);
      appendFileSync(logFile, line + '\n');
    } catch {
      /* a broken log must never take the watchdog down */
    }
    return;
  }
  const useColor = process.stderr.isTTY && process.env.NO_COLOR === undefined;
  process.stderr.write(useColor ? `${COLOR[level]}${line}${COLOR.reset}\n` : line + '\n');
}

function escapeLogControls(value) {
  const singleLine = value.replace(/\r\n|\r|\n/g, '\\n');
  return singleLine.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (character) =>
    `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`,
  );
}

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const suffix = '...[truncated]';
  const prefixBudget = maxBytes - Buffer.byteLength(suffix, 'utf8');
  let prefix = '';
  let used = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > prefixBudget) break;
    prefix += character;
    used += bytes;
  }
  return prefix + suffix;
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * A daemon that runs unattended for days must not fill the disk with its own
 * diagnostics. One previous file is kept, so a crash report survives rotation.
 */
function rotateIfNeeded(path) {
  try {
    if (!existsSync(path) || statSync(path).size < MAX_LOG_BYTES) return;
    const prev = path + '.1';
    try {
      if (existsSync(prev)) unlinkSync(prev);
    } catch { /* best effort */ }
    renameSync(path, prev);
  } catch {
    /* rotation failing is not worth interrupting the daemon */
  }
}
