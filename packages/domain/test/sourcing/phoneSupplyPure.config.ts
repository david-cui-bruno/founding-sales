import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
/** Source-only capacity checks. Deliberately no PG globalSetup or external IO. */
export default defineConfig({
 root:fileURLToPath(new URL('../../../../',import.meta.url)),
 resolve:{alias:{'@fss/contracts':fileURLToPath(new URL('../../../contracts/src/index.ts',import.meta.url))}},
 test:{include:['packages/domain/test/sourcing/phoneSupplyCapacity.test.ts'],maxWorkers:1,fileParallelism:false},
});
