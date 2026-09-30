/**
 * Windows refuses to execute `.cmd`/`.bat` shims through CreateProcess, so
 * anything that resolves to one has to be launched via cmd.exe. Two consequences
 * that are easy to get wrong:
 *
 *  1. `shell: true` with a caller-supplied argument list is a command-injection
 *     vector (Node flags it as DEP0190). It is never used here.
 *  2. Whatever DOES reach the command line must not contain untrusted text. In
 *     this project that means terminal output always travels over stdin, never as
 *     an argument. Only fixed flags and config-supplied values are passed as argv.
 */
import { spawn } from 'node:child_process';

// Allowed: letters, digits and the punctuation that legitimately appears in
// model ids (opencode uses `provider/model#variant`), paths and versions.
// Deliberately excluded: % (cmd.exe variable expansion), & | < > ^ ! ( (cmd.exe
// control operators), and whitespace/quotes.
const SAFE_ARG = /^[A-Za-z0-9._:@/+#-]+$/;

/** Reject values that could break out of a cmd.exe command line. */
export function assertSafeArg(name, value) {
  if (typeof value !== 'string' || !SAFE_ARG.test(value)) {
    throw new Error(`refusing to pass unsafe value for ${name} on a Windows command line: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Turn an argv into something spawn() can run without `shell: true`.
 *
 * Verified on Windows: spawning a bare `npm` with shell:false gives ENOENT, and
 * spawning `npm.cmd` throws EINVAL *synchronously*. Only a real .exe/.com can be
 * executed directly, so everything else -- bare names, .cmd, .bat -- is handed to
 * cmd.exe, which resolves it through PATHEXT itself. Passing args through to
 * cmd.exe is safe only because untrusted text never appears among them.
 */
export function makeRunnable(argv) {
  const [bin, ...rest] = argv;
  if (process.platform !== 'win32') return { cmd: bin, args: rest };
  if (/\.(exe|com)$/i.test(bin)) return { cmd: bin, args: rest };
  return { cmd: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', bin, ...rest] };
}

/**
 * Spawn a process, feed it a prompt on stdin, and collect stdout.
 * Never rejects: transport problems resolve to a tagged string so callers can
 * distinguish "the tool said no" from "the tool never ran".
 *
 * @returns {Promise<string>} stdout, or a `__WD_*__` sentinel describing the failure.
 */
export function runCapture({ cmd, args, cwd, stdin, timeoutMs = 180_000, maxBuffer = 8 * 1024 * 1024 }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve('__WD_SPAWNFAIL__' + e.message);
    }

    let out = '';
    let errBuf = '';
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve(v);
    };

    const timer = setTimeout(() => finish('__WD_TIMEOUT__' + timeoutMs), timeoutMs);
    if (timer.unref) timer.unref();

    child.stdout.on('data', (d) => {
      if (out.length < maxBuffer) out += d;
    });
    child.stderr.on('data', (d) => {
      if (errBuf.length < 8192) errBuf += d;
    });
    child.on('error', (e) => finish('__WD_SPAWNFAIL__' + e.message));
    child.on('close', (code) => {
      if (out.trim()) return finish(out); // a JSON error envelope is still valid output
      if (code !== 0) return finish('__WD_EXIT__' + code + ': ' + errBuf.slice(0, 300));
      finish(out);
    });

    child.stdin.on('error', () => { /* EPIPE when the child exits early */ });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}
