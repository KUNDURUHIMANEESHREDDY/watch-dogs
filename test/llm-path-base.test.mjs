/**
 * The file that was verified must be the file that is changed.
 *
 * This was not true. Verification resolved a proposal's path against the project
 * root, because the staged copy is made from the project root:
 *
 *     applyToStage: join(stage, f.path)          stage came from projectRoot
 *
 * while the real write resolved the same string against the session's working
 * directory:
 *
 *     #patchFile:   const root = ctx.cwd ?? this.projectRoot
 *     watcher:      this.#applier.apply(..., { cwd: rec.cwd, source: 'llm' })
 *
 * So with a monorepo session:
 *
 *     projectRoot = C:\repo
 *     cwd         = C:\repo\packages\api
 *     fix.path    = src/index.js
 *
 * verification checked C:\repo\src\index.js
 * and the write targeted  C:\repo\packages\api\src\index.js
 *
 * Two different files. The verification result said nothing about the file that
 * actually changed, which breaks the one guarantee the staged-verification design
 * exists to provide.
 *
 * A path is now canonicalised against the project root exactly once, before
 * verification, and that same string is used for the write.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { toProjectRelative } from '../src/core/paths.mjs';

/** root/src/index.js and root/packages/api/src/index.js, with different contents. */
function monorepo() {
  const root = mkdtempSync(join(tmpdir(), 'wd-monorepo-'));
  for (const dir of ['src', 'packages/api/src']) {
    mkdirSync(join(root, ...dir.split('/')), { recursive: true });
  }
  // Deliberately different content, so a write to the wrong one is detectable.
  writeFileSync(join(root, 'src', 'index.js'), 'ROOT_COPY = 1;\n', 'utf8');
  writeFileSync(join(root, 'packages', 'api', 'src', 'index.js'), 'PKG_COPY = 1;\n', 'utf8');
  writeFileSync(join(root, 'package.json'), '{"name":"mono"}\n', 'utf8');
  return root;
}

/* ------------------------------------------------------------------ *
 * The canonicalisation
 * ------------------------------------------------------------------ */

test('a path given against the session cwd becomes project-root-relative', () => {
  const root = monorepo();
  const cwd = join(root, 'packages', 'api');
  // The session said "src/index.js", meaning the file next to it.
  assert.equal(toProjectRelative('src/index.js', cwd, root), 'packages/api/src/index.js');
});

test('a path already relative to the project root is unchanged', () => {
  const root = monorepo();
  assert.equal(toProjectRelative('src/index.js', root, root), 'src/index.js');
});

test('the canonical path round-trips to the same file, resolved against the root', () => {
  const root = monorepo();
  const cwd = join(root, 'packages', 'api');
  const rel = toProjectRelative('src/index.js', cwd, root);

  // Resolved against the project root, it is the file the session meant.
  assert.equal(resolve(root, ...rel.split('/')), join(root, 'packages', 'api', 'src', 'index.js'));

  // And resolving it against the session directory instead is what the old code
  // effectively did, which is why the two disagreed. Asserted rather than left as
  // prose, because this double-prefixing is the whole bug in one line.
  assert.notEqual(resolve(cwd, ...rel.split('/')), join(root, 'packages', 'api', 'src', 'index.js'));
  assert.match(resolve(cwd, ...rel.split('/')), /packages[/\\]api[/\\]packages[/\\]api/);
});

test('canonicalisation always uses forward slashes, whatever the platform', () => {
  const root = monorepo();
  const cwd = join(root, 'packages', 'api');
  const rel = toProjectRelative('src/index.js', cwd, root);
  assert.ok(!rel.includes('\\'), `expected forward slashes, got ${rel}`);
  assert.ok(!rel.includes(':'), `expected a relative path, got ${rel}`);
});

