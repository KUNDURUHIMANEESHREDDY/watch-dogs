import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..');
const PORT = 4317;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let gatewayProcess: ChildProcess | undefined;
let pairingCode: string | undefined;

async function waitForGatewayRoot(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(BASE_URL);
      if (response.status === 200) return;
    } catch {
      // The listener may need a short moment after the pairing code is printed.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('The real gateway did not serve its root page within 5 seconds.');
}

async function startGateway(): Promise<string> {
  if (gatewayProcess && gatewayProcess.exitCode === null) {
    throw new Error('The test gateway is already running.');
  }

  const child = spawn(process.execPath, ['src/agent/web-gateway.mjs'], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, WD_WEB_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  gatewayProcess = child;

  let started = false;
  let stderr = '';
  const code = await new Promise<string>((resolveCode, rejectCode) => {
    const startupTimeout = setTimeout(() => {
      child.kill('SIGTERM');
      rejectCode(new Error('Timed out waiting for the real gateway pairing code.'));
    }, 15_000);

    const lines = createInterface({ input: child.stdout! });
    lines.on('line', (line) => {
      const match = line.match(/^Pairing code \(enter in browser; never share\): ([A-Za-z0-9_-]+)$/);
      if (match) {
        started = true;
        clearTimeout(startupTimeout);
        // The code stays in process memory and is deliberately never echoed into CI logs.
        resolveCode(match[1]);
      } else if (line.trim()) {
        console.log(`[real-gateway] ${line}`);
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const message = chunk.toString();
      stderr += message;
      if (message.trim()) console.error(`[real-gateway stderr] ${message.trim()}`);
    });

    child.once('error', (error) => {
      clearTimeout(startupTimeout);
      rejectCode(error);
    });
    child.once('exit', (exitCode, signal) => {
      if (gatewayProcess === child) gatewayProcess = undefined;
      if (!started) {
        clearTimeout(startupTimeout);
        rejectCode(new Error(`Gateway exited before startup (code=${exitCode}, signal=${signal}). ${stderr}`));
      }
    });
  });

  pairingCode = code;
  await waitForGatewayRoot();
  return code;
}

async function stopGateway(): Promise<void> {
  const child = gatewayProcess;
  gatewayProcess = undefined;
  if (!child || child.exitCode !== null) return;

  await new Promise<void>((resolveStop) => {
    const forceStop = setTimeout(() => child.kill('SIGKILL'), 4_000);
    child.once('exit', () => {
      clearTimeout(forceStop);
      resolveStop();
    });
    child.kill('SIGTERM');
  });
}

async function pairWithGateway(page: Page, code: string): Promise<Record<string, any>> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Connect your agent/ })).toBeVisible();
  await page.getByLabel('One-time pairing code').fill(code);

  const snapshotResponse = page.waitForResponse(
    (response) => response.url() === `${BASE_URL}/api/snapshot` && response.status() === 200,
  );
  await page.getByRole('button', { name: /Connect securely/ }).click();

  const response = await snapshotResponse;
  const snapshot = await response.json() as Record<string, any>;
  expect(snapshot.protocol).toBe('watchdogs.local.v1');
  expect(snapshot.agent?.host).toBe('127.0.0.1');
  expect(snapshot.agent?.port).toBe(PORT);
  expect(snapshot.agent?.version).toBe(process.version);
  await expect(page.getByRole('heading', { name: /Overview/ })).toBeVisible();
  return snapshot;
}

test.beforeAll(async () => {
  pairingCode = await startGateway();
});

test.afterAll(async () => {
  await stopGateway();
});

test('real gateway uses an HttpOnly session, revocation returns 401, and re-pair restores the UI', async ({ page }) => {
  const code = pairingCode!;
  const snapshot = await pairWithGateway(page, code);

  const oversizedResponse = await fetch(`${BASE_URL}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairingCode: code, padding: 'x'.repeat(10 * 1024) }),
  });
  expect(oversizedResponse.status).toBe(413);
  await expect(oversizedResponse.json()).resolves.toEqual({ error: 'request body too large' });
  console.log(`Real gateway verified: Node ${snapshot.agent.version}, PID ${snapshot.agent.pid}, port ${snapshot.agent.port}.`);

  const cookie = (await page.context().cookies(BASE_URL)).find((candidate) => candidate.name === 'wd_session');
  expect(cookie, 'The gateway should issue its session cookie.').toBeDefined();
  expect(cookie!.httpOnly).toBe(true);
  expect(cookie!.sameSite).toBe('Strict');
  expect(await page.evaluate(() => document.cookie)).not.toContain('wd_session=');

  // Revoke from outside the browser app so it retains its cookie and must handle a real 401.
  const revoke = await fetch(`${BASE_URL}/api/session/logout`, {
    method: 'POST',
    headers: {
      Origin: BASE_URL,
      'Content-Type': 'application/json',
      Cookie: `wd_session=${cookie!.value}`,
    },
    body: '{}',
  });
  expect(revoke.status).toBe(200);

  const revokedSnapshot = await fetch(`${BASE_URL}/api/snapshot`, {
    headers: { Cookie: `wd_session=${cookie!.value}` },
  });
  expect(revokedSnapshot.status).toBe(401);

  await expect(page.getByRole('heading', { name: /Connect your agent/ })).toBeVisible({ timeout: 12_000 });
  await expect(page.locator('.app-shell')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Your local session expired');

  await pairWithGateway(page, code);
  await page.getByRole('button', { name: 'Activity history' }).click();
  await expect(page.getByRole('heading', { name: /Activity history/ })).toBeVisible();
});

test('gateway outage stays distinct from session expiry; restart invalidates old sessions and allows re-pairing', async ({ page }) => {
  const originalCode = pairingCode!;
  await pairWithGateway(page, originalCode);

  await stopGateway();
  await expect(page.getByText('Gateway unavailable')).toBeVisible({ timeout: 15_000 });
  // A network outage must not be mistaken for authentication expiry.
  await expect(page.getByRole('heading', { name: /Overview/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Connect your agent/ })).toHaveCount(0);

  const restartedCode = await startGateway();
  expect(restartedCode).not.toBe(originalCode);
  // Sessions are in memory; a gateway restart must reject the old browser cookie.
  await expect(page.getByRole('heading', { name: /Connect your agent/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('alert')).toContainText('Your local session expired');

  const recoveredSnapshot = await pairWithGateway(page, restartedCode);
  expect(recoveredSnapshot.protocol).toBe('watchdogs.local.v1');
  await page.getByRole('button', { name: 'Activity history' }).click();
  await expect(page.getByRole('heading', { name: /Activity history/ })).toBeVisible();
});
