import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ci = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
const security = readFileSync(resolve(ROOT, '.github/workflows/security.yml'), 'utf8');

test('security workflow is reusable by the CI release gate', () => {
  assert.match(security, /^  workflow_call:\s*$/m);
});

test('CI invokes the security workflow and passes repository secrets explicitly', () => {
  assert.match(ci, /^  security:\n    name: Security\n    uses: \.\/\.github\/workflows\/security\.yml\n    secrets: inherit$/m);
});

test('the single required aggregate fails closed on security workflow failure', () => {
  const required = ci.slice(ci.indexOf('  required:\n'));
  assert.match(required, /needs: \[[^\]]*\bsecurity\b[^\]]*\]/);
  assert.match(required, /SECURITY_RESULT: \$\{\{ needs\.security\.result \}\}/);
  assert.match(required, /test "\$SECURITY_RESULT" = "success"/);
  assert.match(required, /set -euo pipefail/);
});
