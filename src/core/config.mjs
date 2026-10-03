import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { log } from './log.mjs';

/**
 * Layered config: built-in defaults <- ~/.watchdog/config.json <- ./.watchdog/config.json
 * Project config wins, which is what you want for a per-repo autonomy choice.
 */
export const DEFAULTS = Object.freeze({
  autonomy: 'autonomous', // suggest | allowlist | autonomous  (rail denylist applies regardless)
  capture: {
    layers: {
      shell: true, //   layer 1: profile-injected session capture
      process: true, // layer 2: detached process / exit-code watcher
      conpty: false, //  layer 3: raw ConPTY byte proxy (opt-in, reports availability)
    },
    // Programs that own the screen and cannot survive piped stdio.
    // Sessions running these are passed through and marked `unwatched`
    // rather than silently mis-captured.
    passthrough: [
      'vim', 'nvim', 'vi', 'emacs', 'nano', 'helix', 'hx',
      'less', 'more', 'top', 'htop', 'btop', 'man', 'watch',
      'ssh', 'sftp', 'telnet', 'tmux', 'screen',
      'fzf', 'lazygit', 'gitui', 'k9s', 'lazysql',
      'python', 'python3', 'ipython', 'node', 'irb', 'psql', 'mysql', 'sqlite3',
    ],
    maxLineBytes: 64 * 1024, // guard against a pathological no-newline flood
    // Applies to everything the watchdog itself stores or sends: findings, the
    // journal, LLM prompts, Langfuse traces. It does NOT apply to the shell's own
    // transcript, which PowerShell writes with Start-Transcript before the daemon
    // reads a single byte. That file lands in the user's own profile directory
    // with user-only permissions, but until it is read it holds whatever the
    // terminal printed, secrets included.
    redact: true,
  },
  analyze: {
    llm: {
      enabled: true,
      cli: 'opencode',
      model: null, // null => let opencode pick its default
      timeoutMs: 180_000,
      // Only escalate to the LLM for findings the rules are unsure about.
      minSeverity: 'medium',
      maxInvocationsPerSession: 2,
    },
    cooldownMs: 15_000, // per-signature, stops a looping build spamming the LLM
    maxFindingsPerSession: 200,
  },
  // LLM observability. Off unless credentials are present, and it can never
  // affect a finding: telemetry failing must not change what the watchdog does.
  tracing: {
    enabled: false,
    publicKey: null,
    secretKey: null,
    baseUrl: 'https://cloud.langfuse.com',
    environment: 'local',
    // Terminal output is the advisor's input, and terminal output leaks secrets
    // in ways nobody thinks about. This is on by default and should stay on.
    redact: true,
  },
  paths: {
    data: null, // null => <projectRoot>/.watchdog
  },
  ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**'],
});

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function findProjectRoot(from = process.cwd()) {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, 'package.json')) || existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(from);
    dir = up;
  }
}

export function globalConfigPath() {
  return join(homedir(), '.watchdog', 'config.json');
}

function readJsonIfExists(p) {
  if (!existsSync(p)) return {};
  try {
    // Strip a UTF-8 BOM. Windows PowerShell's `Set-Content -Encoding UTF8` and
    // Notepad both write one, and JSON.parse rejects it -- so without this a
    // perfectly good config file is thrown away wholesale. The failure is nasty
    // because it is total: autonomy, model and rails all revert to defaults, and
    // a file that says "suggest" silently behaves as "autonomous".
    return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    log.warn(`ignoring unparseable config at ${p}: ${err.message}`);
    return {};
  }
}

export function loadConfig({ cwd = process.cwd(), projectRoot } = {}) {
  const root = projectRoot ?? findProjectRoot(cwd);
  const merged = deepMerge(deepMerge(DEFAULTS, readJsonIfExists(globalConfigPath())), readJsonIfExists(join(root, '.watchdog', 'config.json')));

  if (!merged.paths.data) merged.paths.data = join(root, '.watchdog');
  else if (!isAbsolute(merged.paths.data)) merged.paths.data = resolve(root, merged.paths.data);

  if (!['suggest', 'allowlist', 'autonomous'].includes(merged.autonomy)) {
    throw new Error(`autonomy must be suggest|allowlist|autonomous, got ${JSON.stringify(merged.autonomy)}`);
  }
  merged.projectRoot = root;
  return merged;
}

export function saveConfig(cfg) {
  const p = join(cfg.projectRoot, '.watchdog', 'config.json');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(stripInternal(cfg), null, 2) + '\n');
  return p;
}

function stripInternal(cfg) {
  const { projectRoot, ...rest } = cfg;
  return rest;
}
