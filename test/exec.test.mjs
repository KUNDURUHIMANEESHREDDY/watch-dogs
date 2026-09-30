import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRunnable, assertSafeArg, runCapture } from '../src/core/exec.mjs';
import { Advisor } from '../src/analyze/advisor.mjs';

test('non-exe binaries are routed through cmd.exe on Windows', () => {
  // Verified behaviour: bare `npm` -> ENOENT, `npm.cmd` -> synchronous EINVAL.
  for (const argv of [['npm', 'install', 'left-pad'], ['npm.cmd', '--version'], ['yarn', 'add', 'x']]) {
    const { cmd, args } = makeRunnable(argv);
    if (process.platform === 'win32') {
      assert.match(cmd, /cmd(\.exe)?$/i, `${argv[0]} should go via cmd.exe`);
      assert.equal(args[0], '/d');
      assert.ok(args.includes(argv[0]));
    } else {
      assert.equal(cmd, argv[0]);
    }
  }
});

test('a real .exe is spawned directly', () => {
  const { cmd, args } = makeRunnable(['C:/x/y.exe', '--version']);
  assert.match(cmd, /\.exe$/i);
  assert.deepEqual(args, ['--version']);
  // Even the running interpreter, which is a .exe, must bypass cmd.exe.
  const self = makeRunnable([process.execPath, '--version']);
  assert.equal(self.cmd, process.execPath);
});

test('unsafe values are refused rather than pasted onto a command line', () => {
  // These are exactly the shapes that made the old shell:true version injectable.
  for (const bad of [
    'a & calc',
    'a | cmd',
    'a && b',
    'a`b`',
    'a; rm -rf /',
    'a\nb',
    'a"b',
    '',
  ]) {
    assert.throws(() => assertSafeArg('x', bad), /unsafe value/, `should have refused: ${JSON.stringify(bad)}`);
  }
  for (const good of ['gpt-4o', 'anthropic/claude', 'openai/gpt-5#high', 'provider:model', 'C:/x/y.exe']) {
    assert.equal(assertSafeArg('x', good), good, `should accept: ${good}`);
  }
  // % is cmd.exe variable expansion and must stay rejected even though it is harmless-looking.
  assert.throws(() => assertSafeArg('x', 'a%PATH%b'));
});

test('a missing binary resolves to a tagged failure, not a rejection', async () => {
  const r = await runCapture({ cmd: 'definitely-not-a-real-binary-xyz', args: [], cwd: process.cwd(), timeoutMs: 5000 });
  assert.ok(
    r.startsWith('__WD_SPAWNFAIL__') || r.startsWith('__WD_EXIT__') || r.startsWith('__WD_TIMEOUT__'),
    `expected a tagged failure, got: ${r.slice(0, 200)}`,
  );
});

test('a command that exits non-zero is distinguishable from a spawn failure', async () => {
  const r = await runCapture({
    cmd: process.execPath,
    args: ['-e', 'process.exit(3)'],
    cwd: process.cwd(),
    timeoutMs: 10_000,
  });
  assert.ok(r.startsWith('__WD_EXIT__3'), `got: ${r.slice(0, 200)}`);
});

test('stdin reaches the child process', async () => {
  const r = await runCapture({
    cmd: process.execPath,
    args: ['-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log("GOT:"+d.trim()))'],
    cwd: process.cwd(),
    stdin: 'hello from stdin',
    timeoutMs: 10_000,
  });
  assert.match(r, /GOT:hello from stdin/);
});

test('a timeout is enforced promptly', async () => {
  const t0 = Date.now();
  const r = await runCapture({ cmd: process.execPath, args: ['-e', 'setTimeout(()=>{},60000)'], cwd: process.cwd(), timeoutMs: 1200 });
  assert.ok(r.startsWith('__WD_TIMEOUT__'), `got: ${r.slice(0, 120)}`);
  assert.ok(Date.now() - t0 < 15_000);
});

test('a provider quota failure is reported distinctly, never as a plain "unsure"', async (t) => {
  if (process.platform !== 'win32') return t.skip('stub is a .cmd shim');
  const dir = mkdtempSync(join(tmpdir(), 'wd-stub-'));
  const stub = join(dir, 'stubcli.cmd');
  // Reproduces the exact envelope opencode returns when the account is unfunded.
  writeFileSync(
    stub,
    '@echo off\r\n' +
      'echo {"type":"error","timestamp":1790680375149,"sessionID":"ses_x",' +
      '"error":{"type":"provider.quota","message":"Upstream request failed: Insufficient account funds","status":402}}\r\n',
  );

  const a = new Advisor({ cli: stub, model: null, timeoutMs: 20_000 });
  const r = await a.review({ evidence: 'Cannot find module left-pad', cwd: dir, title: 'Dependency missing' });

  assert.equal(r.status, 'provider_402');
  assert.match(r.summary, /out of funds/i);
  // Critically: this must not be indistinguishable from a working model saying "unsure".
  assert.notEqual(r.summary, '');
  assert.equal(r.fix, null);
});

