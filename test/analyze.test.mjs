import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate, listRules, severityAtLeast } from '../src/analyze/rules.mjs';
import { Applier, unifiedDiff } from '../src/act/apply.mjs';

test('detects a missing node module and proposes installing it', () => {
  const f = evaluate("Error: Cannot find module 'left-pad'")[0];
  assert.equal(f.ruleId, 'node-module-missing');
  assert.equal(f.severity, 'critical');
  assert.equal(f.fix.kind, 'install-deps');
  assert.equal(f.fix.package, 'left-pad');
});

test('captures the module name from a scoped package', () => {
  const f = evaluate("Cannot find module '@scope/thing'")[0];
  assert.equal(f.fix.package, '@scope/thing');
});

test('detects a Python missing module', () => {
  const f = evaluate("ModuleNotFoundError: No module named 'requests'")[0];
  assert.equal(f.ruleId, 'python-modulenotfound');
  assert.equal(f.fix.package, 'requests');
});

test('detects a TypeScript error and ignores node_modules noise', () => {
  assert.equal(evaluate('src/a.ts(3,5): error TS2322: Type mismatch')[0].ruleId, 'tsc-error');
  assert.equal(evaluate('node_modules/x/a.ts(3,5): error TS2322: Type mismatch').length, 0);
});

test('detects .NET compiler errors', () => {
  assert.equal(evaluate('Program.cs(12,5): error CS1002: ; expected')[0].ruleId, 'dotnet-error');
});

test('detects an out-of-memory crash', () => {
  assert.equal(evaluate('<--- Last few GCs --->\nFATAL ERROR: Ineffective mark-compacts near heap limit').length + evaluate('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory').length > 0, true);
});

test('detects EACCES', () => {
  assert.equal(evaluate('Error: EACCES: permission denied, open \'/var/log/x\'')[0].ruleId, 'permission-denied');
});

test('does not fire on ordinary successful output', () => {
  for (const line of [
    'Compiled successfully in 214ms',
    '42 passing (1s)',
    'added 214 packages in 6s',
    'Everything up-to-date',
    'Build succeeded',
  ]) {
    assert.deepEqual(evaluate(line), [], `false positive on: ${line}`);
  }
});

test('ignores auth words in test fixtures', () => {
  assert.deepEqual(evaluate('expected 401 Unauthorized in mock response'), []);
});

test('does not report a failing test assertion as an auth problem', () => {
  // Observed live: "E  assert 401 == 200" was reported as unauthenticated.
  assert.deepEqual(evaluate('E       assert 401 == 200'), []);
  assert.deepEqual(evaluate("AssertionError: expected 401 to equal 200"), []);
});

test('still reports a genuine auth failure', () => {
  const f = evaluate('Error: 401 Unauthorized')[0];
  assert.equal(f.ruleId, 'unauthenticated');
  assert.equal(evaluate('You are not logged in. Run: gh auth login')[0].ruleId, 'unauthenticated');
});

test('does not report a command echo as a TypeScript error', () => {
  // Observed live: a transcript header quoting the command line matched the
  // unanchored tsc pattern and produced a false positive.
  assert.deepEqual(
    evaluate('Host Application: powershell.exe -NoLogo -Command Write-Host "src/a.ts(1,1): error TS1: bad"'),
    [],
  );
  assert.deepEqual(evaluate("PS>Write-Host 'src/a.ts(1,1): error TS1: bad'"), []);
});

test('still reports a real TypeScript diagnostic', () => {
  assert.equal(evaluate('src/a.ts(3,5): error TS2322: Type string is not assignable')[0].ruleId, 'tsc-error');
  assert.equal(evaluate('src/a.ts(42,18): error TS2345: Argument of type string')[0].ruleId, 'tsc-error');
});

test('tsc errors inside node_modules stay ignored', () => {
  assert.deepEqual(evaluate('node_modules/left-pad/index.js(4,2): error TS1000: bad'), []);
  assert.deepEqual(evaluate('C:/proj/node_modules/x/a.ts(4,2): error TS1000: bad'), []);
});

test('every finding carries an explanation for a human', () => {
  for (const line of [
    "Cannot find module 'x'",
    "ModuleNotFoundError: No module named 'y'",
    'src/a.ts(1,1): error TS1: bad',
    'fatal: EACCES',
  ]) {
    for (const f of evaluate(line)) {
      assert.ok(f.explain && f.explain.length > 10, `${f.ruleId} has no usable explanation`);
      assert.ok(f.evidence, `${f.ruleId} kept no evidence`);
      assert.ok(f.at, `${f.ruleId} has no timestamp`);
    }
  }
});

