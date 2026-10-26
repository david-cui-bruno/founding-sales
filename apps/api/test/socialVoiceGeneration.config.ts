import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitest/config';
export default defineConfig({
 root:fileURLToPath(new URL('../../../',import.meta.url)),
 resolve:{alias:[
  {find:'@fss/contracts',replacement:fileURLToPath(new URL('../../../packages/contracts/src/index.ts',import.meta.url))},
  {find:/^@fss\/domain\/(.+\.ts)$/u,replacement:`${fileURLToPath(new URL('../../../packages/domain/',import.meta.url))}$1`},
 ]},
 test:{pool:'forks',maxWorkers:1,fileParallelism:false,testTimeout:30000,hookTimeout:60000,
  globalSetup:['packages/domain/test/social/voiceGenerationPgRuntime.ts'],
  include:['packages/domain/test/social/voiceGeneration.runtime.test.ts','packages/domain/test/social/voiceGenerationRaces.runtime.test.ts','apps/api/test/socialVoiceGeneration.test.ts'],
 },
});
