/**
 * Autostart.
 *
 * Prefers a Scheduled Task, because it can restart the daemon on failure, which is
 * the difference between "starts once at logon" and "actually stays covered".
 * Creating one normally needs elevation, so when that is unavailable this falls
 * back to a Startup-folder launcher and says so plainly rather than pretending
 * the stronger guarantee is in place.
 *
 * The launcher is a .vbs rather than a .cmd so no console window flashes at logon.
 */
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

export const TASK_NAME = 'Watchdog Terminal Watchdog';
const LAUNCHER_NAME = 'watchdog-daemon.vbs';
const MARKER = 'watchdog-daemon';

export function startupDir() {
  // WD_STARTUP_DIR redirects the launcher for tests. Without it the test suite
  // installs into, and then deletes from, the real Startup folder -- so merely
  // running the tests silently unregisters the user's watchdog, and two test
  // files racing on the real folder fail intermittently for no real reason.
  if (process.env.WD_STARTUP_DIR) return process.env.WD_STARTUP_DIR;
  return join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

export function launcherPath() {
  return join(startupDir(), LAUNCHER_NAME);
}

export function isElevated() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'], {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    });
    return out.trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * The command line the OS runs to start the daemon. Kept in one place so the
 * scheduled task and the VBS launcher cannot drift apart.
 */
function daemonCommand(nodeExe, entry, { hidden = true } = {}) {
  return `"${nodeExe}" "${entry}" start`;
}

export function buildLauncherForTest(nodeExe, entry) {
  // In VBScript a literal double quote inside a string is written "". The paths
  // contain spaces and need real quoting, so every quote here has to double --
  // emitting them verbatim produces sh.Run ""C:\..."" ... which runs nothing.
  const cmd = daemonCommand(nodeExe, entry).replace(/"/g, '""');
  return [
    "' " + MARKER + " - managed launcher, safe to delete",
    "' Starts the watchdog daemon with no console window.",
    'Set sh = CreateObject("WScript.Shell")',
    'sh.Run "' + cmd + '", 0, False',
    'Set sh = Nothing',
    '',
  ].join('\r\n');
}

/**
 * @param {{nodeExe:string, entry:string, preferTask?:boolean}} opts
 */
/**
 * Register the daemon to start at logon.
 *
 * `preferTask` defaults to false, and it used to default to true.
 *
 * A Scheduled Task was preferred because a task "supervises better than a Startup
 * folder entry". Measured on this machine, that is not true in any respect that
 * matters:
 *
 *   - Registering *any* task here is `Access is denied` without elevation. So the
 *     preference only ever applied to an elevated install.
 *   - The task was created without restart-on-failure settings, and said so --
 *     `restarts: false`, with a warning that a crash still needs a manual restart.
 *   - The Startup-folder path reported `restarts: true`, because the shell profile
 *     relaunches a stale daemon. Both paths install that profile. So the two
 *     mechanisms had identical recovery behaviour, and the task was worse on the
 *     only dimension either of them acts on.
 *
 * What preferring it actually bought: a machine-wide artifact that needs elevation
 * to create and elevation to remove, in exchange for nothing.
 *
 * Real supervision -- restarting the daemon when it dies rather than when you next
 * open a terminal -- needs `<RestartOnFailure>` in the task's settings, and that is
 * not reachable without elevation on this machine either. That is a platform
 * boundary, like the ConPTY layer and layer-2 exit codes, and it is documented as one
 * rather than papered over. The task path is kept so that a future elevated install
 * can turn restart-on-failure on and be honest about the result, but it is no longer
 * preferred for a benefit it does not provide.
 */
export function installAutostart({ nodeExe, entry, preferTask = false }) {
  const warnings = [];

  if (preferTask && isElevated()) {
    try {
      sh('schtasks.exe', [
        '/create', '/tn', TASK_NAME,
        '/tr', daemonCommand(nodeExe, entry),
        '/sc', 'onlogon',
        '/rl', 'limited',
        '/f',
      ]);
      return {
        mechanism: 'scheduled-task',
        detail: TASK_NAME,
        // Accurate, and the reason this is not the default. The shell profile still
        // heals a crash on the next terminal either way; the task adds no restart
        // behaviour of its own.
        restarts: false,
        warnings: [
          'Created without restart-on-failure settings, so a crash is still healed by the shell profile on the next terminal rather than by this task. Restart-on-failure needs an elevated install and is not configured here.',
        ],
      };
    } catch (e) {
      warnings.push(`scheduled task creation failed (${String(e.message).split('\n')[0]}); falling back to the Startup folder`);
    }
  } else if (preferTask) {
    warnings.push('creating a Scheduled Task needs an elevated shell, so the Startup-folder launcher was used instead');
  }

  // Fallback: Startup folder, hidden launch.
  const dir = startupDir();
  const p = launcherPath();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, buildLauncherForTest(nodeExe, entry));
  } catch (e) {
    return { mechanism: 'none', detail: null, restarts: false, warnings: [...warnings, `could not write the Startup launcher: ${e.message}`] };
  }
  return {
    mechanism: 'startup-folder',
    detail: p,
    // Not a supervisor in the strict sense -- it starts the daemon at logon and
    // nothing more. But the shell profile relaunches a stale daemon whenever a
    // terminal opens, so a crash is now recovered from at the moment a user would
    // notice. The caveat that matters is the *gap* between dying and the next
    // shell, not an absence of recovery.
    restarts: true,
    warnings: [
      ...warnings,
      'recovery is on next shell start, not automatic: a crash is healed the next time you open a terminal, not the instant it happens. Run `wd status` to confirm it is alive now.',
    ],
  };
}

