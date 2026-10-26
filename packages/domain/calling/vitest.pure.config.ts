import {defineConfig} from 'vitest/config';
/** Pure orchestration checks only. Migration/runtime acceptance uses the normal domain config. */
export default defineConfig({test:{include:['calling/*.test.ts'],maxWorkers:1}});
