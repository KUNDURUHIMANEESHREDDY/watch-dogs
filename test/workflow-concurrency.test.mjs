import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

for (const workflow of ['ci.yml', 'security.yml']) {
  test(`${workflow} concurrency separates event types and fork repositories`, () => {
    const source = readFileSync(resolve(ROOT, '.github', 'workflows', workflow), 'utf8');
    const group = source.split(/\r?\n/).find((line) => line.trim().startsWith('group:'));
    assert.ok(group, `${workflow} must define a concurrency group`);
    assert.ok(group.includes('github.event_name'), 'push and pull_request runs must not cancel each other');
    assert.ok(group.includes('github.event.pull_request.head.repo.full_name'), 'forks with the same branch name must remain isolated');
  });
}
