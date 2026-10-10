import {defineConfig} from 'vitest/config';
export default defineConfig({test:{pool:'forks',globalSetup:['../../packages/domain/db/testing/globalSetup.ts'],include:['*.test.ts'],testTimeout:30000,hookTimeout:60000}});
