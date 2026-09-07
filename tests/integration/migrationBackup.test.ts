import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const scenarios = [
  'verified-schema-one',
  'pending-only',
  'migration-failure',
  'schema-one-migration-failure',
  'verification-failure',
  'verification-blocks-migration',
  'busy-checkpoint',
  'directory-replaced',
  'unrelated-sidecar',
  'path-replaced',
  'sidecar-race',
  'unlink-failure',
  'creation-fchmod-failure',
  'creation-fstat-failure',
  'creation-fstat-unrecoverable',
  'schema-15-to-16-recovery-preservation',
  'schema-16-to-17-recovery-preservation',
] as const;

let bundleDirectory: string;
let scenarioBundle: string;

describe('verified pre-migration backup', () => {
  beforeAll(() => {
    bundleDirectory = mkdtempSync(join(process.cwd(), '.native-test-'));
    scenarioBundle = join(bundleDirectory, 'migration-backup.cjs');
    const build = spawnSync(
      join(process.cwd(), 'node_modules/.bin/esbuild'),
      [
        join(process.cwd(), 'tests/support/migrationBackupScenario.ts'),
        '--bundle',
        '--platform=node',
        '--format=cjs',
        '--packages=external',
        '--log-level=error',
        `--outfile=${scenarioBundle}`,
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect({
      status: build.status,
      signal: build.signal,
      stderr: build.stderr,
    }).toEqual({ status: 0, signal: null, stderr: '' });
  });

  afterAll(() => {
    rmSync(bundleDirectory, { force: true, recursive: true });
  });

  it.each(scenarios)('passes the %s scenario', (scenario) => {
    const result = spawnSync(process.execPath, [scenarioBundle, scenario], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect({
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual({ status: 0, signal: null, stdout: '', stderr: '' });
  }, 35_000);
});
