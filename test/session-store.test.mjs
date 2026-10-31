import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore } from '../src/agent/session-store.mjs';

test('session store rejects invalid capacity and expiry configuration', () => {
  assert.throws(() => createSessionStore({ maxSessions: 0 }), /maxSessions/);
  assert.throws(() => createSessionStore({ ttlMs: -1 }), /ttlMs/);
  assert.throws(() => createSessionStore({ now: 1 }), /now/);
});

test('expired sessions are removed on access and insertion', () => {
  let now = 100;
  const sessions = createSessionStore({ ttlMs: 10, maxSessions: 2, now: () => now });
  sessions.set('expired', 105);
  now = 105;
  assert.equal(sessions.get('expired'), undefined);
  assert.equal(sessions.size, 0);

  sessions.set('current', 120);
  sessions.set('next', 130);
  assert.equal(sessions.size, 2);
  now = 121;
  sessions.set('new', 140);
  assert.equal(sessions.get('current'), undefined);
  assert.equal(sessions.get('next'), 130);
  assert.equal(sessions.get('new'), 140);
  assert.equal(sessions.size, 2);
});

test('capacity is bounded and the least recently used live session is evicted', () => {
  let now = 1_000;
  const sessions = createSessionStore({ ttlMs: 100, maxSessions: 2, now: () => now });
  sessions.set('a', 1_100);
  sessions.set('b', 1_100);

  // Touch "a", making "b" the least recently used entry.
  assert.equal(sessions.get('a'), 1_100);
  sessions.set('c', 1_200);

  assert.equal(sessions.size, 2);
  assert.equal(sessions.get('b'), undefined);
  assert.equal(sessions.get('a'), 1_100);
  assert.equal(sessions.get('c'), 1_200);
});

test('setting an existing session refreshes its LRU position without growing the store', () => {
  let now = 10;
  const sessions = createSessionStore({ ttlMs: 100, maxSessions: 2, now: () => now });
  sessions.set('a', 110);
  sessions.set('b', 110);
  sessions.set('a', 120);
  sessions.set('c', 130);

  assert.equal(sessions.size, 2);
  assert.equal(sessions.get('a'), 120);
  assert.equal(sessions.get('c'), 130);
  assert.equal(sessions.get('b'), undefined);
});

test('session identifiers and expiry timestamps are validated', () => {
  let now = 10;
  const sessions = createSessionStore({ now: () => now });
  assert.throws(() => sessions.set('', 20), /session id/);
  assert.throws(() => sessions.set('bad', Number.NaN), /expiry/);
  assert.throws(() => sessions.set('past', 10), /expiry/);
});
