import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
/** Retirement checks only. No globalSetup, PostgreSQL, listener or browser. */
export default defineConfig({
 root:fileURLToPath(new URL('../../../../',import.meta.url)),
 resolve:{alias:[
  {find:'@fss/contracts',replacement:fileURLToPath(new URL('../../../contracts/src/index.ts',import.meta.url))},
  {find:/^@fss\/domain\/(.+\.ts)$/u,replacement:`${fileURLToPath(new URL('../../',import.meta.url))}$1`},
 ]},
 test:{include:['packages/domain/test/outreach/settings.test.ts','packages/domain/test/outreach/automaticIncomingRetirement.test.ts','apps/worker/test/outreachReply.test.ts'],maxWorkers:1,fileParallelism:false},
});
