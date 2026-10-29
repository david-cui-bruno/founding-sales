import {defineConfig} from 'vitest/config';
import source from '../../vitest.config.ts';
/** New schema146/model-accounting integration only; controlled providers, no sends. */
export default defineConfig({...source,test:{...source.test,include:['test/db/migration0146.test.ts','test/outreach/campaignOpeningModel.pg.test.ts'],maxWorkers:1,fileParallelism:false}});
