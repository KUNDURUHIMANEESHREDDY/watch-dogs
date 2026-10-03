/**
 * Demonstrates the singleton race with real concurrent processes.
 *
 * Two daemons starting at once both read "no heartbeat", both conclude nobody is
 * running, and both proceed. The window is small but the Startup launcher, a
 * profile self-heal and a hand-typed `wd start` can genuinely collide.
 *
 * Usage: node race-probe.mjs <dataDir> <delayMs>
 */
import { claimSingleton } from '../src/core/heartbeat.mjs';

const [dataDir, delayMs, holdMs] = [process.argv[2], Number(process.argv[3] || 0), Number(process.argv[4] || 400)];

// Stagger so the two processes sit right on top of each other's read.
await new Promise((r) => setTimeout(r, delayMs));

const claim = claimSingleton(dataDir);

// Hold the lock while the other process tries. Without this the probe exits
// before the second process even reads, so the first process looks dead, the
// lock is correctly treated as stale and taken over, and the test measures
// nothing. A real daemon holds for hours.
if (claim.ok) await new Promise((r) => setTimeout(r, holdMs));

process.stdout.write(
  JSON.stringify({ pid: process.pid, ok: claim.ok, reason: claim.reason ?? null }) + '\n',
);
process.exit(claim.ok ? 0 : 3);