import { statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where did this error actually come from?
 *
 * The model is asked to propose an edit for code it cannot read, and it does not
 * see the file tree. So it answers with a bare basename: `tally.js` for a file
 * that lives at `src/tally.js`. The obvious repair -- search the tree for a file
 * with that name -- is a guess wearing a decision's clothes:
 *
 *     model guessed wrong -> system guesses what the model meant -> edit wrong file
 *
 * "Exactly one file has that name" is not evidence of intent. A project with
 * `src/tally.js` and `test/tally.js` has two, so the guess refuses; a project
 * with only `scripts/build.js` has one, and `npm run build` gets edited because
 * nothing happened to collide with it. Both are the same coin flip.
 *
 * But the evidence almost always says which file it was, and says it precisely.
 * A stack trace names the file and the line:
 *
 *     at tally (/app/src/tally.js:2:16)
 *     File "svc/handlers.py", line 88, in handler
 *       --> src/parse.rs:44:9
 *
 * A path with several segments is far stronger evidence than a basename, because
 * two distinct files rarely share a two-segment suffix. So the trace wins, and
 * the basename search is demoted to a fallback for the cases where the evidence
 * carries no usable path at all.
 *
 * The trace's own prefix is not trusted -- it is usually from a container or
 * another machine (`/app/`, `C:\build\`) and will not exist here. What is trusted
 * is the longest trailing sequence of segments that resolves to exactly one real
 * file inside the project. That is a fact about this filesystem rather than a
 * guess about intent.
 */

/**
 * Patterns that name a source location in a trace, across the ecosystems this
 * tool watches. Each captures the path and, where the format has one, a line.
 *
 * Deliberately strict about what counts as a path: it must have a recognised
 * source extension, or contain at least one separator. That keeps prose that
 * happens to mention a filename out of the candidate set.
 */
/**
 * Every pattern captures the path in group 1 and the line in group 2.
 *
 * Uniform on purpose. An earlier version let the V8 patterns split the drive
 * letter into its own group, and the extraction code then read group 1 and group
 * 2 as "drive" and "path" for every pattern -- so a Python `File "svc/x.py",
 * line 88` came out as the path `svc/x.py88`, failed its extension check, and was
 * silently discarded. Every trace format returned nothing.
 */
const TRACE_PATTERNS = [
  // Node / V8:  "    at tally (/app/src/tally.js:2:16)"  and  "    at /app/src/x.js:2:16"
  { re: /\(\s*((?:[A-Za-z]:)?[\\/][^()\s:]+\.[a-z]{1,5}):(\d+)(?::\d+)?\s*\)/gi, kind: 'v8' },
  { re: /^\s*at\s+((?:[A-Za-z]:)?[\\/][^\s()]+\.[a-z]{1,5}):(\d+)(?::\d+)?/gim, kind: 'v8' },

  // Python:  File "svc/handlers.py", line 88, in handler
  { re: /^\s*File\s+"([^"]+\.[a-z]{1,5})",\s*line\s+(\d+)/gim, kind: 'python' },

  // Rust:  --> src/parse.rs:44:9
  { re: /^\s*-->\s+([^:\s]+\.[a-z]{1,5}):(\d+)(?::\d+)?/gim, kind: 'rust' },

  // Generic "path:line" appearing anywhere: Go panics, Java stack frames.
  { re: /(?:^|[\s(])((?:[A-Za-z]:)?[\\/][\w.\\/-]+\.[a-z]{1,5}):(\d+)(?::\d+)?/gm, kind: 'generic' },

  // Bare "path:line" with no directory, e.g. "tally.js:2". Weakest signal there is:
  // a filename with a line number is still just a filename, so it is collected but
  // never treated as specific enough to act on.
  { re: /(?:^|[\s(])([A-Za-z0-9_-]+\.[a-z]{1,5}):(\d+)(?::\d+)?/gm, kind: 'basename' },
];

/**
 * Source-ish extensions, so a path that looks like one is treated as one.
 * A filter rather than a gate: an unfamiliar extension still gets a chance, but
 * a URL or a message id will not be mistaken for a file.
 */
const SOURCE_EXT = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'swift', 'scala', 'sh', 'bash', 'zsh', 'ps1',
  'sql', 'html', 'css', 'scss', 'vue', 'svelte', 'json', 'yaml', 'yml', 'toml',
]);

/**
 * Pull source locations out of trace-shaped evidence.
 *
 * @returns {{path: string, line: number|null, kind: string, segments: number}[]}
 *   ordered most-informative first: more path segments beats fewer, because a
 *   two-segment suffix is much harder to collide than a bare filename.
 */
export function extractTracePaths(evidence) {
  if (typeof evidence !== 'string' || !evidence) return [];
  const found = [];
  const seen = new Set();

  for (const { re, kind } of TRACE_PATTERNS) {
    // A fresh RegExp per pattern: the shared `lastIndex` of a /g regex leaks
    // between calls otherwise, which is how a resolver silently returns nothing
    // on the second invocation in the same process.
    const rx = new RegExp(re.source, re.flags);
    let m;
    while ((m = rx.exec(evidence)) !== null) {
      if (m[0].length === 0) {
        rx.lastIndex++;
        continue;
      }
      const raw = m[1];
      if (!raw) continue;
      const ext = extOf(raw);
      if (!SOURCE_EXT.has(ext)) continue;

      const norm = normaliseTracePath(raw);
      if (!norm || norm.includes('..')) continue;

      const line = m[2] ? Number(m[2]) : null;
      const key = `${norm}:${line ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      found.push({
        path: norm,
        line: Number.isFinite(line) ? line : null,
        kind,
        segments: norm.split('/').length,
      });
    }
  }

  // Most segments first; within that, prefer the formats whose paths are most
  // likely complete, and the earliest occurrence (traces list the throw site
  // first, which is the frame the user cares about).
  const kindRank = { v8: 0, python: 1, rust: 2, generic: 3, basename: 4 };
  found.sort((a, b) => b.segments - a.segments || kindRank[a.kind] - kindRank[b.kind]);

  return found;
}

