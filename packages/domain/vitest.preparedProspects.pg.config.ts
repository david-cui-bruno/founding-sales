import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitest/config';
export default defineConfig({resolve:{alias:{'@fss/contracts':fileURLToPath(new URL('../contracts/src/index.ts',import.meta.url)),
 '@fss/domain':fileURLToPath(new URL('./',import.meta.url))}},test:{pool:'forks',maxWorkers:1,fileParallelism:false,
 globalSetup:['./test/sourcing/preparedProspectsPgRuntime.ts'],include:['test/sourcing/preparedProspects.pg.test.ts','test/sourcing/preparedCaptureBatch.pg.test.ts','test/sourcing/preparedListPerformance.pg.test.ts','test/sourcing/preparedPartialPriority.pg.test.ts'],testTimeout:30000,hookTimeout:60000}});
