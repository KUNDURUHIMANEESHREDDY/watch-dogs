/**
 * Applies proposed actions. Every applied change is journalled with a full before
 * image, so `wd rollback` can undo an autonomous fix without a VCS checkout.
 *
 * Ordering: propose -> guard -> diff -> autonomy gate -> write -> journal.
 * The guard runs before anything touches the disk, not after.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve, relative, basename } from 'node:path';
import { makeRunnable, runCapture } from '../core/exec.mjs';
import { isDeclared, lockfileKind, repairArgv } from './deps.mjs';
import { isRefused, describeRefusal } from './guard.mjs';
import { log } from '../core/log.mjs';

export class Applier {
  constructor({ projectRoot, dataDir, autonomy = 'autonomous', allowlist = [] }) {
    this.projectRoot = resolve(projectRoot);
    this.dataDir = dataDir;
    this.autonomy = autonomy;
    this.allowlist = new Set(allowlist);
    this.journalDir = join(dataDir, 'journal');
  }

  /**
   * Synchronous path, for file operations only.
   *
   * Command execution is deliberately NOT available here. Running a fix command
   * with spawnSync blocks the event loop, which stalls transcript tailing and
   * process polling -- a 30-second npm install would blind every terminal the
   * watchdog is supposed to be watching. Callers that may trigger a command must
   * use applyAsync.
   *
   * @param {{kind: string, package?: string, path?: string, find?: string, replace?: string, argv?: string[]}} action
   * @param {{cwd?: string, evidence?: string}} ctx
   */
  apply(action, ctx = {}) {
    const gate = this.#gate(action, ctx);
    if (gate) return gate;

    if (action.kind === 'command' || action.kind === 'install-deps' || action.kind === 'repair-deps') {
      return { status: 'deferred', why: 'command execution must go through applyAsync' };
    }

    try {
      switch (action.kind) {
        case 'patch-file':
          return this.#patchFile(action, ctx);
        case 'write-file':
          return this.#writeFile(action, ctx);
        default:
          return { status: 'skipped', why: `unknown action kind "${action.kind}"` };
      }
    } catch (err) {
      log.error(`apply failed for ${action.kind}`, err);
      return { status: 'error', why: err.message };
    }
  }

  /** Shared guard + autonomy gate. Returns a refusal/skip result, or null to proceed. */
  #gate(action, ctx) {
    const guardResult = isRefused(action, { projectRoot: this.projectRoot, cwd: ctx.cwd });
    if (!guardResult.ok) {
      const d = describeRefusal(guardResult.code);
      log.warn(`refused ${action.kind}: ${guardResult.why}`);
      return { status: 'refused', code: guardResult.code, why: guardResult.why, examples: d.examples };
    }
    if (this.autonomy === 'suggest') return { status: 'suggested', why: 'autonomy is set to "suggest"' };
    if (this.autonomy === 'allowlist' && !this.allowlist.has(action.kind)) {
      return { status: 'suggested', why: `"${action.kind}" is not on the allowlist` };
    }
    return null;
  }

  /**
   * Full path, including command execution. Never blocks the event loop.
   * Fix commands are serialised, so a burst of findings cannot saturate the
   * machine with concurrent package managers.
   */
  async applyAsync(action, ctx = {}) {
    if (action.kind !== 'command' && action.kind !== 'install-deps' && action.kind !== 'repair-deps') return this.apply(action, ctx);
    const gate = this.#gate(action, ctx);
    if (gate) return gate;

    const previous = this.#queue;
    let release;
    this.#queue = new Promise((r) => (release = r));
    await previous;
    try {
      return await this.#command(action, ctx);
    } finally {
      release();
    }
  }

  #queue = Promise.resolve();

  #resolveInRoot(p, cwd) {
    const abs = resolve(cwd ?? this.projectRoot, p);
    const rel = relative(this.projectRoot, abs);
    if (rel.startsWith('..')) throw new Error(`refusing to write outside project root: ${p}`);
    return abs;
  }

  #snapshot(absPath) {
    if (!existsSync(absPath)) return null;
    const buf = readFileSync(absPath);
    this.#pendingSnapshots.set(absPath, buf);
    return buf;
  }

  #pendingSnapshots = new Map();

  #patchFile(action, ctx) {
    const abs = this.#resolveInRoot(action.path, ctx.cwd);
    if (!existsSync(abs)) return { status: 'skipped', why: `target file does not exist: ${action.path}` };
    // Never read a directory as if it were a file. An empty relative path resolves
    // to the working directory, so this is reachable rather than theoretical.
    if (!statSync(abs).isFile()) {
      return { status: 'skipped', why: `target is not a regular file: ${action.path}` };
    }
    const before = readFileSync(abs, 'utf8');
    const idx = before.indexOf(action.find);
    if (idx === -1) {
      return { status: 'skipped', why: `quoted "find" text is not present in ${action.path}; the model invented it` };
    }
    if (before.indexOf(action.find, idx + 1) !== -1) {
      return { status: 'skipped', why: `"find" text is ambiguous (appears more than once) in ${action.path}` };
    }
    const after = before.slice(0, idx) + action.replace + before.slice(idx + action.find.length);
    this.#snapshot(abs);
    this.#write(abs, after);
    return this.#journal({ type: 'patch', abs, before, after, ctx, action });
  }

  #writeFile(action, ctx) {
    const abs = this.#resolveInRoot(action.path, ctx.cwd);
    this.#snapshot(abs);
    this.#write(abs, action.contents ?? '');
    return this.#journal({ type: 'write', abs, before: this.#pendingSnapshots.get(abs)?.toString() ?? null, after: action.contents ?? '', ctx, action });
  }

  #write(abs, contents) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }

  /** Async command execution. Resolves rather than blocking the event loop. */
  async #command(action, ctx) {
    const root = ctx.cwd ?? this.projectRoot;
    const argv =
      action.kind === 'install-deps'
        ? installArgv(action.package, root)
        : action.kind === 'repair-deps'
          ? repairArgv(root)
          : action.argv;
    if (!argv?.length) {
      return {
        status: 'skipped',
        why:
          action.kind === 'install-deps'
            ? explainInstallRefusal(action.package, ctx.cwd ?? this.projectRoot)
            : action.kind === 'repair-deps'
              ? 'refused to repair node_modules automatically: this project has no lockfile, so npm install would re-resolve every dependency and could pull versions you never pinned. Commit a lockfile, or run the install yourself.'
              : 'no command to run',
        action: action.kind,
      };
    }

    const label = argv.join(' ');
    const timeoutMs = action.timeoutMs ?? 300_000;
    const { cmd, args } = makeRunnable(argv);
    const raw = await runCapture({ cmd, args, cwd: ctx.cwd ?? this.projectRoot, timeoutMs });

    const record = (result, outcome) => {
      this.#recordCommand(argv, ctx, action, { outcome, why: result.why ?? null, detail: result.detail ?? null });
      return result;
    };

    if (raw.startsWith('__WD_TIMEOUT__')) {
      return record({ status: 'error', why: label + ' timed out after ' + raw.slice(14) + 'ms' }, 'timeout');
    }
    if (raw.startsWith('__WD_SPAWNFAIL__')) {
      return record({ status: 'error', why: 'could not run ' + argv[0] + ': ' + raw.slice(17) }, 'spawn-failed');
    }
    if (raw.startsWith('__WD_EXIT__')) {
      const code = raw.slice(11).split(':')[0].trim();
      return record({ status: 'error', why: label + ' exited ' + code, detail: raw.slice(-1500) }, 'failed');
    }
    return record({ status: 'applied', detail: label + ' succeeded' }, 'ok');
  }

  #recordCommand(argv, ctx, action, { outcome, why, detail }) {
    this.#appendJournal({
      type: 'command',
      abs: null,
      argv,
      outcome,
      why: why ?? null,
      detail: detail ?? null,
      cwd: ctx?.cwd ?? null,
      action,
    });
  }

  #journal({ type, abs, before, after, ctx, action }) {
    this.#pendingSnapshots.delete(abs);
    const rec = this.#appendJournal({ type, abs, before, after, ctx, action, outcome: 'ok' });
    return { status: 'applied', journalId: rec.id, path: abs ? relative(this.projectRoot, abs) : null };
  }

  #appendJournal(rec) {
    mkdirSync(this.journalDir, { recursive: true });
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const full = { id, at: new Date().toISOString(), projectRoot: this.projectRoot, cwd: ctx2cwd(rec.ctx), ...rec };
    delete full.ctx;
    writeFileSync(join(this.journalDir, `${id}.json`), JSON.stringify(full));
    return full;
  }

  #snapshots() {
    return this.#pendingSnapshots;
  }

  listJournal() {
    if (!existsSync(this.journalDir)) return [];
    return readdirSync(this.journalDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(this.journalDir, f), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => (a.at < b.at ? 1 : -1));
  }

  /** Undo one journalled change. Newest-first so stacked edits unwind correctly. */
  rollback(id) {
    const p = join(this.journalDir, `${id}.json`);
    if (!existsSync(p)) return { status: 'error', why: `no journal entry ${id}` };
    const rec = JSON.parse(readFileSync(p, 'utf8'));
    if (rec.outcome !== 'ok') return { status: 'skipped', why: 'that action did not succeed' };
    if (rec.type === 'command') return { status: 'skipped', why: 'shell actions are not reversible; rerun the command manually if needed' };
    if (rec.before === null) {
      if (existsSync(rec.abs)) renameSync(rec.abs, rec.abs + '.wd-deleted');
      return { status: 'rolled-back', note: 'file did not exist before; moved to .wd-deleted' };
    }
    writeFileSync(rec.abs, rec.before);
    rec.outcome = 'rolled-back';
    writeFileSync(p, JSON.stringify(rec));
    return { status: 'rolled-back', path: rec.abs };
  }
}

