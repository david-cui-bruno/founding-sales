import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
/** Root's 2026-10-26T12:49 sole-PG grant. No old suites, browser or providers. */
export default defineConfig({
  resolve: { alias: {
    '@fss/contracts': fileURLToPath(new URL('../contracts/src/index.ts', import.meta.url)),
    '@fss/domain': fileURLToPath(new URL('./', import.meta.url)),
  } },
  test: {
    pool: 'forks', maxWorkers: 1, fileParallelism: false, testTimeout: 60_000, hookTimeout: 60_000,
    globalSetup: ['./test/outreach/campaignOpeningPgRuntime.ts'],
    setupFiles: ['./test/outreach/campaignOpeningPgCatalogSetup.ts'],
    include: ['test/outreach/campaignOpening.pg.test.ts', 'test/outreach/campaignOpeningConstraints.pg.test.ts', 'test/outreach/campaignOpeningRisk.pg.test.ts', 'test/db/constraints.test.ts'],
    testNamePattern: /risk R|risk SPEC|admitted real first execution|actual delayed|real source erasure|actual policy absence|actual app role cannot|unclaimed prefix|refuses the insert that would break (?:outreach_campaign_opening_|campaign_opening_)|has a case for every constraint/u,
  },
});
