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
      process: true, // layer 2: detached process lifecycle. No exit codes -- see procwatch.mjs
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
    // Cap on findings.jsonl before it is rotated aside. Sized for records rather
    // than diagnostics; one previous generation is kept.
    maxFindingsBytes: 16 * 1024 * 1024,
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

/**
 * Deep-copy the plain structure in a config value.
 *
 * Needed because `Object.freeze` is one level deep. `DEFAULTS` was frozen, which
 * made it look immutable, but `DEFAULTS.paths` and `DEFAULTS.analyze.llm` were
 * still live objects sharing a reference with every merged result. `loadConfig`
 * then assigned `merged.paths.data = ...`, which wrote straight through into the
 * default, and every later call inherited the first projectRoot's data dir. One
 * project's configuration leaking into another's is exactly the kind of bug that
 * only shows up on a machine watching more than one repo.
 */
function cloneValue(v) {
  if (Array.isArray(v)) return v.map(cloneValue);
  if (!isPlainObject(v)) return v;
  const out = {};
  for (const [k, inner] of Object.entries(v)) out[k] = cloneValue(inner);
  return out;
}

/** One level of clone, recursing. Keeps a shallow `{...base}` from aliasing. */
function clonePlainMap(src) {
  const out = {};
  for (const [k, v] of Object.entries(src)) out[k] = cloneValue(v);
  return out;
}

export function deepMerge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? cloneValue(base) : override;
  // Cloned rather than spread: `{ ...base }` copies nested objects by reference,
  // so a later assignment to any nested key would mutate the base.
  const out = clonePlainMap(isPlainObject(base) ? base : {});
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : cloneValue(v);
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

/**
 * Read one config layer.
 *
 * @returns {{value: object, unreadable: boolean}} `unreadable` means the file
 *   exists but could not be understood, which is not the same as "no opinion".
 *
 * This used to return `{}` on a parse error and let DEFAULTS fill the gap. That
 * is a fail-open, and specifically the wrong direction here: the default autonomy
 * is `autonomous`, so a config file saying `{"autonomy": "suggest"}` that got
 * truncated by a half-finished write, a bad hand-edit, or a BOM it did not expect
 * would silently run the watchdog applying fixes without asking. A config we
 * cannot read is a config whose intent we do not know, and the safe reading of
 * unknown is the least permissive one -- not the default.
 */
function readJsonIfExists(p) {
  if (!existsSync(p)) return { value: {}, unreadable: false };
  try {
    // Strip a UTF-8 BOM. Windows PowerShell's `Set-Content -Encoding UTF8` and
    // Notepad both write one, and JSON.parse rejects it -- so without this a
    // perfectly good config file is thrown away wholesale. The failure is nasty
    // because it is total: autonomy, model and rails all revert to defaults, and
    // a file that says "suggest" silently behaves as "autonomous". Which is why
    // the unreadable case now also pins autonomy rather than trusting defaults.
    const parsed = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    if (!isPlainObject(parsed)) {
      return { value: {}, unreadable: true, why: `top level is ${Array.isArray(parsed) ? 'an array' : typeof parsed}, not an object` };
    }
    return { value: parsed, unreadable: false };
  } catch (err) {
    return { value: {}, unreadable: true, why: err.message };
  }
}

export function loadConfig({ cwd = process.cwd(), projectRoot } = {}) {
  const root = projectRoot ?? findProjectRoot(cwd);

  const layers = [
    ['global', readJsonIfExists(globalConfigPath())],
    ['project', readJsonIfExists(join(root, '.watchdog', 'config.json'))],
  ];

  let merged = DEFAULTS;
  for (const [, layer] of layers) merged = deepMerge(merged, layer.value);

  if (!merged.paths.data) merged.paths.data = join(root, '.watchdog');
  else if (!isAbsolute(merged.paths.data)) merged.paths.data = resolve(root, merged.paths.data);

  if (!['suggest', 'allowlist', 'autonomous'].includes(merged.autonomy)) {
    throw new Error(`autonomy must be suggest|allowlist|autonomous, got ${JSON.stringify(merged.autonomy)}`);
  }

  // Fail safe on an unreadable layer.
  //
  // The rule is narrower than "any broken file pins autonomy". The hazard is
  // specifically an unreadable file letting DEFAULTS supply autonomy, because the
  // default is `autonomous`. If no readable layer states autonomy at all, autonomy
  // would come from that default -- so it is pinned to `suggest`.
  //
  // If a readable layer *does* state autonomy, it is honoured, because that is
  // the user's actual decision rather than a fallback. A corrupt global file (the
  // one holding Langfuse keys) is reported loudly but does not veto a project's
  // deliberate choice: quietly overriding an explicit `autonomous` would make
  // the tool's own fail-safe the thing that decides policy.
  const unreadable = layers.filter(([, l]) => l.unreadable);
  if (unreadable.length) {
    const statedExplicitly = layers.some(
      ([, l]) => !l.unreadable && typeof l.value?.autonomy === 'string',
    );
    const reasons = unreadable.map(([n, l]) => `${n}: ${l.why}`);

    merged.safety = {
      ...(merged.safety ?? {}),
      configUnreadable: unreadable.map(([name, l]) => ({
        layer: name,
        path: name === 'global' ? globalConfigPath() : join(root, '.watchdog', 'config.json'),
        why: l.why,
      })),
    };

    if (!statedExplicitly) {
      const was = merged.autonomy;
      merged.autonomy = 'suggest';
      log.warn(`config unreadable (${reasons.join('; ')}). Autonomy pinned to "suggest" instead of "${was}".`);
    } else {
      log.warn(`config unreadable (${reasons.join('; ')}). Autonomy "${merged.autonomy}" was set explicitly by a readable layer and is kept.`);
    }
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
