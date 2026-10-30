import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitest/config';
/** Execute only with Root's sole disposable PG lane; no real provider or browser. */
export default defineConfig({resolve:{alias:{
 '@fss/contracts':fileURLToPath(new URL('../contracts/src/index.ts',import.meta.url)),
 '@fss/domain':fileURLToPath(new URL('./',import.meta.url)),
}},test:{pool:'forks',maxWorkers:1,fileParallelism:false,globalSetup:['./test/sourcing/preparedSourceIdentityPgRuntime.ts'],
 include:['test/sourcing/preparedSourceIdentity.pg.test.ts','test/db/migration0151.test.ts','test/outreach/preparedIdentityOpeningCompatibility.pg.test.ts','../../apps/worker/test/preparedSourceIdentity.pg.test.ts'],testTimeout:30000,hookTimeout:60000}});
