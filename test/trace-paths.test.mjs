/**
 * Taking the file's name from the error instead of from the model.
 *
 * The model cannot see the file tree, so it answers with a bare basename:
 * `tally.js` for a file at `src/tally.js`. The previous repair was to search the
 * tree for a file with that name and use it when exactly one matched. That is a
 * guess wearing a decision's clothes:
 *
 *     model guessed wrong -> system guesses what the model meant -> edit wrong file
 *
 * "Exactly one file has that name" is not evidence of intent. It refuses when two
 * files collide and accepts when none do, so it is the same coin flip either way
 * -- it just fails loudly sometimes.
 *
 * Meanwhile the evidence usually names the file precisely:
 *
 *     at tally (/app/src/tally.js:2:16)
 *
 * A path with several segments is far harder to collide than a basename, so the
 * trace is the primary source and the basename search is a fallback.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractTracePaths, traceTarget, resolveTracePath, isSpecific } from '../src/analyze/tracepaths.mjs';
import { resolveProposedPath } from '../src/analyze/advisor.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));

/** A project where `tally.js` exists in three places. */
function project() {
  const root = tmp('wd-trace-');
  for (const d of ['src', 'test', 'scripts']) {
    mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, d, 'tally.js'), `// ${d}\nfunction tally(items) {\n  return count / items.length;\n}\n`, 'utf8');
  }
  writeFileSync(join(root, 'package.json'), '{"name":"t"}\n', 'utf8');
  return root;
}

/* ------------------------------------------------------------------ *
 * Extraction
 * ------------------------------------------------------------------ */

test('a Node stack frame yields its file and line', () => {
  const hits = extractTracePaths('ReferenceError: count is not defined\n    at tally (/app/src/tally.js:2:16)');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 'app/src/tally.js');
  assert.equal(hits[0].line, 2);
  assert.equal(hits[0].kind, 'v8');
});

test('an anonymous Node frame is still found', () => {
  const hits = extractTracePaths('    at /app/src/index.js:6:9');
  assert.equal(hits[0].path, 'app/src/index.js');
  assert.equal(hits[0].line, 6);
});

test('a Windows drive letter in a trace is stripped, not treated as absolute', () => {
  const hits = extractTracePaths('    at tally (C:\\build\\src\\tally.js:2:16)');
  assert.equal(hits[0].path, 'build/src/tally.js');
});

test('a Python traceback is understood', () => {
  const hits = extractTracePaths('Traceback (most recent call last):\n  File "svc/handlers.py", line 88, in handler\n    raise ValueError');
  assert.ok(hits.some((h) => h.path === 'svc/handlers.py' && h.line === 88), JSON.stringify(hits));
});

test('a rust diagnostic is understood', () => {
  const hits = extractTracePaths('error[E0308]: mismatched types\n  --> src/parse.rs:44:9');
  assert.ok(hits.some((h) => h.path === 'src/parse.rs' && h.line === 44), JSON.stringify(hits));
});

test('a longer path is ranked above a shorter one', () => {
  // The throw site is the informative one; a later frame mentioning a bare
  // filename must not outrank it.
  const hits = extractTracePaths('at handler (/app/src/deep/nested/thing.js:12:3)\n    at /app/src/thing.js:1:1');
  assert.equal(hits[0].path, 'app/src/deep/nested/thing.js');
});

test('a bare filename with a line is collected but not treated as specific', () => {
  const hits = extractTracePaths('tally.js:2 something went wrong');
  assert.ok(hits.length >= 1);
  // This is the same weak signal as the model's basename guess.
  assert.equal(isSpecific(hits[0].path), false);
});

test('prose that merely mentions a filename is not a location', () => {
  assert.deepEqual(extractTracePaths('please edit config.json when you get a chance'), []);
});

test('non-source paths are not treated as source locations', () => {
  // A URL or an id must not be mistaken for a file to patch.
  assert.deepEqual(extractTracePaths('failed to reach https://example.com/api/v2/items:500'), []);
});

test('extraction is stable across repeated calls', () => {
  // A /g regex carries lastIndex between uses. Sharing one across calls made the
  // second call in the same process silently return nothing, which would have
  // looked like "no trace in this evidence" rather than a bug.
  const ev = 'ReferenceError: count is not defined\n    at tally (/app/src/tally.js:2:16)';
  const first = extractTracePaths(ev);
  const second = extractTracePaths(ev);
  assert.equal(first.length, second.length);
  assert.ok(first.length > 0);
  assert.deepEqual(first, second);
});

/* ------------------------------------------------------------------ *
 * Resolution against the real tree
 * ------------------------------------------------------------------ */

test('a trace path resolves to the real file despite a foreign prefix', () => {
  // `/app/src/tally.js` is from a container. `src/tally.js` is the same file here.
  const root = project();
  const t = traceTarget('    at tally (/app/src/tally.js:2:16)', root);
  assert.equal(t.path, 'src/tally.js');
  assert.equal(t.how, 'suffix-2');
  assert.equal(t.line, 2);
});

