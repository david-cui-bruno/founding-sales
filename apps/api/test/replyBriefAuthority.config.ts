import { defineConfig } from 'vitest/config';
import base from '../vitest.config.ts';

/** Controlled composition seams only. Never acquire the disposable PostgreSQL lane. */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    globalSetup: [],
    include: ['test/replyBriefAuthority.test.ts', 'test/replyComposerComposition.test.ts', 'test/replyGenerationAuthority.test.ts', 'test/replyContextAuthority.test.ts'],
  },
});
