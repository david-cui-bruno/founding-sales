import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const vitestEntry = fileURLToPath(
  new URL('../node_modules/vitest/vitest.mjs', import.meta.url),
);

describe('Vitest discovery boundary', () => {
  it('does not collect Playwright specs or nested Git worktrees', () => {
    const discoveredTests = execFileSync(
      process.execPath,
      [vitestEntry, 'list'],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        encoding: 'utf8',
      },
    );

    expect(discoveredTests).not.toContain('/tests/e2e/');
    expect(discoveredTests).not.toContain('/.worktrees/');
  });
});
