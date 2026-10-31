import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function reservePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose());
  });
  return address.port;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const result = await Promise.race([
    exited.then(() => 'exited'),
    new Promise(resolveTimeout => {
      const timer = setTimeout(() => resolveTimeout('timeout'), 3000);
      timer.unref();
    }),
  ]);
  if (result === 'timeout' && child.exitCode === null && child.signalCode === null) {
    const forceExit = once(child, 'exit');
    child.kill('SIGKILL');
    await forceExit;
  }
}

function postChunkedOversizedBody(port) {
  return new Promise((resolveResponse, rejectResponse) => {
    const req = request({
      hostname: '127.0.0.1',
      port,
      path: '/api/session',
      method: 'POST',
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
      },
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          resolveResponse({ status: res.statusCode, body: JSON.parse(raw) });
        } catch (error) {
          rejectResponse(error);
        }
      });
    });

    req.once('error', rejectResponse);
    // No Content-Length is sent: the gateway must enforce its byte limit while
    // streaming and must not rely on a declared request size.
    req.write('{"pairingCode":"');
    req.write('x'.repeat(5000));
    req.write('","padding":"');
    req.write('y'.repeat(5000));
    req.end('"}');
  });
}

test('chunked oversized session request receives deterministic 413 without retaining the body', async t => {
  const port = await reservePort();
  const child = spawn(process.execPath, ['src/agent/web-gateway.mjs'], {
    cwd: ROOT,
    env: { ...process.env, WD_WEB_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(() => stopChild(child));

  await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      rejectReady(new Error(`gateway did not start on port ${port}: ${output}`));
    }, 5000);
    const ready = () => {
      if (!output.includes(`URL: http://127.0.0.1:${port}`)) return;
      clearTimeout(timer);
      resolveReady();
    };
    child.stdout.on('data', ready);
    child.once('error', error => {
      clearTimeout(timer);
      rejectReady(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      rejectReady(new Error(`gateway exited before listening (code=${code}, signal=${signal})`));
    });
  });

  const response = await postChunkedOversizedBody(port);
  assert.equal(response.status, 413);
  assert.deepEqual(response.body, { error: 'request body too large' });
  assert.equal(child.exitCode, null, 'gateway must remain alive after rejecting the request');
});
