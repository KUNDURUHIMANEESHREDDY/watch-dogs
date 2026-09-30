/**
 * Import smoke test. Every module must at least parse and load, and the CLI must
 * respond to its own --help. Unit tests that only import the modules they exercise
 * will happily miss a syntax error in the rest of the tree, which is exactly how
 * a broken `detectIde` shipped past a green test run once already.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Windows ESM requires a file:// URL; a bare absolute path is rejected.
const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const MODULES = [
  'src/core/log.mjs',
  'src/core/config.mjs',
  'src/core/exec.mjs',
  'src/core/watcher.mjs',
  'src/capture/stream.mjs',
  'src/capture/shell.mjs',
  'src/capture/procwatch.mjs',
  'src/capture/conpty.mjs',
  'src/analyze/rules.mjs',
  'src/analyze/advisor.mjs',
  'src/act/guard.mjs',
  'src/act/apply.mjs',
  'src/install/install.mjs',
  'bin/wd.js',
];

test('every module parses and loads', async () => {
  for (const m of MODULES) {
    await assert.doesNotReject(() => load(m), `module failed to load: ${m}`);
  }
});

const CLI_COMMANDS = [['--help'], ['rules'], ['rails'], ['doctor']];

for (const args of CLI_COMMANDS) {
  test(`CLI responds to \`wd ${args.join(' ')}\``, () => {
    const stdout = execFileSync(process.execPath, [join(ROOT, 'bin', 'wd.js'), ...args], {
      encoding: 'utf8',
      timeout: 90_000,
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.ok(stdout.trim().length > 0, `wd ${args.join(' ')} produced no output`);
  });
}

test('detectIde identifies an IDE terminal from env alone', async () => {
  const { detectIde } = await load('src/capture/shell.mjs');
  assert.equal(detectIde({ VSCODE_PID: '1234' }), 'VS Code / Cursor');
  assert.equal(detectIde({ WT_PROFILE_ID: 'abc' }), 'Windows Terminal');
  assert.equal(detectIde({ GOORU_IDE: 'x' }), 'GoLand');
  assert.equal(detectIde({}), 'unknown');
});

test('config loads and defaults to a valid autonomy', async () => {
  const { loadConfig } = await load('src/core/config.mjs');
  const cfg = loadConfig({ cwd: ROOT });
  assert.ok(['suggest', 'allowlist', 'autonomous'].includes(cfg.autonomy));
  assert.ok(cfg.projectRoot);
  assert.ok(cfg.paths.data.endsWith('.watchdog'));
});

test('a UTF-8 BOM does not throw the whole config away', async () => {
  // Windows PowerShell `Set-Content -Encoding UTF8` and Notepad both emit a BOM,
  // and JSON.parse rejects one. The failure this guards against is total and
  // safety-relevant: a file that says autonomy "suggest" would otherwise be
  // discarded wholesale and the watchdog would run autonomously instead.
  const { loadConfig } = await load('src/core/config.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'wd-bom-'));
  writeFileSync(join(dir, 'package.json'), '{"name":"p"}\n');
  mkdirSync(join(dir, '.watchdog'), { recursive: true });
  writeFileSync(
    join(dir, '.watchdog', 'config.json'),
    '\uFEFF{"autonomy":"suggest","analyze":{"llm":{"model":"pinned/model"}}}',
    'utf8',
  );

  const cfg = loadConfig({ cwd: dir });
  assert.equal(cfg.autonomy, 'suggest', 'autonomy was silently reverted to the default');
  assert.equal(cfg.analyze.llm.model, 'pinned/model', 'the rest of the file was dropped too');
});
