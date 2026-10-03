/**
 * Deterministic rules. Every finding must be reproducible from the captured text
 * with zero model involvement, so a rule carries an `explain` string and the exact
 * pattern that fired. Anything the rules cannot decide with confidence is marked
 * `unsure` and becomes the only thing eligible for an LLM second opinion.
 */
import { isChromeLine } from './transcript.mjs';

export const SEVERITY = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

const R = (id, severity, test, opts = {}) => ({
  id,
  severity,
  test,
  confidence: opts.confidence ?? 'high',
  title: opts.title ?? id,
  explain: opts.explain ?? '',
  fix: opts.fix ?? null,
  tags: opts.tags ?? [],
});

export const RULES = [
  R('node-module-missing', 'critical', (l) => /Cannot find module '([^']+)'/.exec(l), {
    title: 'Dependency missing',
    explain: 'Node cannot resolve a required module, so the process cannot start.',
    fix: { kind: 'install-deps', package: '$1', ecosystem: 'node' },
  }),
  R('npm-install-failed', 'high', (l) => /^npm (?:ERR!|error)\s+code\s+(E\w+)/.exec(l), {
    title: 'npm install failed',
    explain: 'npm reported a fatal error code during install.',
    // 'repair-deps', not 'command'. As a raw command this bypassed BOTH the
    // declared-dependency allowlist and the lockfile-honouring repair, so a
    // failed install anywhere would autonomously re-resolve every dependency.
    fix: { kind: 'repair-deps', why: 'repair node_modules from the lockfile when one exists' },
  }),
  R('python-modulenotfound', 'critical', (l) => /ModuleNotFoundError: No module named '([^']+)'/.exec(l), {
    title: 'Python dependency missing',
    explain: 'The interpreter cannot import a required module.',
    // ecosystem matters, and not as metadata. Without it a Python import error in a
    // project that also has a package.json ran `npm install <name>`, installing an
    // unrelated package from a different registry that merely shares the name.
    fix: { kind: 'install-deps', package: '$1', ecosystem: 'python' },
  }),
  // Anchored deliberately. An earlier version matched any line *containing*
  // "error TS123:", which fired on echoed commands and transcript headers --
  // noise in exactly the place a user cannot afford noise.
  R('tsc-error', 'high', (l) => /^(?!(?:.*[\\/])?node_modules[\\/])[^\s:]+\(\d+,\d+\):\s+error TS(\d+):\s*(.+)$/.exec(l), {
    title: 'TypeScript compile error',
    explain: 'tsc reported a type error, so the build would fail.',
  }),
  R('eslint-error', 'high', (l) => /^\s*(\d+):(\d+)\s+error\s+(.*)$/.exec(l) && l.includes('eslint'), {
    title: 'ESLint error',
    explain: 'Lint rule violation that fails the configured gate.',
  }),
  R('cargo-error', 'high', (l) => /^error(\[[A-Z]\d+\])?:/.test(l) && /could not compile|error\[/.test(l), {
    title: 'Cargo compile error',
    explain: 'cargo failed to compile the crate.',
  }),
  R('go-build-error', 'high', (l) => /^(.*\.go):(\d+):(\d+):\s/.test(l) && /cannot|undefined|too many|not enough/.test(l), {
    title: 'Go build error',
    explain: 'go compiler rejected the package.',
  }),
  R('dotnet-error', 'high', (l) => /: error (CS\d+|MSB\d+):/.test(l), {
    title: '.NET build error',
    explain: 'MSBuild or the C# compiler reported an error.',
  }),
  R('unhandled-rejection', 'critical', (l) => /UnhandledPromiseRejection|unhandled promise rejection/i.test(l), {
    title: 'Unhandled promise rejection',
    explain: 'A promise rejected with no handler; in Node this terminates the process by default.',
  }),
  R('segfault', 'critical', (l) => /Segmentation fault|Access violation \(0xC0000005\)/i.test(l), {
    title: 'Process crash',
    explain: 'The process died on an invalid memory access.',
  }),
  // No `fix` on purpose. The remedy depends on the project (raise --max-old-space-size?
  // tune a worker pool? shrink the dataset?) and a generic command would be a guess
  // presented as an action. A finding with no fix is honest; a no-op fix that reports
  // "skipped: no command to run" is noise.
  R('out-of-memory', 'high', (l) => /JavaScript heap out of memory|OutOfMemoryError|MemoryError|cannot allocate memory/i.test(l), {
    title: 'Out of memory',
    explain: 'The process exhausted its memory budget.',
  }),
  R('econnrefused', 'medium', (l) => /ECONNREFUSED\s+(?:\d{1,3}\.){3}\d{1,3}:\d+/.exec(l), {
    title: 'Connection refused',
    explain: 'Nothing is listening on the target port. Usually the dev server is not up yet.',
  }),
  R('port-in-use', 'medium', (l) => /EADDRINUSE.*?[: ](\d{2,5})\b/.exec(l) || /address already in use.*?(\d{2,5})/i.exec(l), {
    title: 'Port already in use',
    explain: 'A previous process still holds the port.',
  }),
  R('git-dirty-lock', 'medium', (l) => /error: (?:Unable to create '.*\.lock'|cannot lock ref)/.test(l), {
    title: 'Git lock held',
    explain: 'A stale .git lock file is blocking git operations.',
  }),
  R('file-not-found', 'medium', (l) => /(?:No such file or directory|FileNotFoundException|The system cannot find the (?:file|path) specified)/i.test(l) && /['"]?[A-Za-z]:\\|\.\/|~\//.test(l), {
    title: 'File not found',
    explain: 'A referenced path does not exist on disk.',
  }),
  R('permission-denied', 'high', (l) => /\b(EACCES|Permission denied|UnauthorizedAccessException)\b/.test(l), {
    title: 'Permission denied',
    explain: 'The OS or git refused access to the resource.',
  }),
  // Test output talks about 401 constantly ("assert 401 == 200"), so anything
  // that smells like an assertion, a fixture, or a test file is excluded rather
  // than trusting a keyword that appears in both worlds.
  R(
    'unauthenticated',
    'high',
    (l) => {
      if (/\b(assert|AssertionError|test_|spec|mock|fixture|expected|pytest|jest|vitest|describe\(|it\()\b/i.test(l)) return null;
      if (/test|spec|__tests__/i.test(l)) return null;
      return /\b(401 Unauthorized|Unauthorized|Authentication (?:required|failed)|not logged in|Please log ?in|invalid (?:api )?key)\b/i.exec(l);
    },
    {
      title: 'Authentication required',
      explain: 'The command needs credentials that are not present.',
    },
  ),
  R('disk-full', 'critical', (l) => /ENOSPC|No space left on device|disk is full/i.test(l), {
    title: 'Disk full',
    explain: 'Writes are failing because the volume is out of space.',
  }),
  R('todo-left', 'low', (l) => /\b(TODO|FIXME|HACK|XXX)\b[: ]/.test(l), {
    title: 'Unresolved marker in output',
    explain: 'A TODO/FIXME marker surfaced in build or runtime output.',
    confidence: 'medium',
  }),
  R('deprecated-api', 'low', (l) => /\b(deprecated|will be removed in|DeprecationWarning)\b/i.test(l), {
    title: 'Deprecated API in use',
    explain: 'Something in use is scheduled for removal.',
    confidence: 'medium',
  }),
  R('test-failure', 'high', (l) => /^(\d+)\s+(?:failed|failing)\b/.test(l) || /\b(\d+)\s+tests?\s+failed\b/.test(l), {
    title: 'Test failures',
    explain: 'The test run reported failures.',
    // No fix on purpose: re-running "the failing suite" needs the project's test
    // command, which the transcript layer does not reliably expose. A placeholder
    // with an empty argv would only report "skipped: no command to run".
  }),

  // Runtime errors. Added after the sandbox showed that a plain
  // `ReferenceError: count is not defined` produced no finding at all.
  R('js-referenceerror', 'critical', (l) => /^ReferenceError:\s*(\S+)\s+is not defined/.exec(l), {
    title: 'Reference to undefined variable',
    explain: 'The code referenced a variable that does not exist in scope, so it throws at runtime.',
  }),
  R('js-typeerror', 'high', (l) => /^TypeError:\s*(.+)$/.exec(l), {
    title: 'Type error at runtime',
    explain: 'A value had the wrong type or a member was missing, so the call threw.',
  }),
  R('js-syntaxerror', 'high', (l) => /^SyntaxError:\s*(.+)$/.exec(l), {
    title: 'Syntax error',
    explain: 'The file could not be parsed, so nothing in it can run.',
  }),
  R('python-nameerror', 'critical', (l) => /NameError: name '([^']+)' is not defined/.exec(l), {
    title: 'Reference to undefined name',
    explain: 'Python could not resolve a name, so the statement raised.',
  }),
  R('python-keyerror', 'high', (l) => /^KeyError:\s*(.+)$/.exec(l), {
    title: 'Missing dictionary key',
    explain: 'A key lookup failed; the code assumed a key that is not always present.',
  }),
  R('python-attributeerror', 'high', (l) => /AttributeError: '([^']+)' object has no attribute '([^']+)'/.exec(l), {
    title: 'Missing attribute',
    explain: 'An object was used as if it had an attribute it does not have.',
  }),
  R('ruby-nomethoderror', 'high', (l) => /NoMethodError: undefined method/.test(l), {
    title: 'Undefined method',
    explain: 'Ruby could not find the called method on the receiver.',
  }),
  R('java-stacktrace', 'high', (l) => /^\s+at [\w.$]+\([\w.]+:\d+\)/.test(l), {
    title: 'Java stack frame',
    explain: 'Part of a Java stack trace, indicating an uncaught exception.',
    confidence: 'medium',
  }),
  R('go-panic', 'high', (l) => /^panic: /.test(l), {
    title: 'Go panic',
    explain: 'The program hit an unrecoverable panic and is terminating.',
  }),
];

