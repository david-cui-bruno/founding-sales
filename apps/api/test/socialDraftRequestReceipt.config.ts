import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('../../../',import.meta.url)),resolve:{alias:[{find:'@fss/contracts',replacement:fileURLToPath(new URL('../../../packages/contracts/src/index.ts',import.meta.url))},{find:/^@fss\/domain\/(.+\.ts)$/u,replacement:`${fileURLToPath(new URL('../../../packages/domain/',import.meta.url))}$1`}]},test:{include:['apps/api/test/socialDraftRequestReceipt.test.ts'],maxWorkers:1,fileParallelism:false}});
