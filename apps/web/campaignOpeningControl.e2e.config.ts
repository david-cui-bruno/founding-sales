import { defineConfig } from 'playwright/test';
import base from './playwright.config.ts';
/** Fresh Root runtime grant required. Only this changed control journey. */
export default defineConfig(base, { testMatch: /campaignOpeningControl\.spec\.ts/u, workers: 1, fullyParallel: false, retries: 0 });
