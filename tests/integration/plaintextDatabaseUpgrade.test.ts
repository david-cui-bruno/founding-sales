import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const scenarios = [
  'conversion',
  'temp-before-marker',
  'marker-before-rename',
  'recovery-before-promotion',
  'promotion-before-marker-cleanup',
  'marker-before-recovery-cleanup',
  'only-encrypting',
  'only-recovery',
  'partial-copy',
  'invalid-temp-with-recovery',
  'all-invalid',
  'wrong-key',
  'path-mismatched-marker',
  'busy-wal',
  'semantic-content-mismatch',
  'semantic-schema-mismatch',
  'kill-after-rekey',
  'sidecar-only-exists',
  'writer-after-copy',
  'pathname-replaced-after-copy',
  'pathname-created-during-promotion',
] as const;

let bundleDirectory: string;
let scenarioBundle: string;

describe('plaintext schema-1 encryption upgrade', () => {
  beforeAll(() => {
    bundleDirectory = mkdtempSync(join(process.cwd(), '.native-test-'));
    scenarioBundle = join(bundleDirectory, 'plaintext-upgrade.cjs');
    const build = spawnSync(
      join(process.cwd(), 'node_modules/.bin/esbuild'),
      [
        join(process.cwd(), 'tests/support/plaintextUpgradeScenario.ts'),
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

  it.each(scenarios)('passes the %s crash-recovery scenario', (scenario) => {
    const result = spawnSync(process.execPath, [
      scenarioBundle,
      scenario,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect({
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual({
      status: 0,
      signal: null,
      stdout: '',
      stderr: '',
    });
  }, 35_000);

  it.each([
    'writer-after-copy',
    'pathname-replaced-after-copy',
    'pathname-created-during-promotion',
  ])('protects %s under Electron ABI 149', (scenario) => {
    const electron = join(
      process.cwd(),
      'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    );
    const result = spawnSync(electron, [
      scenarioBundle,
      scenario,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 30_000,
    });

    expect({
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual({
      status: 0,
      signal: null,
      stdout: '',
      stderr: '',
    });
  }, 35_000);
});
