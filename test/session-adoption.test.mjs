import test from 'node:test';
import assert from 'node:assert/strict';
import { adoptTranscript } from '../src/capture/session-adoption.mjs';

test('announces a transcript only on first discovery while refreshing sidecar metadata', () => {
  const tracked = new Map();
  const announced = [];
  const tailer = {
    refresh(file, metadata) {
      const current = tracked.get(file);
      if (!current) return false;
      tracked.set(file, { ...current, ...metadata });
      return true;
    },
    track(file, metadata) {
      tracked.set(file, metadata);
    },
  };
  const session = {
    file: 'C:/tmp/powershell-session.log',
    sessionId: 'session-1',
    pid: null,
    cwd: null,
    shell: 'powershell',
    ide: 'Windows Terminal',
  };

  assert.equal(adoptTranscript(tailer, session, (value) => announced.push(value)), true);
  assert.equal(
    adoptTranscript(
      tailer,
      { ...session, pid: 1234, cwd: 'C:/workspace' },
      (value) => announced.push(value),
    ),
    false,
  );

  assert.equal(tracked.size, 1);
  assert.equal(tracked.get(session.file).pid, 1234);
  assert.equal(tracked.get(session.file).cwd, 'C:/workspace');
  assert.equal(announced.length, 1);
  assert.equal(announced[0].sessionId, 'session-1');
});
