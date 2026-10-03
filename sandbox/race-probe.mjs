/**
 * Process-level probe for the daemon singleton.
 *
 * The race this measures is between OS processes, so it cannot be tested from
 * inside one -- claimSingleton's atomicity is a property of O_EXCL, not of any
 * JavaScript sequencing. Run two of these at once against one data directory and
 * count how many were granted ownership. Exactly one, always.
 *
 *   node sandbox/race-probe.mjs <dataDir> [delayMs] [holdMs]
 *
 * Prints one JSON line per process: {"pid":N,"ok":bool,"reason":string|null}
 * Exit 0 when ownership was granted, 3 when refused.
 *
 * The hold is essential. An earlier version exited immediately after claiming,
 * so the holder looked dead to the second process, the lock was correctly taken
 * over as stale, and the probe reported both as winners while measuring nothing.
 */
import { claimSingleton } from '../src/core/heartbeat.mjs';

const [dataDir, delayMs, holdMs] = [process.argv[2], Number(process.argv[3] || 0), Number(process.argv[4] || 400)];

// Stagger so the two processes sit right on top of each other's read.
await new Promise((r) => setTimeout(r, delayMs));

const claim = claimSingleton(dataDir);

// Hold the lock while the other process tries. A real daemon holds for hours.
if (claim.ok) await new Promise((r) => setTimeout(r, holdMs));

process.stdout.write(
  JSON.stringify({ pid: process.pid, ok: claim.ok, reason: claim.reason ?? null }) + '\n',
);
process.exit(claim.ok ? 0 : 3);