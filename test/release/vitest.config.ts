import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The Appendix G release suite (`npm run test:release`).
 *
 * Two things about this file are deliberate and worth reading before changing either.
 *
 * **The files are `*.check.ts`, not `*.test.ts`.** The suffix kept them out of the
 * previous-generation app's root `vitest run`, which collected every `**\/*.test.ts`
 * outside a workspace package; that app was deleted in lane g95, and the suffix stays
 * so that no other runner picks the suite up by the default pattern. See
 * `docs/decisions/g12-where-the-release-suite-lives.md`.
 *
 * **The aliases mirror the workspace packages.** `test/release` is not an npm
 * workspace member, so `@fss/domain/...` resolves through these rather than through a
 * package `exports` map. They are the same targets `apps/api/vitest.config.ts` uses.
 */
export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
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
    globalSetup: ['packages/domain/db/testing/globalSetup.ts'],
    include: ['test/release/**/*.check.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
