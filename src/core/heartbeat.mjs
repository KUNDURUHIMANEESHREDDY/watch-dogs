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
export function claimSingleton(dataDir) {
  const existing = readHeartbeat(dataDir);
  if (existing.state === 'running' && existing.info?.pid && existing.info.pid !== process.pid) {
    return { ok: false, pid: existing.info.pid, reason: `another watchdog is already running (pid ${existing.info.pid})` };
  }
  return { ok: true };
}

