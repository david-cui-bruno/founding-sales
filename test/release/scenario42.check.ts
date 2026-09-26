import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rehearsalReleaseRecordSchema, releaseRecordSchema } from '@fss/contracts';
import { effectiveSendingEnabled } from '@fss/domain/settings';
import { SEND_REFUSAL_CODES } from '@fss/domain/outbound';
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
 *   * **artifact digest** — `rehearsal-release-record.sh` refuses anything that is not
 *     `sha256:` plus 64 hex characters, and the cluster module's variable validation
 *     refuses a mutable tag;
 *   * **rehearsal gate** — the record is written last, from reports the rehearsal-only
 *     scenarios left behind, and only for a green suite;
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
      // The API and the worker are separate npm workspaces with no dependency between
      // them, so the contract is duplicated. Drift between the two would mean one
      // process sends and the other refuses, which is the worst of both.
      for (const [key, name] of Object.entries(WORKER_VARIABLES)) {
        const theirs = (API_VARIABLES as Record<string, string | undefined>)[key];
        if (theirs === undefined) continue;
        expect(theirs, `the two bootstraps disagree about ${key}`).toBe(name);
      }
    });

  });
});

/**
 * G12f: the one exemption stayed one exemption, and lane g97 removed it.
 *
 * `rehearsal_read_production_inventory` was allowed to name production, until lane g97
 * (25 September 2026) replaced the production diff with a comparison of the run's own
 * resources and the exemption went with it. Appendix G 42's record is the other thing
 * that reads a production name — the digests it compares are production's —
 * and it refuses every argument that names one. A change that widened the refusal into
 * a general allowance would show up here first: the record would accept
 * `fss-prod` as a rehearsal prefix and write a release gate reference for it.
 *
 * ## The vacuous-pass trap
 *
 * Asserting that the script still *contains* `rehearsal_refuse_production_arguments`
 * would pass against a guard whose refusal had become a warning, which is exactly the
 * shape of the bug this lane fixed (`rehearsal_aws` printed FAIL and returned 0). So
 * the script is run, with a production prefix and with a production name buried in an
 * argument that is not the prefix, and both must be refused with nothing written.
 */
describe('Appendix G 42: the inventory exemption did not become a general one', () => {
  const record = 'infra/scripts/rehearsal-release-record.sh';
  const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;

  function writeRecord(args: readonly string[]): { readonly code: number; readonly output: string } {
    const reports = mkdtempSync(join(tmpdir(), 'fss-record-'));
    for (const report of ['restore-drill.txt', 'schema-ranges.txt', 'prefix-guard.txt']) {
      writeFileSync(join(reports, report), 'prefix=fss-rh-case\n');
    }
    const out = join(reports, 'release-record.json');
    const result = spawnSync(repositoryPath(record), [...args, out], {
      encoding: 'utf8',
      env: { ...process.env, FSS_REHEARSAL_REPORTS: reports, FSS_REHEARSAL_DRY_RUN: '1' },
    });
    return {
      code: result.status ?? 1,
      output: `${result.stdout}${result.stderr}${existsSync(out) ? readFileSync(out, 'utf8') : ''}`,
    };
  }

  it('writes a record for a rehearsal prefix, which is the positive control', () => {
    const { code, output } = writeRecord(['fss-rh-case', digest('a'), digest('b'), 'commit', 'pass']);

    expect(code, output).toBe(0);
    expect(output).toContain('"releaseGateReference": "fss-rh-case-');
  });

  it('refuses a production prefix', () => {
    const { code, output } = writeRecord(['fss-prod', digest('a'), digest('b'), 'commit', 'pass']);

    expect(code).not.toBe(0);
    expect(output).not.toContain('releaseGateReference');
  });

  it('refuses a production name anywhere else in its arguments', () => {
    // The desktop stamp is free text, so it is the argument a production name would
    // reach the record through.
    const { code, output } = writeRecord([
      'fss-rh-case',
      digest('a'),
      digest('b'),
      'fss-prod-desktop',
      'pass',
    ]);

    expect(code).not.toBe(0);
    expect(output).toContain('names a production resource');
  });
});

