import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { workflowSourceFiles } from '../support/sourceFiles';

/**
 * Static regression: no production workflow source may reintroduce a
 * combined/blended lead score. Fit (0-30) and Timing (0-40) stay separate
 * axes everywhere. Strict Zod schemas enforce the shape at runtime; this
 * guards the vocabulary.
 */
const forbidden =
  /(^|[^a-z])(lead_?score|weighted_?score|blended_?score|fit.*timing.*sum)([^a-z]|$)/i;

const guardedRoots = [
  'src/shared/contracts',
  'src/renderer/features/today',
] as const;

describe('no blended score contract', () => {
  it('finds guarded production sources', async () => {
    const files = await workflowSourceFiles(guardedRoots);
    expect(files.length).toBeGreaterThan(10);
  });

  it('never mentions a combined lead score in guarded sources', async () => {
    const files = await workflowSourceFiles(guardedRoots);
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      expect({ file, match: forbidden.exec(content) }).toEqual({
        file,
        match: null,
      });
    }
  });
});
