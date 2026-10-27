import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
/** New control checks only. Deliberately NO globalSetup, PG, OIDC or browser. */
export default defineConfig({
  root: fileURLToPath(new URL('../../../../', import.meta.url)),
  resolve: { alias: [
    { find: '@fss/contracts', replacement: fileURLToPath(new URL('../../../contracts/src/index.ts', import.meta.url)) },
    { find: /^@fss\/domain\/(.+\.ts)$/u, replacement: `${fileURLToPath(new URL('../../', import.meta.url))}$1` },
  ] },
  test: { include: ['packages/domain/test/outreach/campaignOpeningControl.test.ts', 'apps/api/test/campaignOpeningControl.test.ts',
    'apps/web/test/client/campaignOpeningControl.test.tsx', 'apps/web/test/server/campaignOpeningControlBoundary.test.ts'], maxWorkers: 1, fileParallelism: false },
});
