import { defineConfig } from 'playwright/test';

export default defineConfig({
  // PR diff metadata fetches the base with --depth=1 in Playwright 1.62.
  // Preserve the full checkout required by release provenance and secret scans.
  captureGitInfo: { diff: false },
});
