// eslint-disable-next-line import/no-unresolved -- Vitest exposes this ESM-only config subpath.
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      'tests/e2e/**',
      '.worktrees/**',
      'test/appleBridgeBuild.test.mjs',
      'test/verifyAppleBridgePackage.test.mjs',
    ],
  },
});
