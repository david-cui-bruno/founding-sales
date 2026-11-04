import {defineConfig} from 'vitest/config';

// Isolated host acceptance must not import PostgreSQL global setup or DB credentials.
export default defineConfig({
 test:{environment:'node',pool:'forks',include:['test/publisherHost.test.ts'],testTimeout:120000,hookTimeout:60000,fileParallelism:false,maxWorkers:1},
});