test('severity ordering is correct', () => {
  assert.ok(severityAtLeast('critical', 'low'));
  assert.ok(!severityAtLeast('low', 'high'));
  assert.equal(severityAtLeast('medium', 'medium'), true);
});

test('all rules are well formed', () => {
  const ids = new Set();
  for (const r of listRules()) {
    assert.ok(!ids.has(r.id), `duplicate rule id ${r.id}`);
    ids.add(r.id);
    assert.ok(['critical', 'high', 'medium', 'low', 'info'].includes(r.severity));
  }
});

test('a directory target is refused cleanly rather than crashing', () => {
  const root = tmp();
  const data = join(root, '.watchdog');
  mkdirSync(data, { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  const a = new Applier({ projectRoot: root, dataDir: data, autonomy: 'autonomous' });
  // The sandbox caught this: a model returned path:"" which resolved to the
  // project root and threw EISDIR on read.
  for (const p of ['', '.', 'src']) {
    const r = a.apply({ kind: 'patch-file', path: p, find: 'a', replace: 'b' }, { cwd: root });
    assert.equal(r.status, 'skipped', `path=${JSON.stringify(p)} -> ${JSON.stringify(r)}`);
    assert.match(r.why, /does not exist|not a regular file/);
  }
});

test('no rule ships a fix that does nothing', () => {
  // An empty argv produced findings reported as "applied: skipped - no command to
  // run", which is worse than offering no fix at all.
  for (const line of ['3 failed, 12 passed', 'JavaScript heap out of memory', "Cannot find module 'x'"]) {
    for (const f of evaluate(line)) {
      if (f.fix && (f.fix.kind === 'command' || f.fix.kind === 'install-deps')) {
        assert.ok(f.fix.argv?.length || f.fix.package, `${f.ruleId} has an empty fix`);
      }
    }
  }
});

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'wd-test-'));
  return d;
}

test('applies a patch and journals it for rollback', () => {
  const root = tmp();
  const data = join(root, '.watchdog');
  mkdirSync(data, { recursive: true });
  const target = join(root, 'a.js');
  writeFileSync(target, 'const x = 1;\nconst y = 2;\n');

  const a = new Applier({ projectRoot: root, dataDir: data, autonomy: 'autonomous' });
  const r = a.apply({ kind: 'patch-file', path: 'a.js', find: 'const y = 2;', replace: 'const y = 3;' }, { cwd: root });
  assert.equal(r.status, 'applied');
  assert.match(readFileSync(target, 'utf8'), /const y = 3;/);

  a.rollback(r.journalId);
  assert.match(readFileSync(target, 'utf8'), /const y = 2;/);
});

test('refuses a patch whose quoted find text was invented by the model', () => {
  const root = tmp();
  const data = join(root, '.watchdog');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(root, 'a.js'), 'real content\n');

  const a = new Applier({ projectRoot: root, dataDir: data, autonomy: 'autonomous' });
  const r = a.apply({ kind: 'patch-file', path: 'a.js', find: 'text that does not exist', replace: 'x' }, { cwd: root });
  assert.equal(r.status, 'skipped');
  assert.match(r.why, /invented it/);
  assert.equal(readFileSync(join(root, 'a.js'), 'utf8'), 'real content\n');
});

test('refuses an ambiguous find so it cannot corrupt the wrong site', () => {
  const root = tmp();
  const data = join(root, '.watchdog');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(root, 'a.js'), 'x();\ny();\nx();\n');
  const a = new Applier({ projectRoot: root, dataDir: data, autonomy: 'autonomous' });
  const r = a.apply({ kind: 'patch-file', path: 'a.js', find: 'x();', replace: 'z();' }, { cwd: root });
  assert.equal(r.status, 'skipped');
  assert.match(r.why, /ambiguous/);
});

test('suggest mode never writes', () => {
  const root = tmp();
  const data = join(root, '.watchdog');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(root, 'a.js'), 'x\n');
  const a = new Applier({ projectRoot: root, dataDir: data, autonomy: 'suggest' });
  const r = a.apply({ kind: 'patch-file', path: 'a.js', find: 'x', replace: 'y' }, { cwd: root });
  assert.equal(r.status, 'suggested');
  assert.equal(readFileSync(join(root, 'a.js'), 'utf8'), 'x\n');
});