function ctx2cwd(ctx) {
  return ctx?.cwd ?? null;
}

/**
 * Dependency installs are the one autonomous action that reaches outside the
 * project, so they are the most tightly constrained thing here.
 *
 * The rule that matters: install ONLY what the project already declares. The
 * package name arrives from terminal output, which is untrusted -- a malicious
 * postinstall script, a compromised build tool, or a hostile README printed to
 * your terminal could otherwise choose what gets installed, and installing runs
 * arbitrary code with your privileges. A denylist cannot close that, because the
 * attacker picks the name and would just pick another. DeclaredDependencies is the
 * allowlist, and it is authored by you rather than by a build log.
 *
 * Secondary rule: when the project pins versions, repair via the lockfile
 * (`npm ci`) rather than `npm install <name>`, because installing by name
 * re-resolves and can silently fetch a newer -- possibly malicious -- version than
 * the one your lockfile records.
 */
function installArgv(pkg, root) {
  if (!pkg) return [];

  if (!isDeclared(root, pkg)) return []; // the allowlist gate; caller explains

  const lock = lockfileKind(root);
  if (lock === "pnpm") return ["pnpm", "install", "--frozen-lockfile"];
  if (lock === "yarn") return ["yarn", "install", "--frozen-lockfile"];
  if (lock === "npm") return existsSync(join(root, "package.json")) ? ["npm", "ci"] : [];

  // No lockfile: fall back to the declared package, still allowlisted.
  if (existsSync(join(root, "package.json"))) return ["npm", "install", pkg];

  for (const venv of [".venv", "venv", "env"]) {
    const exe =
      process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
    if (existsSync(join(root, venv)) && existsSync(join(root, exe))) {
      return [join(root, exe), "-m", "pip", "install", pkg];
    }
  }
  return [];
}

