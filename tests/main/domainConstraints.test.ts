import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const scenarios = [
  'duplicate-prospect',
  'duplicate-open-cycle',
  'mismatched-prospect-person',
  'mismatched-source-person',
  'source-event-mismatched-prospect-person',
  'source-event-mismatched-cycle-person',
  'open-without-current-action',
  'closed-with-current-action',
  'current-action-owned-by-another-cycle',
  'complete-referenced-action',
  'delete-referenced-action',
  'pointer-move-before-completion',
  'cyclic-deferred-construction',
  'p0-without-direct-reachability',
  'duplicate-active-cadence',
  'duplicate-provider-activity',
  'immutable-source',
  'immutable-activity',
  'immutable-stage',
  'immutable-trigger',
  'immutable-consent',
  'self-referral',
  'referral-without-referrer',
  'undeletable-opt-out',
  'fitness-before-interviewed',
  'fitness-after-stage-history',
  'open-cycle-race',
] as const;

let bundleDirectory: string;
let scenarioBundle: string;

describe('schema 0002 domain constraints', () => {
  beforeAll(() => {
    bundleDirectory = mkdtempSync(join(process.cwd(), '.native-test-'));
    scenarioBundle = join(bundleDirectory, 'domain-constraints.cjs');
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

  it.each(scenarios)('enforces the %s invariant through raw SQL', (scenario) => {
    const result = spawnSync(process.execPath, [scenarioBundle, scenario], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result).toMatchObject({ status: 0, signal: null, stdout: '', stderr: '' });
  }, 35_000);
});
