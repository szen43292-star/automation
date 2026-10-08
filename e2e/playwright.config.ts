import { defineConfig, devices } from '@playwright/test';

/**
 * Runs against a live server: `FLOWFORGE_URL` (default http://localhost:5678).
 * Set `PW_CHROMIUM_PATH` to use a pre-installed Chromium instead of `npx playwright install`.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.FLOWFORGE_URL ?? 'http://localhost:5678',
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH
      ? { executablePath: process.env.PW_CHROMIUM_PATH }
      : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
