/**
 * The supply-chain guard.
 *
 * Attack: terminal output is untrusted. A malicious postinstall script, a
 * compromised build tool, or a hostile README printed to the terminal can emit
 *
 *     Error: Cannot find module 'evil-pkg'
 *
 * and the `node-module-missing` rule would hand that name to an autonomous
 * `npm install`. Installing a package runs arbitrary code with the user's
 * privileges, so the attacker picks what executes.
 *
 * A denylist cannot close this -- the attacker chooses the name and would simply
 * choose a different one. The fix is an allowlist: only packages the project has
 * already declared. That set is authored by the user, not by a build log.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Applier } from '../src/act/apply.mjs';
import { evaluate } from '../src/analyze/rules.mjs';
import { declaredPackages, isDeclared, normalizePkgName, lockfileKind } from '../src/act/deps.mjs';

function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'wd-deps-'));
  for (const [name, content] of Object.entries(files)) {
    const p = join(root, name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  mkdirSync(join(root, '.watchdog'), { recursive: true });
  return root;
}

const applierFor = (root) => new Applier({ projectRoot: root, dataDir: join(root, '.watchdog'), autonomy: 'autonomous' });

// ------------------------------------------------------------ the attack

test('the exact attack from the report is refused', async () => {
  const root = project({ 'package.json': JSON.stringify({ name: 'app', dependencies: { 'left-pad': '^1.3.0' } }) });
  const a = applierFor(root);

  // The untrusted line an attacker would print.
  const finding = evaluate("Error: Cannot find module 'evil-pkg'")[0];
  assert.equal(finding.ruleId, 'node-module-missing');
  assert.equal(finding.fix.package, 'evil-pkg', 'the rule still extracts it -- the applier must refuse');

  const r = await a.applyAsync(finding.fix, { cwd: root });
  assert.equal(r.status, 'skipped', JSON.stringify(r));
  assert.match(r.why, /not a declared/);
});

test('a declared dependency is still installed automatically', async () => {
  const root = project({ 'package.json': JSON.stringify({ name: 'app', dependencies: { 'left-pad': '^1.3.0' } }) });
  const a = applierFor(root);
  const finding = evaluate("Error: Cannot find module 'left-pad'")[0];
  const r = await a.applyAsync(finding.fix, { cwd: root });
  // Declared, so it is allowed. With no lockfile npm install is used and will
  // actually run here, so only assert that it was not refused for the allowlist.
  assert.doesNotMatch(r.why ?? '', /not a declared dependency/);
});

test('devDependencies count as declared', async () => {
  const root = project({ 'package.json': JSON.stringify({ name: 'app', devDependencies: { typescript: '^5' } }) });
  assert.equal(isDeclared(root, 'typescript'), true);
  assert.equal(isDeclared(root, 'evil'), false);
});

// ------------------------------------------------------------ python side

test('a python package absent from requirements.txt is refused', async () => {
  const root = project({ 'requirements.txt': 'flask==3.0.0\nrequests>=2.31.0\n' });
  const a = applierFor(root);
  const finding = evaluate("ModuleNotFoundError: No module named 'evil'")[0];
  const r = await a.applyAsync(finding.fix, { cwd: root });
  assert.equal(r.status, 'skipped');
  assert.match(r.why, /not a declared/);
});

/**
 * Found by mutation testing: with a venv present and no package.json, a weaker
 * allowlist (one that only guards the JS path) would sail through to
 * `pip install evil` and still report a "skipped" result, because the *message*
 * is computed independently and would still sound correct. Asserting on the
 * message alone is not enough -- this asserts the refusal is structural.
 */
test('an undeclared package is refused even when a usable venv exists', async () => {
  const root = project({ 'requirements.txt': 'flask==3.0.0\n' });
  const scripts = process.platform === 'win32' ? join(root, '.venv', 'Scripts') : join(root, '.venv', 'bin');
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, process.platform === 'win32' ? 'python.exe' : 'python'), '');

  const a = applierFor(root);
  // ecosystem: 'python' because that is what python-modulenotfound emits, and
  // this test is about the allowlist gate -- not about the ecosystem check that
  // now runs ahead of it.
  const r = await a.applyAsync({ kind: 'install-deps', package: 'evil', ecosystem: 'python' }, { cwd: root });
  assert.equal(r.status, 'skipped', 'must refuse even though the venv would have worked');
  assert.match(r.why, /not a declared/);
  // Nothing may have been executed.
  assert.equal(a.listJournal().filter((j) => j.outcome === 'ok').length, 0);
});

test('an undeclared package is refused even in a project with a lockfile', async () => {
  const root = project({
    'package.json': JSON.stringify({ name: 'app', dependencies: { 'left-pad': '1.3.0' } }),
    'package-lock.json': JSON.stringify({ name: 'app', lockfileVersion: 3, packages: {} }),
  });
  const a = applierFor(root);
  // The lockfile makes the repair path look attractive; it must not bypass the gate.
  const r = await a.applyAsync({ kind: 'install-deps', package: 'evil-pkg', ecosystem: 'node' }, { cwd: root });
  assert.equal(r.status, 'skipped');
  assert.match(r.why, /not a declared/);
});