/**
 * Lane g71: "the deployed commit/image digests match the rehearsal artifacts" is a
 * comparison the software makes, not a sentence an admin reads.
 *
 * The record the rehearsal writes is stored (`fss admin release-record put`, run by
 * `release-deploy.sh --release-record`), the API refuses an enable whose record does
 * not pass or does not carry the API's own digest, and the worker refuses to send when
 * the record does not carry the worker's own. The behaviour is asserted in the domain,
 * API and worker suites; this is where the three pieces are held to each other.
 *
 * ## The vacuous-pass trap
 *
 * A contract the script's output was never parsed with would agree with the script
 * only until one of them renamed a field — and the first place that disagreement would
 * surface is David's production enable. So the script is *run* and its output parsed
 * with `releaseRecordSchema`, which is strict: a field the contract does not know, or
 * one it requires and the script dropped, fails here. And the deploy step is run in dry
 * mode rather than read, both with the flag (the put is planned, after the final
 * verify, carrying the file byte for byte) and without it (nothing about the deploy
 * changes).
 */
describe('Appendix G 42: the attestation is bound to the release record (lane g71)', () => {
  const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;

  function writeRecordWithScript(): Record<string, unknown> {
    const reports = mkdtempSync(join(tmpdir(), 'fss-record-contract-'));
    for (const report of ['restore-drill.txt', 'schema-ranges.txt', 'prefix-guard.txt']) {
      writeFileSync(join(reports, report), 'prefix=fss-rh-contract result=pass');
    }
    const out = join(reports, 'release-record.json');
    const result = spawnSync(
      repositoryPath('infra/scripts/rehearsal-release-record.sh'),
      ['fss-rh-contract', digest('a'), digest('b'), 'c'.repeat(40), 'pass', out],
      { encoding: 'utf8', env: { ...process.env, FSS_REHEARSAL_REPORTS: reports, FSS_REHEARSAL_DRY_RUN: '1' } },
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    return JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
  }

  it('parses what rehearsal-release-record.sh writes with the contract the domain stores it by', () => {
    const written = writeRecordWithScript();
    const parsed = releaseRecordSchema.safeParse(written);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    // Strict both ways: every field the script writes is one the contract names, and
    // the digests the two rules compare are where the domain reads them. The script
    // writes no `source`, which is how the contract knows a rehearsal record (lane g96).
    expect(written).not.toHaveProperty('source');
    expect(Object.keys(written).sort()).toEqual(
      Object.keys(rehearsalReleaseRecordSchema.shape)
        .filter(key => key !== 'source')
        .sort(),
    );
    expect(parsed.data?.artifacts).toEqual({ api: digest('a'), worker: digest('b'), desktopCommitStamp: 'c'.repeat(40) });
    expect(parsed.data?.suite).toBe('pass');
    expect(parsed.data?.releaseGateReference.startsWith('fss-rh-contract-')).toBe(true);
  });

  describe('release-deploy.sh --release-record', () => {
    const recordFile = (): { readonly path: string; readonly bytes: Buffer } => {
      const directory = mkdtempSync(join(tmpdir(), 'fss-deploy-record-'));
      const path = join(directory, 'release-record.json');
      writeFileSync(path, `${JSON.stringify(writeRecordWithScript(), null, 2)}\n`);
      return { path, bytes: readFileSync(path) };
    };

    function dryDeploy(extra: readonly string[]): { readonly code: number; readonly output: string; readonly report: string } {
      const reports = mkdtempSync(join(tmpdir(), 'fss-deploy-dry-'));
      const result = spawnSync(
        'bash',
        [
          repositoryPath('infra/scripts/release-deploy.sh'),
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
      // The record names the rehearsal it certifies; the argument that carries it must
      // not, or the production foreign-argument guard would refuse the launch.
      expect(commands[put]?.join(' ')).not.toContain('fss-rh-');
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
