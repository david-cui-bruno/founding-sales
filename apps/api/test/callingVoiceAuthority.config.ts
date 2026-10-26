import {defineConfig} from 'vitest/config';

/** Pure query/token ports only. Never inherit the API PostgreSQL globalSetup. */
export default defineConfig({test:{include:['apps/api/test/callingVoiceAuthority.test.ts'],maxWorkers:1}});
