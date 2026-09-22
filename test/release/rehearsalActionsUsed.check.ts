import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryPath } from './support/coverage.ts';

/**
 * `infra/scripts/rehearsal-actions-used.sh` turns CloudTrail's event history into the
 * list of actions a deployment role actually made: the input to deriving the exact
 * policy after the one wide pass David decided on 22 September 2026
 * (`docs/decisions/g25-discovery-mode-for-the-rehearsal-role.md`).
 *
 * It has no credential here and must not obtain one. What is tested is everything
 * around the call: the argument handling, the filter on the role, the aggregation,
 * that no request parameter is printed, and the two answers that must not look like
 * a result (an empty answer, and a window in which the role made nothing).
 */
describe('the CloudTrail export the exact policy is derived from', () => {
  const script = repositoryPath('infra/scripts/rehearsal-actions-used.sh');

  function stub(events: readonly Record<string, unknown>[]): string {
    const directory = mkdtempSync(join(tmpdir(), 'fss-cloudtrail-'));
    const path = join(directory, 'aws');
    const answer = JSON.stringify(events.map(event => JSON.stringify(event)));
    writeFileSync(join(directory, 'answer.json'), answer);
    writeFileSync(path, `#!/usr/bin/env bash\nset -uo pipefail\ncat "${join(directory, 'answer.json')}"\nexit 0\n`);
    chmodSync(path, 0o755);
    return path;
  }

  function run(args: readonly string[], aws?: string): { readonly code: number; readonly stdout: string; readonly stderr: string } {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (aws !== undefined) env['FSS_ACTIONS_USED_AWS'] = aws;
    const result = spawnSync(script, [...args], { encoding: 'utf8', env });
    return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  }

  const byTheRole = (source: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    eventSource: source,
    eventName: name,
    userIdentity: {
      type: 'AssumedRole',
      arn: 'arn:aws:sts::326255650484:assumed-role/fss-rh-deploy/fss-rh-202609221700',
      sessionContext: { sessionIssuer: { arn: 'arn:aws:iam::326255650484:role/fss-rh-deploy' } },
      ...(extra['invokedBy'] === undefined ? {} : { invokedBy: extra['invokedBy'] }),
    },
    requestParameters: { secretString: 'MUST-NEVER-BE-PRINTED', name: 'rds!db-1' },
    ...extra,
  });

  it('refuses a malformed window and an unknown role, and makes no call', () => {
    const exploding = stub([]);
    for (const args of [
      ['yesterday', '2026-09-22T21:00:00Z'],
      ['2026-09-22T17:00:00Z', '2026-09-22 21:00'],
      ['2026-09-22T17:00:00Z', '2026-09-22T21:00:00Z', 'admin'],
    ]) {
      const { code, stderr } = run(args, exploding);
      expect(code, stderr).toBe(2);
    }
  });

  it('aggregates the role\'s calls by action, keeps errors and invoking services, and prints no request parameter', () => {
    const aws = stub([
      byTheRole('rds.amazonaws.com', 'CreateDBInstance', { errorCode: 'AccessDenied' }),
      byTheRole('secretsmanager.amazonaws.com', 'CreateSecret', {
        errorCode: 'AccessDenied',
        invokedBy: 'rds.amazonaws.com',
        resources: [{ ARN: 'arn:aws:secretsmanager:us-east-1:326255650484:secret:rds!db-1' }],
      }),
      byTheRole('kms.amazonaws.com', 'DescribeKey', { invokedBy: 'rds.amazonaws.com' }),
      byTheRole('kms.amazonaws.com', 'DescribeKey', { invokedBy: 'rds.amazonaws.com' }),
      byTheRole('ec2.amazonaws.com', 'DescribeVpcs'),
      {
        eventSource: 'ec2.amazonaws.com',
        eventName: 'TerminateInstances',
        userIdentity: { type: 'IAMUser', arn: 'arn:aws:iam::326255650484:user/somebody-else' },
      },
    ]);
    const { code, stdout, stderr } = run(['2026-09-22T17:00:00Z', '2026-09-22T21:00:00Z'], aws);
    expect(code, stderr).toBe(0);
    const report = JSON.parse(stdout) as {
      role: string;
      events: number;
      actions: { action: string; count: number; errors: Record<string, number>; invokedBy: string[]; resources: string[] }[];
    };
    expect(report.role).toBe('fss-rh-deploy');
    expect(report.events).toBe(5);
    expect(report.actions.map(row => row.action)).toEqual([
      'ec2:DescribeVpcs',
      'kms:DescribeKey',
      'rds:CreateDBInstance',
      'secretsmanager:CreateSecret',
    ]);
    const describeKey = report.actions.find(row => row.action === 'kms:DescribeKey');
    expect(describeKey?.count).toBe(2);
    expect(describeKey?.invokedBy).toEqual(['rds.amazonaws.com']);
    const createSecret = report.actions.find(row => row.action === 'secretsmanager:CreateSecret');
    expect(createSecret?.errors).toEqual({ AccessDenied: 1 });
    expect(createSecret?.resources).toEqual(['arn:aws:secretsmanager:us-east-1:326255650484:secret:rds!db-1']);
    expect(stdout).not.toContain('MUST-NEVER-BE-PRINTED');
    expect(stderr).not.toContain('MUST-NEVER-BE-PRINTED');
    expect(stderr).toContain('5 event(s) by fss-rh-deploy');
    expect(stderr).toContain('refused: secretsmanager:CreateSecret');
  });

  it('fails rather than reports when the window holds nothing by the role, or nothing at all', () => {
    const nobody = stub([{ eventSource: 'ec2.amazonaws.com', eventName: 'DescribeVpcs', userIdentity: { arn: 'arn:aws:iam::326255650484:user/x' } }]);
    const { code, stderr } = run(['2026-09-22T17:00:00Z', '2026-09-22T21:00:00Z'], nobody);
    expect(code).toBe(1);
    expect(stderr).toContain('no event in the window was made by fss-rh-deploy');
    const silent = stub([]);
    const empty = run(['2026-09-22T17:00:00Z', '2026-09-22T21:00:00Z'], silent);
    expect(empty.code).toBe(1);
  });
});