/**
 * Explain an install refusal in terms the user can act on. The most important
 * case is "not a declared dependency", because that is the supply-chain guard
 * firing and it should read as a deliberate decision rather than a bug.
 */
function explainInstallRefusal(pkg, root) {
  const name = String(pkg ?? '').trim();
  if (!name) return 'no package name was identified in the output';

  if (!isDeclared(root, name)) {
    return (
      'refused to install "' + name + '": it is not a declared dependency of this project. ' +
      'The package name comes from terminal output, which any build tool or postinstall script can influence, ' +
      'so only packages you have already declared are installed automatically. ' +
      'Add it to package.json / requirements.txt yourself, or run the install by hand.'
    );
  }

  const lock = lockfileKind(root);
  if (lock) return 'declared, but the lockfile repair command could not be constructed - run it by hand';

  if (existsSync(join(root, 'package.json'))) {
    return (
      'refused to install "' + name + '" automatically: it is declared, but this project has no lockfile, ' +
      'so installing by name could fetch a different version than intended. Run it yourself.'
    );
  }
  return (
    'refused to install "' + name + '" automatically: it is declared, but no project virtualenv (.venv) exists, ' +
    'so pip would have to modify a global interpreter. Create a venv, or install it yourself.'
  );
}
export function unifiedDiff(before, after, path = 'file') {
  const a = (before ?? '').split('\n');
  const b = (after ?? '').split('\n');
  const out = [`--- a/${path}`, `+++ b/${path}`];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (i < a.length) out.push('-' + a[i++]);
    if (j < b.length) out.push('+' + b[j++]);
    if (out.length > 400) { out.push('... (diff truncated)'); break; }
  }
  return out.join('\n');
}
