import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitest/config';
export default defineConfig({
  esbuild:{jsx:'automatic'},
  resolve:{alias:[
    {find:'@fss/contracts',replacement:fileURLToPath(new URL('../../packages/contracts/src/index.ts',import.meta.url))},
    {find:/^@fss\/domain\/(.+\.ts)$/u,replacement:`${fileURLToPath(new URL('../../packages/domain/',import.meta.url))}$1`},
  ]},
  test:{setupFiles:['test/support/bookingPolicyDom.mts'],include:['test/bookingPolicyJourney.test.mts'],globalSetup:['../../packages/domain/db/testing/globalSetup.ts'],testTimeout:30000,hookTimeout:60000},
});
