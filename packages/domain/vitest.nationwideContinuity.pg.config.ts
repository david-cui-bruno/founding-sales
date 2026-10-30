import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitest/config';
/** Only Root may allocate this sole disposable PostgreSQL lane. */
export default defineConfig({resolve:{alias:{'@fss/contracts':fileURLToPath(new URL('../contracts/src/index.ts',import.meta.url))}},test:{pool:'forks',maxWorkers:1,fileParallelism:false,globalSetup:['./db/testing/globalSetup.ts'],include:['test/sourcing/nationwideContinuity.pg.test.ts'],testTimeout:30000,hookTimeout:60000}});
