/**
 * Layer 1: shell-native transcripts.
 *
 * We deliberately do NOT intercept stdio of an interactive IDE terminal. Patching
 * the pipe a shared VS Code terminal tab depends on can corrupt prompts, TUI apps
 * and exit codes. Instead each shell writes its own native transcript
 * (PowerShell `Start-Transcript`, bash `script`) and this layer tails the files by
 * byte offset. If the tailer misses a chunk we resync from the last known offset,
 * so a truncated read is recoverable instead of silently losing output.
 */
import {
  openSync, readSync, closeSync, statSync, existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LineSplitter } from './stream.mjs';
import { log } from '../core/log.mjs';

export class TranscriptTailer {
  #watcher;
  #splitters = new Map(); // file -> { fd, offset, splitter, sessionId }
  #timer = null;
  #onLines;
  #meta = new Map(); // file -> session meta
  #backfillBytes;
  #recentMs;

  constructor({ onLines, pollMs = 700, backfillBytes = 256 * 1024, recentMs = 10 * 60_000 }) {
    this.#onLines = onLines;
    this.#backfillBytes = backfillBytes;
    this.#recentMs = recentMs;
    this.#timer = setInterval(() => this.poll(), pollMs);
    if (this.#timer.unref) this.#timer.unref();
  }

  /**
   * Register a transcript file to follow.
   *
   * Where to start reading matters more than it looks. Starting at EOF is wrong:
   * discovery runs on an interval, so a session that opens and exits inside one
   * poll window is already fully written by the time we look, and EOF would mean
   * never seeing it at all. So we backfill from the start of recently-touched
   * files (capped), and only fall back to EOF for genuinely old scrollback.
   */
  track(file, meta = {}) {
    if (this.#meta.has(file)) return;
    mkdirSync(join(file, '..'), { recursive: true });

    let size = 0;
    let mtime = 0;
    try {
      const st = statSync(file);
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      /* not created yet; start at 0 and pick it up on first poll */
    }

    const isLive = meta.pid ? pidAlive(meta.pid) : false;
    const isRecent = Date.now() - mtime < this.#recentMs;
    const offset = isLive || isRecent ? Math.max(0, size - this.#backfillBytes) : size;

    this.#meta.set(file, { ...meta, file, sessionId: meta.sessionId ?? randomUUID() });
    this.#open(file, offset);
    log.debug(`tailing ${file} from ${offset} (size ${size}, live=${isLive}, recent=${isRecent})`);
  }

  /**
   * Refresh metadata for a transcript that was already opened before its
   * sidecar became complete. Line callbacks read this map at delivery time.
   */
  refresh(file, meta = {}) {
    const current = this.#meta.get(file);
    if (!current) return false;
    this.#meta.set(file, {
      ...current,
      ...meta,
      file,
      sessionId: meta.sessionId ?? current.sessionId,
    });
    return true;
  }

  #open(file, offset) {
    try {
      const fd = openSync(file, 'r');
      const splitter = new LineSplitter();
      // Anything between the previous offset and this new start is context we
      // cannot attribute, so prime the splitter with it rather than splitting
      // mid-UTF8-sequence at an arbitrary byte.
      //
      // Those bytes are *emitted* below, not merely fed to the splitter, so the
      // stored offset has to move past them. Leaving it at the old value made
      // poll() re-read the whole primed window, reporting every line in it
      // twice: duplicate findings, and duplicate LLM calls and applies.
      let next = offset;
      if (offset > 0) {
        const size = statSync(file).size;
        if (size > offset) {
          const buf = Buffer.alloc(Math.min(size - offset, 4096));
          const read = readSync(fd, buf, 0, buf.length, offset);
          for (const l of splitter.push(buf.subarray(0, read))) this.#onLines(l, this.#meta.get(file));
          next = offset + read;
        }
      }
      this.#splitters.set(file, { fd, offset: next, splitter });
    } catch (e) {
      log.debug(`could not open transcript ${file}: ${e.message}`);
    }
  }

