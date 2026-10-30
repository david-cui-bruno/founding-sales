import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['test/sourcing/targetingCapacityContract.test.ts'],maxWorkers:1,fileParallelism:false}});
