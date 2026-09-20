import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// One PostgreSQL 16 cluster per run (globalSetup), one database per test file.
// Pool `forks` is explicit because globalSetup sets the cluster URL in the
// environment and the workers must inherit it at spawn.
export default defineConfig({
  resolve: {
    alias: {
      '@fss/contracts': fileURLToPath(new URL('../contracts/src/index.ts', import.meta.url)),
    },
  },
  test: {
    pool: 'forks',
    globalSetup: ['./db/testing/globalSetup.ts'],
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
