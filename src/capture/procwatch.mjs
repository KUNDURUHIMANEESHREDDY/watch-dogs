/**
 * Layer 2: detached process watcher.
 *
 * Covers the sessions layer 1 structurally cannot see: processes started by an
 * IDE task runner, a scheduler, or a shell that was never instrumented.
 *
 * What it does NOT have is exit codes, and the reason is worth stating because
 * the code previously claimed otherwise. A process exit code is delivered to the
 * parent that spawned the process. For anything this layer exists to watch, the
 * parent is an IDE or a scheduler, not us, so the code is never sent our way.
 *
 * The two ways to recover it on Windows both fail here:
 *   - WMI process-stop tracing (Win32_ProcessStopTrace, which does carry
 *     ExitStatus) returns "Access denied" for a non-administrator. Verified.
 *   - ETW would work but needs a native binding, which is the same wall that
 *     leaves the ConPTY layer disabled.
 *
 * Commands the watchdog itself spawns DO have exit codes, because runCapture()
 * gets the 'close' event from its own child. So the absence here is specific to
 * externally started processes, not a gap in the execution path.
 *
 * What remains is identity, lifetime and workload-shapedness, and this layer is
 * honest about that: it reports a lifecycle event, never a diagnosis.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from '../core/log.mjs';

const exec = promisify(execFile);

// Command names that indicate a real workload rather than a shell or IDE host.
const WORKLOAD = /^(node|npm|pnpm|yarn|npx|tsc|eslint|jest|vitest|pytest|python3?|pip|poetry|cargo|rustc|go|java|javac|gradle|mvn|dotnet|msbuild|make|cmake|ninja|gcc|g\+\+|clang|docker|dotnet-watch|next|nuxt|vite|webpack|ts-node|tsx|babel|swc|deno|bun)$/i;

export class ProcessWatcher {
  #cfg;
  #timer = null;
  #seen = new Map(); // pid -> { name, startTime, cmd, reported }
  #sessionCwd;
  #onFinding;

  constructor(cfg, onFinding, { sessionCwd } = {}) {
    this.#cfg = cfg;
    this.#onFinding = onFinding;
    // pid -> cwd for shells we instrumented. Windows exposes no cwd through CIM,
    // so this is what makes inheritance-based attribution possible.
    this.#sessionCwd = typeof sessionCwd === 'function' ? sessionCwd : () => null;
  }

  start(intervalMs = 5000) {
    this.poll().catch((e) => log.debug('procwatch poll failed', e));
    this.#timer = setInterval(() => this.poll().catch((e) => log.debug('procwatch poll failed', e)), intervalMs);
    if (this.#timer.unref) this.#timer.unref();
    return this;
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async poll() {
    if (process.platform !== 'win32') return this.#pollUnix();
    const script =
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Compress";
    let procs;
    try {
      const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeout: 20_000,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      });
      procs = JSON.parse(stdout || '[]');
    } catch (e) {
      log.debug(`CIM query failed: ${e.message}`);
      return;
    }
    if (!Array.isArray(procs)) procs = [procs];
    this.#reconcile(procs.map((p) => ({
      pid: p.ProcessId,
      ppid: p.ParentProcessId,
      name: (p.Name || '').replace(/\.exe$/i, ''),
      cmd: p.CommandLine || '',
    })));
  }

  async #pollUnix() {
    try {
      const { stdout } = await exec('ps', ['-eo', 'pid=,ppid=,comm=,args=,lstart='], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
      const procs = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const m = /^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(l);
          return m ? { pid: +m[1], ppid: +m[2], name: m[3], cmd: m[4] } : null;
        })
        .filter(Boolean);
      this.#reconcile(procs);
    } catch (e) {
      log.debug(`ps failed: ${e.message}`);
    }
  }

  /**
 * Reconcile a pre-fetched process list and return the newly tracked entries.
 *
 * Public so the attribution logic can be tested without shelling out to CIM on
 * every case. Not part of the daemon's own flow -- poll() is the door.
 */