  poll() {
    for (const [file, st] of this.#splitters) {
      try {
        const size = statSync(file).size;
        if (size < st.offset) {
          // Truncated or rotated: restart from the beginning of the new content.
          closeSync(st.fd);
          this.#open(file, 0);
          continue;
        }
        if (size === st.offset) continue;
        const len = size - st.offset;
        const buf = Buffer.alloc(len);
        const read = readSync(st.fd, buf, 0, len, st.offset);
        st.offset += read;
        for (const line of st.splitter.push(buf.subarray(0, read))) {
          this.#onLines(line, this.#meta.get(file));
        }
      } catch (e) {
        log.debug(`tail error on ${file}: ${e.message}`);
        this.#close(file);
      }
    }
  }

  #close(file) {
    const st = this.#splitters.get(file);
    if (st) {
      try { closeSync(st.fd); } catch {}
      this.#splitters.delete(file);
    }
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    for (const [file, st] of this.#splitters) {
      try {
        for (const line of st.splitter.flush()) this.#onLines(line, this.#meta.get(file));
      } catch {}
      try { closeSync(st.fd); } catch {}
    }
    this.#splitters.clear();
  }

  get tracked() {
    return [...this.#meta.values()];
  }
}

/** Session registry: the handshake between a live shell and the daemon. */
export class SessionRegistry {
  constructor(dataDir) {
    this.dir = join(dataDir, 'sessions');
    mkdirSync(this.dir, { recursive: true });
  }

  create({ shell, cwd, pid, transcript, parent = 'unknown' }) {
    const id = randomUUID();
    const rec = {
      id,
      shell,
      cwd,
      pid,
      transcript,
      parent,
      startedAt: new Date().toISOString(),
      host: process.env.COMPUTERNAME ?? 'unknown',
      ide: detectIde(),
      status: 'live',
    };
    this.#write(rec);
    return rec;
  }

  update(id, patch) {
    const rec = this.read(id);
    if (!rec) return null;
    const next = { ...rec, ...patch };
    this.#write(next);
    return next;
  }

