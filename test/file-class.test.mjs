/**
 * File-class policy for model-proposed edits.
 *
 * The rails answer "is this path obviously forbidden?". They never asked "is this
 * change safe to make without asking", and nothing inspected the replacement
 * text. So a model asked to fix a build error could rewrite a CI workflow, a git
 * hook, or a package manifest -- paths that are inside the project, are not
 * secret files, and sail straight through.
 *
 * The policy is asymmetric on purpose. These paths are refused for model
 * proposals and permitted for rule proposals, because a rule's fix was reviewed
 * when the rule was written and a model's is a guess about unread code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRefused, REFUSAL, sensitiveClass } from '../src/act/guard.mjs';
import { Applier } from '../src/act/apply.mjs';

const base = () => mkdtempSync(join(tmpdir(), 'wd-class-'));

/** Every class the policy claims to protect. */
const MUST_REFUSE = [
  '.github/workflows/ci.yml',
  '.github/actions/build/action.yml',
  '.gitlab-ci.yml',
  'Jenkinsfile',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pyproject.toml',
  'poetry.lock',
  'requirements.txt',
  'requirements-dev.txt',
  'Cargo.toml',
  'go.mod',
  '.git/hooks/pre-commit',
  '.git/config',
  'deploy.sh',
  'scripts/setup.ps1',
  'build.cmd',
  'Dockerfile',
  'docker-compose.yml',
  'infra/main.tf',
  'k8s/deployment.yaml',
  'Makefile',
  'tsconfig.json',
  '.eslintrc.json',
  'bin/tool.exe',
];

const MUST_ALLOW = [
  'src/index.js',
  'src/components/Button.tsx',
  'lib/util.py',
  'README.md',
  'docs/guide.md',
  'src/deeply/nested/file.js',
];

test('model-proposed edits to high-authority files are refused', () => {
  for (const p of MUST_REFUSE) {
    const v = isRefused({ kind: 'patch-file', path: p }, { projectRoot: base(), source: 'llm' });
    assert.equal(v.ok, false, `model was allowed to edit ${p}`);
    assert.equal(v.code, REFUSAL.SENSITIVE_FILE_CLASS, `${p} refused for the wrong reason`);
  }
});

test('ordinary source edits by the model are still allowed', () => {
  // The policy has to be narrow. Refusing everything is as useless as refusing
  // nothing, and would make the LLM layer pointless.
  for (const p of MUST_ALLOW) {
    const v = isRefused({ kind: 'patch-file', path: p }, { projectRoot: base(), source: 'llm' });
    assert.equal(v.ok, true, `model was refused an ordinary edit to ${p}: ${v.why}`);
  }
});

test('the same path is permitted when a rule proposed it', () => {
  // This is the asymmetry, and it is the whole point. Rules ship reviewed with
  // the program; model proposals are guesses about code the model never read.
  for (const p of ['package.json', '.github/workflows/ci.yml', 'deploy.sh', 'Makefile']) {
    const fromRule = isRefused({ kind: 'patch-file', path: p }, { projectRoot: base(), source: 'rule' });
    assert.equal(fromRule.ok, true, `a rule-proposed edit to ${p} was refused: ${fromRule.why}`);
  }
});

test('no source given is treated as untrusted, not trusted', () => {
  // Defaulting to allowed would mean forgetting the argument disables the policy
  // silently, which is how it would have shipped broken the first time.
  for (const p of ['package.json', '.github/workflows/ci.yml']) {
    const v = isRefused({ kind: 'patch-file', path: p }, { projectRoot: base() });
    assert.equal(v.ok, false, `${p} was allowed with no provenance declared`);
  }
});

test('the refusal explains itself rather than just failing', () => {
  const v = isRefused({ kind: 'patch-file', path: '.github/workflows/ci.yml' }, { projectRoot: base(), source: 'llm' });
  assert.match(v.why, /CI workflows run with repository credentials/);
  assert.match(v.why, /without a human/, 'the message does not say what a human can do instead');
});

test('the applier does not write a refused file, and forwards provenance', () => {
  const root = base();
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  const target = join(root, '.github', 'workflows', 'ci.yml');
  writeFileSync(target, 'name: ci\non: push\n', 'utf8');

  const applier = new Applier({ projectRoot: root, dataDir: join(root, '.watchdog') });

  // Same action, same path. Only provenance differs.
  const fromModel = applier.apply(
    { kind: 'patch-file', path: '.github/workflows/ci.yml', find: 'on: push', replace: 'on: [pull_request_target]' },
    { source: 'llm' },
  );
  assert.equal(fromModel.status, 'refused', 'the model rewrote a CI workflow');
  assert.equal(readFileSync(target, 'utf8'), 'name: ci\non: push\n', 'the workflow was modified');

  const fromRule = applier.apply(
    { kind: 'patch-file', path: '.github/workflows/ci.yml', find: 'on: push', replace: 'on: [pull_request_target]' },
    { source: 'rule' },
  );
  assert.equal(fromRule.status, 'applied', `a rule-proposed edit was refused: ${fromRule.why}`);
});

test('sensitiveClass is case-insensitive and separator-agnostic', () => {
  // A policy that can be bypassed by capitalisation or a backslash is not one.
  assert.ok(sensitiveClass('.GitHub\\WORKFLOWS\\ci.yml'), 'case or separator change bypassed the policy');
  assert.ok(sensitiveClass('PACKAGE.JSON'));
  assert.equal(sensitiveClass('src/index.js'), null);
});

test('paths that merely look similar are not caught', () => {
  // Over-broad patterns are their own bug: a file called packages/notes.md has
  // nothing to do with package.json and must stay editable.
  for (const p of ['src/packages/index.js', 'docs/npmrc.md', 'src/gitignore.js', 'my-app/package.json.bak']) {
    assert.equal(sensitiveClass(p), null, `${p} was wrongly treated as high-authority`);
  }
});