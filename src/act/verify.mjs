/**
 * Proving a proposed change did not break the project, before making it.
 *
 * The problem this exists to solve: an LLM edit is judged on `verdict === problem`
 * and `confidence >= 0.6`. Neither of those is evidence the edit is correct. The
 * model proposes a fix, the anchor is found, the result parses, and the write
 * lands -- but "the error we saw is no longer visible" and "the program still
 * works" are different claims, and only the second one matters. The fix-quality
 * eval made this concrete: patches that applied cleanly and parsed still changed
 * behaviour for the worse, because a valid edit can still be semantically wrong.
 *
 * The shape of the answer is stage -> prove -> promote:
 *
 *     copy the project to a scratch directory
 *     apply the proposed edits there
 *     run the project's own verification
 *     only then replay the same edits against the real tree
 *
 * The real project is never in a half-edited state while the question is still
 * open. That is the difference from apply-then-check-then-revert, which would
 * leave broken code on disk for the duration of the check and would leave it
 * there permanently if the process died mid-check.
 *
 * When there is nothing to verify with, the answer is "unverified" rather than a
 * guess. A project with no test command, no build and no configured check gets
 * no autonomous model edits at all -- they are reported for a human instead.
 */
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, statSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, dirname, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { sha256Of } from './hashes.mjs';

/** Never copied. .git is history, node_modules is large and reinstallable. */
const NOT_STAGED = new Set(['.git', 'node_modules', '.watchdog']);

/** Extensions a staged edit is allowed to touch. */
const CHECKABLE = new Set(['.js', '.mjs', '.cjs', '.jsx']);

/**
 * Copy a project into a scratch directory.
 *
 * `node_modules` is linked rather than copied when the platform allows it: a
 * test run needs its dependencies present, and copying hundreds of megabytes to
 * run one command is not a trade anyone wants. Without the link the staged run
 * simply fails, which surfaces as "unverified" rather than as a false pass.
 */
export function stageProject(root, { maxFiles = 20_000 } = {}) {
  const stage = mkdtempSync(join(tmpdir(), 'wd-verify-'));
  let count = 0;

  const walk = (from, to) => {
    if (count > maxFiles) throw new Error(`project is too large to stage (>${maxFiles} files)`);
    let entries;
    try {
      entries = readdirSync(from, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (NOT_STAGED.has(e.name)) continue;
      const src = join(from, e.name);
      const dst = join(to, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        // Links are not followed. Copying the target's contents would pull in
        // whatever it points at, which may be outside the project entirely.
        continue;
      }
      if (isDir) {
        mkdirSync(dst, { recursive: true });
        walk(src, dst);
      } else if (isFile) {
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst);
        count++;
      }
    }
  };

  mkdirSync(stage, { recursive: true });
  walk(root, stage);

  const deps = join(root, 'node_modules');
  if (existsSync(deps)) linkOrCopy(deps, join(stage, 'node_modules'));

  return stage;
}

/** Reuse the dependency tree: a directory junction on Windows, a symlink elsewhere. */
function linkOrCopy(src, dst) {
  try {
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'mklink', '/J', dst, src], { timeout: 60_000, windowsHide: true, stdio: 'ignore' });
      return;
    }
    execFileSync('ln', ['-s', src, dst], { timeout: 60_000, stdio: 'ignore' });
  } catch {
    // No junction/symlink available. Copying is the slow fallback; failing to do
    // either is fine too, since a missing dependency tree fails the run loudly
    // rather than quietly passing.
    try {
      copyFileTree(src, dst);
    } catch {
      /* leave it absent */
    }
  }
}

function copyFileTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, e.name);
    const to = join(dst, e.name);
    if (e.isDirectory()) copyFileTree(from, to);
    else if (e.isFile()) copyFileSync(from, to);
  }
}

/**
 * Apply the proposed edits to the staged copy only.
 *
 * Returns the edits it could not make rather than throwing, because "the patch
 * does not apply here" is a legitimate unverified outcome, not a crash.
 *
 * @returns {{applied: object[], failed: object[]}}
 */
export function applyToStage(stage, files) {
  const applied = [];
  const failed = [];
  const preimages = [];

  for (const f of files ?? []) {
    const abs = join(stage, f.path);
    if (!existsSync(abs)) {
      failed.push({ path: f.path, why: 'file does not exist in the staged copy' });
      continue;
    }
    let body;
    try {
      body = readFileSync(abs, 'utf8');
    } catch (e) {
      failed.push({ path: f.path, why: e.message });
      continue;
    }

    // The preimage of the version about to be verified. The stage is a faithful
    // copy, so this is also the real file's content at the moment of copying --
    // which is what makes it worth comparing against later.
    preimages.push({ path: f.path, sha256: sha256Of(body) });

    const at = body.indexOf(f.find);
    if (at < 0) {
      failed.push({ path: f.path, why: 'the text to replace is not present in the staged copy' });
      continue;
    }
    if (body.indexOf(f.find, at + 1) >= 0) {
      failed.push({ path: f.path, why: 'the text to replace is ambiguous' });
      continue;
    }
    const after = body.slice(0, at) + f.replace + body.slice(at + f.find.length);
    writeFileSync(abs, after, 'utf8');
    applied.push(f);
  }
  return { applied, failed, preimages };
}

/**
 * Run a command and report its real exit code.
 *
 * Deliberately not `runCapture`. That helper collapses everything to a string and
 * throws the exit code away whenever the command printed anything to stdout:
 *
 *     child.on('close', (code) => {
 *       if (out.trim()) return finish(out);
 *       if (code !== 0) return finish('__WD_EXIT__' + code + ...)
 *
 * That is the right trade for parsing a JSON envelope out of an LLM reply, and
 * the wrong one here. `npm test` prints progress and exits 1; through runCapture
 * that is indistinguishable from success, which would make every verification pass
 * unconditionally and turn the whole gate into decoration. A check that cannot
 * fail is worse than no check, because it is believed.
 */