  #write(rec) {
    writeFileSync(join(this.dir, `${rec.id}.json`), JSON.stringify(rec, null, 2));
  }

  read(id) {
    const p = join(this.dir, `${id}.json`);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  }

  list() {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try { return JSON.parse(readFileSync(join(this.dir, f), 'utf8')); } catch { return null; }
      })
      .filter(Boolean);
  }

  /** Mark sessions whose PID is gone as exited, so status is truthful. */
  reap() {
    const gone = [];
    for (const s of this.list()) {
      if (s.status !== 'live' || !s.pid) continue;
      if (!pidAlive(s.pid)) {
        this.update(s.id, { status: 'exited', endedAt: new Date().toISOString() });
        gone.push(s.id);
      }
    }
    return gone;
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Where instrumented shells write their transcripts.
 *
 * The profile blocks and the daemon must agree on this, so both resolve it here.
 * WD_TRANSCRIPT_DIR exists so a test can point both at a scratch directory:
 * without it, an integration test shares the live daemon's directory and can only
 * get a clean slate by deleting files that a running daemon holds open.
 */
export function transcriptDir() {
  return process.env.WD_TRANSCRIPT_DIR || join(homedir(), '.watchdog', 'transcripts');
}

/**
 * Discovers transcripts written by instrumented shells.
 *
 * The profile writes a `<name>.log` plus a `<name>.log.json` sidecar using only
 * built-in shell commands, so opening a terminal costs no node startup. This is
 * how the daemon finds them without any handshake.
 */
export class TranscriptDiscovery {
  #dir;
  #known = new Map();
  #pending = new Set();
  #seenDirs = new Set();
  #sizes = new Map();

  constructor(dir) {
    this.#dir = dir;
  }

  /** @returns {Array<{file:string, sessionId:string, shell:string, cwd:string|null, ide:string, pid:number|null}>} */
  scan() {
    const found = [];
    for (const dir of [this.#dir, ...this.#extraDirs()]) {
      // Incomplete sidecars are retried even when the directory mtime does not
      // change (for example, a sidecar that is written in place after creation).
      const hasPending = [...this.#pending].some(file => dirname(file) === dir);
      if (this.#seenDirs.has(dir) && !hasPending && !this.#rescan(dir)) continue;
      this.#seenDirs.add(dir);
      let entries;
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (!f.endsWith('.log')) continue;
        const full = join(dir, f);
        const previous = this.#known.get(full);
        if (previous && !this.#pending.has(full)) continue;
        const meta = readMeta(full + '.json', f);
        if (!meta) continue;
        const next = { ...meta, file: full };
        const changed = !previous || !sameSessionMeta(previous, next);
        this.#known.set(full, next);

        const incomplete = !Number.isSafeInteger(next.pid)
          || next.pid <= 0
          || typeof next.cwd !== 'string'
          || !next.cwd.trim();
        if (incomplete) this.#pending.add(full);
        else this.#pending.delete(full);

        if (changed) found.push(next);
      }
    }
    return found;
  }

  #extraDirs() {
    return [];
  }

  #rescan(dir) {
    // Cheap: re-scan a directory only while it is still growing.
    try {
      const s = statSync(dir);
      const prev = this.#sizes.get(dir) ?? 0;
      this.#sizes.set(dir, s.mtimeMs);
      return s.mtimeMs !== prev;
    } catch {
      return true;
    }
  }

  get dir() {
    return this.#dir;
  }
}

/** Compare only sidecar fields that affect attribution and session identity. */
function sameSessionMeta(a, b) {
  return ['sessionId', 'shell', 'cwd', 'ide', 'pid', 'startedAt']
    .every(key => a[key] === b[key]);
}

/** Stable partition that keeps PID-present sessions ahead of exited/unknown ones. */
export function prioritizePidPresentSessions(sessions) {
  const present = [];
  const other = [];
  for (const session of sessions) {
    (session.status === 'pid-present' ? present : other).push(session);
  }
  return [...present, ...other];
}

function readMeta(sidecar, filename) {
  let meta = null;
  try {
    // PowerShell 5.1 `Set-Content -Encoding UTF8` writes a BOM, and JSON.parse
    // rejects a leading U+FEFF. Without this strip every session reports
    // shell "unknown".
    const raw = readFileSync(sidecar, 'utf8').replace(/^\uFEFF/, '');
    meta = JSON.parse(raw);
  } catch {
    meta = null;
  }
  const id = filename.replace(/\.log$/, '');
  return {
    file: sidecar.replace(/\.json$/, ''),
    sessionId: id,
    shell: meta?.shell ?? 'unknown',
    cwd: meta?.cwd ?? null,
    ide: meta?.ide ?? 'unknown',
    pid: meta?.pid ?? null,
    startedAt: meta?.startedAt ?? null,
  };
}

/**
 * Best-effort IDE detection from the environment. IDE integrated terminals
 * inherit distinctive vars, which is how we label a session without hooking it.
 */
export function detectIde(env = process.env) {
  if (env.TerminalApp || env.WT_PROFILE_ID) return 'Windows Terminal';
  if (env.VSCODE_PID || env.VSCODE_INJECTION || env.TERM_PROGRAM === 'vscode') return 'VS Code / Cursor';
  if (Object.keys(env).some((k) => k.startsWith('GOORU_'))) return 'GoLand';
  if (env.JETBRAINS_IDE || env.IDE_PROTO) return 'JetBrains';
  if (env.ConEmuTask) return 'ConEmu';
  if (env.TERMINAL_EMULATOR === 'JetBrains-JediTerm') return 'JetBrains';
  if (env.TMUX) return 'tmux';
  if (env.WSL_DISTRO_NAME) return 'WSL';
  return 'unknown';
}
