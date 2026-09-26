import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The release suite (`npm run test:release`): the checks that run the release scripts,
 * the deploy workflow's own shell, and the code-to-Terraform cross-checks.
 *
 * The files are `*.check.ts`, not `*.test.ts`, so no workspace runner picks them up by
 * the default pattern. `test/release` is not an npm workspace member, so `@fss/domain/...`
 * resolves through the aliases below rather than a package `exports` map; they are the
 * same targets `apps/api/vitest.config.ts` uses.
 */
export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  resolve: {
    alias: {
      '@fss/contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)),
      '@fss/domain/jobs': fileURLToPath(new URL('../../packages/domain/jobs/index.ts', import.meta.url)),
      '@fss/domain/crm': fileURLToPath(new URL('../../packages/domain/crm/index.ts', import.meta.url)),
      '@fss/domain/policy': fileURLToPath(new URL('../../packages/domain/policy/index.ts', import.meta.url)),
      '@fss/domain/suppression': fileURLToPath(new URL('../../packages/domain/suppression/index.ts', import.meta.url)),
      '@fss/domain/dial': fileURLToPath(new URL('../../packages/domain/dial/index.ts', import.meta.url)),
      '@fss/domain/mail': fileURLToPath(new URL('../../packages/domain/mail/index.ts', import.meta.url)),
      '@fss/domain/classification': fileURLToPath(
        new URL('../../packages/domain/classification/index.ts', import.meta.url),
      ),
      '@fss/domain/outbound': fileURLToPath(new URL('../../packages/domain/outbound/index.ts', import.meta.url)),
      '@fss/domain/retention': fileURLToPath(new URL('../../packages/domain/retention/index.ts', import.meta.url)),
      '@fss/domain/restore': fileURLToPath(new URL('../../packages/domain/restore/index.ts', import.meta.url)),
      '@fss/domain/db': fileURLToPath(new URL('../../packages/domain/db/index.ts', import.meta.url)),
      '@fss/domain/today': fileURLToPath(new URL('../../packages/domain/today/index.ts', import.meta.url)),
      '@fss/domain/sequences': fileURLToPath(new URL('../../packages/domain/sequences/index.ts', import.meta.url)),
      '@fss/domain/templates': fileURLToPath(new URL('../../packages/domain/templates/index.ts', import.meta.url)),
      '@fss/domain/settings': fileURLToPath(new URL('../../packages/domain/settings/index.ts', import.meta.url)),
      '@fss/domain/dashboard': fileURLToPath(new URL('../../packages/domain/dashboard/index.ts', import.meta.url)),
      '@fss/domain/release': fileURLToPath(new URL('../../packages/domain/release/index.ts', import.meta.url)),
      '@fss/domain': fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)),
    },
  },
  test: {
    pool: 'forks',
    include: ['test/release/**/*.check.ts'],
    testTimeout: 30_000,
  },
});
