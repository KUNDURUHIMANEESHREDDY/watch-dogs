import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import vm from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appSource = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const htmlSource = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
const contractSource = await readFile(new URL('../web/contracts.d.ts', import.meta.url), 'utf8');

test('browser application parses as a standalone script', () => {
  assert.doesNotThrow(() => new vm.Script(appSource, { filename: 'web/app.js' }));
});

test('the shell uses local assets and exposes accessible connection pairing', () => {
  assert.match(htmlSource, /href="\/styles\.css"/);
  assert.match(htmlSource, /src="\/app\.js"/);
  assert.match(htmlSource, /id="pair-code"[^>]*type="password"/);
  assert.match(htmlSource, /aria-label="Primary navigation"/);
  assert.match(htmlSource, /id="activity-list"[^>]*aria-live="polite"/);
});

test('runtime contract names the protocol and explicit optional bridges', () => {
  assert.match(contractSource, /WatchDogsProtocol = 'watchdogs\.local\.v1'/);
  assert.match(contractSource, /findingsSnapshot: boolean/);
  assert.match(contractSource, /journalSnapshot: boolean/);
  assert.match(contractSource, /liveFindingEvents: boolean/);
  assert.match(contractSource, /repairExecution: boolean/);
  assert.match(contractSource, /resources\?: ObservedResource\[\]/);
  assert.match(contractSource, /No browser-triggered repair endpoint is operational/);
});

test('UI does not claim missing finding or repair integrations are operational', async () => {
  assert.match(appSource, /No synthetic topology/);
  assert.match(appSource, /Approval and execution controls remain disabled/);
  assert.match(appSource, /The UI will display findings only when the local watchdog has recorded real finding records/);
  assert.match(appSource, /STALE/);
  const gatewaySource = await readFile(new URL('../src/agent/web-gateway.mjs', import.meta.url), 'utf8');
  const gatewayPath = fileURLToPath(new URL('../src/agent/web-gateway.mjs', import.meta.url));
  const syntaxCheck = spawnSync(process.execPath, ['--check', gatewayPath], { encoding: 'utf8' });
  assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr || 'gateway syntax check failed');
  assert.match(gatewaySource, /findings\.jsonl/);
  assert.match(gatewaySource, /findingsSnapshot: true/);
  assert.match(gatewaySource, /journalSnapshot: true/);
  assert.match(gatewaySource, /import \{ readJournal \} from '\.\/journal-reader\.mjs'/);
  const journalReaderSource = await readFile(new URL('../src/agent/journal-reader.mjs', import.meta.url), 'utf8');
  assert.match(journalReaderSource, /export function readJournal/);
  assert.match(journalReaderSource, /MAX_JOURNAL_FILES = 200/);
  assert.match(journalReaderSource, /MAX_JOURNAL_ENTRY_BYTES = 256 \* 1024/);
  assert.match(gatewaySource, /const verifications = findings\.filter/);
  assert.match(gatewaySource, /liveFindingEvents: true/);
  assert.match(gatewaySource, /const keepalive = ': keepalive\\n\\n';/);
  assert.match(gatewaySource, /MAX_SSE_HISTORY_EVENTS = 128/);
  assert.match(gatewaySource, /last-event-id/);
  assert.match(appSource, /addEventListener\('reset'/);
  assert.match(appSource, /state\.pollTimer = setInterval\(refreshAndReconnectEvents, 10000\)/);
  assert.match(appSource, /async function refreshAndReconnectEvents\(\) \{[\s\S]*await refreshSnapshot\(\);[\s\S]*if \(state\.snapshot && !state\.lastError && !state\.eventSource\) connectEvents\(\);/);
  assert.match(appSource, /source\.addEventListener\('reset', async \(\) => \{[\s\S]*source\.close\(\);[\s\S]*await refreshAndReconnectEvents\(\);/);
  assert.match(gatewaySource, /res\.writableLength \+ Buffer\.byteLength\(keepalive, 'utf8'\) > MAX_SSE_BUFFER_BYTES/);
  assert.match(gatewaySource, /repairExecution: false/);
  assert.match(appSource, /addEventListener\('finding'/);
});

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
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), remaining); })
    ]).finally(() => clearTimeout(timer));
    if (chunk.done) throw new Error('SSE stream closed before the expected event');
    text += decoder.decode(chunk.value, { stream: true });
    if (predicate(text)) return text;
  }
  throw new Error(message);
}

