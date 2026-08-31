import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let bundleDirectory: string;
let scenarioBundle: string;

describe('domain schema 0002 manifest', () => {
  beforeAll(() => {
    bundleDirectory = mkdtempSync(join(process.cwd(), '.native-test-'));
    scenarioBundle = join(bundleDirectory, 'domain-schema.cjs');
    const build = spawnSync(join(process.cwd(), 'node_modules/.bin/esbuild'), [
      join(process.cwd(), 'tests/support/domainSchemaScenario.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--packages=external',
      '--log-level=error',
      `--outfile=${scenarioBundle}`,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    expect({ status: build.status, stderr: build.stderr }).toEqual({ status: 0, stderr: '' });
  });

  afterAll(() => rmSync(bundleDirectory, { recursive: true, force: true }));

  it('creates schema version 2 with every domain table, critical index, and trigger', () => {
    const result = spawnSync(process.execPath, [scenarioBundle, 'manifest'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result).toMatchObject({ status: 0, signal: null, stdout: '', stderr: '' });
  }, 35_000);
});
