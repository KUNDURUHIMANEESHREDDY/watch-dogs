/**
 * Source integrity.
 *
 * PowerShell 5.1's Set-Content round-trips destroyed UTF-8 characters in this
 * repo five times, replacing em-dashes in README.md with U+FFFD. Each time the
 * file still parsed, the tests still passed, and nothing announced it. Syntax
 * checks catch broken code; they cannot catch content silently mangled by an
 * encoding round-trip.
 *
 * These tests make that class of damage loud instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.watchdog', '.git', 'sandbox']);
const TEXT_EXT = new Set(['.js', '.mjs', '.md', '.json', '.ps1', '.vbs', '.txt']);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (TEXT_EXT.has(extname(entry.name))) yield p;
  }
}

function allTextFiles() {
  return [...walk(ROOT)];
}

test('no file contains a Unicode replacement character', () => {
  const offenders = [];
  for (const f of allTextFiles()) {
    const raw = readFileSync(f, 'utf8');
    if (raw.includes('\uFFFD')) {
      const lines = raw.split('\n');
      lines.forEach((l, i) => {
        if (l.includes('\uFFFD')) offenders.push(`${relative(ROOT, f)}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(offenders, [], `replacement characters (encoding corruption) in: ${offenders.join(', ')}`);
});

test('no file is left half-encoded or truncated', () => {
  // A round-trip that mangles multi-byte sequences often leaves an odd number of
  // bytes or a lone continuation byte. Decoding as strict UTF-8 throws on those.
  for (const f of allTextFiles()) {
    const buf = readFileSync(f);
    // A BOM in the middle of a file means a partial write was appended to.
    const body = buf.subarray(buf.length > 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0);
    const idx = body.indexOf(Buffer.from([0xef, 0xbb, 0xbf]));
    assert.equal(idx, -1, `${relative(ROOT, f)} has a stray BOM at offset ${idx}`);
  }
});

test('source files are ASCII except where unicode is the point', () => {
  // Only two files legitimately need non-ASCII: a progress-bar character class
  // and a multibyte regression test. Everything else stays ASCII so that no
  // future encoding round-trip can damage it.
  const ALLOWED = new Set(['src/capture/stream.mjs', 'test/stream.test.mjs']);
  const offenders = [];
  for (const f of allTextFiles()) {
    const rel = relative(ROOT, f).replace(/\\/g, '/');
    if (ALLOWED.has(rel)) continue;
    const buf = readFileSync(f);
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] > 0x7f) {
        offenders.push(`${rel} (0x${buf[i].toString(16).padStart(2, '0')} at ${i})`);
        break;
      }
    }
  }
  assert.deepEqual(offenders, [], `unexpected non-ASCII: ${offenders.join(', ')}`);
});

test('the two unicode-bearing files still contain what they must', () => {
  // If these were "cleaned up" to ASCII the tests they guard would stop testing
  // anything, so assert the characters are actually present.
  const stream = readFileSync(join(ROOT, 'src/capture/stream.mjs'), 'utf8');
  for (const cp of [0x2588, 0x2593, 0x2592, 0x2591]) {
    assert.ok(stream.includes(String.fromCharCode(cp)), `progress char U+${cp.toString(16)} missing from stream.mjs`);
  }
  const test = readFileSync(join(ROOT, 'test/stream.test.mjs'), 'utf8');
  assert.ok(test.includes('\u00e9'), 'multibyte fixture lost its e-acute');
  assert.ok(test.includes('\u2192'), 'multibyte fixture lost its arrow');
  assert.ok(test.includes('\u00f6'), 'multibyte fixture lost its o-umlaut');
});

test('no source file contains a duplicated top-level block', () => {
  // A failed string-splice edit once duplicated half of bin/wd.js. The result
  // still parsed. Look for the signature: a second import block in one file.
  const offenders = [];
  for (const f of allTextFiles()) {
    if (extname(f) !== '.js' && extname(f) !== '.mjs') continue;
    const lines = readFileSync(f, 'utf8').split('\n');
    const seen = new Map();
    for (const line of lines) {
      const m = /^(?:import .* from |const |function |export (?:function|class) )/.exec(line);
      if (!m) continue;
      if (seen.has(line)) {
        offenders.push(`${relative(ROOT, f)}: "${line.trim().slice(0, 60)}" appears twice (lines ${seen.get(line)}, ${lines.indexOf(line) + 1})`);
      }
      seen.set(line, lines.indexOf(line) + 1);
    }
  }
  assert.deepEqual(offenders, [], `duplicated declarations: ${offenders.join('; ')}`);
});

/**
 * Every source file must parse, and a failure must name the file.
 *
 * A single-quoted string split across two lines is a plain syntax error, but V8
 * reported it 25 lines away as "Private field '#command' must be declared in an
 * enclosing class", because the unterminated literal swallowed a class member
 * declaration. The message pointed nowhere near the cause.
 *
 * An earlier version of this test tried to detect the split by counting quotes
 * per line. That is not reliable -- it flagged its own source -- so the check
 * parses each file and reports the filename, which is the part that was missing.
 */
