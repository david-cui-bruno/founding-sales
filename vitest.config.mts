// eslint-disable-next-line import/no-unresolved -- Vitest exposes this ESM-only config subpath.
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      'tests/e2e/**',
      'tests/browser/**',
      // The thin client is its own package with its own Vitest and Playwright runs (client/).
      'client/**',
      // The greenfield workspace packages run under `npm run test:greenfield`, one Vitest
      // project each, against a real PostgreSQL 16. The old gate never runs them.
      'apps/**',
      'packages/**',
      '.worktrees/**',
      'test/appleBridgeBuild.test.mjs',
      'test/verifyAppleBridgePackage.test.mjs',
    ],
  },
});
