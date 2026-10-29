import {defineConfig} from 'vitest/config';
/** Budget orchestration seams only; no PostgreSQL setup, model or provider. */
export default defineConfig({test:{include:['test/outreach/campaignOpeningPaid.test.ts'],maxWorkers:1}});
