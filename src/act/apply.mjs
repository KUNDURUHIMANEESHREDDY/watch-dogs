/**
 * Applies proposed actions. Every applied change is journalled with a full before
 * image, so `wd rollback` can undo an autonomous fix without a VCS checkout.
 *
 * Ordering: propose -> guard -> diff -> autonomy gate -> write -> journal.
 * The guard runs before anything touches the disk, not after.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, copyFileSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve, relative, basename, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { makeRunnable, runCapture } from '../core/exec.mjs';
import { isDeclared, lockfileKind, repairArgv, installScriptsIn, NO_SCRIPTS } from './deps.mjs';
import { isRefused, describeRefusal } from './guard.mjs';
import { containedPath, openContained, readFd, writeFd, safeClose } from './containment.mjs';
import { sha256Of, shortHash } from './hashes.mjs';
import { atomicReplace, atomicWriteJson, atomicReplaceIfUnchanged, staleTempFiles, removeTemp } from './atomic.mjs';
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
    const root = ctx.cwd ?? this.projectRoot;

    // Validate the path, open it, and prove the handle is the object that was
    // validated -- then read and write through that one descriptor.
    //
    // This used to be five separate opens by path: existsSync, statSync,
    // readFileSync for the edit, a second read for the snapshot, and
    // writeFileSync. Any of those could see a different object than the one
    // before it. The worst consequence was not an escape but a lie in the
    // journal: the snapshot could record content that was not what got patched,
    // so a rollback would restore the wrong thing.
    const opened = openContained(root, action.path, { flags: 'r+' });
    if (!opened.ok) {
      const why =
        opened.why === 'missing'
          ? `target file does not exist: ${action.path}`
          : opened.why === 'not-a-file'
            ? `target is not a regular file: ${action.path}`
            : `${action.path} was not opened for writing: ${opened.detail}`;
      return { status: 'skipped', why };
    }

    const abs = opened.abs;
    let before;
    try {
      before = readFd(opened.fd, 'utf8');
    } catch (e) {
      safeClose(opened.fd);
      return { status: 'skipped', why: `could not read ${action.path}: ${e.message}` };
    }

    // Optimistic concurrency control.
    //
    // Verification proved a particular *version* of this file was fine. This is
    // the last moment the bytes being written are known, so this is where the
    // version that was checked is compared against the version being changed.
    //
    // The check is here rather than in the caller on purpose: a precondition that
    // a caller can forget is not a precondition, and every write funnels through
    // this method. The comparison is against the content read through the
    // validated descriptor -- hashing the path instead would reintroduce the
    // "the object at this path may have changed" problem.
    if (action.expectPreimage) {
      const actual = sha256Of(before);
      if (actual !== action.expectPreimage) {
        safeClose(opened.fd);
        return {
          status: 'stale',
          why:
            `${action.path} changed after it was verified (expected ${shortHash(action.expectPreimage)}, ` +
            `found ${shortHash(actual)}). The fix was proved against a different version of this file, ` +
            'so it was not applied. Re-run the check against the current file.',
          code: 'stale_preimage',
        };
      }
    }

    const idx = before.indexOf(action.find);
    if (idx === -1) {
      safeClose(opened.fd);
      return { status: 'skipped', why: `quoted "find" text is not present in ${action.path}; the model invented it` };
    }
    if (before.indexOf(action.find, idx + 1) !== -1) {
      safeClose(opened.fd);
      return { status: 'skipped', why: `"find" text is ambiguous (appears more than once) in ${action.path}` };
    }
    const after = before.slice(0, idx) + action.replace + before.slice(idx + action.find.length);

    // The anchor being present says nothing about the result being code. Observed
    // from the eval: the model proposed replacing the bare identifier `count`
    // with `let count = 0;`, which matched cleanly and produced a file that does
    // not parse. Applying that in autonomous mode breaks the user's source.
    const verdict = syntaxVerdict(abs, after);
    if (verdict === 'invalid') {
      safeClose(opened.fd);
      return {
        status: 'skipped',
        why:
          `the edit would leave ${action.path} unparseable, so it was not applied. ` +
          'The replacement text did not fit the place the anchor was found.',
      };
    }

    // The snapshot is the content that was actually read through the validated
    // descriptor, not a second read of the path. Two reads can disagree.
    this.#pendingSnapshots.set(abs, Buffer.from(before, 'utf8'));

    try {
      // Replaced atomically and recorded before promotion, the same ordering
      // the transaction uses. The descriptor is closed first because Windows will
      // not rename over an open file; atomicReplaceIfUnchanged then re-reads and
      // compares against the preimage, closing the window that creates.
      safeClose(opened.fd);
      const swap = atomicReplaceIfUnchanged(abs, after, sha256Of(before));
      if (!swap.ok) {
        return { status: 'stale', code: 'stale_preimage', why: action.path + ': ' + swap.why };
      }
    } catch (e) {
      safeClose(opened.fd);
      return { status: 'error', why: `could not write ${action.path}: ${e.message}` };
    }
    safeClose(opened.fd);

    // Both hashes recorded even on this path, so every settled entry -- single or
    // transactional -- is reconcilable after a crash.
    return this.#journal({
      type: 'patch',
      abs,
      before,
      after,
      beforeSha: sha256Of(before),
      afterSha: sha256Of(after),
      ctx,
      action,
    });
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

    // An install whose scripts are disabled will "succeed" and leave a native
    // module installed but unusable. That is worse than refusing, because the
    // next run still fails and now the log says the repair worked. So the refusal
    // happens first and names the package.
    if (action.kind === 'repair-deps') {
      const scripted = installScriptsIn(root);
      if (scripted.length) {
        const result = {
          status: 'refused',
          why:
            'refused to repair dependencies automatically: this project has ' +
            `${scripted.length} package(s) that run install scripts ` +
            `(${scripted.slice(0, 3).map((s) => s.name).join(', ')}${scripted.length > 3 ? ', ...' : ''}). ` +
            'Autonomous repair runs installs with lifecycle scripts disabled, so the package would be ' +
            'installed and still broken. Run the install yourself, where you can see what runs.',
        };
        this.#recordCommand(argv, ctx, action, {
          outcome: 'refused',
          why: result.why,
          detail: scripted.map((s) => `${s.name}: ${s.why}`).join('\n'),
        });
        return result;
      }
    }

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

  /**
 * Apply a set of edits as one transaction.
 *
 * Verification judges the whole proposed set at once, so applying it file by file
 * could leave the repository in a state nobody verified: three files proposed,
 * one applied, two refused, and the result is a mixture that passed no check.
 * Recording that outcome faithfully is not the same as avoiding it.
 *
 * So this is two-phase:
 *
 *   preflight   open every target through the validated handle, read it, check
 *               the anchor is present and unique, check the preimage hash, and
 *               syntax-check the result. Nothing is written.
 *   commit      only if every file passed, write them all and journal them all.
 *
 * A refusal therefore happens before any byte is written, which is the case that
 * actually occurs: the model proposed a manifest and two sources, the manifest is
 * refused by the file-class policy, and nothing needed undoing.
 *
 * Holding the descriptors from preflight through commit is deliberate. It makes
 * the preimage the exact bytes that get written, rather than a re-read that might
 * differ -- which is the same guarantee the preimage check exists to provide.
 *
 * If a write fails *during* commit, files already written are restored from the
 * in-memory preimages. That is a best-effort undo, not a durable transaction: a
 * crash between two writes is still a torn edit, and closing that needs atomic
 * file replacement rather than anything this method can do.
 *
 * @returns {{status: string, results: object[], written: number}}
 */
