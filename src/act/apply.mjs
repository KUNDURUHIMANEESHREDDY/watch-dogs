/**
 * Applies proposed actions. Every applied change is journalled with a full before
 * image, so `wd rollback` can undo an autonomous fix without a VCS checkout.
 *
 * Ordering: propose -> guard -> diff -> autonomy gate -> write -> journal.
 * The guard runs before anything touches the disk, not after.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync, copyFileSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve, relative, basename, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { makeRunnable, runCapture } from '../core/exec.mjs';
import { isDeclared, lockfileKind, repairArgv } from './deps.mjs';
import { isRefused, describeRefusal } from './guard.mjs';
import { containedPath } from './containment.mjs';
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
    // source is forwarded, not dropped: the file-class policy only applies to
    // model-proposed edits, and dropping it here would silently disable it.
    const guardResult = isRefused(action, { projectRoot: this.projectRoot, cwd: ctx.cwd, source: ctx.source });
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
    // This is the last check before bytes hit the disk, so it gets the same
    // realpath treatment as the guard. A junction inside the project passes
    // every relative() test and still writes outside it; verified with
    // mklink /J, which needs no elevation.
    const check = containedPath(this.projectRoot, resolve(cwd ?? this.projectRoot, p));
    if (!check.ok) {
      const detail = check.why === 'reparse' ? ` (resolves to ${check.real})` : '';
      throw new Error(`refusing to write outside project root: ${p}${detail}`);
    }
    return check.abs;
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

    // The anchor being present says nothing about the result being code. Observed
    // from the eval: the model proposed replacing the bare identifier `count`
    // with `let count = 0;`, which matched cleanly and produced a file that does
    // not parse. Applying that in autonomous mode breaks the user's source.
    const verdict = syntaxVerdict(abs, after);
    if (verdict === 'invalid') {
      return {
        status: 'skipped',
        why:
          `the edit would leave ${action.path} unparseable, so it was not applied. ` +
          'The replacement text did not fit the place the anchor was found.',
      };
    }

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
        ? installArgv(action.package, root, action.ecosystem)
        : action.kind === 'repair-deps'
          ? repairArgv(root)
          : action.argv;
    if (!argv?.length) {
      return {
        status: 'skipped',
        why:
          action.kind === 'install-deps'
            ? explainInstallRefusal(action.package, ctx.cwd ?? this.projectRoot, action.ecosystem)
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
    // The project-relative path is the authoritative record of what was touched.
    // `abs` is derived from it on rollback, so a journal that has been edited to
    // point somewhere else cannot steer the write outside the project.
    if (full.abs) {
      full.rel = relative(this.projectRoot, full.abs).split(sep).join('/');
    }
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

    // A journal entry is a file on disk, not a trusted authority.
    //
    // This path used to go straight to writeFileSync(rec.abs, rec.before) with no
    // guard at all, so the security boundary was "normal action -> guard,
    // rollback -> trust the journal". Anything able to edit a journal file -- a
    // postinstall script, a compromised dependency, or a bug in this program --
    // could redirect a rollback to overwrite a file outside the project.
    //
    // The target is therefore re-derived from the recorded relative path and put
    // back through the same containment and file-class policy every other write
    // gets. An entry with no relative path predates this and is refused rather
    // than guessed at.
    const target = this.#rollbackTarget(rec);
    if (target.error) return { status: 'refused', why: target.error };

    if (rec.before === null) {
      if (existsSync(target.abs)) renameSync(target.abs, target.abs + '.wd-deleted');
      rec.outcome = 'rolled-back';
      writeFileSync(p, JSON.stringify(rec));
      return { status: 'rolled-back', note: 'file did not exist before; moved to .wd-deleted', path: target.abs };
    }

    writeFileSync(target.abs, rec.before);
    rec.outcome = 'rolled-back';
    writeFileSync(p, JSON.stringify(rec));
    return { status: 'rolled-back', path: target.abs };
  }

  /**
   * Re-derive and re-validate a rollback target.
   * @returns {{abs: string}|{error: string}}
   */
  #rollbackTarget(rec) {
    const rel = typeof rec.rel === 'string' ? rec.rel.trim() : '';
    if (!rel || rel.startsWith('/') || rel.includes('\0') || /^[A-Za-z]:/.test(rel)) {
      return { error: 'journal entry has no usable relative path, so its target cannot be verified' };
    }
    if (rel.split(/[\\/]/).includes('..')) {
      return { error: `journal entry points outside the project: ${rel}` };
    }

    // Same canonical containment check every other write goes through.
    const check = containedPath(this.projectRoot, rel);
    if (!check.ok) {
      return { error: `journal entry resolves outside the project root (${rel}); refusing to roll back` };
    }

    // Same file-class policy. Rolling a "change" to a credential file or a git
    // hook is still a write to a credential file.
    const verdict = isRefused({ kind: 'patch-file', path: check.real }, { projectRoot: this.projectRoot, source: 'llm' });
    if (!verdict.ok) {
      return { error: `journal entry targets a protected file: ${verdict.why}` };
    }

    // If the entry carries an absolute path and it disagrees with what we just
    // derived, something has edited the journal. Refuse rather than pick one.
    if (typeof rec.abs === 'string' && rec.abs) {
      if (resolve(rec.abs) !== resolve(check.abs)) {
        return { error: `journal entry's recorded path does not match its relative path; refusing to trust it` };
      }
    }
    return { abs: check.abs };
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
/**
 * Exported for tests.
 *
 * The routing decision is the whole point and it cannot be observed from outside
 * without executing an installer, which a test must not do. Callers should use
 * Applier; this exists so the argv can be inspected, never run.
 */
