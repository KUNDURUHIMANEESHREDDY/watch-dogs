/**
 * Daemon singleton.
 *
 * The original guard read the heartbeat, saw nobody running, and returned ok.
 * Check-then-act with nothing in between. Measured against the old code, two
 * concurrent `wd start` processes both won 20 times out of 20 -- the guard was
 * not merely racy, it was ineffective for the case it exists to prevent.
 *
 * Two daemons means double the LLM spend and two autonomous appliers racing on
 * the same files, which is why this is worth an O_EXCL create rather than a
 * slightly better heuristic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimSingleton, releaseSingleton } from '../src/core/heartbeat.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'wd-lock-'));
const lockIn = (d) => join(d, 'daemon.lock');

/** Plant a lock held by a given pid, as if another daemon had taken it. */
function plant(d, pid, token = 'someone-elses-token') {
  mkdirSync(d, { recursive: true });
  writeFileSync(lockIn(d), JSON.stringify({ pid, token, at: new Date().toISOString() }), 'utf8');
}

test('a lock held by a live process is refused', () => {
  // pid 4 is the Windows System process, which is always alive here. Not pid 1:
  // Windows has no pid 1, and pidAlive(1) is false on this platform -- I assumed
  // otherwise and the test passed for the wrong reason until it was checked.
  //
  // Definitely not process.pid either: that is the re-entrancy case, handled one
  // branch earlier.
  const d = dir();
  plant(d, 4);
  const claim = claimSingleton(d);
  assert.equal(claim.ok, false, 'a live holder was overridden');
  assert.match(claim.reason, /already running/);
  assert.equal(claim.pid, 4);
});

test('a lock left by a dead process is taken over', () => {
  // The old code's promise: a dead daemon must not block the next start. A pid
  // this large cannot exist, so the takeover is unambiguous.
  const d = dir();
  plant(d, 0x7ffffff0);
  const claim = claimSingleton(d);
  assert.equal(claim.ok, true, `a dead holder blocked the start: ${claim.reason}`);
  assert.ok(existsSync(lockIn(d)), 'the lock was not re-created by the new holder');
  assert.match(readFileSync(lockIn(d), 'utf8'), /"pid":\s*\d+/);
});

test('claiming twice from the same process is allowed', () => {
  // Re-entrancy: a restart within one process must not deadlock against itself.
  const d = dir();
  const first = claimSingleton(d);
  assert.equal(first.ok, true);
  const second = claimSingleton(d);
  assert.equal(second.ok, true, 'the same pid was refused its own lock');
  assert.equal(second.token, first.token, 'the token changed on re-entry');
});

test('release only removes the lock we still hold', () => {
  // The case that makes releasing dangerous: a daemon that stalled long enough for
  // its lock to be taken over must not delete the NEW holder's lock on exit, or
  // the machine ends up with two daemons and no lock.
  const d = dir();
  const mine = claimSingleton(d);
  assert.equal(mine.ok, true);

  // Someone else takes over.
  plant(d, 4242, 'the-new-holder');
  // plant() wrote a dead pid, so make it look alive for the purposes of the
  // release check -- release only compares tokens, which is the point.
  const released = releaseSingleton(mine.lockPath, mine.token);
  assert.equal(released, false, 'we deleted a lock we no longer owned');
  assert.ok(existsSync(lockIn(d)), 'the new holder lost its lock');
});

test('release removes our own lock', () => {
  const d = dir();
  const mine = claimSingleton(d);
  assert.equal(mine.ok, true);
  assert.equal(releaseSingleton(mine.lockPath, mine.token), true);
  assert.equal(existsSync(lockIn(d)), false, 'the lock survived release');
});

test('releasing without a claim is harmless', () => {
  assert.equal(releaseSingleton(undefined, undefined), false);
  assert.equal(releaseSingleton(lockIn(dir()), 'nope'), false);
});

test('a corrupt lock file does not block a start forever', () => {
  // An unreadable holder means we cannot tell who owns it. Treating that as
  // "busy" would leave the project permanently unstartable; treating it as free
  // after the bounded retries keeps the daemon recoverable from any damage.
  const d = dir();
  mkdirSync(d, { recursive: true });
  writeFileSync(lockIn(d), '{ not json', 'utf8');
  const claim = claimSingleton(d);
  assert.equal(claim.ok, true, `a corrupt lock blocked the start: ${claim.reason}`);
});

test('an unusable lock path fails closed rather than starting unguarded', () => {
  // A directory sitting where the lock file goes makes openSync('wx') report
  // EEXIST, so this exercises the contention branch rather than the direct
  // error branch -- and still must not start. What matters is the refusal, not
  // which branch produced it.
  const d = dir();
  mkdirSync(join(d, 'daemon.lock'), { recursive: true });
  const claim = claimSingleton(d);
  assert.equal(claim.ok, false, 'started with no lock after an unusable lock path');
  assert.match(claim.reason, /daemon lock/);
});