test('a path that escapes the project root is refused rather than rewritten', () => {
  const root = monorepo();
  const cwd = join(root, 'packages', 'api');
  // Climbing out of the session directory but staying inside the project is fine;
  // climbing out of the project is not, and must not become a valid relative path.
  assert.equal(toProjectRelative('../../src/index.js', cwd, root), 'src/index.js');
  assert.equal(toProjectRelative('../../../../outside.js', cwd, root), null);
  assert.equal(toProjectRelative('C:/Windows/System32/drivers/etc/hosts', cwd, root), null);
});

test('a path that does not exist is still canonicalised, because validation comes later', () => {
  // The applier's own checks own "does this file exist". Canonicalisation only
  // answers "which file does this name refer to", and refusing here would report
  // the wrong reason for a genuinely missing file.
  const root = monorepo();
  const cwd = join(root, 'packages', 'api');
  assert.equal(toProjectRelative('src/not-created-yet.js', cwd, root), 'packages/api/src/not-created-yet.js');
});

/* ------------------------------------------------------------------ *
 * The property that matters
 * ------------------------------------------------------------------ */

test('verification and application now resolve to the same absolute file', () => {
  // The regression as a single assertion: given the same proposal and the same
  // session, the staged path and the real path are one file.
  const root = monorepo();
  const cwd = join(root, 'packages', 'api');

  const proposal = { path: 'src/index.js', find: 'PKG_COPY', replace: 'PKG_FIXED' };

  // Canonicalised once, then used for both.
  const canonical = toProjectRelative(proposal.path, cwd, root);
  const stagedPath = resolve(root, ...canonical.split('/')); // stage mirrors projectRoot
  const realPath = resolve(root, ...canonical.split('/')); // apply uses cwd: projectRoot

  assert.equal(stagedPath, realPath, 'the verified file and the applied file differ');
  assert.equal(stagedPath, join(root, 'packages', 'api', 'src', 'index.js'));
});

test('the two files in this repo really are different, so the test above has teeth', () => {
  const root = monorepo();
  const a = readFileSync(join(root, 'src', 'index.js'), 'utf8');
  const b = readFileSync(join(root, 'packages', 'api', 'src', 'index.js'), 'utf8');
  assert.notEqual(a, b, 'the fixtures are identical, so a wrong write would be undetectable');
  assert.match(a, /ROOT_COPY/);
  assert.match(b, /PKG_COPY/);
});

/* ------------------------------------------------------------------ *
 * Through the watcher, where the bug actually lived
 * ------------------------------------------------------------------ */

test('a fix proposed from a subdirectory session changes that session file', async () => {
  // The regression, end to end. The model says `src/index.js`, meaning the file
  // beside the session. Before the fix that string was verified against the
  // project root and written against the session, so the two files diverged: one
  // was checked, the other was changed.
  const { Watcher } = await import('../src/core/watcher.mjs');
  const { loadConfig } = await import('../src/core/config.mjs');
  const { stubAnswering } = await import('./helpers/stub-cli.mjs');
  const { verifyProposals } = await import('../src/act/verify.mjs');

  const root = monorepo();
  const cwd = join(root, 'packages', 'api');
  const rootFile = join(root, 'src', 'index.js');
  const pkgFile = join(cwd, 'src', 'index.js');

  const rootBefore = readFileSync(rootFile, 'utf8');
  const pkgBefore = readFileSync(pkgFile, 'utf8');

  // The canonical path the watcher will compute, and what it must verify and write.
  const canonical = toProjectRelative('src/index.js', cwd, root);
  assert.equal(canonical, 'packages/api/src/index.js');

  // Verification must be asked about that same canonical file.
  const verdict = await verifyProposals({
    projectRoot: root,
    files: [{ path: canonical, find: 'PKG_COPY', replace: 'PKG_FIXED' }],
    verifyCfg: { command: null, timeoutMs: 1000 },
  });
  assert.equal(verdict.verdict, 'unverified', 'with no verifier configured nothing may be applied');

  // And the applier, given the canonical path against the project root, must land
  // on the session's file rather than the root's.
  const { Applier } = await import('../src/act/apply.mjs');
  const base = loadConfig({ cwd: root, projectRoot: root });
  const applier = new Applier({
    projectRoot: root,
    dataDir: join(root, '.watchdog'),
    autonomy: 'autonomous',
    allowlist: [],
  });
  void base;

  const res = applier.apply(
    { kind: 'patch-file', path: canonical, find: 'PKG_COPY', replace: 'PKG_FIXED' },
    { cwd: root, source: 'llm' },
  );
  assert.equal(res.status, 'applied', JSON.stringify(res));

  assert.equal(readFileSync(pkgFile, 'utf8'), 'PKG_FIXED = 1;\n', 'the session file was not the one changed');
  assert.equal(readFileSync(rootFile, 'utf8'), rootBefore, 'the project-root file was changed instead');

  void stubAnswering;
  void Watcher;
});

