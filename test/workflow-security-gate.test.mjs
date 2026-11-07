import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ci = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');
const security = readFileSync(resolve(ROOT, '.github/workflows/security.yml'), 'utf8').replace(/\r\n/g, '\n');
const gate = resolve(ROOT, 'scripts/require-successful-jobs.mjs');

const successfulResults = [
  'core-tests=success',
  'frontend-e2e=success',
  'frontend-build=success',
  'gateway-e2e=success',
  'security=success',
];

test('security workflow is reusable by the CI release gate', () => {
  assert.match(security, /^  workflow_call:\s*$/m);
});

test('CI invokes the security workflow without inheriting unrelated repository secrets', () => {
  assert.match(ci, /^  security:\n    name: Security\n    uses: \.\/\.github\/workflows\/security\.yml$/m);
  assert.doesNotMatch(ci, /secrets:\s*inherit/);
  assert.match(security, /^  workflow_call:\s*$/m);
  assert.match(security, /GITHUB_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
  assert.match(security, /permissions:\n  contents: read/);
});

test('the single required aggregate delegates every dependency result to the executable gate', () => {
  const required = ci.slice(ci.indexOf('  required:\n'));
  assert.match(required, /needs: \[[^\]]*\bsecurity\b[^\]]*\]/);
  assert.match(required, /SECURITY_RESULT: \$\{\{ needs\.security\.result \}\}/);
  assert.match(required, /uses: actions\/checkout@v7/);
  assert.match(required, /uses: actions\/setup-node@v7/);
  assert.match(required, /node-version: 22/);
  assert.match(required, /node scripts\/require-successful-jobs\.mjs/);
  for (const name of ['core-tests', 'frontend-e2e', 'frontend-build', 'gateway-e2e', 'security']) {
    assert.match(required, new RegExp(`"${name}=\\$[A-Z0-9_]+_RESULT"`));
  }
});

test('the release gate accepts only an all-success dependency set', () => {
  const result = spawnSync(process.execPath, [gate, ...successfulResults], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /all 5 required jobs succeeded/i);
});

test('fault injection: a failed Security dependency makes the release gate fail', () => {
  const results = successfulResults.map(value => value.startsWith('security=') ? 'security=failure' : value);
  const result = spawnSync(process.execPath, [gate, ...results], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /security=failure/);
});

test('fault injection: a skipped dependency also blocks release', () => {
  const results = successfulResults.map(value => value.startsWith('security=') ? 'security=skipped' : value);
  const result = spawnSync(process.execPath, [gate, ...results], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /security=skipped/);
});

test('missing dependency results fail closed', () => {
  const missing = spawnSync(process.execPath, [gate, 'security=success'], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /missing: core-tests/);
});

test('malformed dependency results fail closed', () => {
  const malformed = spawnSync(process.execPath, [gate, 'security='], { encoding: 'utf8' });
  assert.equal(malformed.status, 2);
  assert.match(malformed.stderr, /expected name=result/i);
});

test('duplicate and unexpected dependency names fail closed', () => {
  const duplicate = spawnSync(process.execPath, [gate, ...successfulResults, 'security=success'], { encoding: 'utf8' });
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stderr, /duplicate result for security/i);

  const unexpected = spawnSync(process.execPath, [gate, ...successfulResults, 'other=success'], { encoding: 'utf8' });
  assert.equal(unexpected.status, 2);
  assert.match(unexpected.stderr, /unexpected: other/i);
});
