/**
 * Declared dependencies.
 *
 * This is the allowlist that closes the supply-chain hole.
 *
 * The dangerous flow was: terminal output (untrusted, anything can print to it)
 * -> the `node-module-missing` rule extracts a package name -> the watchdog runs
 * `npm install <that name>` autonomously. An attacker who can make a line appear
 * in your terminal could choose what gets installed, and a package install runs
 * postinstall scripts with your privileges.
 *
 * A denylist cannot fix that, because the attacker picks the name and will
 * simply pick a different one. The only sound rule is: install nothing that the
 * project has not already declared. That set is written by you, not by a build
 * log, so the untrusted input can no longer choose the target.
 *
 * Everything here fails CLOSED. An unparseable or unrecognised manifest yields
 * an empty set, which means "install nothing" -- never "install anything".
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Ecosystem-agnostic name normalisation (PEP 503 for Python, plain for npm). */
export function normalizePkgName(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  s = s.replace(/[<>=!~^;].*$/, ''); // version constraints
  s = s.replace(/\[.*?\]$/, ''); // extras: requests[security]
  s = s.replace(/@\d[\w.\-+]*$/, ''); // npm pinned version: left-pad@1.3.0
  s = s.replace(/\[[^\]]*\]/g, '');
  s = s.replace(/[<>=!~^].*$/, '');
  s = s.replace(/^[a-z]+:\/\/.*$/, ''); // URLs are never installable by name
  s = s.replace(/^-/, '');
  s = s.trim().replace(/^["']|["']$/g, '');
  // PEP 503: runs of -, _, . collapse to a single - and it is case-insensitive.
  s = s.toLowerCase().replace(/[-_.]+/g, '-');
  return s;
}

/** Split a python requirement line down to just its distribution name. */
function pythonName(line) {
  let s = line.trim();
  if (!s || s.startsWith('#')) return '';
  // Directives, options and URLs are not bare distribution references.
  if (/^(-r|--requirement|-e|--editable|-c|-f|--find-links|-i|--index-url|--extra-index-url|--hash|--trusted-host)/i.test(s)) return '';
  if (s.includes('://') || s.startsWith('git+') || s.startsWith('file:')) return '';
  if (s.startsWith('-')) return '';
  s = s.split(';')[0]; // environment markers
  s = s.split('#')[0];
  s = s.split(/[\s@]/)[0];
  const m = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(s);
  return m ? normalizePkgName(m[0]) : '';
}

function npmDeclared(pkg) {
  const p = join(pkg.root, 'package.json');
  if (!existsSync(p)) return [];
  let json;
  try {
    json = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return []; // unparseable manifest -> fail closed
  }
  const out = [];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = json?.[field];
    if (deps && typeof deps === 'object') out.push(...Object.keys(deps));
  }
  return out.map(normalizePkgName).filter(Boolean);
}

function requirementsDeclared(pkg, seen = new Set()) {
  return parseRequirements(join(pkg.root, 'requirements.txt'), pkg.root, seen);
}

function parseRequirements(file, root, seen) {
  if (!existsSync(file) || seen.has(file)) return [];
  seen.add(file);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^(-r|--requirement)\s+(\S+)/.exec(line);
    if (m) {
      // Follow local includes only. An include pointing outside the project is
      // ignored rather than followed, so the allowlist cannot be widened by a
      // path outside the thing being watched.
      const inc = m[2].replace(/^["']|["']$/g, '');
      if (inc && !inc.startsWith('/') && !/^[A-Za-z]:/.test(inc) && !inc.includes('://')) {
        out.push(...parseRequirements(join(root, inc), root, seen));
      }
      continue;
    }
    const n = pythonName(line);
    if (n) out.push(n);
  }
  return out;
}

function pyprojectDeclared(pkg) {
  const p = join(pkg.root, 'pyproject.toml');
  if (!existsSync(p)) return [];
  let text;
  try {
    text = readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  const out = [];

  // PEP 621: dependencies = ["requests>=2", ...]
  for (const block of text.matchAll(/dependencies\s*=\s*\[([\s\S]*?)\]/g)) {
    for (const item of block[1].split(',')) {
      const n = pythonName(item.replace(/["']/g, ''));
      if (n) out.push(n);
    }
  }
  // Poetry: [tool.poetry.dependencies] then name = "^1.2"
  const poetry = /\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\n\[|$)/.exec(text);
  if (poetry) {
    for (const line of poetry[1].split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(line);
      if (m && m[1].toLowerCase() !== 'python') out.push(normalizePkgName(m[1]));
    }
  }
  return out;
}

/** Which manifest declares what, by ecosystem. */
export const ECOSYSTEMS = Object.freeze({
  node: 'node',
  python: 'python',
});

const DECLARERS = {
  node: [npmDeclared],
  python: [requirementsDeclared, pyprojectDeclared],
};

/**
 * Every package the project has already declared.
 *
 * With no ecosystem, this is the union across manifests. That union is fine for
 * asking "has this project ever heard of X" and dangerous for authorising an
 * install: in a mixed project the name `requests` appears in requirements.txt,
 * which made an npm install of the unrelated npm package `requests` look
 * declared. Callers that are about to *install* must pass an ecosystem.
 *
 * @param {string} [ecosystem] 'node' | 'python', or omitted for the union
 * @returns {Set<string>} normalised names
 */
export function declaredPackages(root, ecosystem) {
  const fns = ecosystem ? DECLARERS[ecosystem] : [npmDeclared, requirementsDeclared, pyprojectDeclared];
  if (!fns) return new Set(); // unknown ecosystem: declare nothing, fail closed
  const names = new Set();
  for (const fn of fns) {
    try {
      for (const n of fn({ root })) names.add(n);
    } catch {
      // A parser blowing up must not widen the allowlist.
    }
  }
  return names;
}

export function isDeclared(root, rawName, ecosystem) {
  const n = normalizePkgName(rawName);
  if (!n) return false;
  return declaredPackages(root, ecosystem).has(n);
}

/** True when the project pins versions, so repairing should honour the lockfile. */
export function hasLockfile(root) {
  return lockfileKind(root) !== null;
}

/**
 * Which package manager's lockfile is present. Repairing through the lockfile
 * (`npm ci`, `pnpm install --frozen-lockfile`) is strictly safer than installing
 * by name, because installing by name re-resolves and can fetch a newer version
 * than the lockfile records.
 */
/**
 * A repair, not an install.
 *
 * Used when node_modules is known to be broken but no package name is involved
 * (a failed `npm install`). Unlike installArgv there is nothing to allowlist --
 * the name is not chosen by terminal output -- but there is still something to
 * be careful about: bare `npm install` re-resolves every dependency and can
 * silently move the project off the versions its lockfile pins.
 *
 * So this is lockfile-only. With no lockfile there is nothing safe to do
 * automatically, and the caller refuses.
 */
export function repairArgv(root) {
  const lock = lockfileKind(root);
  if (lock === 'pnpm') return ['pnpm', 'install', '--frozen-lockfile'];
  if (lock === 'yarn') return ['yarn', 'install', '--frozen-lockfile'];
  if (lock === 'npm') return ['npm', 'ci'];
  return [];
}
export function lockfileKind(root) {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'package-lock.json')) || existsSync(join(root, 'npm-shrinkwrap.json'))) return 'npm';
  return null;
}
