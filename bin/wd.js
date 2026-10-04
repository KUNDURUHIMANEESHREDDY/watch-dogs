import { loadConfig } from '../src/core/config.mjs';
import { initLog, log } from '../src/core/log.mjs';
import { Watcher } from '../src/core/watcher.mjs';
import { TranscriptTailer, SessionRegistry, TranscriptDiscovery, transcriptDir } from '../src/capture/shell.mjs';
import { ProcessWatcher } from '../src/capture/procwatch.mjs';
import { ConptyLayer } from '../src/capture/conpty.mjs';
import { listRules, evaluate } from '../src/analyze/rules.mjs';
import { makeChromeFilter } from '../src/analyze/transcript.mjs';
import { listRails } from '../src/act/guard.mjs';
import { Applier } from '../src/act/apply.mjs';
import { install, uninstall, effectivePsProfile } from '../src/install/install.mjs';
import { LineSplitter } from '../src/capture/stream.mjs';
import { Heartbeat, readHeartbeat, claimSingleton, releaseSingleton } from '../src/core/heartbeat.mjs';
import { installAutostart, removeAutostart, autostartStatus, coverageVerdict } from '../src/install/autostart.mjs';
import { resolveTracing } from '../src/observe/trace.mjs';
import { homedir } from 'node:os';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const C = { r: '\x1b[31m', y: '\x1b[33m', g: '\x1b[32m', c: '\x1b[36m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' };
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const col = (c, s) => (useColor ? `${C[c]}${s}${C.x}` : s);

const SEV_COLOR = { critical: 'r', high: 'y', medium: 'c', low: 'd', info: 'd' };

let isChrome = () => false;

function out(...a) {
  process.stdout.write(a.join(' ') + '\n');
}

