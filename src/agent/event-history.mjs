import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
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
    const linkStat = lstatSync(path);
    if (linkStat.isSymbolicLink() || !linkStat.isFile() || linkStat.size > maxBytes) {
      return { events: [], healthy: false };
    }
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    fd = openSync(path, flags);
    const stat = fstatSync(fd);
    // O_NOFOLLOW is not available on every supported platform. Compare the
    // opened descriptor with the pre-open path identity as a second guard.
    if (!stat.isFile() || stat.size > maxBytes ||
        (linkStat.dev !== stat.dev || linkStat.ino !== stat.ino)) {
      return { events: [], healthy: false };
    }
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

function syncParentDirectory(path) {
  // POSIX filesystems require the containing directory to be synced after
  // rename if the new directory entry must survive a sudden power loss.
  // Node does not expose portable directory fsync on Windows.
  if (process.platform === 'win32') return;
  let directoryFd;
  try {
    directoryFd = openSync(dirname(path), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    fsyncSync(directoryFd);
  } finally {
    if (directoryFd !== undefined) closeSync(directoryFd);
  }
}

/**
 * Persist the complete bounded cursor ring using write+fsync+rename. POSIX
 * also syncs the parent directory so the replacement entry is durable. Windows
 * supports process-restart replay here, but no power-loss durability claim.
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

  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    // Directory creation is part of persistence and must fail closed like the
    // later write/rename/fsync operations. A replaced or unavailable parent
    // must not escape into the gateway's event-publishing path.
    mkdirSync(dirname(path), { recursive: true });
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    syncParentDirectory(path);
    return true;
  } catch {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    try { unlinkSync(temporary); } catch {}
    return false;
  }
}
