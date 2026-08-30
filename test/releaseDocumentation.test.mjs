import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('release verification documentation', () => {
  it('packages before packaged E2E and verifies that artifact afterward', () => {
    const readme = readFileSync(join(projectRoot, 'README.md'), 'utf8');
    const packageJson = JSON.parse(
      readFileSync(join(projectRoot, 'package.json'), 'utf8'),
    );
    const documentedSequence = [
      'npm ci',
      'npm run rebuild',
      'npm run verify',
      'npm run verify:e2e',
      'npm run verify:package',
      'npm run start',
    ].join('\n');

    expect(readme).toContain(documentedSequence);
    expect(packageJson.scripts['verify:e2e']).toBe(
      'npm run package && npm run test:e2e',
    );
  });
});