function runCommand(argv, { cwd, timeoutMs, maxBuffer = 4 * 1024 * 1024 }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: null, spawnFailed: true, timedOut: false, output: `${argv[0]}: ${e.message}` });
    }

    let out = '';
    let err = '';
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(v);
    };

    const timer = setTimeout(
      () => finish({ code: null, spawnFailed: false, timedOut: true, output: (out + err).slice(-2000) }),
      timeoutMs,
    );
    if (timer.unref) timer.unref();

    child.stdout.on('data', (d) => {
      if (out.length < maxBuffer) out += d;
    });
    child.stderr.on('data', (d) => {
      if (err.length < maxBuffer) err += d;
    });
    child.on('error', (e) => finish({ code: null, spawnFailed: true, timedOut: false, output: `${argv[0]}: ${e.message}` }));
    child.on('close', (code) => finish({ code, spawnFailed: false, timedOut: false, output: (out + err).slice(-4000) }));
  });
}

/**
 * Run the project's own verification against a staged tree.
 *
 * @returns {Promise<{ok: boolean, code: number|null, timedOut: boolean, output: string}>}
 */
export async function runVerifier(stage, verifyCfg) {
  const argv = verifyCfg?.command;
  if (!Array.isArray(argv) || !argv.length || typeof argv[0] !== 'string') {
    return { ok: false, code: null, timedOut: false, output: 'no verification command configured', skipped: true };
  }
  const r = await runCommand(argv, { cwd: stage, timeoutMs: verifyCfg.timeoutMs ?? 300_000 });
  return { ...r, ok: r.code === 0 };
}

/**
 * Decide whether a set of proposed edits may be applied autonomously.
 *
 * @returns {Promise<{verdict: 'pass'|'fail'|'unverified', why: string, output?: string}>}
 */
export async function verifyProposals({ projectRoot, files, verifyCfg }) {
  if (!verifyCfg?.command) {
    return {
      verdict: 'unverified',
      why:
        'no verification command is configured, so there is no way to prove this edit does not ' +
        'break the project. Set verify.command (for example ["npm","test"]) to allow model edits, ' +
        'or run this one by hand from the finding.',
    };
  }

  let stage;
  let preimages = [];
  try {
    stage = stageProject(projectRoot);
  } catch (e) {
    return { verdict: 'unverified', why: `could not stage the project for checking: ${e.message}` };
  }

  try {
    const { applied, failed, preimages: pre } = applyToStage(stage, files);
    preimages = pre;
    if (failed.length) {
      return {
        verdict: 'unverified',
        why: `the edit does not apply cleanly: ${failed.map((f) => `${f.path} (${f.why})`).join('; ')}`,
      };
    }
    if (!applied.length) {
      return { verdict: 'unverified', why: 'the proposal contained no edits to check' };
    }

    // Cheap floor first. A test run is expensive and an edit that cannot parse
    // has already failed, so the broken-file class is rejected without paying for
    // the verifier.
    const parse = parsesCleanly(stage, files);
    if (!parse.ok) {
      return { verdict: 'fail', why: `the edit leaves the project unbuildable: ${parse.why}` };
    }

    const result = await runVerifier(stage, verifyCfg);
    if (result.skipped) return { verdict: 'unverified', why: 'no verification command is configured' };
    if (result.timedOut) {
      return {
        verdict: 'unverified',
        why: `verification timed out after ${verifyCfg.timeoutMs ?? 300_000}ms, so the result is unknown rather than a pass`,
      };
    }
    if (result.spawnFailed) {
      return { verdict: 'unverified', why: `verification could not be run: ${result.output}` };
    }
    if (!result.ok) {
      return {
        verdict: 'fail',
        why: 'the project does not pass its own verification with this edit applied',
        output: result.output,
      };
    }
    return {
      verdict: 'pass',
      why: 'the project passes its own verification with this edit applied',
      preimages,
    };
  } finally {
    try {
      rmSync(stage, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* a leftover scratch dir is not worth failing a decision over */
    }
  }
}

/**
 * The cheapest possible check: does the edited file still parse?
 *
 * This is a floor, not a proof. It catches the class of model error that produces
 * a broken file -- replacing a bare identifier with a statement -- and is used
 * ahead of the full verifier so obviously-dead edits do not pay for a test run.
 */
export function parsesCleanly(stageRoot, files) {
  for (const f of files ?? []) {
    if (!CHECKABLE.has(extOf(f.path))) continue;
    const abs = join(stageRoot, f.path);
    if (!existsSync(abs)) return { ok: false, why: `${f.path} is missing` };
    let tmp = null;
    try {
      tmp = join(stageRoot, `.wd-syntax-${Math.random().toString(36).slice(2)}${extOf(f.path)}`);
      writeFileSync(tmp, readFileSync(abs, 'utf8'), 'utf8');
      execFileSync(process.execPath, ['--check', tmp], { timeout: 20_000, stdio: ['ignore', 'ignore', 'pipe'] });
      return { ok: true };
    } catch (e) {
      return { ok: false, why: `${f.path} would not parse: ${(e.stderr ?? e.message ?? '').toString().split('\n').slice(0, 3).join(' ')}` };
    } finally {
      if (tmp) {
        try {
          rmSync(tmp, { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { ok: true };
}

function extOf(p) {
  const i = String(p).lastIndexOf('.');
  return i < 0 ? '' : String(p).slice(i).toLowerCase();
}

export { relative, resolve, statSync };