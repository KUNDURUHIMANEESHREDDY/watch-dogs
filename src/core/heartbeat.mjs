/**
 * Liveness heartbeat.
 *
 * The Startup-folder mechanism has no supervisor: if the daemon crashes at logon
 * there is nothing to restart it, and nothing would tell you. That silent-failure
 * state is the dangerous one, because the user reasonably assumes they are
 * covered. So the daemon proves it is alive by beating, and the absence of a
 * fresh beat is reported as loudly as a finding.
 */
import { writeFileSync, renameSync, readFileSync, existsSync, unlinkSync, mkdirSync, openSync, fstatSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pidAlive } from '../capture/shell.mjs';

export const BEAT_INTERVAL_MS = 5000;
/** Four missed beats. Generous enough to survive a GC pause or a busy disk. */
export const STALE_AFTER_MS = 20_000;
export const HEARTBEAT_VERSION = 1;

export class Heartbeat {
  #path;
  #timer = null;
  #state;
  #beats = 0;
  #indexPath;

  constructor(dataDir, state = {}) {
    this.#path = join(dataDir, 'daemon.json');
    // A global index so a freshly opened shell can tell whether *any* project is
    // covered, without knowing which projects those are. The shell profile reads
    // only this; it has no idea where the projects live.
    this.#indexPath = join(homedir(), '.watchdog', 'daemons.json');
    this.#state = {
      v: HEARTBEAT_VERSION,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      lastBeat: new Date().toISOString(),
      beats: 0,
      ...state,
    };
  }

  get path() {
    return this.#path;
  }

  start() {
    this.#write();
    this.#timer = setInterval(() => this.#write(), BEAT_INTERVAL_MS);
    if (this.#timer.unref) this.#timer.unref();
    return this;
  }

  #write() {
    this.#state.lastBeat = new Date().toISOString();
    this.#state.beats = ++this.#beats;
    this.#state.elapsedMs = Date.now() - Date.parse(this.#state.startedAt);
    atomicWriteJson(this.#path, this.#state);
    this.#writeIndex();
  }

  #writeIndex() {
    try {
      const now = Date.now();
      // Prune by whether the project still exists, not by age.
      //
      // This index does two jobs: it lists live daemons, and it is what tells a
      // freshly opened shell that something died and needs relaunching. Pruning
      // on age silently destroyed the second job -- a daemon that died over ten
      // minutes ago lost its entry, so the shell no longer knew to restart it and
      // coverage was gone for good. Age-based pruning also meant the shell
      // relaunched whichever corpse happened to be oldest rather than the project
      // that had actually just failed.
      const entries = readIndex(this.#indexPath)
        .filter((e) => e.pid !== this.#state.pid)
        .filter((e) => e.projectRoot && existsSync(e.projectRoot));
      entries.push({
        pid: this.#state.pid,
        heartbeat: this.#path,
        projectRoot: this.#state.projectRoot ?? null,
        entry: this.#state.toolRoot ? join(this.#state.toolRoot, 'bin', 'wd.js') : null,
        lastBeat: this.#state.lastBeat,
      });
      atomicWriteJson(this.#indexPath, entries.slice(-20));
    } catch {
      /* the index is an optimisation for shell startup; never fatal */
    }
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    try {
      unlinkSync(this.#path);
    } catch {
      /* already gone */
    }
    try {
      atomicWriteJson(
        this.#indexPath,
        readIndex(this.#indexPath).filter((e) => e.pid !== this.#state.pid),
      );
    } catch {
      /* best effort */
    }
  }
}

function readIndex(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Read the heartbeat and turn it into a verdict. The verdict is the whole point:
 * "registered" and "actually running" are different claims, and only the second
 * one means anybody is protected.
 *
 * @returns {{state:'running'|'stale'|'dead'|'never-started'|'foreign-process',
 *            detail:string, info:object|null}}
 */
export function readHeartbeat(dataDir, { now = Date.now() } = {}) {
  const path = join(dataDir, 'daemon.json');
  if (!existsSync(path)) {
    return { state: 'never-started', detail: 'no heartbeat file - the daemon has never run from this project', info: null };
  }

  let info;
  try {
    info = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    return { state: 'dead', detail: `heartbeat file is unreadable (${e.message}) - the daemon most likely crashed mid-write`, info: null };
  }

  const age = now - Date.parse(info.lastBeat ?? 0);
  if (Number.isNaN(age)) {
    return { state: 'dead', detail: 'heartbeat has no valid timestamp', info };
  }

  if (age > STALE_AFTER_MS) {
    return {
      state: 'stale',
      detail: `heartbeat is ${Math.round(age / 1000)}s old (limit ${STALE_AFTER_MS / 1000}s) - the daemon died ${Math.round(age / 1000)}s ago and nothing restarted it`,
      info,
    };
  }
  if (info.pid && !pidAlive(info.pid)) {
    return { state: 'dead', detail: `process ${info.pid} is gone but the heartbeat file survived - unclean shutdown`, info };
  }
  return {
    state: 'running',
    detail: `alive, pid ${info.pid}, up ${Math.round((now - Date.parse(info.startedAt ?? info.lastBeat)) / 1000)}s, beat ${Math.round(age / 1000)}s ago`,
    info,
  };
}

/**
 * Write via a temp file and rename, so a reader never observes a half-written
 * JSON document. A reader that trips over a partial file would report a false
 * crash, which is exactly the confusion this whole mechanism exists to avoid.
 */
export function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  try {
    renameSync(tmp, path);
  } catch {
    // Windows can refuse a rename onto an existing file in some conditions.
    try {
      writeFileSync(path, JSON.stringify(value, null, 2));
      unlinkSync(tmp);
    } catch {
      /* give up; a missing heartbeat is preferable to a thrown crash loop */
    }
  }
}

/**
 * Guard against a second daemon. The Startup entry plus a manual `wd start` is an
 * easy way to end up with two writers appending to the same findings log.
 */
/**
 * Take exclusive ownership of a data directory.
 *
 * The previous version read the heartbeat, saw nobody running, and returned ok.
 * That is check-then-act with nothing in between, and two daemons starting at the
 * same moment both pass it. Measured here at 20 wins out of 20 concurrent starts,
 * so the guard was not merely racy -- it was ineffective for the case it exists
 * to prevent. It matters because two daemons means double the LLM spend and two
 * autonomous appliers racing on the same files.
 *
 * Now it creates the lock with O_EXCL, which is atomic on Windows and POSIX
 * alike: exactly one creator can win, and the losers learn immediately rather
 * than by observing a heartbeat later.
 *
 * A lock left behind by a crashed daemon is taken over, checked by pid liveness
 * rather than age, so a dead daemon still cannot block the next start.
 */
export function claimSingleton(dataDir) {
  const lockPath = join(dataDir, 'daemon.lock');
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {
    /* the caller will fail on its own if the directory is unusable */
  }

  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // 'wx' is O_CREAT|O_EXCL: the create fails if the path already exists, and
      // that check and the create are one operation rather than two.
      const fd = openSync(lockPath, 'wx');
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }));
      } finally {
        closeSync(fd);
      }
      return { ok: true, token, lockPath };
    } catch (e) {
      if (e.code !== 'EEXIST') {
        // Anything else -- a read-only directory, permissions -- must not be read
        // as "free to start", or a daemon could launch unguarded.
        return { ok: false, reason: `could not create the daemon lock: ${e.message}` };
      }
    }

    const holder = readLock(lockPath);

    // Re-entrant: a process that already holds the lock keeps it. Without this a
    // restart of the same process would deadlock against itself.
    if (holder && holder.pid === process.pid) {
      return { ok: true, token: holder.token, lockPath };
    }

    if (holder && holder.pid && pidAlive(holder.pid)) {
      return {
        ok: false,
        pid: holder.pid,
        reason: `another watchdog is already running (pid ${holder.pid})`,
      };
    }

    // Stale: the holder is gone. Remove and retry. The retry is bounded, so a
    // lock that keeps reappearing fails the claim rather than looping.
    try {
      unlinkSync(lockPath);
    } catch {
      /* someone else may have taken it over; the next attempt will see that */
    }
  }
  return { ok: false, reason: 'could not acquire the daemon lock after several attempts' };
}

/** Read a lock file, or null when it is missing or unreadable. */
function readLock(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/**
 * Release the lock, but only if we still hold it.
 *
 * The token check is the point. A daemon whose lock was taken over because it
 * stalled must not delete the *new* holder's lock on its way out, which would
 * leave the machine with no lock and two daemons running.
 */
export function releaseSingleton(lockPath, token) {
  if (!lockPath) return false;
  const holder = readLock(lockPath);
  if (holder && token && holder.token !== token) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