/** True when a trace path is specific enough to act on without further help. */
export function isSpecific(path) {
  return typeof path === 'string' && path.split('/').length >= 2;
}

/**
 * Resolve a trace path against the real project tree.
 *
 * The trace's prefix is discarded -- `/app/src/tally.js` and `src/tally.js` are
 * the same file seen from two machines -- and the longest trailing run of
 * segments that exists is used. Two or more matches at the same length is a
 * refusal rather than a coin flip.
 *
 * @returns {{path: string, from: string, line: number|null, how: string}|null}
 */
export function resolveTracePath(tracePath, root) {
  if (typeof tracePath !== 'string' || !tracePath) return null;
  const segments = normaliseTracePath(tracePath).split('/').filter(Boolean);
  if (!segments.length) return null;

  for (let take = segments.length; take >= 1; take--) {
    const candidate = segments.slice(segments.length - take).join('/');
    const abs = join(root, ...candidate.split('/'));

    // Never resolve to a directory: `src` is not a file to patch.
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;

    return {
      path: candidate,
      from: tracePath,
      line: null,
      how: take === segments.length ? 'exact' : `suffix-${take}`,
    };
  }
  return null;
}

/**
 * Best project-relative file named by the evidence, or null.
 *
 * Only a path with at least two segments is returned. A bare filename in a trace
 * (`tally.js:2`) is the same weak signal as the model's basename guess, and
 * pretending otherwise would reintroduce the guess this module exists to remove.
 */
export function traceTarget(evidence, root) {
  for (const c of extractTracePaths(evidence)) {
    if (!isSpecific(c.path)) continue;
    const hit = resolveTracePath(c.path, root);
    if (hit) return { ...hit, line: c.line, kind: c.kind };
  }
  return null;
}

function normaliseTracePath(p) {
  return String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

function extOf(p) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(String(p));
  return m ? m[1].toLowerCase() : '';
}