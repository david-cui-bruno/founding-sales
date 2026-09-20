import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The workspace packages resolve to their sources; the greenfield tree is never built
// before it is tested. Nothing here needs a database or a browser: the Playwright
// specs under test/e2e live behind `npm run test:e2e`.
export default defineConfig({
  resolve: {
    alias: {
      '@fss/contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
