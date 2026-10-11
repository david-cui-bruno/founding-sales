import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { repositoryPath } from './support/repository.ts';
function select(paths: string[], main = false) {
  const result = spawnSync(process.execPath, [repositoryPath('tools/ci/select.mjs'), ...(main ? ['--main'] : [])], { input: paths.join('\n'), encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { broad: boolean; suites: string[]; upgrade: boolean; reasons: string[] };
}
describe('required CI selection', () => {
  it('runs API changes with their desktop consumer and conserved domain/operations controls', () => {
    expect(select(['apps/api/src/routes/gmail.ts']).suites).toEqual(['domain', 'api', 'desktop', 'ops']);
  });
  it('runs worker edits with API-owned configured extraction, Ask and booking journeys', () => {
    expect(select(['apps/worker/src/bootstrap/deployment.ts']).suites).toEqual(['domain', 'api', 'worker', 'ops']);
  });
  it('never narrows shared contracts, unknown paths or selector edits', () => {
    for (const path of ['packages/contracts/src/index.ts', 'unmapped/new.ts', 'tools/ci/select.mjs']) expect(select([path]).broad).toBe(true);
  });
  it('requires real upgrade checks for schema paths and broad regression on main', () => {
    expect(select(['packages/domain/db/migrations/0100_example.sql']).upgrade).toBe(true);
    expect(select(['apps/desktop/src/renderer/index.ts'], true).suites).toEqual(['contracts', 'domain', 'api', 'worker', 'desktop', 'ops', 'ask-evaluation']);
  });
  it('keeps the required gate present for documentation with a recorded reason', () => {
    const result = select(['docs/adr/0011-lean-automatic-releases-with-maintenance.md']);
    expect(result.suites).toEqual(['ops']);
    expect(result.reasons).toContain('documentation: operations contract checks');
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