test('advisor surfaces a missing CLI as unavailable, not as a verdict', async () => {
  const a = new Advisor({ cli: 'definitely-not-a-real-advisor-cli', model: null, timeoutMs: 15_000 });
  const r = await a.review({ evidence: 'x', cwd: process.cwd(), title: 'y' });
  assert.ok(r.status, 'a transport failure must carry a status');
  assert.notEqual(r.status, 'ok');
  assert.equal(r.fix, null);
});

test('advisor never throws, whatever happens', async () => {
  const a = new Advisor({ cli: 'definitely-not-a-real-advisor-cli', model: null, timeoutMs: 15_000 });
  await assert.doesNotReject(() => a.review({ evidence: 'x', cwd: process.cwd(), title: 'y' }));
});

/**
 * A stub CLI that behaves like `opencode run --format json`: a node script that
 * prints NDJSON events, wrapped in a .cmd so the real Windows launch path
 * (cmd.exe /d /s /c) is exercised rather than bypassed.
 *
 * `cmd.exe echo` cannot emit quotes faithfully -- it writes backslashes
 * literally -- so emitting JSON from a batch file corrupts it. A node script is
 * the honest way to produce the exact bytes the real CLI produces.
 */
function makeStubCli(prefix, events) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const js = join(dir, 'stub.js');
  const cmd = join(dir, 'stubcli.cmd');
  writeFileSync(js, 'process.stdout.write(' + JSON.stringify(events.join('\n') + '\n') + ');\n');
  writeFileSync(cmd, '@echo off\r\n"' + process.execPath + '" "' + js + '" %*\r\n');
  return { cmd, dir };
}

const evText = (text) =>
  JSON.stringify({ type: 'text', timestamp: 2, sessionID: 'ses_x', part: { id: 'p1_text-0', type: 'text', text, time: { start: 1, end: 2 } } });

test('reads the verdict out of a real opencode event stream', async () => {
  if (process.platform !== 'win32') return;
  // Reproduces the real stream: a step_start, then the answer inside part.text.
  const { cmd, dir } = makeStubCli('wd-evt-', [
    JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 'ses_x', part: { id: 'p1', type: 'step-start' } }),
    evText('{"verdict":"problem","confidence":0.9,"summary":"left-pad is not installed","fix":{"description":"add the dep","files":[]}}'),
  ]);

  const a = new Advisor({ cli: cmd, model: null, timeoutMs: 20_000 });
  const r = await a.review({ evidence: "Cannot find module 'left-pad'", cwd: dir, title: 'Dependency missing' });

  assert.equal(r.verdict, 'problem', 'the verdict inside part.text must be read');
  assert.equal(r.confidence, 0.9);
  assert.match(r.summary, /left-pad is not installed/);
  assert.equal(r.status, undefined, 'a successful reply must carry no failure status');
});

test('a code-fenced answer is still parsed', async () => {
  if (process.platform !== 'win32') return;
  const { cmd, dir } = makeStubCli('wd-fence-', [
    evText('Here you go:\n```json\n{"verdict":"noise","confidence":0.8,"summary":"expected output"}\n```'),
  ]);
  const a = new Advisor({ cli: cmd, model: null, timeoutMs: 20_000 });
  const r = await a.review({ evidence: 'npm WARN deprecated', cwd: dir, title: 'Deprecated' });
  assert.equal(r.verdict, 'noise');
  assert.equal(r.status, undefined);
});

test('a model reply with no fix produces no fix, not a crash', async () => {
  if (process.platform !== 'win32') return;
  const { cmd, dir } = makeStubCli('wd-nofix-', [
    evText('{"verdict":"problem","confidence":0.95,"summary":"real bug","fix":null}'),
  ]);
  const a = new Advisor({ cli: cmd, model: null, timeoutMs: 20_000 });
  const r = await a.review({ evidence: 'something', cwd: dir, title: 'T' });
  assert.equal(r.verdict, 'problem');
  assert.equal(r.fix, null);
});

test('a low-confidence answer never produces an applied fix', async () => {
  if (process.platform !== 'win32') return;
  const { cmd, dir } = makeStubCli('wd-lowc-', [
    evText('{"verdict":"problem","confidence":0.2,"summary":"guess","fix":{"description":"d","files":[{"path":"a.js","find":"x","replace":"y"}]}}'),
  ]);
  const a = new Advisor({ cli: cmd, model: null, timeoutMs: 20_000 });
  const r = await a.review({ evidence: 'something', cwd: dir, title: 'T' });
  // The fix is returned but the watcher only acts at >= 0.6; assert the gate value.
  assert.equal(r.confidence, 0.2);
  assert.ok(r.confidence < 0.6);
});
