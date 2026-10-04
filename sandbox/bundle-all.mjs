/**
 * Dump every file in this project into one text file.
 *
 * Deliberately excluded, and the reasons matter:
 *
 *   .git/        repository internals -- objects, refs, logs. Not "the code".
 *   node_modules/  third-party code, and enormous. Only what this project wrote is
 *                 the thing being preserved.
 *   .watchdog/    LIVE DATA. Holds the Langfuse keys used for tracing. Those keys
 *                 have never been in the repo and must not start now, in a file
 *                 that is easy to paste into a chat window.
 *   the bundle itself, and .daemon.* scratch files.
 *
 * Binary files are detected by content, not by extension, and listed in the index
 * rather than mangled into the text.
 *
 * Every file gets a size and a SHA-256 in the index so the copy can be checked
 * against the tree it came from.
 *
 * Run: node sandbox/bundle-all.mjs [outputPath]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();

/**
 * Default output sits OUTSIDE the repository, one level up.
 *
 * Not tidiness. test/integrity.test.mjs enforces ASCII on every .txt at the repo
 * root, on the grounds that an em-dash in a source file has broken a commit five
 * times. The bundle legitimately contains non-ASCII -- it faithfully copies
 * sandbox/README.md and a progress-bar character class, which that test exempts by
 * path -- so a bundle written into the root trips a rule that exists for a good
 * reason, and the failure looks like a source problem rather than a packaging one.
 *
 * A generated artifact should not be governed by the rules for things a human
 * hand-edits, and it should not be one `git add -A` away from being committed.
 */
const OUT = process.argv[2] ?? join(ROOT, '..', 'watch-dog-ALL-SOURCE.txt');

/** Path segments never included, matched at any depth. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.watchdog', '.idea', '.vscode', 'coverage']);
/** Exact file names never included. */
const SKIP_FILES = new Set([OUT.replace(/^.*[\\/]/, ''), '.m.txt', '.c.txt', '.mut.txt']);
const SKIP_PREFIX = ['.daemon.', '.d.'];

const skipReason = (name) => {
  if (SKIP_DIRS.has(name)) return true;
  if (SKIP_FILES.has(name)) return true;
  return SKIP_PREFIX.some((p) => name.startsWith(p));
};

/** Walk, returning relative paths with forward slashes, sorted for reproducibility. */
function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (skipReason(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.isFile()) acc.push(relative(ROOT, full).split(sep).join('/'));
  }
  return acc;
}

/**
 * Decide whether a file is text.
 *
 * The obvious rule -- "a NUL byte means binary" -- is wrong, and it was wrong here.
 * test/advisor-validation.test.mjs contains exactly one NUL, deliberately, inside
 * the fixture for a path-validation case ('a.js\0'). That is real source code and
 * the first version of this script silently dropped it from the bundle.
 *
 * So NUL is now one signal rather than a verdict. A file is binary when it has a
 * high share of control characters, or when NULs are dense enough to be structure
 * rather than data. One NUL in four kilobytes is a value; NULs every few bytes are
 * a format.
 *
 * Tab, newline, carriage return and ESC are excluded from the control-character
 * count, because test fixtures for ANSI stripping embed ESC as a literal.
 */
function looksBinary(buf) {
  if (buf.length === 0) return false;
  const slice = buf.subarray(0, Math.min(buf.length, 8000));
  const IGNORED = new Set([9, 10, 13, 27]);

  let odd = 0;
  let nul = 0;
  for (const b of slice) {
    if (b === 0) nul++;
    else if (!IGNORED.has(b) && b < 32) odd++;
  }
  if (odd / slice.length > 0.3) return true;

  // Dense NULs mean the bytes are structure (a header, a table, a code page), not
  // text that happens to mention one.
  return nul > 0 && nul / slice.length > 0.005;
}

const files = walk(ROOT).sort();
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const included = [];
const binaries = [];
const failed = [];
let totalBytes = 0;

for (const rel of files) {
  let buf;
  try {
    buf = readFileSync(join(ROOT, rel));
  } catch (e) {
    failed.push({ rel, why: e.message });
    continue;
  }
  const rec = { rel, size: buf.length, sha: sha(buf) };
  if (looksBinary(buf)) binaries.push(rec);
  else {
    included.push(rec);
    totalBytes += buf.length;
  }
}

/* ---------------------------------------------------------------- *
 * Secret scan. This file is meant to be pasted around, so it gets
 * checked rather than trusted.
 * ---------------------------------------------------------------- */
