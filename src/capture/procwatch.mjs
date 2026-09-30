/**
 * Layer 2: detached process watcher.
 *
 * Covers the sessions layer 1 structurally cannot see: processes started by an
 * IDE task runner, a scheduler, or a shell that was never instrumented. It has no
 * output text, only process identity and exit codes, so it contributes crash and
 * non-zero-exit findings rather than content analysis.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from '../core/log.mjs';

const exec = promisify(execFile);

// Command names that indicate a real workload rather than a shell or IDE host.
const WORKLOAD = /^(node|npm|pnpm|yarn|npx|tsc|eslint|jest|vitest|pytest|python3?|pip|poetry|cargo|rustc|go|java|javac|gradle|mvn|dotnet|msbuild|make|cmake|ninja|gcc|g\+\+|clang|docker|dotnet-watch|next|nuxt|vite|webpack|ts-node|tsx|babel|swc|deno|bun)$/i;

const CRASH_CODES = new Set([-1073741819, -1073740791, -1073741510, 139, 134, 133]); // AV, stack buffer, ctrl-c, SIGABRT, SIGTRAP

export class ProcessWatcher {
  #cfg;
  #timer = null;
  #seen = new Map(); // pid -> { name, startTime, cmd, reported }
  #onFinding;

  constructor(cfg, onFinding) {
    this.#cfg = cfg;
    this.#onFinding = onFinding;
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

  #reconcile(procs) {
    const live = new Set();
    for (const p of procs) {
      if (!p.pid) continue;
      live.add(p.pid);
      if (this.#seen.has(p.pid)) continue;
      if (isOwnProcess(p.pid)) continue;
      if (!WORKLOAD.test(p.name) && !WORKLOAD.test(p.cmd.split(/\s+/)[0] ?? '')) continue;
      if (!this.#relevant(p)) continue;
      this.#seen.set(p.pid, { ...p, firstSeen: Date.now() });
      log.debug(`procwatch tracking ${p.pid} ${p.name}`);
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
  #relevant(p) {
    if (this.#cfg.capture.layers.processAnywhere) return true;
    const root = (this.#cfg.projectRoot || '').toLowerCase();
    if (!root) return false;
    const hay = `${p.cmd ?? ''} ${p.cwd ?? ''}`.toLowerCase();
    return hay.includes(root);
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
      evidence: `${rec.name} (pid ${rec.pid}) exited after ${secs}s`,
      note: 'no output captured; this is a process lifecycle event, not a diagnosis',
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

export { CRASH_CODES };
