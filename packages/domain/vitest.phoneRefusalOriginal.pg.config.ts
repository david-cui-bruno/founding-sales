import {defineConfig} from 'vitest/config';
if(process.env['FSS_PHONE_REFUSAL_ORIGINAL_PG_GRANT']!=='retained-only')throw Error('Fresh Root exclusive retained-original PG grant required before globalSetup');
export default defineConfig({test:{include:['test/sourcing/prospectPhoneRefusalOriginal.pg.test.ts'],globalSetup:['db/testing/globalSetup.ts'],maxWorkers:1,testTimeout:30000,hookTimeout:60000}});
