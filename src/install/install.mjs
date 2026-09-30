/**
 * Idempotent installer. Every edit is append-only and marker-delimited, so
 * re-running is safe and uninstall is exact. Existing user profiles are never
 * overwritten -- if a profile already exists we append a guarded block.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { log } from '../core/log.mjs';

const BEGIN = '# >>> watchdog begin >>> (managed block - do not edit, safe to delete)';
const END = '# <<< watchdog end <<<';

export function effectivePsProfile() {
  // Ask PowerShell where it actually loads from. On this machine Documents is
  // redirected to OneDrive, so guessing "Documents" writes a file nothing reads.
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '$PROFILE.CurrentUserAllHosts'],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true },
    ).trim();
    if (out) return out;
  } catch (e) {
    log.debug(`could not query $PROFILE: ${e.message}`);
  }
  return join(homedir(), 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
}

/**
 * NOTE: these are String.raw templates on purpose. In a normal JS template
 * literal, a Windows path like '.watchdog\bin' contains `\b`, which JavaScript
 * silently turns into a BACKSPACE character. That produced a profile that threw
 * "Illegal characters in path" on every single shell start. String.raw keeps the
 * backslashes literal.
 */

/** Works for both PowerShell 5.1 and pwsh 7. */
export const buildProfileBlock = (nodeExe) => String.raw`${BEGIN}
$env:WD_DISABLE = $null
$__wdRoot = Join-Path $env:USERPROFILE '.watchdog'
$__wdBin  = Join-Path $__wdRoot 'bin'
try {
  if (Test-Path $__wdBin) { $env:PATH = "$__wdBin;$env:PATH" }
  Set-Alias -Name wd -Value (Join-Path $__wdBin 'wd.ps1') -Scope Global -ErrorAction SilentlyContinue
} catch { }

# --- capture ---
# Uses only built-in PowerShell: no node process is spawned at shell start, so
# startup latency stays flat. The daemon discovers these files on its own.
try {
  if (-not $env:WD_DISABLE) {
    # WD_TRANSCRIPT_DIR must be honoured here as well as in the daemon, or the
    # shell would write somewhere the daemon never looks. See transcriptDir().
    $__wdT = if ($env:WD_TRANSCRIPT_DIR) { $env:WD_TRANSCRIPT_DIR } else { Join-Path $__wdRoot 'transcripts' }
    if (-not (Test-Path $__wdT)) { New-Item -ItemType Directory -Path $__wdT -Force | Out-Null }
    $__wdIde = 'unknown'
    if ($env:WT_PROFILE_ID) { $__wdIde = 'Windows Terminal' }
    elseif ($env:VSCODE_PID -or $env:TERM_PROGRAM -eq 'vscode') { $__wdIde = 'VS Code / Cursor' }
    elseif ($env:GOORU_IDE) { $__wdIde = 'GoLand' }
    elseif ($env:WT_SESSION) { $__wdIde = 'Windows Terminal' }
    $__wdF = Join-Path $__wdT ('ps-{0}-{1}.log' -f $PID, (Get-Date -Format 'yyyyMMdd-HHmmss'))
    # Assigning to $null suppresses the "Transcript started" host message, which
    # would otherwise print into the user's prompt on every single shell start.
    $null = Start-Transcript -Path $__wdF -Append -ErrorAction SilentlyContinue
    # --- self-heal ------------------------------------------------------------
    # The Startup folder can start the daemon but cannot restart it, so a crash
    # means no coverage until someone notices. Every new shell is a chance to
    # notice and fix that -- which is exactly when a user would want to know.
    #
    # PowerShell-native on purpose: the fast path is one small file read. Spawning
    # node here instead would add ~200ms to the start of every single shell.
    try {
      $__wdIdx = Join-Path $env:USERPROFILE '.watchdog\daemons.json'
      if (Test-Path $__wdIdx) {
        $__wdNode = '${nodeExe}'
        $__wdDone = @{}
        # Every stale project is relaunched, not just the first. Restarting one
        # would leave the rest uncovered while making the machine look healed,
        # which is worse than the original single-project failure.
        foreach ($__wdD in @((Get-Content $__wdIdx -Raw | ConvertFrom-Json))) {
          if (-not $__wdD.lastBeat -or -not $__wdD.entry) { continue }
          $__wdA = ((Get-Date) - [datetime]::Parse($__wdD.lastBeat)).TotalSeconds
          if ($__wdA -le 45) { continue }
          # One relaunch per project, even if the index lists it twice.
          if ($__wdDone.ContainsKey($__wdD.projectRoot)) { continue }
          if ((Test-Path $__wdNode) -and (Test-Path $__wdD.entry) -and (Test-Path $__wdD.projectRoot)) {
            $__wdDone[$__wdD.projectRoot] = $true
            # Detached and hidden: this shell must never wait on the daemon.
            # Start-Process does NOT quote ArgumentList elements, and this path contains a space, so it must be quoted or node gets a truncated path and dies.
            Start-Process -FilePath $__wdNode -ArgumentList ('"{0}" start' -f $__wdD.entry) -WorkingDirectory $__wdD.projectRoot -WindowStyle Hidden
          }
        }
      }
    } catch { }
    @{
      shell = 'powershell'
      pid   = $PID
      cwd   = (Get-Location).Path
      file  = $__wdF
      ide   = $__wdIde
      startedAt = (Get-Date).ToString('o')
    } | ConvertTo-Json | Set-Content -Path ($__wdF + '.json') -Encoding UTF8
  }
} catch { }
${END}`;

