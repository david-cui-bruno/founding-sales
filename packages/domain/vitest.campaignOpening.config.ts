import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
/** Deliberately no globalSetup, database or browser allocation. */
export default defineConfig({
  resolve: { alias: {
    '@fss/contracts': fileURLToPath(new URL('../contracts/src/index.ts', import.meta.url)),
    '@fss/domain': fileURLToPath(new URL('./', import.meta.url)),
  } },
  test: { include: ['test/outreach/campaignOpening.test.ts', 'test/outreach/campaignOpeningStore.test.ts', 'test/outreach/campaignOpeningSource.test.ts', '../../apps/worker/test/campaignOpeningSequence.test.ts'], pool: 'forks' },
});
