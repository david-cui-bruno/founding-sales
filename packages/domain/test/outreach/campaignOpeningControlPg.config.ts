import { defineConfig } from 'vitest/config';
import source from './campaignOpeningControl.config.ts';
/** Separate opt-in runtime path. Never part of the source-only invocation. */
export default defineConfig({ ...source, test: { include: ['packages/domain/test/outreach/campaignOpeningControlPg.test.ts'],
  globalSetup: ['packages/domain/db/testing/globalSetup.ts'], maxWorkers: 1, fileParallelism: false } });
