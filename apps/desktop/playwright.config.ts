import { defineConfig } from 'playwright/test';

/**
 * The window specs. `npm run test:e2e --workspace apps/desktop`.
 *
 * They are not in `gate:greenfield`: the documented local install is
 * `npm install --ignore-scripts`, which deliberately skips the Electron download and
 * anything else with a postinstall, and a gate that needs a browser binary present is
 * a gate that fails for the wrong reason. See docs/decisions/g2-desktop-test-layers.md.
 */
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list']],
  use: { browserName: 'chromium' },
  // Playwright 1.62 fetches the PR base with --depth=1; the secret scan and release
  // provenance both need the full checkout, so the diff metadata stays off.
  captureGitInfo: { diff: false },
});
