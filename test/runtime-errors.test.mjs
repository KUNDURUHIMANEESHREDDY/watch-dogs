/**
 * Runtime-error rules and the residual-triage shape test.
 *
 * Both came out of the sandbox: a plain `ReferenceError: count is not defined`
 * produced no finding at all, which also revealed that the advisor only ever
 * saw problems the rules already understood.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/analyze/rules.mjs';
import { looksLikeError } from '../src/core/watcher.mjs';

test('detects common runtime errors', () => {
  const cases = [
    ['ReferenceError: count is not defined', 'js-referenceerror'],
    ['TypeError: leftPad is not a function', 'js-typeerror'],
    ['SyntaxError: Unexpected token }', 'js-syntaxerror'],
    ["NameError: name 'foo' is not defined", 'python-nameerror'],
    ["KeyError: 'username'", 'python-keyerror'],
    ["AttributeError: 'NoneType' object has no attribute 'get'", 'python-attributeerror'],
    ['NoMethodError: undefined method missing', 'ruby-nomethoderror'],
    ['    at com.example.Service.run(Service.java:42)', 'java-stacktrace'],
    ['panic: runtime error: index out of range', 'go-panic'],
  ];
  for (const [line, rule] of cases) {
    const ids = evaluate(line).map((f) => f.ruleId);
    assert.ok(ids.includes(rule), `expected ${rule} for "${line}", got ${JSON.stringify(ids)}`);
  }
});

test('runtime rules do not fire on ordinary chatter', () => {
  for (const line of [
    '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    'at 2026-09-29 10:00:00 INFO  started',
    'added 412 packages in 9s',
  ]) {
    assert.deepEqual(evaluate(line), [], `false positive on: ${line}`);
  }
});

test('looksLikeError separates failures from ordinary output', () => {
  for (const line of [
    'Error: something broke',
    'FATAL: cannot open database',
    'npm ERR! code ELIFECYCLE',
    'cat: /x: Permission denied',
    'Traceback (most recent call last):',
    'src/a.ts(1,1): error TS1: bad',
  ]) {
    assert.ok(looksLikeError(line), `should look like an error: ${line}`);
  }
  for (const line of [
    'added 412 packages in 9s',
    'Everything up-to-date',
    '42 passing (1s)',
    'hello from shell',
    'On branch main',
    'Build completed with 0 errors',
    '0 errors, 0 warnings',
    'build succeeded',
    'nothing to commit, working tree clean',
    'all tests passed',
  ]) {
    assert.ok(!looksLikeError(line), `should not look like an error: ${line}`);
  }
});

test('a rule-less runtime error still yields a finding', () => {
  // The concrete gap the sandbox exposed.
  const f = evaluate('ReferenceError: count is not defined');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'critical');
  assert.match(f[0].explain, /does not exist in scope/);
});
