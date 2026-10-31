import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonObject } from '../src/agent/json-body.mjs';

test('preserves a UTF-8 code point split across request chunks', () => {
  const expected = { pairingCode: 'not-valid', note: 'split \u{1F9EA} code point' };
  const bytes = Buffer.from(JSON.stringify(expected), 'utf8');
  const marker = Buffer.from('\u{1F9EA}', 'utf8');
  const offset = bytes.indexOf(marker);
  assert.ok(offset >= 0);

  const chunks = [
    bytes.subarray(0, offset + 1),
    bytes.subarray(offset + 1, offset + 3),
    bytes.subarray(offset + 3),
  ];
  assert.deepEqual(parseJsonObject(chunks), expected);
});

test('rejects malformed UTF-8 instead of silently replacing invalid bytes', () => {
  const bytes = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
  assert.throws(() => parseJsonObject([bytes]), { code: 'ERR_INVALID_JSON_UTF8' });
});

test('rejects valid JSON values that do not satisfy the object request contract', () => {
  for (const value of ['null', '[]', 'false', '42', '"text"']) {
    assert.throws(
      () => parseJsonObject([Buffer.from(value, 'utf8')]),
      { code: 'ERR_JSON_BODY_TYPE' },
      value,
    );
  }
});

test('treats an empty request body as an empty object', () => {
  assert.deepEqual(parseJsonObject([]), {});
});
