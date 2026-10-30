import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitest/config';
/** Controlled extraction only. Root allocates PostgreSQL separately for integration. */
export default defineConfig({resolve:{alias:[
 {find:'@fss/contracts',replacement:fileURLToPath(new URL('../../packages/contracts/src/index.ts',import.meta.url))},
 {find:/^@fss\/domain\/(.+\.ts)$/u,replacement:`${fileURLToPath(new URL('../../packages/domain/',import.meta.url))}$1`},
]},test:{pool:'forks',maxWorkers:1,fileParallelism:false,include:['test/preparedIdentityExtraction.test.ts','test/sourcingQualification.test.ts']}});
