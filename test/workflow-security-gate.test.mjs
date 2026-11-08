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

/**
 * Extract one top-level job block from a GitHub Actions workflow.
 *
 * @param {string} source - Complete workflow YAML source.
 * @param {string} name - Job identifier to locate.
 * @returns {string} The selected job block.
 */
function workflowJob(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex(line => line === `  ${name}:`);
  assert.notEqual(start, -1, `workflow must declare the ${name} job`);
  const next = lines.findIndex((line, index) => index > start && /^  [a-z0-9-]+:\s*$/.test(line));
  return lines.slice(start, next === -1 ? undefined : next).join('\n');
}

/**
 * Extract one named step block from a workflow job.
 *
 * @param {string} job - Complete job YAML block.
 * @param {string} name - Human-readable step name to locate.
 * @returns {string} The selected step block.
 */
function workflowStep(job, name) {
  const lines = job.split('\n');
  const marker = `      - name: ${name}`;
  const start = lines.findIndex(line => line === marker);
  assert.notEqual(start, -1, `job must declare the ${name} step`);
  const next = lines.findIndex((line, index) => index > start && /^      - name:/.test(line));
  return lines.slice(start, next === -1 ? undefined : next).join('\n');
}

test('security workflow is reusable by the CI release gate', () => {
  assert.match(security, /^  workflow_call:\s*$/m);
});

test('CI invokes the security workflow without inheriting unrelated repository secrets', () => {
  const securityJob = workflowJob(ci, 'security').trimEnd();
  assert.equal(securityJob, [
    '  security:',
    '    name: Security',
    '    uses: ./.github/workflows/security.yml',
    '    permissions:',
    '      actions: read',
    '      contents: read',
    '      security-events: write',
  ].join('\n'));
  assert.doesNotMatch(securityJob, /^    secrets:\s*inherit\s*$/m);
  assert.match(security, /^  workflow_call:\s*$/m);
  const secretScan = workflowJob(security, 'secret-scan');
  assert.match(secretScan, /fetch-depth: 0/);
  assert.match(secretScan, /persist-credentials: false/);
  assert.match(secretScan, /ghcr\.io\/gitleaks\/gitleaks:v8\.30\.1@sha256:b109bc5f8f76a38196a3e413704fc5b9e3c32360bce4e4b603bd6f45b3721dbb/);
  assert.match(secretScan, /docker run --rm --network none --read-only/);
  assert.match(secretScan, /detect --source \/repo --log-opts=\"--all\" --redact --no-banner --exit-code 1/);
  assert.doesNotMatch(secretScan, /GITHUB_TOKEN|gitleaks-action|setup-go/);
  assert.match(security, /^  codeql:\s*$/m);
  const securityRequired = workflowJob(security, 'security-required');
  assert.match(securityRequired, /GITLEAKS_RESULT:/);
  assert.doesNotMatch(securityRequired, /SECRET_SCAN_RESULT/);
  assert.match(security, /^  security-required:\s*$/m);
  assert.match(security, /permissions:\n  contents: read/);
});

test('the single required aggregate maps every dependency to its matching result', () => {
  const required = workflowJob(ci, 'required');
  const expected = [
    ['core-tests', 'CORE_TESTS_RESULT'],
    ['frontend-e2e', 'FRONTEND_E2E_RESULT'],
    ['frontend-build', 'FRONTEND_BUILD_RESULT'],
    ['gateway-e2e', 'GATEWAY_E2E_RESULT'],
    ['security', 'SECURITY_RESULT'],
  ];

  const needsMatch = required.match(/^    needs:\s*\[([^\]]+)\]/m);
  assert.ok(needsMatch, 'required aggregate must declare its dependency list');
  const dependencies = needsMatch[1].split(',').map(name => name.trim()).sort();
  assert.deepEqual(dependencies, expected.map(([name]) => name).sort());

  const gateStep = workflowStep(required, 'Enforce all release checks');
  const envStart = gateStep.indexOf('\n        env:\n');
  const runStart = gateStep.indexOf('\n        run: |\n');
  assert.ok(envStart >= 0 && runStart > envStart, 'the gate step must define its own env block before its run block');
  const envBlock = gateStep.slice(envStart, runStart);
  const envMappings = [...envBlock.matchAll(/^          ([A-Z0-9_]+_RESULT):\s*\$\{\{\s*needs\.([a-z0-9-]+)\.result\s*\}\}$/gm)]
    .map(([, variable, name]) => [name, variable]);
  assert.deepEqual(envMappings, expected, 'the gate step must map each result variable to its matching required dependency');

  const slash = String.fromCharCode(92);
  const expectedRun = [
    '        run: |',
    '          node scripts/require-successful-jobs.mjs ' + slash,
    '            "core-tests=$CORE_TESTS_RESULT" ' + slash,
    '            "frontend-e2e=$FRONTEND_E2E_RESULT" ' + slash,
    '            "frontend-build=$FRONTEND_BUILD_RESULT" ' + slash,
    '            "gateway-e2e=$GATEWAY_E2E_RESULT" ' + slash,
    '            "security=$SECURITY_RESULT"',
  ].join('\n');
  const actualRun = gateStep.slice(runStart + 1).trimEnd();
  assert.equal(actualRun, expectedRun, 'the complete gate step command must exactly match the expected invocation');

  assert.match(required, /^    if: always\(\)$/m);
  assert.match(required, /uses: actions\/checkout@v7/);
  assert.match(required, /uses: actions\/setup-node@v7/);
  assert.match(required, /node-version: 22/);
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
