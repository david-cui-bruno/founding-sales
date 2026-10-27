import {defineConfig} from 'vitest/config';
/** Query-port fence tests only. No PostgreSQL setup or provider resources. */
export default defineConfig({test:{include:['packages/domain/test/outreach/factsAuthority.noPG.test.ts','apps/api/test/outreachFacts.noPG.test.ts'],maxWorkers:1}});
