/**
 * Layer 2 project attribution.
 *
 * Windows exposes no working directory through CIM. Verified against a process
 * started with an explicit -WorkingDirectory: no such property exists on
 * Win32_Process, and the working directory appears nowhere in CommandLine.
 *
 * Attribution therefore used to rest entirely on argv containing the project
 * path, which made `node server.js`, `npm test` and `pytest` run from the project
 * invisible -- the exact processes this layer exists to catch.
 *
 * The fix infers cwd by inheritance: a child inherits its parent's working
 * directory, and the session registry knows the cwd of every shell we
 * instrumented. These tests drive it through observe(), which exists so the
 * logic can be exercised offline without shelling out to CIM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProcessWatcher } from '../src/capture/procwatch.mjs';

const ROOT = 'C:\\Users\\someone\\projects\\app';
const OTHER = 'C:\\Users\\someone\\projects\\other';

function make(sessionCwd) {
  return new ProcessWatcher(
    { projectRoot: ROOT, capture: { layers: {} } },
    () => {},
    { sessionCwd },
  );
}

const pids = (tracked) => tracked.map((t) => t.pid).sort((a, b) => a - b);

test('a bare command with no project path in argv is attributed via its shell', () => {
  // The regression this exists for: argv says nothing, so the old filter missed
  // it and the process was never watched.
  const w = make((pid) => (pid === 1000 ? ROOT : null));
  const tracked = w.observe([
    { pid: 1000, ppid: 4, name: 'powershell', cmd: 'powershell.exe' },
    { pid: 2000, ppid: 1000, name: 'node', cmd: 'node server.js' },
  ]);
  assert.deepEqual(pids(tracked), [2000], 'the bare node process was not attributed to the project');
});

test('the inherited cwd is recorded on the tracked process', () => {
  // Without this the finding carries no cwd at all, so a reader cannot tell the
  // layer why it considered the process relevant.
  const w = make((pid) => (pid === 1000 ? ROOT : null));
  const tracked = w.observe([
    { pid: 1000, ppid: 4, name: 'powershell', cmd: 'powershell.exe' },
    { pid: 2000, ppid: 1000, name: 'node', cmd: 'node server.js' },
  ]);
  assert.equal(tracked.find((t) => t.pid === 2000)?.cwd, ROOT);
});

test('inheritance is followed more than one level up', () => {
  const w = make((pid) => (pid === 1000 ? ROOT : null));
  const tracked = w.observe([
    { pid: 1000, ppid: 4, name: 'powershell', cmd: 'powershell.exe' },
    { pid: 1500, ppid: 1000, name: 'cmd', cmd: 'cmd.exe' },
    { pid: 2000, ppid: 1500, name: 'node', cmd: 'node build.js' },
  ]);
  assert.deepEqual(pids(tracked), [2000], 'a grandchild of the project shell was not attributed');
});

test('a process from another project is still ignored', () => {
  // Widening the filter to fix false negatives must not introduce the false
  // positives that get a monitor switched off.
  const w = make((pid) => (pid === 1000 ? OTHER : null));
  const tracked = w.observe([
    { pid: 1000, ppid: 4, name: 'powershell', cmd: 'powershell.exe' },
    { pid: 2000, ppid: 1000, name: 'node', cmd: 'node server.js' },
  ]);
  assert.deepEqual(pids(tracked), [], 'a process from an unrelated project was attributed to this one');
});

test('argv matching still works when no session is known', () => {
  // Additive, not a replacement: anything the old filter caught must still be
  // caught, including processes from an uninstrumented parent.
  const w = make(() => null);
  const tracked = w.observe([{ pid: 2000, ppid: 999, name: 'node', cmd: `node ${ROOT}\\server.js` }]);
  assert.deepEqual(pids(tracked), [2000], 'argv-based attribution regressed');
});

test('a process with no known ancestor cwd is not attributed', () => {
  const w = make(() => null);
  const tracked = w.observe([
    { pid: 2000, ppid: 999, name: 'node', cmd: 'node server.js' },
    { pid: 999, ppid: 888, name: 'node', cmd: 'node other.js' },
  ]);
  assert.deepEqual(pids(tracked), [], 'a process of unknown provenance was attributed anyway');
});

test('a cyclic parent chain terminates', () => {
  // The walk is bounded. A malformed or looping chain must not spin the poll loop
  // that runs every 5 seconds for the life of the daemon.
  const chain = [];
  for (let i = 0; i < 40; i++) chain.push({ pid: 3000 + i, ppid: 3001 + i, name: 'node', cmd: `node x${i}.js` });
  chain.push({ pid: 3040, ppid: 3000, name: 'node', cmd: 'node loop.js' });
  const w = make((pid) => (pid === 999999 ? ROOT : null));
  const started = Date.now();
  w.observe(chain);
  assert.ok(Date.now() - started < 1000, 'reconciliation of a cyclic chain took over a second');
});

test('processAnywhere still overrides attribution entirely', () => {
  const w = new ProcessWatcher({ projectRoot: ROOT, capture: { layers: { processAnywhere: true } } }, () => {}, {
    sessionCwd: () => null,
  });
  const tracked = w.observe([{ pid: 2000, ppid: 999, name: 'node', cmd: 'node server.js' }]);
  assert.deepEqual(pids(tracked), [2000], 'processAnywhere stopped working');
});