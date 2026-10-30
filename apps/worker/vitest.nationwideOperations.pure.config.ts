import {defineConfig} from 'vitest/config';
import base from './vitest.config.ts';
export default defineConfig({...base,test:{...base.test,globalSetup:[],include:['test/nationwideOperations.pure.test.ts'],maxWorkers:1,fileParallelism:false}});
