import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
/** Requires Root's fresh exclusive disposable-PG grant. Never run as a pure check. */
export default defineConfig({
 root:fileURLToPath(new URL('../../../../',import.meta.url)),
 resolve:{alias:{'@fss/contracts':fileURLToPath(new URL('../../../contracts/src/index.ts',import.meta.url))}},
 test:{include:['packages/domain/test/sourcing/phoneSupplyPg.test.ts'],globalSetup:['packages/domain/db/testing/globalSetup.ts'],pool:'forks',maxWorkers:1,fileParallelism:false,testTimeout:30000,hookTimeout:60000},
});