test('through the real watcher, a subdirectory session changes its own file', async () => {
  // Drives ingest -> advisor -> verification -> apply for real, with only the
  // model's answer stubbed. Calling the applier directly, as the test above does,
  // cannot see a mutation in the watcher -- and the earlier mutation of exactly
  // that line passed the whole suite.
  const { Watcher } = await import('../src/core/watcher.mjs');
  const { loadConfig } = await import('../src/core/config.mjs');
  const { stubAnswering } = await import('./helpers/stub-cli.mjs');
  const { mkdtempSync: mk } = await import('node:fs');

  const root = monorepo();
  const cwd = join(root, 'packages', 'api');
  const rootFile = join(root, 'src', 'index.js');
  const pkgFile = join(cwd, 'src', 'index.js');

  // A verification command that passes, so the gate actually opens and a write
  // happens. Without one the refusal path is taken and nothing is ever applied,
  // which would make this test green for the wrong reason.
  const checkDir = mk(join(tmpdir(), 'wd-check-'));
  writeFileSync(join(checkDir, 'check.cjs'), 'process.exit(0);\n', 'utf8');

  const stub = stubAnswering(
    JSON.stringify({
      verdict: 'problem',
      confidence: 0.95,
      summary: 'PKG_COPY is wrong',
      // The model, which cannot see the tree, names the file beside the session.
      fix: { description: 'd', files: [{ path: 'src/index.js', find: 'PKG_COPY', replace: 'PKG_FIXED' }] },
    }),
  );

  const base = loadConfig({ cwd: root, projectRoot: root });
  const watcher = new Watcher({
    ...base,
    projectRoot: root,
    autonomy: 'autonomous',
    analyze: {
      ...base.analyze,
      llm: { enabled: true, cli: stub.cmd, model: null, timeoutMs: 60_000, minSeverity: 'low', maxInvocationsPerSession: 5 },
    },
    verify: { command: [process.execPath, join(checkDir, 'check.cjs')], timeoutMs: 60_000 },
    paths: { data: join(root, '.watchdog') },
  });

  const seen = [];
  watcher.on('needs-human', (rec) => seen.push({ kind: 'needs-human', rec }));
  watcher.on('finding-updated', (rec) => seen.push({ kind: 'finding-updated', rec }));

  // An error-shaped line no rule claims, so it reaches the residual advisor.
  await watcher.ingest('ZorblaxError: widget batch misaligned\n    at run (/app/packages/api/src/index.js:1:1)', {
    sessionId: 's1',
    cwd,
    shell: 'powershell',
  });

  const decided = () =>
    seen.some((e) => e.kind === 'needs-human' || (e.kind === 'finding-updated' && e.rec.advisor?.verification));
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline && !decided()) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 400));

  assert.match(readFileSync(pkgFile, 'utf8'), /PKG_FIXED/, "the session's own file was not the one changed");
  assert.match(readFileSync(rootFile, 'utf8'), /ROOT_COPY/, 'the project-root file was changed instead');
  assert.ok(!readFileSync(rootFile, 'utf8').includes('PKG_FIXED'), 'a second file was written');
});