const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, 'anthropic key'],
  [/sk-[A-Za-z0-9]{32,}/g, 'openai-style key'],
  [/ghp_[A-Za-z0-9]{30,}/g, 'github PAT'],
  [/github_pat_[A-Za-z0-9_]{50,}/g, 'github fine-grained PAT'],
  [/AKIA[0-9A-Z]{16}/g, 'aws access key id'],
  [/AIza[0-9A-Za-z_-]{35}/g, 'google api key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, 'private key'],
  [/\blangfuseSecretKey\b\s*[:=]\s*['"][^'"]{8,}/gi, 'langfuse secret'],
];
const findings = [];
for (const rec of included) {
  const text = readFileSync(join(ROOT, rec.rel), 'utf8');
  for (const [re, label] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    const hits = text.match(re);
    if (hits) findings.push({ file: rec.rel, label, count: hits.length });
  }
}

/* ---------------------------------------------------------------- *
 * Assemble
 * ---------------------------------------------------------------- */
const bar = '='.repeat(78);
const sub = '-'.repeat(78);
const out = [];
const push = (s = '') => out.push(s);

push(bar);
push('watch-dogs  --  complete source bundle');
push(bar);
push(`generated       ${new Date().toISOString()}`);
push(`source tree     ${ROOT}`);
push(`commit          ${exec('git rev-parse HEAD')}`);
push(`branch          ${exec('git rev-parse --abbrev-ref HEAD')}`);
push(`, files         ${files.length} found, ${included.length} included as text`);
push(`, binary skipped ${binaries.length}`);
push(`, unreadable     ${failed.length}`);
push(`text bytes      ${totalBytes.toLocaleString('en-US')}`);
push('');
push('EXCLUDED ON PURPOSE');
for (const [d, why] of [
  ['.git/', 'repository internals, not source'],
  ['node_modules/', 'third-party code'],
  ['.watchdog/', 'LIVE DATA -- contains Langfuse tracing keys'],
  ['.daemon.*, .m.txt, .c.txt', 'scratch output from test runs'],
]) {
  push(`  ${d.padEnd(24)} ${why}`);
}
push('');
push('SECRET SCAN OF INCLUDED FILES');
if (findings.length === 0) {
  push('  clean -- no key-shaped strings in any included file');
} else {
  for (const f of findings) push(`  ${f.file}: ${f.label} x${f.count}`);
}
push('');
push('INDEX');
const width = Math.max(...included.map((f) => f.rel.length));
for (const f of included) {
  push(`  ${f.rel.padEnd(width)}  ${String(f.size).padStart(8)}  ${f.sha.slice(0, 12)}`);
}
if (binaries.length) {
  push('');
  push('BINARY (not reproduced)');
  for (const f of binaries) push(`  ${f.rel}  ${f.size} bytes  sha256 ${f.sha.slice(0, 12)}`);
}
if (failed.length) {
  push('');
  push('UNREADABLE');
  for (const f of failed) push(`  ${f.rel}: ${f.why}`);
}
push('');
push(bar);
push('FILE CONTENTS');
push(bar);

for (const [i, rec] of included.entries()) {
  const text = readFileSync(join(ROOT, rec.rel), 'utf8');
  const nl = text.includes('\r\n') ? 'CRLF' : 'LF';
  push('');
  push(sub);
  push(`FILE ${i + 1} of ${included.length}:  ${rec.rel}`);
  push(`${rec.size} bytes  ${nl}  sha256 ${rec.sha}`);
  push(sub);
  push('');
  // A trailing newline is added where missing, so the next FILE header always
  // starts on its own line instead of being glued to the last line of content.
  push(text.endsWith('\n') ? text.replace(/\n$/, '') : text);
}

push('');
push(bar);
push('END OF BUNDLE');
push(bar);

const body = out.join('\n') + '\n';
writeFileSync(OUT, body, 'utf8');

console.log(`wrote ${OUT}`);
console.log(`  ${included.length} files, ${binaries.length} binary skipped, ${failed.length} unreadable`);
console.log(`  ${body.length.toLocaleString('en-US')} bytes total`);
console.log(`  secret findings: ${findings.length}`);
for (const f of findings) console.log(`    ${f.file}: ${f.label} x${f.count}`);

function exec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '(unknown -- not a git repo, or git unavailable)';
  }
}