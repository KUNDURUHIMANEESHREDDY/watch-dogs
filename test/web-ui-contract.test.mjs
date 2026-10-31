import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
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
  assert.match(gatewaySource, /repairExecution: false/);
});
