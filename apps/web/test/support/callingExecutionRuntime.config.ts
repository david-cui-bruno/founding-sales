import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['packages/domain/test/calls/executionReceiptRuntime.test.ts'],globalSetup:['apps/web/test/support/callingExecutionDatabase.ts'],maxWorkers:1,fileParallelism:false,testTimeout:15000,hookTimeout:120000}});
