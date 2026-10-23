import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

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
  assert.match(contractSource, /liveFindingEvents: boolean/);
  assert.match(contractSource, /repairExecution: boolean/);
  assert.match(contractSource, /resources\?: ObservedResource\[\]/);
  assert.match(contractSource, /No browser-triggered repair endpoint is operational/);
});

test('UI does not claim missing finding or repair integrations are operational', () => {
  assert.match(appSource, /No synthetic topology/);
  assert.match(appSource, /Approval and execution controls remain disabled/);
  assert.match(appSource, /The UI will display findings only after the runtime exposes/);
  assert.match(appSource, /STALE/);
});