test('authenticated event stream publishes newly persisted findings', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wd-live-findings-'));
  const dataDir = join(root, 'data');
  await mkdir(join(root, '.watchdog'), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"wd-gateway-events-test"}\n');
  await writeFile(join(root, '.watchdog', 'config.json'), JSON.stringify({ paths: { data: dataDir } }));
  await writeFile(join(dataDir, 'findings.jsonl'), '');

  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));

  const gatewayPath = fileURLToPath(new URL('../src/agent/web-gateway.mjs', import.meta.url));
  const child = spawn(process.execPath, [gatewayPath], {
    cwd: root,
    env: { ...process.env, WD_WEB_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let reader;
  t.after(async () => {
    try { await reader?.cancel(); } catch {}
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 4000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    await rm(root, { recursive: true, force: true });
  });

  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  const pairing = await waitUntil(
    () => /Pairing code \(enter in browser; never share\): ([A-Za-z0-9_-]+)/.exec(stdout),
    6000,
    'gateway did not print a pairing code'
  );
  const origin = `http://127.0.0.1:${port}`;
  const session = await fetch(`${origin}/api/session`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ pairingCode: pairing[1] })
  });
  assert.equal(session.status, 200);
  const cookie = session.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'gateway should issue an HttpOnly session cookie');

  const snapshotResponse = await fetch(`${origin}/api/snapshot`, { headers: { origin, cookie } });
  assert.equal(snapshotResponse.status, 200);
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshot.capabilities.liveFindingEvents, true);
  assert.equal(snapshot.capabilities.repairExecution, false);

  const response = await fetch(`${origin}/api/events`, { headers: { origin, cookie } });
  assert.equal(response.status, 200);
  reader = response.body.getReader();
  await readSseUntil(reader, text => text.includes('event: connected'), 5000, 'SSE connection event missing');

  const record = {
    signature: 'test-live-finding',
    ruleId: 'TEST_LIVE_FINDING',
    title: 'Live finding regression',
    severity: 'high',
    confidence: 'high',
    evidence: 'x'.repeat(6000),
    at: new Date().toISOString()
  };
  await writeFile(join(dataDir, 'findings.jsonl'), JSON.stringify(record) + '\n');
  const eventText = await readSseUntil(reader, text => text.includes('event: finding'), 5000, 'persisted finding event was not delivered');
  const match = /event: finding\ndata: ([^\n]+)\n\n/.exec(eventText);
  assert.ok(match, eventText);
  const envelope = JSON.parse(match[1]);
  assert.equal(envelope.protocol, 'watchdogs.local.v1');
  assert.equal(envelope.type, 'finding');
  assert.equal(envelope.data.ruleId, 'TEST_LIVE_FINDING');
  assert.equal(envelope.data.evidence.length, 4096);
  assert.equal(envelope.data.evidenceTruncated, true);
  assert.ok(Buffer.byteLength(match[1], 'utf8') < 16 * 1024, 'SSE event payload should remain bounded');
  const firstEventId = /^id: ([a-f0-9]{24})\nevent: finding/m.exec(eventText)?.[1];
  assert.ok(firstEventId, 'finding events should expose a standard SSE id');

  const secondRecord = {
    signature: 'test-live-finding-replay',
    ruleId: 'TEST_LIVE_FINDING_REPLAY',
    title: 'Replay finding regression',
    severity: 'medium',
    confidence: 'high',
    evidence: 'replay evidence',
    at: new Date(Date.now() + 1).toISOString()
  };
  await writeFile(join(dataDir, 'findings.jsonl'), JSON.stringify(record) + '\n' + JSON.stringify(secondRecord) + '\n');
  const secondText = await readSseUntil(reader, text => text.includes('TEST_LIVE_FINDING_REPLAY'), 5000, 'second persisted finding event was not delivered');
  const secondEventId = /^id: ([a-f0-9]{24})\nevent: finding/m.exec(secondText)?.[1];
  assert.ok(secondEventId, 'second finding should expose an SSE id');
  await reader.cancel();
  reader = undefined;

  const replayResponse = await fetch(`${origin}/api/events`, {
    headers: { origin, cookie, 'last-event-id': firstEventId }
  });
  assert.equal(replayResponse.status, 200);
  reader = replayResponse.body.getReader();
  const replayText = await readSseUntil(reader, text => text.includes('TEST_LIVE_FINDING_REPLAY'), 5000, 'missed finding was not replayed');
  assert.match(replayText, /event: connected/);
  assert.match(replayText, /event: finding/);
  assert.match(replayText, /TEST_LIVE_FINDING_REPLAY/);

  // Evict the first cursor from the bounded history using more than 128
  // distinct persisted findings. An actually expired cursor must trigger reset,
  // not silently skip events that fell out of the ring.
  const burstRecords = Array.from({ length: 130 }, (_, index) => ({
    signature: `test-live-finding-overflow-${index}`,
    ruleId: `TEST_LIVE_FINDING_OVERFLOW_${index}`,
    title: `Replay overflow regression ${index}`,
    severity: 'low',
    confidence: 'high',
    evidence: 'bounded replay evidence',
    at: new Date(Date.now() + index + 2).toISOString()
  }));
  await writeFile(
    join(dataDir, 'findings.jsonl'),
    [record, secondRecord, ...burstRecords].map(item => JSON.stringify(item)).join('\n') + '\n'
  );
  const burstText = await readSseUntil(
    reader,
    text => text.includes('TEST_LIVE_FINDING_OVERFLOW_129'),
    8000,
    'finding burst did not reach the live stream'
  );
  let lastBurstEventId;
  for (const match of burstText.matchAll(/id: ([a-f0-9]{24})\\nevent: finding\\ndata: ([^\\n]+)\\n\\n/g)) {
    const envelope = JSON.parse(match[2]);
    if (envelope.data?.ruleId === 'TEST_LIVE_FINDING_OVERFLOW_129') lastBurstEventId = match[1];
  }
  assert.ok(lastBurstEventId, 'latest burst event should expose a replay cursor');

  await reader.cancel();
  reader = undefined;
  const resetResponse = await fetch(`${origin}/api/events`, {
    headers: { origin, cookie, 'last-event-id': firstEventId }
  });
  assert.equal(resetResponse.status, 200);
  reader = resetResponse.body.getReader();
  const resetText = await readSseUntil(reader, text => text.includes('event: reset'), 5000, 'evicted event cursor did not request a snapshot refresh');
  assert.ok(resetText.includes('"snapshotRequired":true'));

  // A finding can be within the character cap but exceed the byte cap when
  // evidence contains multi-byte UTF-8. It must produce a replayable reset,
  // not disconnect the client and silently omit the event from history.
  const oversizedRecord = {
    signature: 'test-live-finding-oversized-utf8',
    ruleId: 'TEST_LIVE_FINDING_OVERSIZED_UTF8',
    title: 'Oversized UTF-8 finding regression',
    severity: 'high',
    confidence: 'high',
    evidence: '😀'.repeat(4096),
    at: new Date(Date.now() + 1000).toISOString()
  };
  await writeFile(
    join(dataDir, 'findings.jsonl'),
    [record, secondRecord, ...burstRecords, oversizedRecord].map(item => JSON.stringify(item)).join('\\n') + '\\n'
  );
  const liveOversizeReset = await readSseUntil(
    reader,
    text => text.includes('"reason":"event_too_large"'),
    5000,
    'oversized finding did not request a snapshot refresh'
  );
  assert.match(liveOversizeReset, /event: reset/);
  assert.match(liveOversizeReset, /id: [a-f0-9]{24}/);

  await reader.cancel();
  reader = undefined;
  const replayResetResponse = await fetch(`${origin}/api/events`, {
    headers: { origin, cookie, 'last-event-id': lastBurstEventId }
  });
  assert.equal(replayResetResponse.status, 200);
  reader = replayResetResponse.body.getReader();
  const replayResetText = await readSseUntil(
    reader,
    text => text.includes('"reason":"event_too_large"'),
    5000,
    'oversized-event reset marker was not replayed after reconnect'
  );
  assert.match(replayResetText, /event: reset/);
  assert.ok(replayResetText.includes('"snapshotRequired":true'));
});
