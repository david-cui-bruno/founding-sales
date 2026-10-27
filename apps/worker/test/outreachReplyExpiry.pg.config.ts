import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
export default defineConfig({root,resolve:{alias:[
 {find:'@fss/contracts',replacement:root+'packages/contracts/src/index.ts'},
 {find:/^@fss\/domain\/(.+\.ts)$/u,replacement:root+'packages/domain/$1'},
]},test:{pool:'forks',globalSetup:[root+'packages/domain/db/testing/globalSetup.ts'],include:['apps/worker/test/outreachReplyExpiry.pg.test.ts'],maxWorkers:1,fileParallelism:false,retry:0,testTimeout:30000,hookTimeout:60000}});