/**
 * The bash managed block, exposed so tests can assert on the text that actually
 * gets written to .bashrc. It is a separate block from the PowerShell one and
 * needs the same guarantees: it must honour WD_TRANSCRIPT_DIR, and it must not
 * contain a dollar-brace that a JS template literal would eat.
 */
export const buildBashBlock = () => BASH_BLOCK;

const BASH_BLOCK = String.raw`# >>> watchdog begin >>> (managed block - do not edit, safe to delete)
export WD_DISABLE=
if [ -n "$WD_DISABLE" ]; then return 0 2>/dev/null || true; fi
export PATH="$HOME/.watchdog/bin:$PATH"
# Git Bash: record each session so the daemon can tail it.
if [ -n "$HOME" ]; then
  # Same override as the PowerShell block, spelled without bash brace syntax:
  # these blocks live inside JS template literals, where a dollar-brace is read as
  # JS interpolation and silently truncates the file.
  __wd_t="$WD_TRANSCRIPT_DIR"
  if [ -z "$__wd_t" ]; then __wd_t="$HOME/.watchdog/transcripts"; fi
  mkdir -p "$__wd_t" 2>/dev/null
  __wd_f="$__wd_t/ba-$$-$(date +%Y%m%d-%H%M%S).log"
  printf '{"shell":"bash","pid":%s,"cwd":"%s","file":"%s","ide":"Git Bash"}\n' \
    "$$" "$(pwd)" "$__wd_f" > "$__wd_f.json" 2>/dev/null
  # script(1) is present in Git for Windows; without it we still get a header.
  if command -v script >/dev/null 2>&1; then
    script -q -f "$__wd_f" >/dev/null 2>&1
  fi
  unset __wd_t __wd_f
fi
# <<< watchdog end <<<`;

/** Kept tiny: a broken profile line would break every shell the user opens. */
export const HOOK_PS1 = String.raw`# watchdog shell hook (managed)
$ErrorActionPreference = 'Continue'
if ($env:WD_DISABLE) { return }
$__wdBin = Join-Path $env:USERPROFILE '.watchdog\bin'
if (-not (Test-Path $__wdBin)) { return }
$env:PATH = "$__wdBin;$env:PATH"
Set-Alias -Name wd -Value (Join-Path $__wdBin 'wd.ps1') -Scope Global -ErrorAction SilentlyContinue
`;

export const HOOK_SH = `# watchdog shell hook (managed)
export PATH="$HOME/.watchdog/bin:$PATH"
`;