export function severityAtLeast(sev, min) {
  return SEVERITY[sev] <= SEVERITY[min];
}

/** Substitute `$1`, `$2` ... in a fix template from the rule's regex captures. */
function expandFix(fix, m) {
  // Index the raw match: `$1` is capture group 1, so it must be m[1], not m[0]
  // (which is the entire match). Filtering out undefined optional groups first
  // would shift every subsequent index.
  const sub = (v) => (typeof v === 'string' ? v.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? '') : v);
  const out = {};
  for (const [k, v] of Object.entries(fix)) out[k] = sub(v);
  return out;
}

/**
 * @param {string} line
 * @param {{cwd?: string, sessionId?: string}} ctx
 * @returns {Array<object>} findings
 */
export function evaluate(line, ctx = {}) {
  // Transcript chrome is never a diagnosis. Checked here, inside the evaluator,
  // so every consumer benefits -- not just the daemon's callback.
  if (isChromeLine(line)) return [];

  const findings = [];
  for (const rule of RULES) {
    let hit;
    try {
      hit = rule.test(line, ctx);
    } catch {
      continue; // a broken rule must not kill the stream
    }
    if (!hit) continue;
    // A rule may return either a RegExp match array (so its fix template can
    // reference capture groups) or a plain boolean from `.test()`.
    const m = Array.isArray(hit) ? hit : null;
    findings.push({
      ruleId: rule.id,
      severity: rule.severity,
      confidence: rule.confidence,
      title: rule.title,
      explain: rule.explain,
      evidence: line.slice(0, 500),
      fix: rule.fix ? (m ? expandFix(rule.fix, m) : { ...rule.fix }) : null,
      tags: rule.tags,
      cwd: ctx.cwd,
      sessionId: ctx.sessionId,
      at: new Date().toISOString(),
    });
  }
  return findings;
}

export function listRules() {
  return RULES.map((r) => ({ id: r.id, severity: r.severity, title: r.title, hasFix: !!r.fix, confidence: r.confidence }));
}
