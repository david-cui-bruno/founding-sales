import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// PR800 CI1 only: original fifteen failures, one changed no-policy expectation,
// and directly necessary new activation/history guards. No accepted-suite replay.
export default defineConfig({
  resolve: { alias: { '@fss/contracts': fileURLToPath(new URL('../contracts/src/index.ts', import.meta.url)) } },
  test: {
    pool: 'forks', maxWorkers: 1, fileParallelism: false,
    globalSetup: ['./test/outreach/campaignOpeningPgRuntime.ts'],
    include: ['test/restore/missingFences.test.ts', 'test/dial/callingAssessment.test.ts',
      'test/dial/phoneHandoffAuthority.test.ts', 'test/dial/phonePublicationRisk.test.ts',
      'test/sourcing/discoveryIdentityRecovery.test.ts', 'test/outreach/campaignOpeningCompatibility.pg.test.ts',
      'test/outreach/campaignOpeningSerialization.pg.test.ts'],
    testNamePattern: /records a prepared fence|records the bytes Gmail holds|marks the fence sent from its stored bytes|will not call a body verified|leaves the bytes alone|records a held fence|revalidates exact calling sources after an actual|refuses when membership revocation commits during a registry wait|reads current membership status after waiting on its authority row|candidate-first (delete|finish) concurrent with reservation|sees a (workspace|channel) research hold committed|CI1 |risk STD1 policy=false candidate-first inversion preserves/,
    testTimeout: 60_000, hookTimeout: 90_000,
  },
});
