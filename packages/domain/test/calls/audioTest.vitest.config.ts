import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Pure/fake-SQL lane only: deliberately has no PostgreSQL globalSetup. */
export default defineConfig({
  resolve: { alias: { '@fss/contracts': fileURLToPath(new URL('../../../contracts/src/index.ts', import.meta.url)) } },
  test: { pool: 'forks', include: ['test/calls/audioTest*.test.ts'], exclude: ['test/calls/audioTestPg*.test.ts'] },
});