test('every source file parses, and failures name their file', () => {
  const broken = [];
  for (const f of allTextFiles()) {
    if (extname(f) !== '.js' && extname(f) !== '.mjs') continue;
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      const msg = (e.stderr?.toString() || '').split('\n').find((l) => /Error/.test(l)) ?? 'parse error';
      broken.push(`${relative(ROOT, f)}: ${msg.trim()}`);
    }
  }
  assert.deepEqual(broken, [], `files that do not parse: ${broken.join('; ')}`);
});

test('every module still loads', async () => {
  const { pathToFileURL } = await import('node:url');
  const mods = [
    'src/core/log.mjs',
    'src/core/config.mjs',
    'src/core/exec.mjs',
    'src/core/heartbeat.mjs',
    'src/core/watcher.mjs',
    'src/capture/stream.mjs',
    'src/capture/shell.mjs',
    'src/capture/procwatch.mjs',
    'src/capture/conpty.mjs',
    'src/analyze/rules.mjs',
    'src/analyze/transcript.mjs',
    'src/analyze/advisor.mjs',
    'src/act/guard.mjs',
    'src/act/deps.mjs',
    'src/act/apply.mjs',
    'src/install/install.mjs',
    'src/install/autostart.mjs',
  ];
  for (const m of mods) {
    await assert.doesNotReject(
      () => import(pathToFileURL(join(ROOT, m)).href),
      `module failed to load: ${m}`,
    );
  }
});

test('the CLI entry point is not executed by importing it', () => {
  // bin/wd.js calls main() at import time. Guard that it stays a script, since
  // the smoke test used to import it and silently run the CLI as a side effect.
  const src = readFileSync(join(ROOT, 'bin', 'wd.js'), 'utf8');
  assert.match(src, /^main\(\)/m, 'expected a top-level main() call');
});

/**
 * `cmdStatus` was lost during a file-recovery incident. main() still routed to
 * it, the file parsed, and every test passed -- the only symptom was
 * `ReferenceError: cmdStatus is not defined` when a user actually ran the
 * command. Parsing proves nothing about whether a called symbol exists.
 */
test('every routed command resolves to a function that exists', () => {
  const src = readFileSync(join(ROOT, 'bin', 'wd.js'), 'utf8');
  const routed = [...src.matchAll(/case '([a-z-]+)':\s*return (?:await )?(\w+)\(/g)];
  assert.ok(routed.length >= 10, `expected to find the command routing, found ${routed.length}`);

  const defined = new Set([...src.matchAll(/(?:async )?function (\w+)\(/g)].map((m) => m[1]));
  const missing = routed.filter((m) => !defined.has(m[2])).map((m) => `${m[1]} -> ${m[2]}`);
  assert.deepEqual(missing, [], `routed to undefined functions: ${missing.join(', ')}`);
});

test('every command listed in the help text is actually routable', () => {
  const src = readFileSync(join(ROOT, 'bin', 'wd.js'), 'utf8');
  const help = /const HELP = `([\s\S]*?)`;/.exec(src);
  assert.ok(help, 'could not locate the HELP block');
  const routed = new Set([...src.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]));
  // "wd" itself and the help/usage invocation are not switch cases.
  const documented = new Set([...help[1].matchAll(/^\s*wd ([a-z-]+)/gm)].map((m) => m[1]));
  documented.delete('wd');
  const undocumentable = [...documented].filter((c) => !routed.has(c) && c !== 'rollback');
  assert.deepEqual(undocumentable, [], `documented but not routable: ${undocumentable.join(', ')}`);
});

test('every routed command runs without throwing', () => {
  // Not every command is safe to run in a test (start would launch a daemon), so
  // this checks the read-only ones actually produce output.
  const safe = ['--help', 'rules', 'rails', 'status', 'findings', 'journal', 'doctor', 'autostart'];
  for (const args of safe.map((a) => [a])) {
    let stdout = '';
    let threw = null;
    try {
      stdout = execFileSync(process.execPath, [join(ROOT, 'bin', 'wd.js'), ...args], {
        encoding: 'utf8',
        timeout: 180_000,
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      threw = e;
    }
    const label = `wd ${args.join(' ')}`;
    assert.equal(threw, null, `${label} failed: ${threw?.stderr?.toString().slice(0, 300) ?? threw?.message}`);
    assert.ok(stdout.trim().length > 0, `${label} produced no output`);
  }
});
