import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The workspace packages resolve to their sources; the greenfield tree is never built
// before it is tested. The PostgreSQL cluster comes from @fss/domain's globalSetup.
export default defineConfig({
  resolve: {
    alias: [
      // `@fss/domain/<directory>/<module>.ts` is that file, as the package's exports map says.
      { find: /^@fss\/domain\/(.+\.ts)$/u, replacement: `${fileURLToPath(new URL('../../packages/domain/', import.meta.url))}$1` },
      { find: '@fss/contracts', replacement: fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)) },
      { find: '@fss/domain/db/testing', replacement: fileURLToPath(new URL('../../packages/domain/db/testing/index.ts', import.meta.url)) },
      { find: '@fss/domain/jobs', replacement: fileURLToPath(new URL('../../packages/domain/jobs/index.ts', import.meta.url)) },
      { find: '@fss/domain/crm', replacement: fileURLToPath(new URL('../../packages/domain/crm/index.ts', import.meta.url)) },
      { find: '@fss/domain/suppression', replacement: fileURLToPath(new URL('../../packages/domain/suppression/index.ts', import.meta.url)) },
      { find: '@fss/domain/mail', replacement: fileURLToPath(new URL('../../packages/domain/mail/index.ts', import.meta.url)) },
      { find: '@fss/domain/classification', replacement: fileURLToPath(new URL('../../packages/domain/classification/index.ts', import.meta.url)) },
      { find: '@fss/domain/outbound', replacement: fileURLToPath(new URL('../../packages/domain/outbound/index.ts', import.meta.url)) },
      { find: '@fss/domain/db', replacement: fileURLToPath(new URL('../../packages/domain/db/index.ts', import.meta.url)) },
      { find: '@fss/domain/today', replacement: fileURLToPath(new URL('../../packages/domain/today/index.ts', import.meta.url)) },
      { find: '@fss/domain/sequences', replacement: fileURLToPath(new URL('../../packages/domain/sequences/index.ts', import.meta.url)) },
      { find: '@fss/domain/templates', replacement: fileURLToPath(new URL('../../packages/domain/templates/index.ts', import.meta.url)) },
      { find: '@fss/domain/settings', replacement: fileURLToPath(new URL('../../packages/domain/settings/index.ts', import.meta.url)) },
      { find: '@fss/domain/retention', replacement: fileURLToPath(new URL('../../packages/domain/retention/index.ts', import.meta.url)) },
      { find: '@fss/domain/restore', replacement: fileURLToPath(new URL('../../packages/domain/restore/index.ts', import.meta.url)) },
      { find: '@fss/domain/policy', replacement: fileURLToPath(new URL('../../packages/domain/policy/index.ts', import.meta.url)) },
      { find: '@fss/domain/dial', replacement: fileURLToPath(new URL('../../packages/domain/dial/index.ts', import.meta.url)) },
      { find: '@fss/domain/release', replacement: fileURLToPath(new URL('../../packages/domain/release/index.ts', import.meta.url)) },
      { find: '@fss/domain', replacement: fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)) },
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
