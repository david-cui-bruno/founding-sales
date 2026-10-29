import {defineConfig} from 'vitest/config';
/** No database/runtime allocation. Root owns the authored persisted acceptance cases. */
export default defineConfig({test:{include:['test/social/publicThreadValidation.test.ts'],maxWorkers:1,fileParallelism:false}});
