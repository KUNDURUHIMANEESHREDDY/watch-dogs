import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCookies } from '../src/agent/cookies.mjs';

test('cookie values are decoded and retain equals signs', () => {
  const cookies = parseCookies('theme=dark; wd_session=abc%2Bdef%3Dghi; empty');
  assert.equal(cookies.theme, 'dark');
  assert.equal(cookies.wd_session, 'abc+def=ghi');
  assert.equal(cookies.empty, '');
});

test('malformed percent-encoding becomes an invalid empty value instead of throwing', () => {
  assert.doesNotThrow(() => parseCookies('wd_session=%ZZ; other=%E0%A4%A'));
  const cookies = parseCookies('wd_session=%ZZ; other=%E0%A4%A');
  assert.equal(cookies.wd_session, '');
  assert.equal(cookies.other, '');
});

test('cookie names cannot mutate the parser result prototype', () => {
  const cookies = parseCookies('__proto__=attacker; wd_session=valid');
  assert.equal(Object.getPrototypeOf(cookies), null);
  assert.equal(cookies.wd_session, 'valid');
});
