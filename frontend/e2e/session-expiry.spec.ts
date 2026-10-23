import { expect, test } from '@playwright/test';

test('returns to pairing when the local snapshot session expires', async ({ page }) => {
  let expireSession = false;

  await page.route('**/api/session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'paired' }),
    });
  });

  await page.route('**/api/snapshot', async (route) => {
    if (expireSession) {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'session expired' }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        watchdog: { state: 'running', detail: 'test gateway' },
        findings: [],
        journal: [],
      }),
    });
  });

  await page.goto('/');
  await page.getByLabel('One-time pairing code').fill('test-pairing-code');
  await page.getByRole('button', { name: /Connect securely/ }).click();
  await expect(page.getByRole('button', { name: 'Refresh snapshot' })).toBeVisible();

  expireSession = true;
  await page.getByRole('button', { name: 'Refresh snapshot' }).click();

  await expect(page.getByRole('heading', { name: /Connect your agent/ })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Your local session expired');
});
