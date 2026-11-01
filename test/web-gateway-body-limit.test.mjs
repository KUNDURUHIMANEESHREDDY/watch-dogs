import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readJsonBody } from '../src/agent/request-body.mjs';

class FakeRequest extends EventEmitter {
  constructor(headers = {}) {
    super();
    this.headers = headers;
    this.paused = false;
    this.destroyed = false;
  }

  pause() {
    this.paused = true;
    return this;
  }

  destroy() {
    this.destroyed = true;
    return this;
  }
}

test('reads chunked JSON objects and accepts an empty body as an empty object', async () => {
  const request = new FakeRequest();
  const result = readJsonBody(request, 32);
  request.emit('data', Buffer.from('{"pairing'));
  request.emit('data', Buffer.from('Code":"abc"}'));
  request.emit('end');
  assert.deepEqual(await result, { pairingCode: 'abc' });

  const empty = new FakeRequest();
  const emptyResult = readJsonBody(empty, 32);
  empty.emit('end');
  assert.deepEqual(await emptyResult, {});
});

test('rejects a declared oversized body before buffering it', async () => {
  const request = new FakeRequest({ 'content-length': '9000' });
  await assert.rejects(readJsonBody(request, 8192), (error) => {
    assert.equal(error.status, 413);
    assert.equal(error.message, 'request body too large');
    return true;
  });
  assert.equal(request.paused, true);
  assert.equal(request.destroyed, false, 'the HTTP handler must be able to send its 413 response first');
});

test('rejects streamed bytes before appending the chunk that crosses the limit', async () => {
  const request = new FakeRequest();
  const result = readJsonBody(request, 8);
  request.emit('data', Buffer.from('12345678'));
  request.emit('data', Buffer.from('9'));
  await assert.rejects(result, (error) => error.status === 413);
  assert.equal(request.paused, true);
  assert.equal(request.destroyed, false);
});

test('accepts a body exactly at the byte limit', async () => {
  const request = new FakeRequest();
  const result = readJsonBody(request, 7);
  request.emit('data', Buffer.from('{"a":1}'));
  request.emit('end');
  assert.deepEqual(await result, { a: 1 });
});

test('rejects malformed and non-object JSON with HTTP 400 semantics', async () => {
  const malformed = new FakeRequest();
  const malformedResult = readJsonBody(malformed, 32);
  malformed.emit('data', Buffer.from('{'));
  malformed.emit('end');
  await assert.rejects(malformedResult, (error) => error.status === 400 && error.message === 'invalid JSON');

  for (const value of ['null', '[]', '"pairing"']) {
    const request = new FakeRequest();
    const result = readJsonBody(request, 32);
    request.emit('data', Buffer.from(value));
    request.emit('end');
    await assert.rejects(result, (error) => error.status === 400 && error.message === 'JSON body must be an object');
  }
});

test('rejects invalid maximum sizes instead of silently disabling the bound', () => {
  const request = new FakeRequest();
  assert.throws(() => readJsonBody(request, 0), /positive safe integer/);
  assert.throws(() => readJsonBody(request, Number.MAX_SAFE_INTEGER + 1), /positive safe integer/);
});
