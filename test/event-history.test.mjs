import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEventHistory, persistEventHistory } from '../src/agent/event-history.mjs';

function event(id, type = 'finding') {
  const envelope = {
    protocol: 'watchdogs.local.v1',
    event_id: id,
    type,
    timestamp: '2026-11-01T00:00:00.000Z',
    data: { ruleId: 'TEST_EVENT', evidence: 'sanitized' }
  };
  return {
    id,
    payload: `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(envelope)}\n\n`
  };
}

async function withHistory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'wd-event-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'finding-events.jsonl');
}

test('bounded SSE cursor history survives a gateway-process reinitialization', async t => {
  const path = await withHistory(t);
  const first = event('000000000000000000000001');
  const second = event('000000000000000000000002');

  assert.deepEqual(loadEventHistory(path), { events: [], healthy: true });
  assert.equal(persistEventHistory(path, [first, second]), true);

  // A new process calls loadEventHistory against the same durable file.
  const restarted = loadEventHistory(path);
  assert.equal(restarted.healthy, true);
  assert.deepEqual(restarted.events, [first, second]);
  assert.equal(restarted.events[0].id, first.id);
  assert.match(restarted.events[1].payload, /TEST_EVENT/);
});

test('history retention and serialized bytes remain bounded', async t => {
  const path = await withHistory(t);
  const options = { maxEvents: 2, maxBytes: 4096, maxEventBytes: 1024 };
  const entries = [
    event('000000000000000000000011'),
    event('000000000000000000000012'),
    event('000000000000000000000013')
  ];

  assert.equal(persistEventHistory(path, entries, options), true);
  const loaded = loadEventHistory(path, options);
  assert.equal(loaded.healthy, true);
  assert.deepEqual(loaded.events, entries.slice(-2));
  assert.ok(Buffer.byteLength(await readFile(path), 'utf8') <= options.maxBytes);
});

test('corrupt history fails closed and requests a snapshot reset', async t => {
  const path = await withHistory(t);
  await writeFile(path, '{"id":"broken","payload":"not-an-sse-event"}\n', 'utf8');

  const loaded = loadEventHistory(path);
  assert.equal(loaded.healthy, false);
  assert.deepEqual(loaded.events, []);
});

test('invalid or oversized event payloads are never persisted', async t => {
  const path = await withHistory(t);
  const valid = event('000000000000000000000021');
  const invalid = { id: '000000000000000000000022', payload: 'event: finding\ndata: {}\n\n' };

  assert.equal(persistEventHistory(path, [valid, invalid]), false);
  assert.equal(loadEventHistory(path).events.length, 0);
  assert.equal(persistEventHistory(path, [event('000000000000000000000023')], {
    maxEvents: 1,
    maxBytes: 128,
    maxEventBytes: 64
  }), false);
});

test('invalid retention configuration is rejected', () => {
  assert.throws(() => loadEventHistory('unused', { maxEvents: 0 }), /maxEvents/);
  assert.throws(() => persistEventHistory('unused', [], { maxBytes: 0 }), /maxBytes/);
});

test('symlinked history files fail closed', async t => {
  const path = await withHistory(t);
  const target = path + '.target';
  await writeFile(target, JSON.stringify(event('000000000000000000000031')) + '\\n', 'utf8');
  try {
    await symlink(target, path);
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error?.code)) {
      t.skip('symlink creation is not permitted on this runner');
      return;
    }
    throw error;
  }

  const loaded = loadEventHistory(path);
  assert.equal(loaded.healthy, false);
  assert.deepEqual(loaded.events, []);
});
