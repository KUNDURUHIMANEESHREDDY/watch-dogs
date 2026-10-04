/**
 * No secret-shaped string may exist in any file in this repository.
 *
 * The redaction tests need input the redactor will match, which means input shaped
 * exactly like a credential. An audit flagged the repository for containing such
 * strings and was right to: an AWS-shaped example key and a sequential GitHub token
 * string, both obviously synthetic, but "obviously synthetic" is a judgement every
 * scanner has to make and some get wrong. A security-focused repository should pass
 * a secret scan without an argument.
 *
 * The first version of this file quoted one of those values in the paragraph above,
 * and the guard failed on itself. That is the whole argument for having the guard: it
 * does not matter that the value is fake, only that it is contiguous.
 *
 * They are now assembled at runtime in `test/helpers/secret-fixtures.mjs`, so no
 * contiguous match exists anywhere. This test stops that regressing -- someone adding
 * a fixture with a literal is the obvious way to break it, and the obvious way is the
 * one that happens.
 *
 * The shapes are built by concatenation in that helper for the same reason, so this
 * file does not reintroduce on the way to forbidding it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';
import { SECRET_SHAPES, awsKeyId, githubToken } from './helpers/secret-fixtures.mjs';
import { redact } from '../src/capture/stream.mjs';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['.git', 'node_modules', '.watchdog', '.idea', '.vscode', 'coverage']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.ps1', '.vbs', '.txt', '.yml', '.yaml']);

/** Every text file in the repository, as [repoRelativePath, contents]. */
function* textFiles(dir = ROOT) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* textFiles(full);
    else if (entry.isFile() && TEXT_EXT.has(extname(entry.name).toLowerCase())) {
      yield [relative(ROOT, full).split(sep).join('/'), readFileSync(full, 'utf8')];
    }
  }
}

test('no file in the repository contains a secret-shaped string', () => {
  const found = [];
  let scanned = 0;

  for (const [path, contents] of textFiles()) {
    scanned++;
    for (const [label, pattern] of SECRET_SHAPES) {
      pattern.lastIndex = 0;
      const hit = pattern.exec(contents);
      // Position, not the value: echoing the match back into a failure message would
      // put the string in the transcript, which is the thing being prevented.
      if (hit) found.push(`${path}: ${label} at offset ${hit.index}`);
    }
  }

  assert.ok(scanned > 50, `only ${scanned} files were scanned, so this test is not looking at the repository`);
  assert.deepEqual(found, [], `secret-shaped strings found in source:\n  ${found.join('\n  ')}`);
});

test('the shapes this test forbids are the shapes redaction actually catches', () => {
  // Guards against the two drifting apart. If the redactor stopped matching while only
  // the scanner kept looking, the repository would pass its own secret scan while
  // leaking, which is the worst outcome available.
  assert.match(redact(`key ${awsKeyId}`), /<redacted:aws-key>/);
  assert.match(redact(`token ${githubToken}`), /<redacted:github-token>/);
});

test('the fixtures are assembled, not written down', () => {
  // The whole mitigation rests on there being no contiguous literal to find. If
  // someone simplifies the helper back to one, the first test fails for a reason that
  // reads like a false positive.
  const src = readFileSync(join(ROOT, 'test', 'helpers', 'secret-fixtures.mjs'), 'utf8');
  for (const [label, pattern] of SECRET_SHAPES) {
    pattern.lastIndex = 0;
    assert.equal(pattern.test(src), false, `${label} appears literally in the fixture helper`);
  }
});

test('the scan patterns match the shapes they claim to forbid', () => {
  // Closes the loop, and it exists because of a specific failure.
  //
  // The first version of the helper built these patterns by concatenation and split
  // one inside a character class, producing [0-9AZ] rather than [0-9A-Z]. That
  // pattern matched nothing, so this test passed against a repository still full of
  // the exact strings it existed to forbid. A guard whose own patterns are untested
  // is a guard that reports success for as long as nothing needs catching -- which is
  // precisely when it stops being checked.
  //
  // The values come from the same helper the patterns are built in, so this asserts
  // the patterns are capable rather than restating what they are.
  const byLabel = new Map(SECRET_SHAPES);
  const cases = [
    ['aws access key id', awsKeyId],
    ['github token', githubToken],
  ];

  for (const [label, value] of cases) {
    const pattern = byLabel.get(label);
    assert.ok(pattern, `no scan pattern exists for ${label}`);
    pattern.lastIndex = 0;
    assert.equal(pattern.test(value), true, `the ${label} pattern does not match a value of that shape`);
  }
});

test('the fixtures are still shaped like the credentials the redactor expects', () => {
  // A weaker guard than the one above, and the one that would catch a well-meaning
  // edit to the helper: if the fragments stopped assembling into something the
  // redactor matches, the redaction tests would quietly stop testing redaction.
  assert.match(awsKeyId, /^AKIA[A-Z0-9]{16}$/);
  assert.match(githubToken, /^ghp_[A-Za-z0-9]{16,}$/);
});