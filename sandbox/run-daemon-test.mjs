/**
 * End-to-end daemon test: runs the real `wd start` rooted inside the sandbox
 * project, drives a real PowerShell session from it, and asserts what the daemon
 * reported. This is the only check that covers the whole chain:
 *
 *   PowerShell profile -> Start-Transcript -> discovery -> tailing -> line
 *   splitting -> rules -> (LLM) -> apply
 *
 * Run with WD_LIVE_LLM=1 to include the model in the residual-triage leg.
 */
import { rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SANDBOX = join(HERE, 'project');
const WD = join(ROOT, 'bin', 'wd.js');
const EMIT = join(HERE, 'emit.ps1');
// A scratch transcript directory, so this test never deletes or tails the live
// daemon's real transcripts. WD_TRANSCRIPT_DIR is read by the profile block (the
// shell that writes them) and by the daemon (the one that reads them), so both
// sides stay in agreement.
const TRANSCRIPTS = join(HERE, 'project', '.watchdog', 'transcripts');
process.env.WD_TRANSCRIPT_DIR = TRANSCRIPTS;
// These daemons inherit the real global config, credentials and all. Without this
// they would ship the sandbox's deliberately-broken output to the actual
// Langfuse project, which is not what a test harness gets to do quietly.
process.env.WD_TRACING = 'off';
const USE_MODEL = process.env.WD_LIVE_LLM === '1';

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[1m', d: '\x1b[90m', x: '\x1b[0m' };
const c = (k, s) => `${C[k]}${s}${C.x}`;

let pass = 0;
let fail = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) pass++;
  else {
    fail++;
    failures.push({ label, detail });
  }
  console.log(`  ${ok ? c('g', 'PASS') : c('r', 'FAIL')}  ${label}${ok || !detail ? '' : `\n         ${c('y', detail)}`}`);
}

function resetSandbox() {
  // Surgical, not rm -rf: opencode's background service keeps its working
  // directory open, so a full-tree delete fails with EPERM on Windows. Rewriting
  // the files this test depends on is both sufficient and immune to that lock.
  try {
    rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* locked; the explicit fixture rewrite below still applies */
  }
  mkdirSync(join(SANDBOX, 'src'), { recursive: true });
  mkdirSync(join(SANDBOX, '.watchdog'), { recursive: true });
  rmSync(join(SANDBOX, '.watchdog', 'findings.jsonl'), { force: true });
  rmSync(join(SANDBOX, '.watchdog', 'journal'), { recursive: true, force: true });
  writeFileSync(join(SANDBOX, 'package.json'), JSON.stringify({ name: 'watchdog-sandbox', private: true }, null, 2) + '\n');
  writeFileSync(join(SANDBOX, 'src', 'tally.js'), 'function tally(items) {\n  return count / items.length;\n}\n');
  writeFileSync(
    join(SANDBOX, '.watchdog', 'config.json'),
    JSON.stringify(
      {
        autonomy: 'autonomous',
        capture: { layers: { shell: true, process: true, conpty: false }, redact: true },
        analyze: {
          llm: {
            enabled: true,
            cli: 'opencode',
            model: process.env.WD_TEST_MODEL ?? 'opencode/space-bunny-free',
            timeoutMs: 180_000,
            minSeverity: 'low',
            maxInvocationsPerSession: 4,
          },
          cooldownMs: 0,
        },
      },
      null,
      2,
    ) + '\n',
  );
}

/**
 * Kill a sandbox daemon left behind by an interrupted run.
 *
 * Without this, one aborted run poisons every later one: the orphan holds the
 * sandbox's heartbeat, so the next daemon correctly refuses to start as a
 * duplicate and the whole harness reports failure for a reason that has nothing
 * to do with the code. Only pids named by the sandbox's own heartbeat are killed,
 * so the user's real daemon is never touched.
 */
function reapOrphan() {
  const beatPath = join(SANDBOX, '.watchdog', 'daemon.json');
  if (!existsSync(beatPath)) return 0;
  let info;
  try {
    info = JSON.parse(readFileSync(beatPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return 0;
  }
  const pid = Number(info?.pid);
  if (!pid || !Number.isInteger(pid)) return 0;
  if (info.projectRoot && resolve(info.projectRoot) !== resolve(SANDBOX)) return 0;
  try {
    process.kill(pid);
    return pid;
  } catch {
    return 0; // already gone
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start the daemon, run the emitter, wait, then stop the daemon. */
async function runDaemonLeg({ residual }) {
  const orphan = reapOrphan();
  if (orphan) {
    await sleep(1500);
    console.log(c('d', `  (reaped orphaned sandbox daemon pid ${orphan} from an earlier run)`));
  }
  resetSandbox();
  // The sandbox's own transcript dir, so this is safe to clear outright: nothing
  // outside this test is holding a handle in it.
  rmSync(TRANSCRIPTS, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  mkdirSync(TRANSCRIPTS, { recursive: true });

  const out = join(HERE, 'daemon.log');
  const err = join(HERE, 'daemon.err');
  rmSync(out, { force: true });
  rmSync(err, { force: true });

  const daemon = spawn(process.execPath, [WD, 'start'], { cwd: SANDBOX, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  daemon.stdout.on('data', (d) => (log += d));
  daemon.stderr.on('data', (d) => (log += d));

  await sleep(3000);
  // A real shell, from the sandbox directory, so the transcript is a genuine one.
  try {
    execFileSync('powershell.exe', ['-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', EMIT, ...(residual ? ['-Residual'] : [])], {
      cwd: SANDBOX,
      timeout: 60_000,
      stdio: 'ignore',
    });
  } catch (e) {
    check('emitter script ran', false, e.message);
  }

  await sleep(residual && USE_MODEL ? 45_000 : 12_000);
  daemon.kill();
  await sleep(500);
  return log;
}

async function main() {
  console.log(c('b', '\ndaemon integration (real PowerShell, real transcripts)'));
  console.log(c('d', `live model: ${USE_MODEL ? 'enabled' : 'disabled'}\n`));

  // ---- leg 1: a real ReferenceError
  console.log(c('b', 'leg 1  rule detection through a live shell'));
  let log = await runDaemonLeg({ residual: false });
  console.log(c('d', indent(log)));
  check('daemon rooted itself in the sandbox', /root=.*sandbox\\project/.test(log), log.slice(0, 200));
  check('discovered the PowerShell session', /\+ watching powershell/.test(log));
  check('caught the ReferenceError', /js-referenceerror/.test(log), 'no js-referenceerror finding');
  check('reported it as CRITICAL', /CRITICAL\s+js-referenceerror/.test(log));
  check('did not chase the noise', !/unrecognised-error/.test(log), 'should not have triaged successful output');
  check('no stderr noise', !/EISDIR|TypeError: |ReferenceError: m/.test(log));

  // ---- leg 2: residual triage, the LLM path
  console.log(c('b', '\nleg 2  residual triage (error no rule matches)'));
  log = await runDaemonLeg({ residual: true });
  console.log(c('d', indent(log)));
  check('triaged the unrecognised error', /unrecognised-error/.test(log));
  check('did NOT triage "Build completed with 0 errors"', (log.match(/MEDIUM\s+unrecognised-error/g) || []).length === 1, 'saw ' + (log.match(/MEDIUM\s+unrecognised-error/g) || []).length);
  if (USE_MODEL) {
    // "unsure" is a legitimate answer here: the seeded error is fictional, so a
    // model that declines to guess is behaving correctly. Requiring problem|noise
    // made this leg flaky rather than meaningful.
    check('model returned a recognised verdict', /updated:.*llm:(problem|noise|unsure)/.test(log), 'no llm verdict line');
    check('did not claim the LLM is broken', !/LLM SECOND OPINION IS NOT WORKING/.test(log), 'spurious advisor-down banner');
  } else {
    check('model leg skipped', true);
  }

  console.log('\n' + '='.repeat(66));
  if (pass + fail === 0) {
    console.log(c('r', 'NO CHECKS RAN'));
    process.exitCode = 1;
    return;
  }
  console.log(c('b', 'DAEMON RESULT') + `  ${pass}/${pass + fail} checks passed`);
  if (fail) for (const f of failures) console.log(`  ${c('r', 'x')} ${f.label}`);
  else console.log(c('g', '  clean'));
  process.exitCode = fail ? 1 : 0;
}

function indent(s) {
  return s
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => '         ' + l)
    .join('\n');
}

main();
