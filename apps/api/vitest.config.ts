import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The workspace packages resolve to their sources; the greenfield tree is never built
// before it is tested. The PostgreSQL cluster comes from @fss/domain's globalSetup.
export default defineConfig({
  resolve: {
    alias: {
      '@fss/contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)),
      '@fss/domain/db/testing': fileURLToPath(new URL('../../packages/domain/db/testing/index.ts', import.meta.url)),
      '@fss/domain/jobs': fileURLToPath(new URL('../../packages/domain/jobs/index.ts', import.meta.url)),
      '@fss/domain/crm': fileURLToPath(new URL('../../packages/domain/crm/index.ts', import.meta.url)),
      '@fss/domain/research/testing': fileURLToPath(
        new URL('../../packages/domain/research/testing/fixtures.ts', import.meta.url),
      ),
      '@fss/domain/research': fileURLToPath(new URL('../../packages/domain/research/index.ts', import.meta.url)),
      '@fss/domain/policy': fileURLToPath(new URL('../../packages/domain/policy/index.ts', import.meta.url)),
      '@fss/domain/suppression': fileURLToPath(new URL('../../packages/domain/suppression/index.ts', import.meta.url)),
      '@fss/domain/dial': fileURLToPath(new URL('../../packages/domain/dial/index.ts', import.meta.url)),
      '@fss/domain/mail': fileURLToPath(new URL('../../packages/domain/mail/index.ts', import.meta.url)),
      '@fss/domain/outbound': fileURLToPath(new URL('../../packages/domain/outbound/index.ts', import.meta.url)),
      '@fss/domain/db': fileURLToPath(new URL('../../packages/domain/db/index.ts', import.meta.url)),
      '@fss/domain/today': fileURLToPath(new URL('../../packages/domain/today/index.ts', import.meta.url)),
      '@fss/domain/retention': fileURLToPath(new URL('../../packages/domain/retention/index.ts', import.meta.url)),
      '@fss/domain': fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)),
    },
  },
  test: {
    pool: 'forks',
    globalSetup: ['../../packages/domain/db/testing/globalSetup.ts'],
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
