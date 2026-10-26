import {defineConfig} from 'vitest/config';
/** Deliberately no shared PostgreSQL globalSetup. This suite uses pure dependency ports. */
export default defineConfig({test:{include:['apps/api/test/callingExecutionReceipt.test.ts','packages/domain/test/calls/executionReceipt.test.ts'],maxWorkers:1}});
