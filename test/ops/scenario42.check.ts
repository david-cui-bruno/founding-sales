import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ciGateReleaseReference, releaseRecordSchema } from '@fss/contracts';
import { effectiveSendingEnabled } from '@fss/domain/settings/effective.ts';
import { SEND_REFUSAL_CODES } from '@fss/domain/outbound/types.ts';
import { SHARED_DEPLOYMENT_VARIABLES } from '@fss/domain/release/deployment.ts';
import { DEPLOYMENT_ENVIRONMENT_VARIABLES as WORKER_VARIABLES } from '../../apps/worker/src/bootstrap/deployment.ts';
import { DEPLOYMENT_ENVIRONMENT_VARIABLES as API_VARIABLES } from '../../apps/api/src/bootstrap/deployment.ts';
import { repositoryPath } from './support/repository.ts';

/**
 * Appendix G 42: "Authentication passes but production sending remains disabled until
 * artifact digest, rehearsal gate, smoke tests, and manual enable all agree."
 *
 * 16.2 in one sentence, and this lane's headline deliverable. Four conditions, and each
 * one is held by a different thing:
 *
 *   * **artifact digest** — the release record's contract refuses anything that is not
 *     `sha256:` plus 64 hex characters, and the cluster module's variable validation
 *     refuses a mutable tag;
 *   * **release gate** — the record `record.sh from-ci` writes from the green CI
 *     gate run on the deployed commit (lane g96);
 *   * **smoke tests** — `scripts/productionSmoke.mjs`, whose sixth check's expected
 *     answer is that sending is *off* before the enable (`--expect-sending`, whose
 *     default is `disabled`; lane g80);
 *   * **manual enable** — `workspace_settings.sending_enabled`, admin-only, carrying the
 *     `releaseGateReference` of the rehearsal whose digests match.
 *
 * ## The vacuous-pass trap
 *
 * Four conditions ANDed are indistinguishable from one condition if only one of them is
 * ever varied: a test that turned everything on and then turned one thing off would pass
 * against an implementation that read only that one thing. That is not hypothetical —
 * before this lane the send gate read the *domain* flag and nothing else, and a workspace
 * whose DNS passed could have sent from an image nobody rehearsed.
 *
 * Closed by varying each condition independently and requiring sending to stay off for
 * each, and by asserting the positive control: with all of them true, it is on.
 */

const REFERENCE = 'fss-rh-20260920-example';

describe('Appendix G 42: sending stays off until all four agree', () => {
  describe('the two switches the send gate reads', () => {
    it('is on only when the deployment flag and the admin attestation both say yes', () => {
      // The positive control. Without it, "always false" would pass every case below.
      expect(effectiveSendingEnabled(true, { enabled: true, releaseGateReference: REFERENCE })).toBe(true);
    });

    it('is off when the deployment has not been told the gate passed', () => {
      expect(effectiveSendingEnabled(false, { enabled: true, releaseGateReference: REFERENCE })).toBe(false);
    });

    it('is off when no admin has enabled it', () => {
      expect(effectiveSendingEnabled(true, { enabled: false, releaseGateReference: null })).toBe(false);
    });

    it('is off when the attestation names no release gate, because "an admin clicked yes" is not the gate', () => {
      expect(effectiveSendingEnabled(true, { enabled: true, releaseGateReference: null })).toBe(false);
    });

    it('is off when the stored setting is unreadable, which is a bug failing to the safe side', () => {
      for (const stored of [null, undefined, {}, { enabled: 'yes' }, 'true', 42]) {
        expect(effectiveSendingEnabled(true, stored)).toBe(false);
      }
    });
  });

  describe('the dispatch path has its own refusal codes', () => {
    it('names its own refusal code, distinct from the domain authentication one', () => {
      expect(SEND_REFUSAL_CODES).toContain('workspace_sending_not_attested');
      expect(SEND_REFUSAL_CODES).toContain('automated_sending_disabled');
    });

  });

  describe('the two processes agree about the deployment they are reading', () => {
    it('name the same environment variable for every fact they share', () => {
      // Drift between the two would mean one process sends and the other refuses, which is
      // the worst of both. Since W3-S9 both maps spread SHARED_DEPLOYMENT_VARIABLES
      // (packages/domain/release/deployment.ts), so this holds by construction today; it
      // stays as the guard against an override in one process (review of PR 278).
      const shared = Object.keys(WORKER_VARIABLES).filter(key => key in API_VARIABLES);
      for (const key of Object.keys(SHARED_DEPLOYMENT_VARIABLES)) expect(shared, `both processes read ${key}`).toContain(key);
      for (const key of shared) {
        expect((API_VARIABLES as Record<string, string>)[key], `the two bootstraps disagree about ${key}`).toBe(
          (WORKER_VARIABLES as Record<string, string>)[key],
        );
      }
      expect(WORKER_VARIABLES.sendingEnabled).toBe('FSS_SENDING_ENABLED');
    });
  });
});

