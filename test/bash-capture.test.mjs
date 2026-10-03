/**
 * Bash capture.
 *
 * The .bashrc block used to call `script` directly. Given no command, `script`
 * launches its own interactive shell, so that nested a shell inside the one
 * already starting and waited for it. On this machine it never fired at all,
 * because Git for Windows does not ship `script` -- which meant the block
 * advertised a transcript that could not exist, and the daemon discovered a
 * session whose file was never going to grow.
 *
 * The fix moves `script` outside the shell, into a wrapper. These tests pin the
 * properties that matter rather than the exact text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBashBlock, buildProfileBlock, WRAPPER_SH, HOOK_PS1 } from '../src/install/install.mjs';

const block = buildBashBlock();

// ---------------------------------------------------------------- the block

test('the .bashrc block never launches script', () => {
  // The nesting bug. Match a real invocation, not the word in a comment.
  const invokes = block.match(/^\s*(?:command\s+)?script\s+-/m);
  assert.equal(invokes, null, `the block still runs script: ${invokes && invokes[0]}`);
});

test('the .bashrc block does not clear WD_DISABLE', () => {
  // The block used to open with `export WD_DISABLE=`, destroying the user's
  // documented opt-out before anything could read it.
  assert.ok(
    !/^\s*export\s+WD_DISABLE=\s*$/m.test(block),
    'the block resets WD_DISABLE, so the documented opt-out can never take effect',
  );
  assert.match(block, /if \[ -n "\$WD_DISABLE" \]/, 'the block no longer reads WD_DISABLE');
});

test('a session is announced only when a capture file really exists', () => {
  // Advertising a transcript that was never going to be written is worse than
  // advertising nothing: the daemon would tail a file that never grew.
  assert.match(block, /-n "\$WD_BASH_CAPTURE_FILE"/);
  assert.match(block, /-f "\$WD_BASH_CAPTURE_FILE"/, 'the sidecar is written without checking the file exists');
  assert.ok(
    block.includes('$WD_BASH_CAPTURE_FILE.json'),
    'the sidecar is not named after the transcript it describes',
  );
});

test('the block stays additive: it keeps PATH and adds nothing destructive', () => {
  assert.match(block, /export PATH="\$HOME\/\.watchdog\/bin:\$PATH"/);
  // A managed block that can exit the shell would break every bash session.
  assert.ok(!/^\s*exit\s/m.test(block), 'the block exits the shell');
  assert.ok(!/^\s*exec\s/m.test(block), 'the block execs something, replacing the user shell');
});

// ------------------------------------------------------------- the wrapper

test('the wrapper wraps the shell from outside', () => {
  assert.ok(WRAPPER_SH.startsWith('#!/usr/bin/env bash'), 'no shebang, so it is not directly executable');
  assert.match(WRAPPER_SH, /export WD_BASH_CAPTURE_FILE=/, 'the wrapper does not tell the profile where the transcript is');

  // script must be handed an explicit shell to record. Given none, it starts its
  // own interactive one, which is the whole bug this file exists about.
  const execLine = WRAPPER_SH.split('\n').find((l) => /^exec script\b/.test(l));
  assert.ok(execLine, 'the wrapper does not exec script');
  assert.match(execLine, /\bbash\b/, `script is not given a shell to record: ${execLine}`);
  assert.match(execLine, /-f\s+"\$__wd_f"/, `script is not told where to write: ${execLine}`);
});

test('the wrapper reports the missing-script case instead of failing quietly', () => {
  // Git for Windows has no script(1). Silently producing nothing would be a
  // capture gap with no explanation anywhere.
  assert.match(WRAPPER_SH, /command -v script/, 'the wrapper does not check for script');
  assert.match(WRAPPER_SH, /cannot be captured/, 'the wrapper does not explain the limitation');
  assert.match(WRAPPER_SH, /exec bash "\$@"/, 'the wrapper does not fall through to a normal shell');
});

test('the wrapper creates the transcript before exporting it', () => {
  // The profile block only announces a session when the file exists, so the
  // wrapper has to create it first or the announcement is skipped.
  const createIdx = WRAPPER_SH.indexOf(': > "$__wd_f"');
  const exportIdx = WRAPPER_SH.indexOf('export WD_BASH_CAPTURE_FILE');
  assert.ok(createIdx !== -1, 'the wrapper never creates the transcript file');
  assert.ok(exportIdx !== -1);
  assert.ok(createIdx < exportIdx, 'the wrapper exports a path before creating it');
});

test('the wrapper honours WD_TRANSCRIPT_DIR like every other consumer', () => {
  assert.match(WRAPPER_SH, /WD_TRANSCRIPT_DIR/);
});

// ------------------------------------------------------------------- opt-out

test('neither profile block clears WD_DISABLE before reading it', () => {
  // The documented opt-out was destroyed by the very block meant to honour it.
  // PowerShell reset it to $null on line 1; bash exported it empty. Both then
  // went on to test a variable they had just wiped, so `WD_DISABLE=1` captured
  // everything anyway. A safety control that silently does nothing is worse than
  // an absent one, because it is documented as working.
  const ps = buildProfileBlock('C:/node/node.exe');
  assert.ok(
    !/\$env:WD_DISABLE\s*=\s*\$null/.test(ps),
    'the PowerShell block resets WD_DISABLE to $null before anything reads it',
  );
  assert.ok(
    !/^\s*export\s+WD_DISABLE=\s*$/m.test(block),
    'the bash block clears WD_DISABLE before anything reads it',
  );
});

test('both blocks actually test the opt-out rather than just mentioning it', () => {
  const ps = buildProfileBlock('C:/node/node.exe');
  assert.match(ps, /if \(-not \$env:WD_DISABLE\)/, 'the PowerShell block does not check WD_DISABLE');
  assert.match(block, /if \[ -n "\$WD_DISABLE" \]/, 'the bash block does not check WD_DISABLE');
  assert.match(HOOK_PS1, /if \(\$env:WD_DISABLE\) \{ return \}/, 'the PowerShell hook does not check WD_DISABLE');
});

// ------------------------------------------------------- redaction boundary

test('the transcript is written by the shell, so redaction cannot precede it', async () => {
  // A claim this codebase used to make in two places: that secrets are stripped
  // "before anything is written to disk". That is false. Start-Transcript writes
  // the raw session as the shell runs, and the daemon only sees it afterwards.
  //
  // This test cannot make the exposure go away -- nothing in-process can, because
  // the write belongs to PowerShell. What it can do is stop the documentation
  // quietly tightening back into a lie.
  const { readFileSync } = await import('node:fs');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const config = readFileSync(new URL('../src/core/config.mjs', import.meta.url), 'utf8');

  for (const [name, text] of [['README.md', readme], ['config.mjs', config]]) {
    const overclaims = text.match(/secrets?[^.\n]*?(?:before anything (?:is )?written to disk|before anything hits disk)/gi);
    assert.equal(overclaims, null, `${name} claims redaction happens before the shell's transcript exists: ${overclaims}`);
  }
  // The real boundary must still be documented, not just the false claim removed.
  assert.match(readme, /Start-Transcript/, 'the transcript exposure is no longer explained anywhere');
  assert.match(readme, /ACL|profile directory/, 'the actual mitigation is not stated');
});