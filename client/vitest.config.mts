// eslint-disable-next-line import/no-unresolved -- Vitest exposes this ESM-only config subpath.
import { defineConfig } from 'vitest/config';

// Unit tests live beside the main and preload sources. `tests/` holds the Playwright specs and
// the stub worker, which Playwright runs; Vitest must never pick those up.
export default defineConfig({
  resolve: { dedupe: ['zod'] },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'out/**', '.vite/**', 'tests/**'],
  },
});