test('allowlist mode only acts on listed kinds', () => {
  const root = tmp();
  const data = join(root, '.watchdog');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(root, 'a.js'), 'x\n');
  const a = new Applier({ projectRoot: root, dataDir: data, autonomy: 'allowlist', allowlist: ['command'] });
  assert.equal(a.apply({ kind: 'patch-file', path: 'a.js', find: 'x', replace: 'y' }, { cwd: root }).status, 'suggested');
});

test('refuses a write outside the project root even in autonomous mode', () => {
  const root = tmp();
  const data = join(root, '.watchdog');
  mkdirSync(data, { recursive: true });
  const outside = join(tmp(), 'victim.txt');
  writeFileSync(outside, 'safe\n');
  const a = new Applier({ projectRoot: root, dataDir: data, autonomy: 'autonomous' });
  const r = a.apply({ kind: 'patch-file', path: outside, find: 'safe', replace: 'pwned' }, { cwd: root });
  assert.equal(r.status, 'refused');
  assert.equal(readFileSync(outside, 'utf8'), 'safe\n');
});

test('refuses a .env write in autonomous mode', () => {
  const root = tmp();
  const data = join(root, '.watchdog');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(root, '.env'), 'TOKEN=abc\n');
  const a = new Applier({ projectRoot: root, dataDir: data, autonomy: 'autonomous' });
  const r = a.apply({ kind: 'patch-file', path: '.env', find: 'abc', replace: 'xyz' }, { cwd: root });
  assert.equal(r.status, 'refused');
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'TOKEN=abc\n');
});

test('journal records before and after content', () => {
  const root = tmp();
  const data = join(root, '.watchdog');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(root, 'a.js'), 'before\n');
  const a = new Applier({ projectRoot: root, dataDir: data, autonomy: 'autonomous' });
  const r = a.apply({ kind: 'write-file', path: 'a.js', contents: 'after\n' }, { cwd: root });
  const entries = a.listJournal();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].before, 'before\n');
  assert.equal(entries[0].after, 'after\n');
  assert.ok(existsSync(join(data, 'journal', `${r.journalId}.json`)));
});

test('unified diff shows the change', () => {
  const d = unifiedDiff('a\nb\n', 'a\nc\n', 'x.js');
  assert.match(d, /-b/);
  assert.match(d, /\+c/);
});

test('a real command is executed and journalled', async () => {
  const root = tmp();
  const data = join(root, '.watchdog');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x' }));
  const a = new Applier({ projectRoot: root, dataDir: data, autonomy: 'autonomous' });
  // `node --version` rather than an absolute path to node.exe. A path is refused
  // by the command policy on purpose -- "run this exact file" is the shape that
  // turns a vetted program name into "run whatever that file does" -- and these
  // tests are about exec mechanics, not about smuggling code past the rails.
  const r = await a.applyAsync({ kind: 'command', argv: ['node', '--version'] }, { cwd: root });
  assert.equal(r.status, 'applied', JSON.stringify(r));
  const entries = a.listJournal();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].outcome, 'ok');
});

test('a command is never run synchronously', () => {
  const root = tmp();
  const data = join(root, '.watchdog');
  mkdirSync(data, { recursive: true });
  const a = new Applier({ projectRoot: root, dataDir: data, autonomy: 'autonomous' });
  // The sync entry point must refuse to block the event loop on a subprocess.
  const r = a.apply({ kind: 'command', argv: ['node', '--version'] }, { cwd: root });
  assert.equal(r.status, 'deferred');
});

test('reports a command that cannot be run, rather than claiming success', async () => {
  const root = tmp();
  const data = join(root, '.watchdog');
  mkdirSync(data, { recursive: true });
  const a = new Applier({ projectRoot: root, dataDir: data, autonomy: 'autonomous' });
  const r = await a.applyAsync({ kind: 'command', argv: ['definitely-not-a-real-binary-xyz'] }, { cwd: root });
  // An unknown program is now refused before it is ever spawned, rather than being
  // attempted and failing. The concern this test exists for -- never claim success
  // for a command that did not run -- holds either way, but the reason changed, so
  // assert on the refusal and check that nothing was journalled as done.
  assert.notEqual(r.status, 'applied');
  assert.match(r.why, /not a program the watchdog is permitted to invoke|exited|could not run/);
  assert.equal(a.listJournal().filter((e) => e.outcome === 'ok').length, 0);
});

