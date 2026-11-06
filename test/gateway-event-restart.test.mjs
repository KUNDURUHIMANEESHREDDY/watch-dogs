import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const gatewayPath = fileURLToPath(new URL('../src/agent/web-gateway.mjs', import.meta.url));

async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function readSseUntil(reader, predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  const decoder = new TextDecoder();
  let text = '';
  while (Date.now() < deadline) {
    let timer;
    const remaining = Math.max(1, deadline - Date.now());
    const chunk = await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), remaining);
      })
    ]).finally(() => clearTimeout(timer));
    if (chunk.done) throw new Error('SSE stream closed before the expected event');
    text += decoder.decode(chunk.value, { stream: true });
    if (predicate(text)) return text;
  }
  throw new Error(message);
}

function startGateway(cwd, port) {
  const child = spawn(process.execPath, [gatewayPath], {
    cwd,
    env: { ...process.env, WD_WEB_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  return {
    child,
    get stdout() { return stdout; },
    get stderr() { return stderr; }
  };
}

async function pairingCode(handle) {
  const match = await waitUntil(
    () => /Pairing code \(enter in browser; never share\): ([A-Za-z0-9_-]+)/.exec(handle.stdout),
    7000,
    'gateway did not print a pairing code: ' + handle.stderr.slice(-2000)
  );
  return match[1];
}

async function stopGateway(handle) {
  if (!handle || (handle.child.exitCode !== null && handle.child.signalCode !== null)) return;
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  handle.child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => handle.child.once('exit', resolve)),
    new Promise(resolve => setTimeout(() => {
      handle.child.kill('SIGKILL');
      resolve();
    }, 5000))
  ]);
}

async function reservePort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve, reject) => {
    reservation.close(error => error ? reject(error) : resolve());
  });
  return port;
}

async function createSession(origin, code) {
  const response = await fetch(origin + '/api/session', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ pairingCode: code })
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'gateway should issue a new HttpOnly session');
  return cookie;
}

function finding(signature, ruleId, title, at) {
  return {
    signature,
    ruleId,
    title,
    severity: 'medium',
    confidence: 'high',
    evidence: 'persisted restart replay evidence',
    at
  };
}

function extractEventId(text, ruleId) {
  for (const match of text.matchAll(/id: ([a-f0-9]{24})\nevent: finding\ndata: ([^\n]+)\n\n/g)) {
    const envelope = JSON.parse(match[2]);
    if (envelope.data?.ruleId === ruleId) return match[1];
  }
  return null;
}

test('SSE Last-Event-ID replays a persisted finding after the gateway process restarts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wd-durable-event-restart-'));
  const dataDir = join(root, 'data');
  await mkdir(join(root, '.watchdog'), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"wd-durable-event-restart-test"}\n');
  await writeFile(join(root, '.watchdog', 'config.json'), JSON.stringify({ paths: { data: dataDir } }));
  await writeFile(join(dataDir, 'findings.jsonl'), '');

  let gateway;
  let reader;
  t.after(async () => {
    try { await reader?.cancel(); } catch {}
    await stopGateway(gateway);
    await rm(root, { recursive: true, force: true });
  });

  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const findingsPath = join(dataDir, 'findings.jsonl');

  gateway = startGateway(root, port);
  const firstCookie = await createSession(origin, await pairingCode(gateway));
  const firstResponse = await fetch(origin + '/api/events', {
    headers: { origin, cookie: firstCookie }
  });
  assert.equal(firstResponse.status, 200);
  reader = firstResponse.body.getReader();
  await readSseUntil(reader, text => text.includes('event: connected'), 5000, 'first gateway SSE connection missing');

  const first = finding('restart-first-signature', 'TEST_RESTART_FIRST', 'First restart replay finding', new Date().toISOString());
  await writeFile(findingsPath, JSON.stringify(first) + '\n', 'utf8');
  const firstText = await readSseUntil(reader, text => text.includes(first.ruleId), 6000, 'first persisted finding event was not delivered');
  const firstEventId = extractEventId(firstText, first.ruleId);
  assert.ok(firstEventId, 'first finding must expose a standard SSE cursor');

  const second = finding('restart-second-signature', 'TEST_RESTART_SECOND', 'Second restart replay finding', new Date(Date.now() + 1).toISOString());
  await writeFile(findingsPath, JSON.stringify(first) + '\n' + JSON.stringify(second) + '\n', 'utf8');
  const secondText = await readSseUntil(reader, text => text.includes(second.ruleId), 6000, 'second persisted finding event was not delivered');
  const secondEventId = extractEventId(secondText, second.ruleId);
  assert.ok(secondEventId, 'second finding must expose a standard SSE cursor');
  await reader.cancel();
  reader = undefined;

  // The process owns the session store, but the bounded cursor history is on disk.
  await stopGateway(gateway);
  gateway = undefined;

  const restarted = startGateway(root, port);
  gateway = restarted;
  const secondCookie = await createSession(origin, await pairingCode(restarted));
  const replayResponse = await fetch(origin + '/api/events', {
    headers: { origin, cookie: secondCookie, 'last-event-id': firstEventId }
  });
  assert.equal(replayResponse.status, 200);
  reader = replayResponse.body.getReader();

  const replayText = await readSseUntil(
    reader,
    text => text.includes(second.ruleId),
    6000,
    'persisted finding after Last-Event-ID was not replayed after process restart: ' + restarted.stderr.slice(-2000)
  );
  assert.match(replayText, /event: connected/);
  assert.match(replayText, /event: finding/);
  assert.ok(replayText.includes(second.ruleId));
  assert.ok(!replayText.includes(first.ruleId), 'the acknowledged event must not be replayed again');
  assert.notEqual(firstEventId, secondEventId);
});
