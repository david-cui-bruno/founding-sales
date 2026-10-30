import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitest/config';
/** Root-owned sole disposable PostgreSQL acceptance lane. */
export default defineConfig({resolve:{alias:{'@fss/contracts':fileURLToPath(new URL('../contracts/src/index.ts',import.meta.url))}},test:{pool:'forks',maxWorkers:1,fileParallelism:false,globalSetup:['./db/testing/globalSetup.ts'],include:['test/db/migration0150.test.ts','test/sourcing/targetingCapacity.pg.test.ts'],testTimeout:30000,hookTimeout:60000}});
