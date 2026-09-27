import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The workspace packages resolve to their sources; the greenfield tree is never built
// before it is tested. Nothing here needs a database or a browser: the Playwright
// specs under test/e2e live behind `npm run test:e2e`.
//
// `.tsx` is in `include` since 1.0.12, and the component tests ask for jsdom in their own
// docblock (`@vitest-environment jsdom`) rather than here — the main-process and view-model
// suites are the large majority and they are faster in `node`.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@fss/contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    testTimeout: 15_000,
  },
});