export function removeAutostart() {
  const removed = [];
  const p = launcherPath();
  if (existsSync(p) && isOurLauncher(p)) {
    unlinkSync(p);
    removed.push({ mechanism: 'startup-folder', detail: p });
  }
  try {
    sh('schtasks.exe', ['/delete', '/tn', TASK_NAME, '/f']);
    removed.push({ mechanism: 'scheduled-task', detail: TASK_NAME });
  } catch {
    /* not present, or not permitted - nothing to remove */
  }
  return removed;
}

/** Only ever delete a launcher we wrote, never someone else's Startup entry. */
function isOurLauncher(p) {
  try {
    return readFileSync(p, 'utf8').includes(MARKER);
  } catch {
    return false;
  }
}

/** What is registered, independent of whether anything is actually running. */
export function autostartStatus() {
  const found = [];
  const p = launcherPath();
  if (existsSync(p) && isOurLauncher(p)) {
    found.push({ mechanism: 'startup-folder', detail: p, installedAt: safeMtime(p) });
  }
  try {
    sh('schtasks.exe', ['/query', '/tn', TASK_NAME, '/fo', 'LIST', '/v']);
    found.push({ mechanism: 'scheduled-task', detail: TASK_NAME });
  } catch {
    /* not registered */
  }
  return {
    installed: found.length > 0,
    entries: found,
    canUseScheduledTask: isElevated(),
  };
}

function safeMtime(p) {
  try {
    return statSync(p).mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * The coverage verdict.
 *
 * Extracted from the CLI so it can be tested. Two facts are tracked separately --
 * "registered at logon" and "alive right now" -- because conflating them is the
 * failure this whole mechanism exists to prevent: a user who sees only the first
 * reasonably assumes they are protected while nothing is watching.
 *
 * All four combinations have a distinct message. The one that previously had none
 * was registered=false/alive=true: covered for now, silently unprotected after the
 * next logoff.
 */
export function coverageVerdict({ registered, beatState }) {
  const alive = beatState === 'running';

  if (registered && alive) {
    // The one state that could be read as a blanket promise, so it is worded as
    // what it actually is: a live daemon. Alive is not comprehensive. Only shells
    // that load the hook are instrumented, a terminal opened before installation
    // stays uninstrumented until it is reopened, and the ConPTY layer is off.
    // `wd doctor` breaks the rest down per layer.
    return {
      level: 'ok',
      headline: 'Daemon covered: registered at logon and alive right now.',
      lines: [
        'That is liveness, not full coverage: only hooked shells are instrumented,',
        'and a terminal opened before installation is not covered until reopened.',
      ],
    };
  }
  if (registered && !alive) {
    return {
      level: 'bad',
      headline: 'REGISTERED BUT NOT RUNNING - you are NOT being covered.',
      lines: [
        'The launcher is in place but no live daemon is beating. This is the',
        'dangerous state: it looks installed and silently protects nothing.',
        'Fix: run `wd start` now, and check `wd status` after the next logon.',
      ],
    };
  }
  if (!registered && alive) {
    return {
      level: 'warn',
      headline: 'RUNNING NOW, BUT NOT AT NEXT LOGON.',
      lines: [
        'A live daemon is watching, but nothing is registered to start it again.',
        'Run `wd autostart` to keep it running after a reboot or logoff.',
      ],
    };
  }
  return {
    level: 'warn',
    headline: 'Nothing is watching your terminals.',
    lines: ['wd autostart   start the daemon at every logon', 'wd start       run it once, in the foreground'],
  };
}
/** Startup folder entries, used to surface anything unexpected. */
export function startupEntries() {
  try {
    return readdirSync(startupDir()).filter((f) => f.toLowerCase().endsWith('.vbs') || f.toLowerCase().endsWith('.cmd') || f.toLowerCase().endsWith('.lnk'));
  } catch {
    return [];
  }
}


