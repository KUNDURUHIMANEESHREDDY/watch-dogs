/**
 * Verify the bundle against the tree it claims to copy.
 *
 * The bundler reporting its own success proves nothing -- it could drop a file and
 * still say "88 files". This reads the bundle back as text, splits it on its own
 * separators, and re-hashes each extracted body against the file on disk. Anything
 * that does not match, is missing, or is unaccounted for, is listed.
 *
 * This is the check that catches the bundler's own bugs. It caught two in its first
 * version: it looked for a bar of '=' as the header's closing rule when the bundler
 * writes '-', and it read the sha line one row too low. Both made it report 176
 * problems against a perfectly good bundle. A verifier that reports nonsense is
 * worse than no verifier, because it trains you to ignore it.
 *
 * Run: node sandbox/verify-bundle.mjs <bundlePath>
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = process.cwd();
const bundlePath = process.argv[2] ?? join(ROOT, 'watch-dog-ALL-SOURCE.txt');

const SUB = '-'.repeat(78);
const BAR = '='.repeat(78);
const SEP = `\n${SUB}\n`;

const text = readFileSync(bundlePath, 'utf8');
const problems = [];

/* --- 1. Index rows: path -> claimed size and short sha ---------------- */
const indexRe = /^ {2}(\S[^ ]*)\s{2,}(\d+)\s+([0-9a-f]{12})$/gm;
const claimed = new Map();
for (const m of text.matchAll(indexRe)) {
  if (!claimed.has(m[1])) claimed.set(m[1], { size: Number(m[2]), sha12: m[3] });
}

/* --- 2. Split on the section rule ------------------------------------- *
 * The stream alternates:  rule / header / rule / blank / body / blank /
 * rule / header ...  so every other chunk after the preamble is a header
 * and the chunk after that is the file body with one leading newline.
 */
const chunks = text.split(SEP);
const sections = [];
for (let i = 0; i < chunks.length; i++) {
  const h = chunks[i].match(/^FILE (\d+) of (\d+):  (.+)\n(\d+) bytes  (CRLF|LF)  sha256 ([0-9a-f]{64})$/);
  if (!h) continue;
  const bodyChunk = chunks[i + 1] ?? '';
  let body = bodyChunk.startsWith('\n') ? bodyChunk.slice(1) : bodyChunk;

  // The final section runs into the closing banner rather than another rule.
  const tail = body.indexOf(`\n\n${BAR}\nEND OF BUNDLE`);
  if (tail !== -1) body = body.slice(0, tail);

  sections.push({
    n: Number(h[1]),
    total: Number(h[2]),
    path: h[3],
    size: Number(h[4]),
    nl: h[5],
    sha: h[6],
    body,
  });
}

if (sections.length && sections[sections.length - 1].total !== sections.length) {
  problems.push(`last header claims ${sections[sections.length - 1].total} sections, found ${sections.length}`);
}

/* --- 3. Re-hash each body against disk ------------------------------- */
let checked = 0;
for (const s of sections) {
  const diskBuf = readFileSync(join(ROOT, s.path));
  const disk = diskBuf.toString('utf8');

  const diskSha = createHash('sha256').update(diskBuf).digest('hex');
  if (diskSha !== s.sha) {
    problems.push(`${s.path}: header sha256 ${s.sha.slice(0, 12)} != disk ${diskSha.slice(0, 12)}`);
  }
  if (diskBuf.length !== s.size) {
    problems.push(`${s.path}: header says ${s.size} bytes, disk has ${diskBuf.length}`);
  }
  const diskNl = disk.includes('\r\n') ? 'CRLF' : 'LF';
  if (diskNl !== s.nl) problems.push(`${s.path}: header says ${s.nl}, disk looks ${diskNl}`);

  // The bundler strips one trailing newline before printing, but the blank line it
  // emits next puts that newline back through join(). So in practice the bundle
  // holds the file byte-for-byte. Measured rather than assumed: an earlier version
  // of this check stripped a newline from disk to "match" the bundle, and then
  // reported 88 failures against a bundle that was already exact.
  //
  // Both shapes are therefore accepted -- identical, or differing by exactly one
  // trailing newline -- and nothing else. Any other delta means content was lost.
  const bodyBytes = Buffer.from(s.body, 'utf8');
  const diskBytes = diskBuf;
  const sameBytes = bodyBytes.equals(diskBytes);
  const differsByOneNewline =
    s.body.length === disk.length + 1 && s.body.startsWith(disk) && s.body.endsWith('\n');
  if (!sameBytes && !differsByOneNewline) {
    problems.push(`${s.path}: body in the bundle does not reproduce the file (${bodyBytes.length} vs ${diskBytes.length} bytes)`);
  }

  if (!claimed.has(s.path)) problems.push(`${s.path}: in the body but absent from the index`);
  checked++;
}

/* --- 4. Index rows with no content ----------------------------------- */
const bundled = new Set(sections.map((s) => s.path));
for (const p of claimed.keys()) {
  if (!bundled.has(p)) problems.push(`${p}: in the index but no content follows`);
}

/* --- 5. Anything on disk the walk missed ----------------------------- *
 * Ground truth is an independent walk, not the bundler's own file list.
 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.watchdog', '.idea', '.vscode', 'coverage']);
const onDisk = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(d, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.isFile()) onDisk.push(relative(ROOT, full).split(sep).join('/'));
  }
})(ROOT);

const selfName = relative(ROOT, bundlePath).split(sep).join('/');
const missed = onDisk.filter(
  (f) =>
    !bundled.has(f) &&
    f !== selfName &&
    !/^\.(m|c|mut)\.txt$/.test(f) &&
    !f.startsWith('.daemon.'),
);

console.log(`bundle       ${bundlePath}`);
console.log(`sections     ${sections.length}`);
console.log(`index rows   ${claimed.size}`);
console.log(`on disk      ${onDisk.length} (excluding .git, node_modules, .watchdog)`);
console.log(`re-hashed    ${checked} bodies against disk (sha256, byte length, newline style)`);
console.log(`missed       ${missed.length}`);
for (const f of missed) console.log(`  MISSED ${f}`);
console.log(`problems     ${problems.length}`);
for (const p of problems.slice(0, 40)) console.log(`  ${p}`);
if (problems.length > 40) console.log(`  ... and ${problems.length - 40} more`);

const ok = problems.length === 0 && missed.length === 0;
console.log(ok ? '\nVERIFIED: the bundle reproduces every file in the tree.' : '\nFAILED');
process.exit(ok ? 0 : 1);