export /** Extensions node can parse on its own. Anything else is not our judgement to make. */
const CHECKABLE = new Set(['.js', '.mjs', '.cjs', '.jsx']);

/**
 * Would this content parse as JavaScript?
 *
 * @returns {'valid'|'invalid'|'unknown'} 'unknown' when the file is not something
 *   we can check, or when the checker itself failed. An unknown never blocks a
 *   fix: refusing everything we cannot verify would block every TypeScript edit.
 */
function syntaxVerdict(absPath, contents) {
  if (!CHECKABLE.has(extname(absPath).toLowerCase())) return 'unknown';
  let tmp = null;
  try {
    tmp = join(tmpdir(), `wd-syntax-${process.pid}-${randomBytes(4).toString('hex')}${extname(absPath)}`);
    writeFileSync(tmp, contents, 'utf8');
    execFileSync(process.execPath, ['--check', tmp], { timeout: 20_000, stdio: ['ignore', 'ignore', 'pipe'] });
    return 'valid';
  } catch (e) {
    // A non-zero exit is the answer we want. A missing node or a spawn failure is
    // not, and must not be read as "invalid".
    if (e && typeof e.status === 'number') return 'invalid';
    return 'unknown';
  } finally {
    if (tmp) {
      try {
        unlinkSync(tmp);
      } catch {
        /* best effort */
      }
    }
  }
}

export function installArgv(pkg, root, ecosystem) {
  if (!pkg) return [];

  // The ecosystem is declared by the rule that recognised the error, and it is
  // required. Guessing it is the bug this replaces: package.json was checked
  // first, so a ModuleNotFoundError in a mixed project ran `npm install <name>`
  // and the npm registry served a package that merely shares the name.
  //
  // An unrecognised or missing ecosystem therefore refuses rather than defaulting
  // to Node. Both registries host packages with the same names, so "which one" is
  // not a detail -- and defaulting would put the failure back with a shrug.
  if (ecosystem === "python") return pythonInstallArgv(pkg, root);
  if (ecosystem !== "node") return [];

  if (!isDeclared(root, pkg, "node")) return []; // the allowlist gate; caller explains

  const lock = lockfileKind(root);
  if (lock === "pnpm") return ["pnpm", "install", "--frozen-lockfile"];
  if (lock === "yarn") return ["yarn", "install", "--frozen-lockfile"];
  if (lock === "npm") return existsSync(join(root, "package.json")) ? ["npm", "ci"] : [];

  // No lockfile: fall back to the declared package, still allowlisted.
  if (existsSync(join(root, "package.json"))) return ["npm", "install", pkg];
  return [];
}

/**
 * Python installs go through a virtual environment and pip, never a Node package
 * manager. Without a recognised venv there is nothing safe to do automatically:
 * a global `pip install` mutates the interpreter rather than the project, so the
 * action is refused and the user is told what to run.
 */
function pythonInstallArgv(pkg, root) {
  if (!isDeclared(root, pkg, "python")) return []; // declared as a python dependency, or not at all

  for (const venv of [".venv", "venv", "env"]) {
    const exe = process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
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
function explainInstallRefusal(pkg, root, ecosystem) {
  const name = String(pkg ?? '').trim();
  if (!name) return 'no package name was identified in the output';

  // Ecosystem-scoped now. "Declared somewhere in this repo" is not consent to
  // install from a different ecosystem's registry.
  const manifest = ecosystem === 'python' ? 'requirements.txt / pyproject.toml' : 'package.json';

  if (ecosystem !== 'python' && ecosystem !== 'node') {
    return (
      'refused to install "' + name + '": the action did not say which ecosystem it belongs to. ' +
      'Both registries host packages with the same names, so guessing would risk installing a ' +
      'different package than the one that failed.'
    );
  }

  if (!isDeclared(root, name, ecosystem)) {
    const elsewhere = ecosystem === 'python' ? '' : isDeclared(root, name, 'python') ? ' (it is declared in requirements.txt, which is a different registry)' : '';
    return (
      'refused to install "' + name + '"' + elsewhere + ': it is not a declared ' +
      (ecosystem === 'python' ? 'Python' : 'Node') + ' dependency of this project. ' +
      'The package name comes from terminal output, which any build tool or postinstall script can influence, ' +
      'so only packages you have already declared, in the ecosystem that failed, are installed automatically. ' +
      'Add it to ' + manifest + ' yourself, or run the install by hand.'
    );
  }

  if (ecosystem === 'python') {
    return (
      'refused to install "' + name + '" automatically: it is declared, but no project virtualenv (.venv) exists, ' +
      'so pip would have to modify a global interpreter. Create a venv, or install it yourself.'
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
    'refused to install "' + name + '" automatically: it is declared as a Node dependency, but this project has no package.json. Run it yourself.'
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
