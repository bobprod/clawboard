import { defineConfig, devices } from '@playwright/test';

/**
 * ClawBoard — Playwright E2E configuration.
 *
 * Requires both dev server (Vite :5173) and backend (:4000) to be running.
 * Use `reuseExistingServer: true` so CI / manual runs both work.
 *
 * Run: npx playwright test
 */
export default defineConfig({
  testDir: '.',
  fullyParallel: false,   // in-memory state means tests must not race
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,

  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '../../test-results/playwright-report' }],
  ],

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
    actionTimeout: 10_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
  ],

  webServer: [
    {
      command: 'node server.mjs',
      port: 4000,
      reuseExistingServer: true,
      timeout: 10_000,
    },
    {
      command: 'npm run dev',
      port: 5173,
      reuseExistingServer: true,
      timeout: 20_000,
    },
  ],
});