test('the longest matching suffix wins over a shorter one', () => {
  const root = project();
  const t = traceTarget('at f (/app/src/nested/deep.js:1:1)', root) ?? null;
  // Nothing nested exists, so this should be null rather than a wrong answer.
  assert.equal(t, null);
});

test('resolution refuses rather than guessing when the suffix is ambiguous', () => {
  // `test/tally.js` and `src/tally.js` both exist. A one-segment suffix is not
  // specific enough to choose between them, and choosing would edit the wrong file.
  const root = project();
  const t = traceTarget('    at tally (/app/tally.js:2:16)', root);
  assert.equal(t, null, 'an ambiguous basename was resolved anyway');
});

test('a directory is never resolved as a file', () => {
  // `src` is a directory that exists, so a resolver that only checked existence
  // would hand back a path that cannot be patched.
  const root = project();
  assert.equal(resolveTracePath('src', root), null);
  assert.equal(resolveTracePath('app/src', root), null);
});

test('resolveTracePath reports how much of the path it used', () => {
  const root = project();
  assert.equal(resolveTracePath('src/tally.js', root).how, 'exact');
  assert.equal(resolveTracePath('app/src/tally.js', root).how, 'suffix-2');
  assert.equal(resolveTracePath('nowhere/at/all.js', root), null);
});

test('a traversal in a trace path is refused', () => {
  const root = project();
  assert.equal(resolveTracePath('../../etc/passwd.js', root), null);
  assert.equal(traceTarget('at f (/app/../../secrets/key.js:1:1)', root), null);
});

/* ------------------------------------------------------------------ *
 * The comparison the old approach got wrong
 * ------------------------------------------------------------------ */

test('the basename search refuses this collision where a naive pick would not', () => {
  const root = project();
  // Three files named tally.js. The old approach refused, which is right.
  assert.equal(resolveProposedPath('tally.js', root), 'tally.js');
});

test('but the basename search accepts a lone match it should not trust', () => {
  // This is the failure mode, stated as a test. With only one `build.js` in the
  // tree, searching by name resolves it -- so a model naming the wrong file gets
  // that file edited, silently, because nothing collided.
  const root = tmp('wd-lonely-');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'build.js'), '// unrelated build helper\n', 'utf8');

  assert.equal(
    resolveProposedPath('build.js', root),
    'scripts/build.js',
    'the search resolved a name the evidence never mentioned',
  );

  // The trace, meanwhile, says exactly which file it was.
  const t = traceTarget('at run (/app/src/build.js:10:5)', root);
  assert.equal(t, null, 'there is no src/build.js, so nothing should be resolved');
});

test('evidence that names no file leaves the old path as the last resort', () => {
  const root = project();
  assert.equal(traceTarget('the build failed in an unspecified way', root), null);
});

/* ------------------------------------------------------------------ *
 * End to end, through the advisor
 * ------------------------------------------------------------------ */

test('a model naming the wrong file is overridden by the trace', async () => {
  // The case the whole change exists for. The model cannot see the tree, so it
  // says `tally.js`. Three files have that name, so the old code refused. The
  // trace says `src/tally.js` -- and `src/tally.js` is right.
  const { Advisor } = await import('../src/analyze/advisor.mjs');
  const { stubAnswering } = await import('./helpers/stub-cli.mjs');
  const root = project();

  const stub = stubAnswering(
    JSON.stringify({
      verdict: 'problem',
      confidence: 0.9,
      summary: 'count is undefined',
      fix: { description: 'd', files: [{ path: 'tally.js', find: 'count', replace: 'items.length' }] },
    }),
  );
  const advisor = new Advisor({ cli: stub.cmd, model: null, timeoutMs: 60_000 });
  const r = await advisor.review({
    evidence: 'ReferenceError: count is not defined\n    at tally (/app/src/tally.js:2:16)',
    cwd: root,
    title: 'ReferenceError: count is not defined',
  });

  assert.equal(r.verdict, 'problem', JSON.stringify(r));
  const f = r.fix?.files?.[0];
  assert.ok(f, `the proposal was dropped instead of resolved: ${JSON.stringify(r.fix)}`);
  assert.equal(f.path, 'src/tally.js', 'the trace did not override the model basename');
  assert.equal(f.resolvedBy, 'trace');
  assert.equal(f.proposedPath, 'tally.js', 'what the model actually said is not recorded');
});

test('with no trace, the fallback still resolves a unique basename', () => {
  // The fallback stays, because sometimes the evidence genuinely names no file.
  // It is a fallback now, not the primary mechanism.
  const root = tmp('wd-fallback-');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'only.js'), '', 'utf8');
  assert.equal(resolveProposedPath('only.js', root), 'src/only.js');
});

test('an empty or non-string evidence is handled rather than throwing', () => {
  for (const ev of ['', null, undefined, 42, {}]) {
    assert.deepEqual(extractTracePaths(ev), []);
  }
  assert.equal(traceTarget('', project()), null);
});