test('never installs into a global interpreter without a project venv', async () => {
  const root = tmp();
  const data = join(root, '.watchdog');
  mkdirSync(data, { recursive: true });
  // Declared, so the allowlist passes; only the venv gate can stop this.
  writeFileSync(join(root, 'requirements.txt'), 'requests>=2.31.0\n');
  const a = new Applier({ projectRoot: root, dataDir: data, autonomy: 'autonomous' });
  // ecosystem is what the python-modulenotfound rule emits.
  const r = await a.applyAsync({ kind: 'install-deps', package: 'requests', ecosystem: 'python' }, { cwd: root });
  assert.equal(r.status, 'skipped', JSON.stringify(r));
  assert.match(r.why, /global interpreter/);
});

test('the allowlist is checked before anything else', async () => {
  const root = tmp();
  const data = join(root, '.watchdog');
  mkdirSync(data, { recursive: true });
  const a = new Applier({ projectRoot: root, dataDir: data, autonomy: 'autonomous' });
  const r = await a.applyAsync({ kind: 'install-deps', package: 'requests', ecosystem: 'node' }, { cwd: root });
  assert.equal(r.status, 'skipped');
  // The allowlist is the outer gate: an undeclared package is refused even when
  // the reason the older code would have given (no venv) also applies.
  assert.match(r.why, /not a declared Node dependency/);
});

test('an install with no ecosystem is refused rather than guessed', async () => {
  // Both registries host packages with the same names, so defaulting the
  // ecosystem is not a neutral choice -- it is the original bug with a shrug.
  const root = tmp();
  const data = join(root, '.watchdog');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { requests: '^1.0.0' } }));
  writeFileSync(join(root, 'requirements.txt'), 'requests>=2.31.0\n');
  const a = new Applier({ projectRoot: root, dataDir: data, autonomy: 'autonomous' });
  const r = await a.applyAsync({ kind: 'install-deps', package: 'requests' }, { cwd: root });
  assert.equal(r.status, 'skipped');
  assert.match(r.why, /did not say which ecosystem/);
});

test('targets a project virtualenv when one exists', async () => {
  const root = tmp();
  const data = join(root, '.watchdog');
  mkdirSync(data, { recursive: true });
  mkdirSync(join(root, '.venv', 'Scripts'), { recursive: true });
  writeFileSync(join(root, '.venv', 'Scripts', 'python.exe'), '');
  const a = new Applier({ projectRoot: root, dataDir: data, autonomy: 'autonomous' });
  const r = await a.applyAsync({ kind: 'install-deps', package: 'requests' }, { cwd: root });
  // The venv python is an empty stub, so this must not fall back to a global install.
  assert.doesNotMatch(r.why ?? '', /global interpreter/);
  assert.notEqual(r.status, 'applied');
});

test('a hanging command is killed instead of hanging the daemon', async () => {
  const root = tmp();
  const data = join(root, '.watchdog');
  mkdirSync(data, { recursive: true });
  // The command is `npm run test`, a permitted shape. What the script does is the
  // project's own business -- the watchdog asked to run the project's test
  // command, which is exactly what it is allowed to do. Reaching for `node -e`
  // here would have meant the guard was in the way of its own test.
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'x', scripts: { test: 'node -e "setTimeout(()=>{},60000)"' } }),
  );
  const a = new Applier({ projectRoot: root, dataDir: data, autonomy: 'autonomous' });
  const started = Date.now();
  const r = await a.applyAsync(
    { kind: 'command', argv: ['npm', 'run', 'test'], timeoutMs: 1200 },
    { cwd: root },
  );
  assert.equal(r.status, 'error', JSON.stringify(r));
  assert.match(r.why, /timed out/);
  assert.ok(Date.now() - started < 20_000, 'timeout did not actually fire promptly');
});

test('fix commands are serialised rather than run concurrently', async () => {
  const root = tmp();
  const data = join(root, '.watchdog');
  mkdirSync(data, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'x', scripts: { test: 'node -e "setTimeout(()=>{},600)"' } }),
  );
  const a = new Applier({ projectRoot: root, dataDir: data, autonomy: 'autonomous' });
  const cmd = { kind: 'command', argv: ['npm', 'run', 'test'] };
  const started = Date.now();
  const results = await Promise.all([
    a.applyAsync(cmd, { cwd: root }),
    a.applyAsync(cmd, { cwd: root }),
    a.applyAsync(cmd, { cwd: root }),
  ]);
  assert.equal(results.filter((r) => r.status === 'applied').length, 3, JSON.stringify(results));
  // Three slow jobs run one after another, so this must take well over 1.8s.
  assert.ok(Date.now() - started > 1800, 'the three jobs appear to have run concurrently');
  assert.equal(a.listJournal().length, 3);
});
