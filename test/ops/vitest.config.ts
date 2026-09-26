import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The ops suite (`npm run test:ops`): the checks that run the release and deploy
 * scripts against stub CLIs, the deploy workflow's own shell, the deployment role
 * policies, the alarm digest, the production smoke and the code-to-Terraform
 * cross-checks. Product behaviour is tested in the workspace suites.
 *
 * The files are `*.check.ts`, not `*.test.ts`, so no workspace runner picks them up by
 * the default pattern. `test/ops` is not an npm workspace member, so `@fss/domain/...`
 * resolves through the aliases below rather than a package `exports` map; they are the
 * same targets `apps/api/vitest.config.ts` uses.
 */
export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  resolve: {
    alias: [
      // `@fss/domain/<directory>/<module>.ts` is that file, as the package's exports map says.
      { find: /^@fss\/domain\/(.+\.ts)$/u, replacement: `${fileURLToPath(new URL('../../packages/domain/', import.meta.url))}$1` },
      { find: '@fss/contracts', replacement: fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)) },
      { find: '@fss/domain/jobs', replacement: fileURLToPath(new URL('../../packages/domain/jobs/index.ts', import.meta.url)) },
      { find: '@fss/domain/crm', replacement: fileURLToPath(new URL('../../packages/domain/crm/index.ts', import.meta.url)) },
      { find: '@fss/domain/policy', replacement: fileURLToPath(new URL('../../packages/domain/policy/index.ts', import.meta.url)) },
      { find: '@fss/domain/suppression', replacement: fileURLToPath(new URL('../../packages/domain/suppression/index.ts', import.meta.url)) },
      { find: '@fss/domain/dial', replacement: fileURLToPath(new URL('../../packages/domain/dial/index.ts', import.meta.url)) },
      { find: '@fss/domain/mail', replacement: fileURLToPath(new URL('../../packages/domain/mail/index.ts', import.meta.url)) },
      { find: '@fss/domain/classification', replacement: fileURLToPath(new URL('../../packages/domain/classification/index.ts', import.meta.url)) },
      { find: '@fss/domain/outbound', replacement: fileURLToPath(new URL('../../packages/domain/outbound/index.ts', import.meta.url)) },
      { find: '@fss/domain/retention', replacement: fileURLToPath(new URL('../../packages/domain/retention/index.ts', import.meta.url)) },
      { find: '@fss/domain/restore', replacement: fileURLToPath(new URL('../../packages/domain/restore/index.ts', import.meta.url)) },
      { find: '@fss/domain/db', replacement: fileURLToPath(new URL('../../packages/domain/db/index.ts', import.meta.url)) },
      { find: '@fss/domain/today', replacement: fileURLToPath(new URL('../../packages/domain/today/index.ts', import.meta.url)) },
      { find: '@fss/domain/sequences', replacement: fileURLToPath(new URL('../../packages/domain/sequences/index.ts', import.meta.url)) },
      { find: '@fss/domain/templates', replacement: fileURLToPath(new URL('../../packages/domain/templates/index.ts', import.meta.url)) },
      { find: '@fss/domain/settings', replacement: fileURLToPath(new URL('../../packages/domain/settings/index.ts', import.meta.url)) },
      { find: '@fss/domain/dashboard', replacement: fileURLToPath(new URL('../../packages/domain/dashboard/index.ts', import.meta.url)) },
      { find: '@fss/domain/release', replacement: fileURLToPath(new URL('../../packages/domain/release/index.ts', import.meta.url)) },
      { find: '@fss/domain', replacement: fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)) },
    ],
  },
  test: {
    pool: 'forks',
    include: ['test/ops/**/*.check.ts'],
    testTimeout: 30_000,
  },
});