observe(procs) {
  this.#reconcile(procs);
  return [...this.#seen.values()];
}

#reconcile(procs) {
    const live = new Set();
    // Built once per poll so parent-chain lookups do not rescan the list.
    const byPid = new Map();
    for (const p of procs) if (p.pid) byPid.set(p.pid, p);

    for (const p of procs) {
      if (!p.pid) continue;
      live.add(p.pid);
      if (this.#seen.has(p.pid)) continue;
      if (isOwnProcess(p.pid)) continue;
      if (!WORKLOAD.test(p.name) && !WORKLOAD.test(p.cmd.split(/\s+/)[0] ?? '')) continue;
      if (!this.#relevant(p, byPid)) continue;
      this.#seen.set(p.pid, { ...p, firstSeen: Date.now() });
      log.debug(`procwatch tracking ${p.pid} ${p.name}${p.cwd ? ` (cwd inherited: ${p.cwd})` : ''}`);
    }

    for (const [pid, rec] of this.#seen) {
      if (live.has(pid)) continue;
      this.#seen.delete(pid);
      this.#reportExit(rec);
    }
  }

  /**
   * Only track work that plausibly belongs to the project being watched.
   * Without this the layer reports the machine's own infrastructure -- an MCP
   * server's node/python workers restarting is not the user's build failing,
   * and drowning real signal in that noise is how a monitor gets ignored.
   */
  #relevant(p, byPid) {
    if (this.#cfg.capture.layers.processAnywhere) return true;
    const root = (this.#cfg.projectRoot || '').toLowerCase();
    if (!root) return false;
    const hay = `${p.cmd ?? ''} ${p.cwd ?? ''}`.toLowerCase();
    if (hay.includes(root)) return true;

    // Windows does not expose a process's working directory through CIM -- there
    // is no such property, verified against a process started with an explicit
    // -WorkingDirectory whose command line contained no trace of it. So a bare
    // `node server.js` in the project was invisible to this layer and every
    // layer-2 finding depended on the project path appearing in argv.
    //
    // The cwd is still inferable: a child inherits its parent's working
    // directory, and the session registry knows the cwd of every shell we
    // instrumented. Walking up the parent chain recovers it for exactly the
    // processes this layer exists to watch -- those started from a terminal.
    const inherited = this.#inheritedCwd(p, byPid);
    if (inherited) {
      p.cwd = inherited;
      return inherited.toLowerCase().includes(root);
    }
    return false;
  }

  /**
   * Walk ParentProcessId upward looking for an ancestor whose working directory we
   * know. Bounded, because a deep or cyclic chain must not spin the poll loop.
   */
  #inheritedCwd(p, byPid) {
    if (!byPid) return null;
    let cur = p;
    for (let depth = 0; depth < 8 && cur?.ppid; depth++) {
      const known = this.#sessionCwd(cur.ppid);
      if (known) return known;
      cur = byPid.get(cur.ppid);
    }
    return null;
  }

  #reportExit(rec) {
    // An exit with no captured output is not a diagnosis. It is reported once per
    // distinct (name, command) so a restarting service cannot flood the stream,
    // and it carries no rule evaluation -- claiming a "problem" here would be a
    // guess dressed as a finding.
    const key = `${rec.name}::${(rec.cmd ?? '').slice(0, 200)}`;
    if (this.#reported.has(key)) return;
    this.#reported.add(key);
    const secs = Math.round((Date.now() - rec.firstSeen) / 1000);
    this.#onFinding?.({
      kind: 'process-exit',
      severity: 'info',
      name: rec.name,
      pid: rec.pid,
      cmd: rec.cmd,
      // Stated on the finding itself, not only in a comment. "Exited" reads like
      // a diagnosis until you know the exit code was never available to us, and a
      // reader of the findings log has no access to the source file.
      exitCode: null,
      evidence: `${rec.name} (pid ${rec.pid}) exited after ${secs}s`,
      note:
        'no output captured and no exit code available: this layer did not spawn the ' +
        'process, so the code was never delivered to us. A lifecycle event, not a diagnosis.',
      at: new Date().toISOString(),
    });
  }

  #reported = new Set();

  get tracked() {
    return [...this.#seen.values()];
  }
}

function isOwnProcess(pid) {
  return pid === process.pid || pid === process.ppid;
}