applyAll(actions, ctx = {}) {
  const list = Array.isArray(actions) ? actions : [];
  if (!list.length) return { status: 'none', results: [], written: 0 };
  if (list.length > MAX_TRANSACTION_FILES) {
    return {
      status: 'refused',
      results: list.map(() => ({
        status: 'refused',
        why: `a proposal touching more than ${MAX_TRANSACTION_FILES} files is refused rather than applied in parts`,
      })),
      written: 0,
    };
  }

  // ---- phase 1: preflight. No writes.
  const prepared = [];
  const results = new Array(list.length).fill(null);

  for (let i = 0; i < list.length; i++) {
    const action = list[i];

    const gate = this.#gate(action, ctx);
    if (gate) {
      results[i] = gate;
      continue;
    }
    if (action.kind !== 'patch-file') {
      // Commands and installs are not part of a file transaction; they are
      // refused here rather than silently half-applied alongside patches.
      results[i] = {
        status: 'refused',
        why: `a file transaction cannot include a ${action.kind} action; run it separately`,
      };
      continue;
    }

    const root = ctx.cwd ?? this.projectRoot;
    const opened = openContained(root, action.path, { flags: 'r+' });
    if (!opened.ok) {
      results[i] = {
        status: 'skipped',
        why:
          opened.why === 'missing'
            ? `target file does not exist: ${action.path}`
            : opened.why === 'not-a-file'
              ? `target is not a regular file: ${action.path}`
              : `${action.path} was not opened for writing: ${opened.detail}`,
      };
      continue;
    }

    let before;
    try {
      before = readFd(opened.fd, 'utf8');
    } catch (e) {
      safeClose(opened.fd);
      results[i] = { status: 'skipped', why: `could not read ${action.path}: ${e.message}` };
      continue;
    }

    if (action.expectPreimage) {
      const actual = sha256Of(before);
      if (actual !== action.expectPreimage) {
        safeClose(opened.fd);
        results[i] = {
          status: 'stale',
          code: 'stale_preimage',
          why:
            `${action.path} changed after it was verified (expected ${shortHash(action.expectPreimage)}, ` +
            `found ${shortHash(actual)}). The fix was proved against a different version of this file.`,
        };
        continue;
      }
    }

    const at = before.indexOf(action.find);
    if (at < 0) {
      safeClose(opened.fd);
      results[i] = { status: 'skipped', why: `quoted "find" text is not present in ${action.path}; the model invented it` };
      continue;
    }
    if (before.indexOf(action.find, at + 1) !== -1) {
      safeClose(opened.fd);
      results[i] = { status: 'skipped', why: `"find" text is ambiguous (appears more than once) in ${action.path}` };
      continue;
    }

    const after = before.slice(0, at) + action.replace + before.slice(at + action.find.length);
    if (syntaxVerdict(opened.abs, after) === 'invalid') {
      safeClose(opened.fd);
      results[i] = {
        status: 'skipped',
        why:
          `the edit would leave ${action.path} unparseable, so it was not applied. ` +
          'The replacement text did not fit the place the anchor was found.',
      };
      continue;
    }

    // Held open until commit, so the bytes written are the bytes validated.
    prepared.push({ index: i, action, fd: opened.fd, abs: opened.abs, before, after, ctx });
  }

  if (results.some((r) => r !== null)) {
    // Something failed. Release every descriptor and write nothing at all.
    for (const p of prepared) safeClose(p.fd);
    for (const p of prepared) {
      results[p.index] = {
        status: 'skipped',
        why:
          'not applied: another file in the same proposal was refused, and a partial edit would leave ' +
          'the project in a state that was never verified.',
      };
    }
    const counts = aggregateTx(results);
    return { status: counts.status, results, written: 0 };
  }

  // ---- phase 2: commit.
  //
  // Each file is replaced atomically and recorded before it is promoted, so a
  // crash at any point leaves either the old file or a recoverable marker:
  //
  //   crash before the rename   target untouched, entry says 'pending'
  //   crash after the rename    entry says 'pending' and the target holds the
  //                             new content, so recovery can tell which happened
  //   crash after the settle    entry says 'ok', as normal
  //
  // The descriptor is closed before the rename because Windows will not rename
  // over an open file. That reopens a small window, which is why the target is
  // re-read and compared against the validated preimage immediately before the
  // swap: a concurrent edit becomes a refusal rather than a silent overwrite.
  const written = [];
  for (const p of prepared) safeClose(p.fd);
  try {
    for (const p of prepared) {
      const swap = atomicReplaceIfUnchanged(p.abs, p.after, sha256Of(p.before));
      if (!swap.ok) {
        const undone = this.#undoWritten(written);
        for (const q of prepared) {
          results[q.index] =
            q.index === p.index
              ? { status: 'stale', code: 'stale_preimage', why: `${p.action.path} changed before it could be written: ${swap.why}` }
              : { status: 'skipped', why: 'not applied: the transaction stopped before this file.' };
        }
        return {
          status: undone.length ? 'rolled-back' : 'none_applied',
          results,
          written: 0,
          detail: undone.length ? `restored ${undone.length} file(s): ${undone.join(', ')}` : 'nothing had been written',
        };
      }

      // The intent record, durable and atomic, written *before* the promotion.
      const rec = this.#appendJournal({
        type: 'patch', abs: p.abs, before: p.before, after: p.after,
        beforeSha: sha256Of(p.before), afterSha: sha256Of(p.after),
        ctx, action: p.action, outcome: 'pending',
      });
      p.journalId = rec.id;
      written.push(p);
      this.#pendingSnapshots.set(p.abs, Buffer.from(p.before, 'utf8'));
      this.#settleJournal(rec.id, 'ok');
      results[p.index] = { status: 'applied', journalId: rec.id, path: relative(this.projectRoot, p.abs) };
    }  } catch (e) {
    // Undo what landed. The preimages are in memory, so this restores exactly the
    // bytes that were there -- no separate backup file needed.
    const undone = [];
    for (const p of written) {
      try {
        writeFd(p.fd, p.before);
        undone.push(p.action.path);
      } catch {
        /* reported below; nothing more can be done for this one */
      }
    }
    for (const p of prepared) safeClose(p.fd);
    for (const p of written) results[p.index] = { status: 'error', why: `write failed and was rolled back: ${e.message}` };

    return {
      status: 'rolled-back',
      results,
      written: 0,
      detail: undone.length
        ? `restored ${undone.length} file(s): ${undone.join(', ')}`
        : 'nothing had been written yet',
    };
  }

  for (const p of prepared) safeClose(p.fd);
  const counts = aggregateTx(results);
  return { status: counts.status, results, written: prepared.length };
}



  #journal(recIn) {
    const { type, abs, before, after, ctx, action } = recIn;
    this.#pendingSnapshots.delete(abs);
    // Written as 'pending' and then settled, even on the single-file path: the entry
    // is durable before the caller is told the change succeeded.
    const rec = this.#appendJournal({ ...recIn, outcome: 'pending' });
    this.#settleJournal(rec.id, 'ok');
    return { status: 'applied', journalId: rec.id, path: abs ? relative(this.projectRoot, abs) : null };
  }

  /**
   * Restore files already written in a transaction that then failed.
   *
   * The preimages are in memory, so this restores exactly the bytes that were
   * there. Each restore is itself atomic, so a failure part-way through does not
   * leave a half-restored file.
   */
  #undoWritten(written) {
    const undone = [];
    for (const p of written) {
      try {
        atomicReplace(p.abs, p.before);
        undone.push(p.action.path);
        this.#settleJournal(this.#journalIdFor(p), 'rolled-back');
      } catch {
        /* reported by the caller's summary rather than swallowed */
      }
    }
    return undone;
  }

  /** Journal id recorded for a prepared entry, once it has been written. */
  #journalIdFor(p) {
    return p.journalId;
  }

  /** Move a journalled record from 'pending' to a settled outcome. */
  #settleJournal(id, outcome) {
    const p = join(this.journalDir, `${id}.json`);
    if (!existsSync(p)) return null;
    let rec;
    try {
      rec = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
    rec.outcome = outcome;
    rec.settledAt = new Date().toISOString();
    atomicWriteJson(p, rec);
    return rec;
  }

  /**
   * Reconcile journal entries left 'pending' by a crash.
   *
   * An entry is written before its file is promoted, so 'pending' covers both
   * "the crash happened first" and "the promotion happened first". The hashes
   * recorded with it tell the two apart:
   *
   *   target matches afterSha   the promotion happened; settle it as ok
   *   target matches beforeSha  nothing happened; settle it as aborted
   *   neither                   someone else changed the file; leave it and say so
   */
  recoverPending() {
    if (!existsSync(this.journalDir)) return { reconciled: [], removedTemp: [] };
    const reconciled = [];

    for (const f of readdirSync(this.journalDir)) {
      if (!f.endsWith('.json')) continue;
      const p = join(this.journalDir, f);
      let rec;
      try {
        rec = JSON.parse(readFileSync(p, 'utf8'));
      } catch {
        continue;
      }
      if (rec.outcome !== 'pending') continue;

      const target = this.#rollbackTarget(rec);
      if (target.error) {
        rec.outcome = 'unresolved';
        rec.note = target.error;
        atomicWriteJson(p, rec);
        reconciled.push({ id: rec.id, outcome: 'unresolved', why: target.error });
        continue;
      }

      let current = null;
      try {
        current = readFileSync(target.abs, 'utf8');
      } catch {
        current = null;
      }
      const now = current === null ? null : sha256Of(current);

      // The same classification rollback uses, so a crash and an operator reach
      // the same conclusion about the same entry.
      const outcome = this.#classify(rec, target.abs);

      rec.outcome = outcome;
      rec.settledAt = new Date().toISOString();
      atomicWriteJson(p, rec);
      reconciled.push({ id: rec.id, outcome, path: rec.rel ?? null });
    }

    // Scratch files from a crash mid-write. Only ones carrying our prefix and
    // only in directories we wrote to, and only old enough that no live write is
    // still holding one.
    const dirs = new Set();
    for (const r of reconciled) {
      if (!r.path) continue;
      const t = this.#rollbackTarget({ rel: r.path });
      if (!t.error) dirs.add(dirname(t.abs));
    }
    const removedTemp = [];
    for (const abs of staleTempFiles([...dirs], { olderThanMs: 0 })) {
      if (removeTemp(abs)) removedTemp.push(abs);
    }

    return { reconciled, removedTemp };
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

    // Conflict detection: is the file still the version we wrote?
    //
    // Rolling back means overwriting whatever is there now with what was there
    // before. If something has edited the file since, that overwrites the newer
    // work -- silently, and reporting success. "The file contains what we put
    // there" is the only condition under which a rollback is the operation the
    // user asked for.
    //
    // Entries written before hashes existed fall back to comparing the text we
    // recorded, and an entry with neither is refused rather than assumed safe:
    // "I cannot tell whether this is safe" is not permission to overwrite.
    const conflict = this.#rollbackConflict(rec, target.abs);
    if (conflict) return { status: 'conflict', code: 'rollback_conflict', why: conflict };

    if (rec.before === null) {
      // The file did not exist before. Removing it is only correct if it is
      // still exactly what we created -- otherwise this would delete a file the
      // user has since written.
      if (existsSync(target.abs)) {
        const moved = `${target.abs}.wd-deleted`;
        renameSync(target.abs, moved);
        rec.outcome = 'rolled-back';
        rec.rolledBackAt = new Date().toISOString();
        atomicWriteJson(p, rec);
        return { status: 'rolled-back', note: 'file did not exist before; moved aside', path: moved };
      }
      rec.outcome = 'rolled-back';
      atomicWriteJson(p, rec);
      return { status: 'rolled-back', note: 'file was already gone', path: target.abs };
    }

    // Atomic, like every other write: a crash mid-rollback must not leave the
    // file half-restored.
    atomicReplace(target.abs, rec.before);
    rec.outcome = 'rolled-back';
    rec.rolledBackAt = new Date().toISOString();
    atomicWriteJson(p, rec);
    return { status: 'rolled-back', path: target.abs };
  }

  /**
   * Where does this file sit relative to the two images a journal entry records?
   *
   * @returns {'ok'|'aborted'|'conflict'} `ok` means the entry's change landed,
   *   `aborted` means the file is still the pre-image, `conflict` means it is
   *   neither -- somebody else changed it, and guessing would be wrong.
   *
   * Shared by crash recovery and rollback so both answer the same question the
   * same way. They previously differed in a way that mattered: recovery compared
   * hashes, rollback compared nothing at all.
   */
  #classify(rec, abs) {
    let current = null;
    try {
      current = readFileSync(abs, 'utf8');
    } catch {
      current = null;
    }
    if (current === null) return 'aborted';
    const now = sha256Of(current);
    if (rec.afterSha && now === rec.afterSha) return 'ok';
    if (rec.beforeSha && now === rec.beforeSha) return 'aborted';
    if (!rec.afterSha && typeof rec.after === 'string') return current === rec.after ? 'ok' : 'conflict';
    return 'conflict';
  }
  /**
   * Would this rollback destroy someone else's work?
   *
   * @returns {string|null} the reason it would, or null when it is safe
   */
  #rollbackConflict(rec, abs) {
    let current = null;
    try {
      current = readFileSync(abs, 'utf8');
    } catch {
      current = null;
    }

    if (current === null) {
      // The file is gone. Restoring `before` is not a conflict -- there is
      // nothing to destroy.
      return null;
    }

    const now = sha256Of(current);
    if (rec.afterSha && now === rec.afterSha) return null;
    if (!rec.afterSha && typeof rec.after === 'string' && current === rec.after) return null;

    if (!rec.afterSha && typeof rec.after !== 'string') {
      return (
        `cannot tell whether ${rec.rel ?? abs} is safe to roll back: this entry records no ` +
        'post-image, so there is nothing to compare the file against. Rolling it back would ' +
        'overwrite whatever is there now. Roll back manually if that is what you want.'
      );
    }

    return (
      `${rec.rel ?? abs} has changed since the watchdog wrote it, so rolling back would ` +
      `overwrite newer work (expected ${shortHash(rec.afterSha ?? sha256Of(rec.after ?? ''))}, ` +
      `found ${shortHash(now)}). Nothing was written. Revert it yourself, or force the ` +
      'rollback if you are sure the newer changes should be discarded.'
    );
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
  if (lock === "pnpm") return ["pnpm", "install", "--frozen-lockfile", ...NO_SCRIPTS.pnpm];
  if (lock === "yarn") return ["yarn", "install", "--frozen-lockfile", ...NO_SCRIPTS.yarn];
  if (lock === "npm") return existsSync(join(root, "package.json")) ? ["npm", "ci", ...NO_SCRIPTS.npm] : [];

  // No lockfile: fall back to the declared package, still allowlisted.
  if (existsSync(join(root, "package.json"))) return ["npm", "install", pkg, ...NO_SCRIPTS.npm];
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
      // The venv's own interpreter, invoked as a bare name relative to the venv's
      // bin directory -- not as an absolute path. The command policy refuses
      // absolute executables on purpose ("run this exact file" is the shape that
      // turns a vetted program name into "run whatever that file does"), and a
      // path here was refused until this was fixed.
      //
      // `python -m pip` rather than the venv's pip script: the same interpreter,
      // the same environment, and it does not depend on a `pip.exe` shim existing.
      //
      // `--only-binary=:all:` because pip has no `--ignore-scripts`. A wheel
      // installs declaratively; an sdist runs the package's own setup.py with the
      // user's privileges, which is the thing being refused.
      return ["python", "-m", "pip", "install", pkg, ...NO_SCRIPTS.python];
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

/** Summarise a transaction's per-file outcomes. */
function aggregateTx(results) {
  const applied = results.filter((r) => r?.status === 'applied').length;
  const n = results.length;
  let status;
  if (applied === n) status = 'all_applied';
  else if (applied === 0) status = results.some((r) => r?.status === 'refused') ? 'refused' : 'none_applied';
  else status = 'partially_applied';
  return { status, applied, total: n, allApplied: applied === n };
}

/** A proposal this large is not something to apply in parts. */
const MAX_TRANSACTION_FILES = 25;
