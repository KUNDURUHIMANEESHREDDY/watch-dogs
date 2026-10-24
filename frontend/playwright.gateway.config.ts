import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e-gateway',
  testMatch: '**/*.gateway.e2e.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4317',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-real-gateway',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
