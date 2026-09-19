import { defineConfig } from 'playwright/test';

// The specs launch the built client (main, preload and renderer bundles under `.vite/`) as a real
// Electron app against the stub worker in `tests/stubWorker.ts`. `globalSetup` builds those bundles once.
export default defineConfig({
  testDir: 'tests',
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
  globalSetup: './tests/support/globalSetup.ts',
  // PR diff metadata fetches the base with --depth=1 in Playwright 1.62; keep the full checkout that
  // release provenance and the secret scan rely on (same as the root configuration).
  captureGitInfo: { diff: false },
});
