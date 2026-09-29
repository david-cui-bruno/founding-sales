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
      { find: '@fss/contracts', replacement: fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)) },
      { find: /^@fss\/domain\/restore$/u, replacement: fileURLToPath(new URL('../../packages/domain/restore/index.ts', import.meta.url)) },
      // `@fss/domain/<directory>/<module>.ts` is that file, as the package's exports map says.
      { find: /^@fss\/domain\/(.+\.ts)$/u, replacement: `${fileURLToPath(new URL('../../packages/domain/', import.meta.url))}$1` },
    ],
  },
  test: {
    pool: 'forks',
    include: ['test/ops/**/*.check.ts'],
    // These checks drive real shell scripts against stub CLIs: hundreds of processes per
    // test, so their wall time is set by how many files the runner has in flight, not by
    // the work itself. Under Vitest 2 the slowest already reported over thirty seconds and
    // passed; Vitest 5 schedules more of the sixteen files at once, and six of them went
    // past the limit while each still passed every assertion (`scenario39.check.ts` alone:
    // 28/28 in 95s, against 228s for the same file inside the full run). The timeout here
    // is a stop for a hung script, not a budget for a slow one.
    testTimeout: 120_000,
  },
});
