/**
 * Test helper: a stub CLI that behaves like `opencode run --format json`.
 *
 * It must go through the real Windows launch path (cmd.exe /d /s /c) rather than
 * bypassing it, and it must emit the exact NDJSON event stream the real CLI does.
 *
 * `cmd.exe echo` cannot emit quotes faithfully -- it writes backslashes literally
 * -- so emitting JSON from a batch file corrupts it. A node script is the honest
 * way to produce the real bytes.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One `{type:"text"}` event carrying `text` as the model's answer. */
export const evText = (text) =>
  JSON.stringify({
    type: 'text',
    timestamp: 2,
    sessionID: 'ses_x',
    part: { id: 'p1_text-0', type: 'text', text, time: { start: 1, end: 2 } },
  });

export const evStepStart = () =>
  JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 'ses_x', part: { id: 'p1', type: 'step-start' } });

/** @returns {{cmd: string, dir: string}} path to the stub, plus its scratch dir */
export function makeStubCli(prefix, lines) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const js = join(dir, 'stub.js');
  const cmd = join(dir, 'stubcli.cmd');
  writeFileSync(js, 'process.stdout.write(' + JSON.stringify(lines.join('\n') + '\n') + ');\n');
  writeFileSync(cmd, '@echo off\r\n"' + process.execPath + '" "' + js + '" %*\r\n');
  return { cmd, dir };
}

/** Convenience: a stub that replies with a single text event. */
export function stubAnswering(answer) {
  return makeStubCli('wd-ans-', [evText(answer)]);
}

/** Convenience: a stub that returns a provider error envelope verbatim. */
export function stubErroring(errorObj) {
  return makeStubCli('wd-err-', [
    JSON.stringify({ type: 'error', timestamp: 1790680375149, sessionID: 'ses_x', error: errorObj }),
  ]);
}
