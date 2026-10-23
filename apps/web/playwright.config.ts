import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list']],
  use: { browserName: 'chromium', headless: true, ignoreHTTPSErrors: true,
    ...(process.env['FSS_LOCAL_BROWSER_EXECUTABLE'] ? { launchOptions: { executablePath: process.env['FSS_LOCAL_BROWSER_EXECUTABLE'] } } : {}),
  },
  captureGitInfo: { diff: false },
});