const HELP = `
${col('b', 'wd')} - cross-terminal watchdog

${col('b', 'USAGE')}
  wd init [--dry-run]            wire this machine's shells + IDE terminals
  wd autostart [--remove|--status] start the daemon at logon, or inspect it
  wd uninstall                   remove the managed blocks
  wd start                       start the daemon (foreground)
  wd doctor                      report what is and is not being watched
  wd status                      live session + finding summary
  wd findings [--min <sev>]      list findings
  wd rules                       list detection rules
  wd rails                       list the hard safety rails
  wd journal                     list reversible actions
  wd rollback <id>               undo one journalled change
  wd scan <file>                 run the rules over an existing log

${col('b', 'ENV')}
  WD_DISABLE=1      opt a shell out of capture
  WD_LOG_LEVEL      debug|info|warn|error
  NO_COLOR          disable colour
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  // The daemon runs for days with its console discarded by the launcher, so its
  // diagnostics must land in a file. Without this a crash leaves no trace at
  // all, which is exactly what happened the first time it died.
  if (cmd === 'start') {
    const bootCfg = loadConfig();
    initLog({ level: flags.log, file: join(bootCfg.paths.data, 'daemon.log') });
  } else {
    initLog({ level: flags.log });
  }

  switch (cmd) {
    case 'init': return cmdInit(flags);
    case 'uninstall': return cmdUninstall();
    case 'start': return cmdStart(flags);
    case 'autostart': return cmdAutostart(flags);
    case 'doctor': return await cmdDoctor();
    case 'status': return cmdStatus();
    case 'findings': return cmdFindings(flags);
    case 'rules': return cmdRules();
    case 'rails': return cmdRails();
    case 'journal': return cmdJournal();
    case 'rollback': return cmdRollback(rest[0]);
    case 'scan': return cmdScan(rest[0], flags);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      out(HELP);
      return;
    default:
      out(col('r', `unknown command: ${cmd}`) + '\n' + HELP);
      process.exitCode = 1;
  }
}

function parseFlags(args) {
  const f = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') f.dryRun = true;
    else if (a === '--remove') f.remove = true;
    else if (a === '--status') f.status = true;
    else if (a === '--min') f.min = args[++i];
    else if (a === '--log') f.log = args[++i];
    else if (a === '--no-color') process.env.NO_COLOR = '1';
    else f._.push(a);
  }
  return f;
}

function cmdInit(flags) {
  const dryRun = flags.dryRun;
  if (dryRun) out(col('y', 'dry run: nothing will be written\n'));
  out(col('b', 'PowerShell profile in use: ') + effectivePsProfile());
  if (dryRun) {
    out(`  would add a managed block to: ${effectivePsProfile()}`);
    out(`  would add a managed block to: ${join(process.env.USERPROFILE ?? '', '.bashrc')}`);
    out(`  would install shims into:     ${join(process.env.USERPROFILE ?? '', '.watchdog', 'bin')}`);
    return;
  }
  const res = install({ toolRoot: TOOL_ROOT, shells: ['powershell', 'bash'], ides: ['Code', 'Cursor'] });
  for (const p of res.profiles) out(col('g', 'profile ') + `${p.action.padEnd(9)} ${p.file}${p.hadUserContent ? col('d', '  (existing content preserved)') : ''}`);
  out(col('g', 'shims    ') + Object.values(res.hooks).join('\n          '));
  for (const i of res.ides) out(col('c', i.ide + '     ') + i.settingsPath + col('d', '\n          ' + i.note));
  for (const n of res.notes) out(col('y', 'note: ') + n);
  out('\n' + col('b', 'Next: ') + 'open a new terminal, then run ' + col('b', 'wd doctor') + ' to confirm coverage.');
}

function cmdUninstall() {
  const removed = uninstall();
  if (!removed.length) out(col('y', 'no managed blocks found - nothing to remove'));
  for (const f of removed) out(col('g', 'cleaned ') + f);
}

function cmdStart(flags) {
  const cfg = loadConfig();
  const watcher = new Watcher(cfg);
  const registry = new SessionRegistry(cfg.paths.data);

  // Refuse a second daemon before anything writes. Two writers appending to one
  // findings log is a quiet corruption, not an error anyone would notice.
  const claim = claimSingleton(cfg.paths.data);
  if (!claim.ok) {
    out(col('r', 'not starting: ') + claim.reason);
    out(col('d', '  run `wd status` to check the running one'));
    process.exitCode = 1;
    return;
  }
  const beat = new Heartbeat(cfg.paths.data, { projectRoot: cfg.projectRoot, toolRoot: TOOL_ROOT, autonomy: cfg.autonomy }).start();

  // Release on a clean exit so the next start does not have to wait for the
  // pid-liveness check to discover the corpse. releaseSingleton verifies the
  // token first, so a daemon whose lock was taken over cannot delete the new
  // holder's on its way out.
  const releaseLock = () => releaseSingleton(claim.lockPath, claim.token);
  process.once('exit', releaseLock);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      releaseLock();
      process.exit(0);
    });
  }
  log.info(
    'daemon starting: pid=' + process.pid +
      ' node=' + process.version +
      ' root=' + cfg.projectRoot +
      ' autonomy=' + cfg.autonomy +
      ' llm=' + (cfg.analyze.llm.enabled ? cfg.analyze.llm.cli : 'disabled') +
      ' layers=' + JSON.stringify(cfg.capture.layers),
  );

  out(col('b', 'watchdog') + ` starting  root=${cfg.projectRoot}  autonomy=${cfg.autonomy}  data=${cfg.paths.data}`);

  const onLines = (line, meta) => {
    if (!line.trim()) return;
    if (isChrome(line)) return;
    watcher.ingest(line, { sessionId: meta?.sessionId, cwd: meta?.cwd ?? cfg.projectRoot, shell: meta?.shell });
  };

  const tailer = new TranscriptTailer({ onLines });
  isChrome = makeChromeFilter();

  // Transcripts are discovered, not registered: a shell writes a .log plus a
  // .json sidecar using only built-in commands, so this needs no handshake.
  // WD_TRANSCRIPT_DIR overrides the location so an integration test can run in
  // isolation instead of tailing -- and deleting -- the live daemon's directory.
  const discovery = new TranscriptDiscovery(transcriptDir());
  const adopt = () => {
    for (const t of discovery.scan()) {
      // Only the daemon's own transcript is skipped -- tracking it would feed the
      // watchdog its own findings forever. Dead sessions MUST still be tracked:
      // a shell that opens and exits inside one poll interval is already fully
      // written by the time we discover it, and TranscriptTailer.track() is what
      // decides how far back to read.
      if (t.pid === process.pid) continue;
      tailer.track(t.file, t);
      out(col('c', '+ watching ') + t.shell + ' ' + t.sessionId + '  ' + col('d', '[' + t.ide + ']'));
    }
    for (const s of registry.list()) {
      if (s.status === 'live' && s.transcript) tailer.track(s.transcript, s);
    }
  };
  adopt();
  const adoptTimer = setInterval(adopt, 4000);

  let proc = null;
  if (cfg.capture.layers.process) {
    // Windows exposes no working directory through CIM, so layer 2 infers one by
    // walking ParentProcessId up to a shell we instrumented and reusing the cwd
    // the session registry recorded. Without this, a plain `node server.js` in the
    // project was never recognised, because argv does not contain the path.
    //
    // The lookup is memoised for a second: it would otherwise re-read the whole
    // sessions directory once per candidate process on every 5s poll.
    let cwdCache = { at: 0, byPid: new Map() };
    const sessionsByPid = () => {
      if (Date.now() - cwdCache.at < 1000) return cwdCache.byPid;
      const byPid = new Map();
      for (const s of registry.list()) {
        if (s.status === 'live' && s.pid && s.cwd) byPid.set(s.pid, s.cwd);
      }
      cwdCache = { at: Date.now(), byPid };
      return byPid;
    };
    proc = new ProcessWatcher(cfg, (f) => out(formatFinding(f)), {
      sessionCwd: (pid) => sessionsByPid().get(pid) ?? null,
    }).start();
    out(col('g', 'layer 2 on ') + 'process watcher (lifecycle, cwd inherited from sessions)');
  } else {
    out(col('d', 'layer 2 off') + ' process watcher');
  }

  if (cfg.capture.layers.shell) {
    out(col('g', 'layer 1 on ') + 'shell transcripts');
  } else {
    out(col('d', 'layer 1 off') + ' shell transcripts');
  }

  const conpty = new ConptyLayer(cfg);
  const c = conpty.attach().then((r) => {
    if (r.started) out(col('g', 'layer 3 on  conpty proxy'));
    else out(col('y', 'layer 3 off') + ` conpty: ${r.why}`);
  });

  watcher.on('advisor-down', (a) => {
    out('');
    out(col('y', '  LLM SECOND OPINION IS NOT WORKING'));
    out(col('y', '  ') + a.summary);
    out(col('d', '  Rule-based detection is unaffected. Run `wd doctor` to recheck.'));
    out('');
  });
  watcher.on('finding', (f) => out(formatFinding(f)));
  watcher.on('finding-updated', (f) => {
    // Fires for both an advisor verdict and a completed fix command.
    const applied = f.applied && f.applied.status !== 'running' ? ' applied:' + f.applied.status : '';
    const adv = f.advisor?.verdict ? ' llm:' + f.advisor.verdict : '';
    const why = f.applied?.why ? ' - ' + f.applied.why : '';
    out(col('d', '  updated: ') + f.ruleId + applied + adv + why);
  });

  out(col('d', `\nwatching. ctrl-c to stop.\n`));

  const shutdown = () => {
    clearInterval(adoptTimer);
    beat.stop();
    tailer.stop();
    proc?.stop();
    out('\n' + col('d', 'stopped.'));
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  void c;
}

function formatFinding(f) {
  if (f.kind === 'process-exit') {
    return col('d', `[proc] ${f.evidence ?? f.name + ' pid=' + f.pid + ' exited'}`);
  }
  const sev = col(SEV_COLOR[f.severity] ?? 'd', f.severity.toUpperCase().padEnd(8));
  const applied = f.applied?.status === 'applied' ? col('g', ' [applied]') : f.applied?.status === 'refused' ? col('y', ' [refused]') : '';
  const adv = f.advisor?.verdict ? col('d', ` llm:${f.advisor.verdict}`) : '';
  return `${sev} ${f.ruleId.padEnd(22)} ${f.title}${applied}${adv}\n        ${col('d', f.evidence.split('\n')[0].slice(0, 110))}`;
}

async function cmdAutostart(flags) {
  const cfg = loadConfig();
  const status = autostartStatus();
  const beat = readHeartbeat(cfg.paths.data);

  if (flags.remove) {
    const removed = removeAutostart();
    if (!removed.length) out(col('y', 'nothing was registered'));
    for (const r of removed) out(col('g', 'removed ') + r.mechanism + ': ' + r.detail);
    out(col('d', '  the daemon will no longer start at logon; `wd start` still works manually'));
    return;
  }

  if (flags.status) {
    printAutostartStatus(status, beat);
    return;
  }

  const res = installAutostart({ nodeExe: process.execPath, entry: join(TOOL_ROOT, 'bin', 'wd.js') });
  out(col('b', 'autostart: ') + col('g', res.mechanism));
  out('  ' + res.detail);
  for (const w of res.warnings ?? []) out(col('y', '  ! ') + w);
  out('');
  printAutostartStatus(autostartStatus(), beat);
}

/**
 * The whole point: "registered" and "running" are different claims. Printing both,
 * and colouring the combination that leaves someone falsely believing they are
 * covered, is what makes this worth having.
 */
function printAutostartStatus(status, beat) {
  out(col('b', '\n  registered at logon:  ') + (status.installed ? col('g', 'yes') : col('d', 'no')));
  for (const e of status.entries ?? []) out(col('d', '    via ' + e.mechanism + ': ' + e.detail));

  const label = beat.state === 'running' ? col('g', 'RUNNING') : col('r', beat.state.toUpperCase());
  out(col('b', '  actually running:    ') + label);
  out(col('d', '    ' + beat.detail));

  // The verdict lives in a tested function (coverageVerdict in install/autostart.mjs)
  // so the messaging cannot drift away from the behaviour it describes.
  const v = coverageVerdict({ registered: status.installed, beatState: beat.state });
  out('');
  const tone = v.level === 'ok' ? 'g' : v.level === 'bad' ? 'r' : 'y';
  out(col(tone, '  ' + v.headline));
  for (const l of v.lines) out(col('d', '    ' + l));
}
/**
 * Say out loud when autonomy is not what the config asked for.
 *
 * A config file that cannot be parsed pins autonomy to `suggest`. That downgrade
 * is the safe direction, but a silent one is a lie the user has to notice
 * themselves -- the obvious reading of `autonomy  suggest` is "I chose that",
 * when in fact the choice was taken away from them by a broken file. So the
 * reason travels with the config and every status view prints it.
 */
function reportUnreadableConfig(cfg, indent = '') {
  const bad = cfg.safety?.configUnreadable;
  if (!bad?.length) return;
  out(
    indent +
      col('y', 'config could not be read, so autonomy was pinned to "suggest" rather than assumed') +
      col('d', '  (a broken config must never grant more permission)'),
  );
  for (const b of bad) {
    out(indent + col('y', `  ${b.layer}: ${b.path}`));
    out(indent + col('d', `    ${b.why}`));
  }
}

async function cmdDoctor(flags) {
  const cfg = loadConfig();
  out(col('b', 'watchdog doctor\n'));
  out(`project root   ${cfg.projectRoot}`);
  out(`data dir       ${cfg.paths.data}${existsSync(cfg.paths.data) ? '' : col('y', '  (not created yet)')}`);
  out(`autonomy       ${cfg.autonomy}${cfg.autonomy === 'autonomous' ? col('y', '  <- applies fixes without asking') : ''}`);
  reportUnreadableConfig(cfg);
  out(`llm advisor    ${cfg.analyze.llm.enabled ? cfg.analyze.llm.cli : 'disabled'}${cfg.analyze.llm.model ? ` (${cfg.analyze.llm.model})` : ''}`);
  out('');

  // An unfunded or unauthenticated LLM must be visible here, not discovered later
  // when you wonder why the second opinion never appears.
  if (cfg.analyze.llm.enabled) {
    const { Advisor } = await import('../src/analyze/advisor.mjs');
    const probe = new Advisor({ cli: cfg.analyze.llm.cli, model: cfg.analyze.llm.model, timeoutMs: 45_000 });
    const res = await probe.review({ evidence: 'probe', cwd: cfg.projectRoot, title: 'connectivity probe' });
    if (res.status) {
      // Every failure path sets a status; only a genuine model reply omits it.
      out(col('y', '  LLM advisor is NOT working: ') + res.summary);
      out(col('d', '  Rule-based detection below is unaffected. Fix the advisor, or set'));
      out(col('d', '  analyze.llm.enabled=false in .watchdog/config.json to silence this.'));
    } else {
      out(col('g', '  LLM advisor reachable.'));
    }
    out('');
  }

  const auto = autostartStatus();
  const beat = readHeartbeat(cfg.paths.data);
  out(col('b', 'autostart + liveness'));
  out(`  registered    ${auto.installed ? col('g', 'yes') : col('d', 'no')}${auto.entries.map((e) => '  [' + e.mechanism + ']' ).join('')}`);
  const aliveTxt = beat.state === 'running' ? col('g', 'RUNNING') : col('r', beat.state.toUpperCase());
  out(`  daemon        ${aliveTxt}   ${col('d', beat.detail)}`);
  if (auto.installed && beat.state !== 'running') {
    out('  ' + col('r', 'NOT COVERED') + col('d', ' - registered but no live daemon. Run `wd start`.'));
  }
  out('');

  out(col('b', 'capture layers'));
  const conpty = new ConptyLayer(cfg);
  const probe = conpty.probe();
  out(`  1 shell transcripts  ${cfg.capture.layers.shell ? col('g', 'on') : col('d', 'off')}`);
  out(`  2 process watcher    ${cfg.capture.layers.process ? col('g', 'on') : col('d', 'off')}`);
  out(`  3 conpty proxy       ${cfg.capture.layers.conpty ? (probe.available ? col('g', 'on') : col('y', 'requested but unavailable')) : col('d', 'off')}`);
  if (!probe.available && cfg.capture.layers.conpty) out('      ' + col('y', probe.reason));
  out('');

  out(col('b', 'shell integration'));
  const prof = effectivePsProfile();
  const hasBlock = existsSync(prof) && readFileSync(prof, 'utf8').includes('watchdog begin');
  out(`  PowerShell profile  ${hasBlock ? col('g', 'managed block present') : col('y', 'NOT installed')}  ${col('d', prof)}`);
  const bashrc = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.bashrc');
  const hasBash = existsSync(bashrc) && readFileSync(bashrc, 'utf8').includes('watchdog begin');
  out(`  Git Bash ~/.bashrc  ${hasBash ? col('g', 'managed block present') : col('d', 'not installed (optional)')}`);
  out('');

  out(col('b', 'IDE terminals'));
  for (const [name, p] of [
    ['VS Code', join(process.env.APPDATA ?? '', 'Code', 'User', 'settings.json')],
    ['Cursor', join(process.env.APPDATA ?? '', 'Cursor', 'User', 'settings.json')],
  ]) {
    out(`  ${name.padEnd(18)} ${existsSync(p) ? col('g', 'installed') : col('d', 'not found')}  ${col('d', p)}`);
  }
  out('  ' + col('d', 'IDE terminals load the PowerShell profile, so coverage follows the profile block.'));
  out('');

  const reg = new SessionRegistry(cfg.paths.data);
  const sessions = reg.list();
  out(col('b', `sessions (${sessions.length})`));
  for (const s of sessions.slice(-8)) {
    out(`  ${s.status.padEnd(7)} ${String(s.shell).padEnd(12)} ${s.ide.padEnd(18)} ${s.cwd}`);
  }
  if (!sessions.length) out('  ' + col('d', 'none yet - start a terminal and run `wd start` in another'));
}

/**
 * Live summary: is anything being watched, and what has it found.
 *
 * This function was lost during an earlier file-recovery incident and nothing
 * caught it -- main() still routed to it, the file still parsed, and no test
 * invoked `wd status`. test/integrity.test.mjs now asserts that every routed
 * command resolves to a function that actually exists.
 */
function cmdStatus() {
  const cfg = loadConfig();
  const auto = autostartStatus();
  const beat = readHeartbeat(cfg.paths.data);

  out(col('b', 'watchdog status') + col('d', '  ' + cfg.projectRoot));
  out('');

  const v = coverageVerdict({ registered: auto.installed, beatState: beat.state });
  const tone = v.level === 'ok' ? 'g' : v.level === 'bad' ? 'r' : 'y';
  out('  ' + col(tone, v.headline));
  for (const l of v.lines) out(col('d', '    ' + l));
  out('');

  const llm = cfg.analyze.llm.enabled
    ? cfg.analyze.llm.cli + (cfg.analyze.llm.model ? ' ' + cfg.analyze.llm.model : '')
    : 'disabled';
  out('  ' + col('b', 'autonomy'.padEnd(15)) + ' ' + cfg.autonomy + (cfg.autonomy === 'autonomous' ? col('y', '  (applies fixes without asking)') : ''));
  reportUnreadableConfig(cfg, '    ');
  out('  ' + col('b', 'llm advisor'.padEnd(15)) + ' ' + llm);
  out('  ' + col('b', 'daemon'.padEnd(15)) + ' ' + beat.detail);

  // Tracing is reported like everything else: a reader should never have to guess
  // whether their LLM calls are being observed, or to which project they are sent.
  const tr = resolveTracing(cfg);
  if (tr.enabled) {
    out('  ' + col('b', 'langfuse'.padEnd(15)) + ' ' + tr.baseUrl.replace(/^https?:\/\//, '') + col('d', `  (env ${tr.environment}, input ${tr.redact ? 'redacted' : col('y', 'NOT redacted')})`));
  } else if (tr.configured) {
    out('  ' + col('b', 'langfuse'.padEnd(15)) + ' ' + col('y', 'on but no credentials - every span is being dropped') + col('d', '  set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY'));
  } else {
    out('  ' + col('b', 'langfuse'.padEnd(15)) + ' ' + col('d', 'off (set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY to enable)'));
  }

  const sessions = new SessionRegistry(cfg.paths.data).list();
  const live = sessions.filter((s) => s.status === 'live');
  out('  ' + col('b', 'sessions'.padEnd(15)) + ' ' + sessions.length + ' recorded, ' + live.length + ' live');
  for (const s of live.slice(-5)) out(col('d', '    ' + String(s.shell).padEnd(12) + (s.ide ?? '')));

  const seen = new Map();
  for (const f of loadFindingsFile(cfg)) seen.set((f.signature ?? '') + (f.sessionId ?? ''), f);
  const counts = {};
  for (const f of seen.values()) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  const summary = ['critical', 'high', 'medium', 'low', 'info']
    .filter((s) => counts[s])
    .map((s) => counts[s] + ' ' + s)
    .join(', ');
  out('  ' + col('b', 'findings'.padEnd(15)) + ' ' + (seen.size ? summary : col('d', 'none recorded')));
  out('');
  out(col('d', '  wd findings   full list        wd doctor   coverage report'));
}

function loadFindingsFile(cfg) {
  const p = join(cfg.paths.data, 'findings.jsonl');
  // Read the rotated generation too. The log is capped, so ignoring findings.jsonl.1
  // would make rotation look like data loss to anyone checking whether a fix ran.
  const out = [];
  for (const f of [p + '.1', p]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* a torn final line from a rotation mid-write; skip it */
      }
    }
  }
  return out;
}

function cmdFindings(flags) {
  const cfg = loadConfig();
  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const min = flags.min ?? 'low';
  const all = loadFindingsFile(cfg);
  const seen = new Map();
  for (const f of all) seen.set(f.signature + (f.sessionId ?? ''), f);
  const list = [...seen.values()]
    .filter((f) => (order[f.severity] ?? 9) <= (order[min] ?? 9))
    .sort((a, b) => (order[a.severity] - order[b.severity]) || (a.at < b.at ? 1 : -1));

  if (!list.length) return out(col('g', 'no findings'));
  out(col('b', `${list.length} finding(s)\n`));
  for (const f of list.slice(0, 60)) {
    out(formatFinding(f));
    if (f.advisor?.summary) out('        ' + col('c', 'llm: ') + f.advisor.summary);
  }
}

function cmdRules() {
  out(col('b', 'detection rules\n'));
  for (const r of listRules()) {
    out(`  ${col(SEV_COLOR[r.severity] ?? 'd', r.severity.padEnd(8))} ${r.id.padEnd(24)} ${r.title}${r.hasFix ? col('g', '  [fix]') : ''}${r.confidence !== 'high' ? col('d', `  (${r.confidence} confidence)`) : ''}`);
  }
}

function cmdRails() {
  out(col('b', 'hard safety rails') + col('d', '  (cannot be disabled by config or by the LLM)\n'));
  for (const r of listRails()) {
    out(`  ${col('r', r.code.padEnd(28))} ${col('d', r.examples.join(', '))}`);
  }
}

function cmdJournal() {
  const cfg = loadConfig();
  const dir = join(cfg.paths.data, 'journal');
  if (!existsSync(dir)) return out(col('d', 'journal is empty'));
  const entries = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))).sort((a, b) => (a.at < b.at ? 1 : -1));
  for (const e of entries) {
    out(`  ${e.id.padEnd(18)} ${e.outcome.padEnd(12)} ${e.type.padEnd(8)} ${e.abs ? e.abs.replace(cfg.projectRoot, '.') : (e.argv || []).join(' ')}`);
  }
}

function cmdRollback(id) {
  if (!id) return out(col('r', 'usage: wd rollback <id>'));
  const cfg = loadConfig();
  const a = new Applier({ projectRoot: cfg.projectRoot, dataDir: cfg.paths.data, autonomy: 'suggest' });
  const r = a.rollback(id);
  out(r.status === 'rolled-back' ? col('g', 'rolled back ') + r.path : col('y', r.status + ': ' + r.why));
}

function cmdScan(file) {
  if (!file) return out(col('r', 'usage: wd scan <file>'));
  const p = resolve(file);
  if (!existsSync(p)) return out(col('r', `no such file: ${p}`));
  const splitter = new LineSplitter();
  const lines = [...splitter.push(readFileSync(p)), ...splitter.flush()];
  let n = 0;
  for (const l of lines) {
    for (const f of evaluate(l, { cwd: process.cwd() })) {
      n++;
      out(formatFinding(f));
    }
  }
  out(n ? col('d', `\n${n} finding(s) in ${lines.length} lines`) : col('g', 'no findings'));
}

main().catch((e) => {
  log.error(e);
  process.exitCode = 1;
});

