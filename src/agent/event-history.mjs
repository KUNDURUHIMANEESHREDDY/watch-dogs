import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const DEFAULT_MAX_EVENTS = 128;
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 16 * 1024;

function limits(options = {}) {
  const value = {
    maxEvents: options.maxEvents ?? DEFAULT_MAX_EVENTS,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    maxEventBytes: options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES
  };
  for (const [name, number] of Object.entries(value)) {
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  if (value.maxEventBytes > value.maxBytes) {
    throw new RangeError('maxEventBytes must not exceed maxBytes');
  }
  return value;
}

function validEntry(entry, maxEventBytes) {
  if (!entry || typeof entry !== 'object' ||
      typeof entry.id !== 'string' || !/^[a-f0-9]{24}$/.test(entry.id) ||
      typeof entry.payload !== 'string' || Buffer.byteLength(entry.payload, 'utf8') > maxEventBytes) {
    return false;
  }
  const lines = entry.payload.split('\n');
  if (lines[0] !== `id: ${entry.id}`) return false;
  const eventLine = lines.find(line => line.startsWith('event: '));
  const dataLine = lines.find(line => line.startsWith('data: '));
  if (!eventLine || !dataLine) return false;
  try {
    const envelope = JSON.parse(dataLine.slice(6));
    return Boolean(envelope && envelope.event_id === entry.id && typeof envelope.type === 'string');
  } catch {
    return false;
  }
}

/**
 * Load the bounded SSE cursor ring. A corrupt, oversized, symlinked, or
 * non-regular history file fails closed: callers must send a snapshot reset.
 */
export function loadEventHistory(path, options = {}) {
  const { maxEvents, maxBytes, maxEventBytes } = limits(options);
  let fd;
  try {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    fd = openSync(path, flags);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return { events: [], healthy: false };
    const content = readFileSync(fd, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > maxBytes) return { events: [], healthy: false };
    if (!content) return { events: [], healthy: true };

    const lines = content.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.length > maxEvents) return { events: [], healthy: false };

    const events = [];
    const seen = new Set();
    for (const line of lines) {
      if (!line) return { events: [], healthy: false };
      let entry;
      try { entry = JSON.parse(line); } catch {
        return { events: [], healthy: false };
      }
      if (!validEntry(entry, maxEventBytes) || seen.has(entry.id)) {
        return { events: [], healthy: false };
      }
      seen.add(entry.id);
      events.push({ id: entry.id, payload: entry.payload });
    }
    return { events, healthy: true };
  } catch (error) {
    if (error?.code === 'ENOENT') return { events: [], healthy: true };
    return { events: [], healthy: false };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

/**
 * Persist the complete bounded cursor ring using write+fsync+rename. The temp
 * file is private to the current process and never overwrites the target until
 * a complete replacement has been written.
 */
export function persistEventHistory(path, events, options = {}) {
  const { maxEvents, maxBytes, maxEventBytes } = limits(options);
  if (!Array.isArray(events)) return false;
  const bounded = events.slice(-maxEvents);
  if (!bounded.every(entry => validEntry(entry, maxEventBytes))) return false;

  const seen = new Set();
  for (const entry of bounded) {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
  }

  const content = bounded.length
    ? bounded.map(entry => JSON.stringify(entry)).join('\n') + '\n'
    : '';
  if (Buffer.byteLength(content, 'utf8') > maxBytes) return false;

  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    return true;
  } catch {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    try { unlinkSync(temporary); } catch {}
    return false;
  }
}
