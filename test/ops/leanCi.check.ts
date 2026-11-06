import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { repositoryPath } from './support/repository.ts';
function select(paths: string[], main = false) {
  const result = spawnSync(process.execPath, [repositoryPath('tools/ci/select.mjs'), ...(main ? ['--main'] : [])], { input: paths.join('\n'), encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { broad: boolean; suites: string[]; upgrade: boolean; reasons: string[] };
}
describe('required CI selection', () => {
  it('never narrows shared contracts, unknown paths or selector edits', () => {
    for (const path of ['packages/contracts/src/index.ts', 'packages/telemetry/src/privacy.ts', 'unmapped/new.ts', 'tools/ci/select.mjs']) expect(select([path]).broad).toBe(true);
  });
  it('requires real upgrade checks for schema paths', () => {
    expect(select(['packages/domain/db/migrations/0100_example.sql']).upgrade).toBe(true);
  });
});

const { parsePlan, machinesFor } = await import(repositoryPath('tools/ci/plan.mjs')) as {
  parsePlan(text: string): { broad: boolean; suites: string[]; upgrade: boolean };
  machinesFor(plan: { suites: string[] }): { machine: string; suites: string[] }[];
};
const { refusals } = await import(repositoryPath('tools/ci/aggregate.mjs')) as { refusals(needs: string | undefined): string[] };
const mainPlan = JSON.stringify({ broad: true, suites: ['contracts', 'telemetry', 'domain', 'social-publisher', 'api', 'worker', 'web', 'ops'], upgrade: false });
function needs(results: Record<string, string>, plan = mainPlan) {
  return JSON.stringify(Object.fromEntries(Object.entries(results).map(([job, result]) => [job, { result, outputs: job === 'plan' ? { plan } : {} }])));
}
const green = { plan: 'success', validate: 'success', suites: 'success' };
describe('required CI machines and aggregate', () => {
  it('runs every selected suite exactly once, across machines, and never an unselected one', () => {
    for (const paths of [[], ['apps/worker/src/index.ts'], ['apps/api/src/index.ts'], ['docs/a.md']]) {
      const plan = parsePlan(JSON.stringify(select(paths)));
      expect(machinesFor(plan).flatMap(({ suites }) => suites).sort()).toEqual([...plan.suites].sort());
    }
  });
  it('refuses a plan without the mandatory ops suite, with an unknown or repeated suite, or that is not a plan', () => {
    for (const bad of [{ broad: false, upgrade: false, suites: ['domain'] }, { broad: false, upgrade: false, suites: ['ops', 'ops'] }, { broad: false, upgrade: false, suites: ['ops', 'nope'] }, { broad: false, upgrade: false, suites: 'ops' }, { suites: ['ops'], broad: 'yes', upgrade: false }, { broad: true, upgrade: false, suites: ['ops'] }, null, []]) {
      expect(() => parsePlan(JSON.stringify(bad))).toThrow('Invalid required gate selection');
    }
    expect(() => parsePlan('')).toThrow('Invalid required gate selection');
  });
  it('the suite runner refuses a machine the plan does not contain before running anything', () => {
    const plan = JSON.stringify({ broad: false, suites: ['ops'], upgrade: false });
    for (const machine of ['worker', '', undefined]) {
      const result = spawnSync(process.execPath, [repositoryPath('tools/ci/run-selected.mjs'), 'suite'], { encoding: 'utf8', env: { PATH: '/nonexistent', CI_PLAN: plan, ...(machine === undefined ? {} : { CI_MACHINE: machine }) } });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('is not in the required gate plan');
    }
  });
  it('goes green only when the plan, validation and every suite succeeded', () => {
    expect(refusals(needs(green))).toEqual([]);
    for (const job of Object.keys(green)) {
      for (const result of ['failure', 'cancelled', 'skipped']) expect(refusals(needs({ ...green, [job]: result })), `${job} ${result}`).toHaveLength(1);
      const missing = Object.fromEntries(Object.entries(green).filter(([name]) => name !== job));
      expect(refusals(needs(missing)), `${job} missing`).toHaveLength(1);
    }
  });
  it('refuses an unreadable result set or a plan that no machine could have been built from', () => {
    for (const bad of [undefined, '', 'not json', 'null']) expect(refusals(bad)).toHaveLength(1);
    for (const plan of ['', '{}', JSON.stringify({ broad: true, suites: ['domain'], upgrade: false })]) expect(refusals(needs(green, plan))).toHaveLength(1);
  });
});

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
describe('supported production writer serialization', () => {
  it('allows local reads but refuses actual local writes and held workflow writes before AWS', () => {
    const directory = mkdtempSync(join(tmpdir(), 'serialized-release-'));
    try {
      const spy = join(directory, 'aws');
      writeFileSync(spy, '#!/bin/sh\nprintf called >> "$TEST_CALLS"\nprintf "{}"\n'); chmodSync(spy, 0o700);
      const run = (action: string, extra: Record<string, string> = {}) => spawnSync('bash', ['-c', 'source "$1"; release_aws production ecs "$2" --cluster fss-prod-cluster', 'shell', repositoryPath('infra/scripts/lib.sh'), action], {
        env: { PATH: `${directory}:/usr/bin:/bin`, TEST_CALLS: join(directory, 'calls'), ...extra }, encoding: 'utf8',
      });
      expect(run('describe-services').status).toBe(0);
      expect(run('update-service').status).toBe(1);
      expect(run('update-service', { GITHUB_ACTIONS: 'true', GITHUB_WORKFLOW_REF: 'david-cui-bruno/founding-sales/.github/workflows/greenfield-deploy.yml@refs/heads/main', FSS_RELEASE_HOLD: 'true' }).status).toBe(1);
      expect(readFileSync(join(directory, 'calls'), 'utf8')).toBe('called');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
