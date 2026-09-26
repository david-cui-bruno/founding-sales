import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The workspace packages resolve to their sources; the greenfield tree is never built
// before it is tested. The PostgreSQL cluster comes from @fss/domain's globalSetup.
export default defineConfig({
  resolve: {
    alias: [
      { find: '@fss/contracts', replacement: fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)) },
      { find: /^@fss\/domain\/restore$/u, replacement: fileURLToPath(new URL('../../packages/domain/restore/index.ts', import.meta.url)) },
      // `@fss/domain/<directory>/<module>.ts` is that file, as the package's exports map says.
      { find: /^@fss\/domain\/(.+\.ts)$/u, replacement: `${fileURLToPath(new URL('../../packages/domain/', import.meta.url))}$1` },
    ],
  },
  test: {
    pool: 'forks',
    globalSetup: ['../../packages/domain/db/testing/globalSetup.ts'],
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
