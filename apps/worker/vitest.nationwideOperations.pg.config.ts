import {defineConfig} from 'vitest/config';
import base from './vitest.config.ts';
/** Root allocates the sole disposable PostgreSQL lane. */
export default defineConfig({...base,test:{...base.test,include:['test/nationwideOperations.pg.test.ts'],maxWorkers:1,fileParallelism:false}});
