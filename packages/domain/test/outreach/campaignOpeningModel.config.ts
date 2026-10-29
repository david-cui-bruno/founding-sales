import {defineConfig} from 'vitest/config';
import source from './campaignOpeningControl.config.ts';
/** Adapter-only checks: controlled transport, no PG or provider initialization. */
export default defineConfig({...source,test:{include:['packages/domain/test/outreach/campaignOpeningModel.test.ts'],maxWorkers:1,fileParallelism:false}});