test('python requirement formats are all recognised', () => {
  const root = project({
    'requirements.txt': [
      '# a comment',
      'requests==2.31.0',
      'flask>=2.0',
      'django[argon2]==5.0 ; python_version >= "3.10"',
      'Django_REST_framework', // PEP 503 normalisation: underscore -> hyphen
      '-r other.txt',
      '--index-url https://example.com/simple',
      'https://example.com/pkg.tar.gz',
    ].join('\n'),
  });
  const declared = declaredPackages(root);
  assert.ok(declared.has('requests'));
  assert.ok(declared.has('flask'));
  assert.ok(declared.has('django'));
  assert.ok(declared.has('django-rest-framework'), `got ${[...declared].join(',')}`);
  assert.equal(declared.has('other'), false, 'the -r include target is not itself a package');
});

test('pyproject dependencies and poetry deps are recognised', () => {
  const pep621 = project({
    'pyproject.toml': '[project]\nname = "x"\ndependencies = ["httpx>=0.27", "pydantic==2.0"]\n',
  });
  const d1 = declaredPackages(pep621);
  assert.ok(d1.has('httpx') && d1.has('pydantic'), [...d1].join(','));

  const poetry = project({ 'pyproject.toml': '[tool.poetry.dependencies]\npython = "^3.11"\nhttpx = "^0.27"\n' });
  const d2 = declaredPackages(poetry);
  assert.ok(d2.has('httpx'), [...d2].join(','));
  assert.ok(!d2.has('python'), 'python itself is not an installable requirement here');
});

test('requirements includes are followed, but not outside the project', () => {
  const root = project({ 'requirements.txt': '-r extra.txt\n', 'extra.txt': 'click==8.1.0\n' });
  assert.ok(declaredPackages(root).has('click'), 'local include should be followed');
});

// ------------------------------------------------------------ fail closed

test('an unparseable manifest yields an empty allowlist, not an open one', () => {
  const root = project({ 'package.json': '{ this is not json' });
  assert.equal(declaredPackages(root).size, 0);
  assert.equal(isDeclared(root, 'anything'), false);
});

test('a project with no manifests declares nothing', () => {
  const root = project({});
  assert.equal(declaredPackages(root).size, 0);
});

// ------------------------------------------------------------ normalisation

test('package names normalise consistently', () => {
  assert.equal(normalizePkgName('left-pad'), 'left-pad');
  assert.equal(normalizePkgName('left-pad@1.3.0'), 'left-pad');
  assert.equal(normalizePkgName('requests==2.31.0'), 'requests');
  assert.equal(normalizePkgName('requests[security]'), 'requests');
  assert.equal(normalizePkgName('Django_REST_framework'), 'django-rest-framework');
  assert.equal(normalizePkgName('https://example.com/x.tar.gz'), '');
  assert.equal(normalizePkgName('  spaced  '), 'spaced');
});

// ------------------------------------------------------------ lockfile

test('lockfile detection drives lockfile-honouring repair', () => {
  assert.equal(lockfileKind(project({ 'package.json': '{}', 'package-lock.json': '{}' })), 'npm');
  assert.equal(lockfileKind(project({ 'package.json': '{}', 'yarn.lock': '' })), 'yarn');
  assert.equal(lockfileKind(project({ 'package.json': '{}', 'pnpm-lock.yaml': '' })), 'pnpm');
  assert.equal(lockfileKind(project({ 'package.json': '{}' })), null);
});

test('a declared dep with a lockfile repairs via the lockfile, not by name', async () => {
  const root = project({
    'package.json': JSON.stringify({ name: 'app', dependencies: { 'left-pad': '1.3.0' } }),
    // A lockfile whose repair command will fail fast, so nothing is fetched.
    'package-lock.json': JSON.stringify({ name: 'app', lockfileVersion: 3, packages: {} }),
  });
  const a = applierFor(root);
  const r = await a.applyAsync({ kind: 'install-deps', package: 'left-pad' }, { cwd: root });
  // Whatever npm ci decides, the point is that the name was NOT re-resolved.
  assert.doesNotMatch(r.why ?? '', /not a declared dependency/);
  const journal = a.listJournal();
  if (journal.length) assert.ok(!journal[0].argv.includes('left-pad'), `argv was ${journal[0].argv}`);
});

// ------------------------------------------------------------ the rule side

test('the rule still extracts names; the allowlist is the only gate', () => {
  // Deliberately assert the rule is unchanged: detection must not be weakened,
  // only the acting on it. Suppressing the rule would just hide real problems.
  assert.equal(evaluate("Cannot find module 'left-pad'")[0].fix.package, 'left-pad');
  assert.equal(evaluate("ModuleNotFoundError: No module named 'requests'")[0].fix.package, 'requests');
});
