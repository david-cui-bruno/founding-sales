import {defineConfig} from 'vitest/config';

export default defineConfig({
 test:{environment:'node',pool:'forks',globalSetup:['../domain/db/testing/globalSetup.ts'],include:['test/**/*.test.ts'],testTimeout:30_000,hookTimeout:60_000},
});
