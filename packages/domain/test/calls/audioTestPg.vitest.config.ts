import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Only new PostgreSQL acceptance cases. Execution requires Root's fresh runtime grant. */
export default defineConfig({
  resolve: { alias: { '@fss/contracts': fileURLToPath(new URL('../../../contracts/src/index.ts', import.meta.url)) } },
  test: {
    pool: 'forks', maxWorkers: 1, fileParallelism: false, retry: 0,
    globalSetup: ['./db/testing/globalSetup.ts'], include: ['test/calls/audioTestPg*.test.ts'],
    testTimeout: 15_000, hookTimeout: 60_000,
  },
});
