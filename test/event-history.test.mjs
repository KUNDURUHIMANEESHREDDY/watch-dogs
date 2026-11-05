import test from 'node:test';
import fs, { renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

test('atomic replacements leave only the canonical history file', async t => {
  const path = await withHistory(t);
  const first = event('000000000000000000000041');
  const second = event('000000000000000000000042');

  assert.equal(persistEventHistory(path, [first]), true);
  assert.equal(persistEventHistory(path, [second]), true);
  assert.deepEqual(await readdir(dirname(path)), ['finding-events.jsonl']);
  assert.deepEqual(loadEventHistory(path).events, [second]);
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

test('event history does not block when a regular file is replaced with a FIFO before open', async t => {
  if (process.platform === 'win32') {
    t.skip('POSIX FIFO semantics are not available on Windows');
    return;
  }

  const path = await withHistory(t);
  const originalPath = path + '.original';
  const fifoPath = path + '.fifo';
  await writeFile(path, 'regular placeholder\\n', 'utf8');

  try {
    execFileSync('mkfifo', [fifoPath], { stdio: 'ignore' });
  } catch (error) {
    if (['ENOENT', 'EACCES', 'EPERM'].includes(error?.code)) {
      t.skip('mkfifo is unavailable on this runner');
      return;
    }
    throw error;
  }

  let swapped = false;
  const originalOpenSync = fs.openSync;
  const openMock = t.mock.method(fs, 'openSync', (candidatePath, flags, mode) => {
    if (String(candidatePath) === path && !swapped) {
      swapped = true;
      renameSync(path, originalPath);
      renameSync(fifoPath, path);
      assert.equal(typeof flags, 'number');
      assert.notEqual(flags & fs.constants.O_NONBLOCK, 0, 'event-history reads must be nonblocking');
    }
    return originalOpenSync(candidatePath, flags, mode);
  });

  syncBuiltinESMExports();
  try {
    assert.deepEqual(loadEventHistory(path), { events: [], healthy: false });
    assert.equal(swapped, true, 'the test must replace the path after its initial lstat');
  } finally {
    openMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('event history bounds reads when the file grows after descriptor stat', async t => {
  const path = await withHistory(t);
  const options = { maxEvents: 4, maxBytes: 512, maxEventBytes: 256 };
  await writeFile(path, JSON.stringify(event('000000000000000000000061')) + '\n', 'utf8');

  let appended = false;
  let maxRequested = 0;
  const originalReadSync = fs.readSync;
  const readMock = t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    if (!appended) {
      appended = true;
      writeFileSync(path, 'x'.repeat(options.maxBytes * 4), { flag: 'a' });
    }
    maxRequested = Math.max(maxRequested, length);
    return originalReadSync(fd, buffer, offset, length, position);
  });

  syncBuiltinESMExports();
  try {
    const loaded = loadEventHistory(path, options);
    assert.equal(appended, true, 'the file must grow after fstat and before the first read');
    assert.equal(maxRequested, options.maxBytes + 1, 'the reader must request no more than the configured cap plus one byte');
    assert.equal(loaded.healthy, false, 'growth beyond the configured byte cap must fail closed');
    assert.deepEqual(loaded.events, []);
  } finally {
    readMock.mock.restore();
    syncBuiltinESMExports();
  }
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


test('directory preparation failures return unavailable without escaping persistence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wd-event-history-blocked-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const blockedParent = join(directory, 'not-a-directory');
  await writeFile(blockedParent, 'preserve this file', 'utf8');
  const path = join(blockedParent, 'finding-events.jsonl');

  assert.equal(persistEventHistory(path, [event('000000000000000000000051')]), false);
  assert.equal(await readFile(blockedParent, 'utf8'), 'preserve this file');
});