function upsertBlock(file, begin, end, block) {
  mkdirSync(dirname(file), { recursive: true });
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const start = existing.indexOf(begin);
  const endIdx = existing.indexOf(end);

  if (start !== -1 && endIdx !== -1 && endIdx > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(endIdx + end.length);
    const next = before + block + after;
    if (next !== existing) writeFileSync(file, next);
    return { file, action: 'updated', hadUserContent: existing.slice(0, start).trim().length > 0 };
  }

  const sep = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  if (existing.length > 0 && !file.endsWith('.ps1')) {
    // .bashrc has no notion of a trailing newline guarantee; keep it tidy.
  }
  writeFileSync(file, existing + sep + block + '\n');
  return { file, action: existing.length ? 'appended' : 'created', hadUserContent: existing.trim().length > 0 };
}

function installHooks(binDir, entryScript) {
  mkdirSync(binDir, { recursive: true });
  const hookPs1 = join(binDir, 'wd-hook.ps1');
  const hookSh = join(binDir, 'wd-hook.sh');
  writeFileSync(hookPs1, HOOK_PS1);
  writeFileSync(hookSh, HOOK_SH);

  // Absolute-path shims: PATH injection must not depend on cwd.
  const cmdShim = join(binDir, 'wd.cmd');
  writeFileSync(cmdShim, ['@echo off', `"${process.execPath}" "${entryScript}" %*`, ''].join('\r\n'));

  const ps1Shim = join(binDir, 'wd.ps1');
  writeFileSync(ps1Shim, `& '${process.execPath}' '${entryScript}' @args\n`);

  return { hookPs1, hookSh, cmdShim, ps1Shim };
}

export function install({ toolRoot, shells = ['powershell', 'bash'], ides = ['Code', 'Cursor'] }) {
  const home = homedir();
  const binDir = join(home, '.watchdog', 'bin');
  const results = { hooks: null, profiles: [], ides: [], notes: [] };

  const entryScript = join(toolRoot, 'bin', 'wd.js');
  results.hooks = installHooks(binDir, entryScript);

  if (shells.includes('powershell')) {
    const profile = effectivePsProfile();
    results.profiles.push(upsertBlock(profile, BEGIN, END, buildProfileBlock(process.execPath)));
    if (profile.toLowerCase().includes('onedrive')) {
      results.notes.push(
        `PowerShell profile resolved into OneDrive: ${profile}\n` +
          '  This is the file PowerShell actually reads, so it is the correct target - but OneDrive sync can hold a lock on it.',
      );
    }
  }

  if (shells.includes('bash')) {
    const bashrc = join(homedir(), '.bashrc');
    results.profiles.push(upsertBlock(bashrc, '# >>> watchdog begin >>>', '# <<< watchdog end <<<', BASH_BLOCK));
    results.notes.push('Git Bash reads ~/.bashrc; Git for Windows also needs /etc/bash.bashrc if you use it for aliases.');
  }

  for (const ide of ides) results.ides.push(ideTerminalHint(ide));

  return results;
}

/**
 * IDEs inherit the same PowerShell profile, so the managed block covers their
 * integrated terminals automatically. We do not rewrite the user's settings.json -
 * that risks breaking their layout for no gain.
 */
function ideTerminalHint(ide) {
  const appData = process.env.APPDATA;
  const settings = ide === 'Cursor' ? join(appData, 'Cursor', 'User', 'settings.json') : join(appData, 'Code', 'User', 'settings.json');
  return {
    ide,
    settingsPath: settings,
    settingsExists: existsSync(settings),
    note: 'integrated terminals load the PowerShell profile, so the managed block already applies. No settings.json edit required.',
  };
}

export function uninstall({ shells = ['powershell', 'bash'] } = {}) {
  const removed = [];
  if (shells.includes('powershell')) {
    const p = effectivePsProfile();
    if (existsSync(p) && stripBlock(p)) removed.push(p);
  }
  const bashrc = join(homedir(), '.bashrc');
  if (existsSync(bashrc) && stripBlock(bashrc)) removed.push(bashrc);
  return removed;
}

function stripBlock(file) {
  const begin = file.endsWith('.ps1') ? BEGIN : '# >>> watchdog begin >>>';
  const end = file.endsWith('.ps1') ? END : '# <<< watchdog end <<<';
  const src = readFileSync(file, 'utf8');
  const s = src.indexOf(begin);
  const e = src.indexOf(end);
  if (s === -1 || e === -1 || e < s) return false;
  writeFileSync(file, src.slice(0, s) + src.slice(e + end.length).replace(/^\n/, ''));
  return true;
}