/**
 * Lane g71: "the deployed commit/image digests match the released artifacts" is a
 * comparison the software makes, not a sentence an admin reads.
 *
 * The release record is stored (`fss admin release-record put`, run by
 * `deploy.sh release --release-record`), the API refuses an enable whose record does
 * not pass or does not carry the API's own digest, and the worker refuses to send when
 * the record does not carry the worker's own. The behaviour is asserted in the domain,
 * API and worker suites; this is where the deploy step is held to them.
 *
 * ## The vacuous-pass trap
 *
 * The deploy step is run in dry mode rather than read, both with the flag (the put is
 * planned, after the final verify, carrying the file byte for byte) and without it
 * (nothing about the deploy changes). The record it carries is a `ci-gate` record the
 * contract accepts, so a record shape the contract no longer describes fails here
 * rather than at the put. `record.check.ts` runs the script that writes it.
 */
describe('Appendix G 42: the attestation is bound to the release record (lane g71)', () => {
  const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;

  /** A `ci-gate` record for digests a and b, as `record.sh from-ci` writes one. */
  function ciGateRecord(): Record<string, unknown> {
    const commit = 'c'.repeat(40);
    const gateRunId = '4242';
    const record = {
      schema: 'fss.release-record.v1',
      source: 'ci-gate',
      releaseGateReference: ciGateReleaseReference(gateRunId, commit),
      recordedAt: '2026-09-26T12:00:00Z',
      suite: 'pass',
      commit,
      gateRunId,
      gateRunUrl: `https://github.com/example-owner/example-repo/actions/runs/${gateRunId}`,
      imagesRunId: '4243',
      artifacts: { api: digest('a'), worker: digest('b'), desktopCommitStamp: commit },
      enablesSending: false,
    };
    const parsed = releaseRecordSchema.safeParse(record);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    return record;
  }

  describe('deploy.sh release --release-record', () => {
    const recordFile = (): { readonly path: string; readonly bytes: Buffer } => {
      const directory = mkdtempSync(join(tmpdir(), 'fss-deploy-record-'));
      const path = join(directory, 'release-record.json');
      writeFileSync(path, `${JSON.stringify(ciGateRecord(), null, 2)}\n`);
      return { path, bytes: readFileSync(path) };
    };

    function dryDeploy(
      extra: readonly string[],
      fixtures: Readonly<Record<string, string>> = {},
    ): { readonly code: number; readonly output: string; readonly report: string } {
      const reports = mkdtempSync(join(tmpdir(), 'fss-deploy-dry-'));
      const result = spawnSync(
        'bash',
        [
          repositoryPath('infra/scripts/deploy.sh'),
          'release',
          'infra/roots/production',
          'fss-prod',
          '--worker-digest',
          digest('b'),
          ...extra,
        ],
        {
          cwd: repositoryPath(''),
          encoding: 'utf8',
          env: {
            ...process.env,
            FSS_REHEARSAL_DRY_RUN: '1',
            FSS_REHEARSAL_REPORTS: reports,
            FSS_RELEASE_CALLER_ACCOUNT: '123456789012',
            AWS_REGION: 'us-east-1',
            FSS_RELEASE_OUTPUT_CLUSTER_ARN: 'arn:aws:ecs:us-east-1:123456789012:cluster/fss-prod-cluster',
            FSS_RELEASE_OUTPUT_MIGRATION_TASK_DEFINITION_ARN:
              'arn:aws:ecs:us-east-1:123456789012:task-definition/fss-prod-migration:1',
            FSS_RELEASE_OUTPUT_OPERATIONS_TASK_DEFINITION_ARN:
              'arn:aws:ecs:us-east-1:123456789012:task-definition/fss-prod-operations:1',
            FSS_RELEASE_OUTPUT_APP_RUNTIME_DATABASE_SECRET_ARN:
              'arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-prod/app-runtime-database-a',
            FSS_RELEASE_OUTPUT_TASK_NETWORK_CONFIGURATION: JSON.stringify({
              subnet_ids: ['subnet-1111111111111111a'],
              security_group_id: 'sg-1111111111111111b',
              assign_public_ip: 'ENABLED',
              database_host: 'fss-prod-pg.example',
              inbound_rule_count: 0,
            }),
            FSS_RELEASE_OUTPUT_DEPLOYMENT_PLAN: JSON.stringify({
              api: { service_name: 'fss-prod-api', declared_desired_count: 1 },
              worker: { service_name: 'fss-prod-worker', declared_desired_count: 1 },
              bootstrap: false,
            }),
            FSS_RELEASE_OUTPUT_WORKER_LOG_GROUP_NAME: '/fss/fss-prod/worker',
            ...fixtures,
          },
        },
      );
      const reportPath = join(reports, 'release-deploy.txt');
      return {
        code: result.status ?? 1,
        output: `${result.stdout}${result.stderr}`,
        report: existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '',
      };
    }

    const plannedCommands = (output: string): readonly string[][] =>
      [...output.matchAll(/--overrides (\{"containerOverrides".*\})$/gmu)].map(match => {
        const overrides = JSON.parse(match[1] ?? '{}') as { containerOverrides: { command: string[] }[] };
        return overrides.containerOverrides[0]?.command ?? [];
      });

    it('puts the record after the final verify of a schema release, as the file’s own bytes', () => {
      const file = recordFile();
      const { code, output, report } = dryDeploy(['--schema-change', '--release-record', file.path]);
      expect(code, output).toBe(0);
      const commands = plannedCommands(output);
      const verifyDeployed = commands.findIndex(
        command => command.includes('verify') && command.includes('/tmp/fss-verify-deployed.json'),
      );
      const put = commands.findIndex(command => command.slice(0, 3).join(' ') === 'admin release-record put');
      expect(verifyDeployed, 'the final verify is not planned').toBeGreaterThan(-1);
      expect(put, 'the release record put is not planned').toBeGreaterThan(verifyDeployed);
      const encoded = commands[put]?.[(commands[put]?.indexOf('--json-base64') ?? -2) + 1] ?? '';
      expect(Buffer.from(encoded, 'base64').equals(file.bytes)).toBe(true);
      expect(report).toContain('release_record=planned');
    });

    it('puts the record last on the rolling path too, as its only one-off task, after the running digests', () => {
      // Lane g80: an app-only deploy launches no one-off task of its own, so the put is
      // the one command planned, and it comes after the deployment has been read back.
      const file = recordFile();
      const { code, output, report } = dryDeploy(['--release-record', file.path]);
      expect(code, output).toBe(0);
      const commands = plannedCommands(output);
      expect(commands.map(command => command.slice(0, 3).join(' '))).toEqual(['admin release-record put']);
      const digests = output.indexOf('3/3 the running tasks of fss-prod-worker and fss-prod-api');
      expect(digests, 'the running digests are not planned').toBeGreaterThan(-1);
      expect(output.indexOf('admin release-record put')).toBeGreaterThan(digests);
      const encoded = commands[0]?.[(commands[0]?.indexOf('--json-base64') ?? -2) + 1] ?? '';
      expect(Buffer.from(encoded, 'base64').equals(file.bytes)).toBe(true);
      expect(report).toContain('release_record=planned');
    });

    it('changes nothing about the deploy without the flag', () => {
      for (const extra of [[], ['--schema-change']]) {
        const { code, output, report } = dryDeploy(extra);
        expect(code, output).toBe(0);
        expect(plannedCommands(output).some(command => command.includes('release-record'))).toBe(false);
        expect(report).toContain('release_record=none');
      }
    });

    it('refuses a record naming other digests than the release, before anything is planned', () => {
      const file = recordFile();
      const { code, output } = dryDeploy(['--api-digest', digest('d'), '--release-record', file.path]);
      expect(code).not.toBe(0);
      expect(output).toContain(`names api ${digest('a')} (this release: ${digest('d')})`);
      expect(plannedCommands(output)).toEqual([]);
      expect(output).not.toContain('update-service');
    });

    it('refuses before anything is scaled when the file is not a release record', () => {
      const directory = mkdtempSync(join(tmpdir(), 'fss-deploy-bad-'));
      const path = join(directory, 'not-a-record.json');
      writeFileSync(path, JSON.stringify({ schema: 'something.else' }));
      const { code, output } = dryDeploy(['--release-record', path]);
      expect(code).not.toBe(0);
      expect(output).toContain('is not a release record');
      expect(output).not.toContain('update-service');
    });
  });
});
