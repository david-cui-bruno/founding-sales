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
import { mustBeRehearsed, readRepositoryFile, repositoryPath } from './support/coverage.ts';
import {
  REHEARSAL_STAGE_CHOICES,
  rehearsalJobSteps,
  stagesForCondition,
  stepScript,
  stepsForStage,
} from './support/releaseWorkflow.ts';

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
  mustBeRehearsed(42);

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

  describe('the dispatch path reads both, and the domain flag as well', () => {
    const gate = readRepositoryFile('packages/domain/outbound/gate.ts');

    it('names its own refusal code, distinct from the domain authentication one', () => {
      expect(SEND_REFUSAL_CODES).toContain('workspace_sending_not_attested');
      expect(SEND_REFUSAL_CODES).toContain('automated_sending_disabled');
    });

    it('calls effectiveSendingEnabled with the deployment flag before it reads the domain', () => {
      const attestationAt = gate.indexOf('effectiveSendingEnabled(');
      const domainAt = gate.indexOf('readPrimarySendingDomain(');
      expect(attestationAt).toBeGreaterThan(-1);
      expect(domainAt).toBeGreaterThan(attestationAt);
      expect(gate).toContain("readSetting(context, 'sending_enabled')");
      // Fail closed: an absent flag is false, never "probably fine".
      expect(gate).toContain('deps.deploymentSendingEnabled ?? false');
    });

    it('still refuses on the domain half, so the three facts are not one fact', () => {
      expect(gate).toContain('automatedSendingEnabled');
      expect(gate).toContain("refuseSend('automated_sending_disabled')");
    });
  });

  describe('the attestation can only be set by an authenticated admin', () => {
    const store = readRepositoryFile('packages/domain/settings/store.ts');
    const contracts = readRepositoryFile('packages/contracts/src/settings.ts');

    it('refuses a non-admin scope in the same transaction as the write', () => {
      expect(store).toContain("if (!isAdminScope(context.scope)) return { ok: false, reason: 'admin_only' };");
      expect(store).toContain("if (actor.kind !== 'user') return { ok: false, reason: 'admin_only' };");
    });

    it('refuses an enable that names no release gate', () => {
      expect(contracts).toContain('releaseGateReference');
      expect(contracts).toContain('enabling production sending names the release gate it passed');
    });
  });

  describe('the release record is what the attestation refers to', () => {
    const script = readRepositoryFile('infra/scripts/rehearsal-release-record.sh');
    const workflow = readRepositoryFile('.github/workflows/greenfield-release.yml');

    it('refuses a suite result that is not a pass', () => {
      expect(script).toContain('a release record is only written for a green suite');
    });

    it('refuses a mutable tag in place of a digest, and one image under both names', () => {
      expect(script).toContain("digest_shape='^sha256:[0-9a-f]{64}$'");
      expect(script).toContain('one image was pushed under both names');
    });

    it('refuses a record for a rehearsal whose drills left no report', () => {
      for (const report of ['restore-drill.txt', 'carry-watermark.txt', 'schema-ranges.txt', 'prefix-guard.txt']) {
        expect(script).toContain(report);
      }
    });

    it('is written last in the workflow, after teardown and the production-prefix assertion', () => {
      const teardownAt = workflow.indexOf('rehearsal-teardown.sh');
      const guardAt = workflow.lastIndexOf('rehearsal-prefix-guard.sh');
      const recordAt = workflow.lastIndexOf('rehearsal-release-record.sh');
      expect(teardownAt).toBeGreaterThan(-1);
      expect(recordAt).toBeGreaterThan(teardownAt);
      expect(recordAt).toBeGreaterThan(guardAt);
    });

    it('enables nothing by itself', () => {
      expect(script).toContain('"enablesSending": false');
    });
  });

  /**
   * G12k: the rehearsal has five stages and only one of them is the gate.
   *
   * A `plan`, `create` or `deploy` run is a discovery run — it exists so that the next
   * plan-time error costs a minute rather than an hour — and none of them proves what
   * 16.2 asks of a release. G16's `teardown` is not even that: it removes an
   * environment an earlier run left standing. The thing that must be impossible is any
   * of the four producing the artifact an admin later points at when enabling sending,
   * so the release-record step's `if:` is the whole of that impossibility.
   *
   * ## The vacuous-pass trap
   *
   * Asserting that the workflow *mentions* `stage` would pass against an input nothing
   * reads, and asserting the record step has some condition would pass against
   * `inputs.stage != 'plan'` — which lets a `create` run write a record for an
   * environment that was never deployed or drilled. Closed by reading the condition as
   * a set of stages and requiring it to be exactly `{full}`, by requiring the record
   * step to be absent from the step list of each of the other four, and by the
   * positive control that it is present in `full`. The mutation check drops the
   * condition and requires this to go red.
   */
  describe('only the full stage can write a release record', () => {
    const steps = rehearsalJobSteps();
    const record = steps.find(step => step.text.includes('rehearsal-release-record.sh'));

    it('offers the five stages and defaults to the cheap one', () => {
      const workflow = readRepositoryFile('.github/workflows/greenfield-release.yml');
      const input = workflow.slice(workflow.indexOf('      stage:'), workflow.indexOf('  pull_request:'));
      expect(input, 'workflow_dispatch declares no `stage` input').toContain('type: choice');
      for (const stage of REHEARSAL_STAGE_CHOICES) expect(input).toContain(`          - ${stage}\n`);
      // The expensive gate is chosen, never inherited from a default.
      expect(input).toContain("default: 'plan'");
    });

    it('runs the release record in the full stage and in no other', () => {
      expect(record, 'no step of the rehearsal job writes a release record').toBeDefined();
      expect(record?.condition).toBe("inputs.stage == 'full'");
      expect([...stagesForCondition(record?.condition ?? null)]).toEqual(['full']);
    });

    it('is not in the step list of a plan, a create, a deploy or a teardown run', () => {
      for (const stage of REHEARSAL_STAGE_CHOICES) {
        const names = stepsForStage(stage, steps).map(step => step.name);
        expect(names.includes(record?.name ?? ''), `a ${stage} run writes a release record`).toBe(stage === 'full');
      }
    });

    it('cannot produce a releaseGateReference from a run that applied nothing', () => {
      // The other half of the same sentence: a `plan` run creates no environment, so
      // even a record step that escaped its condition would have nothing to record.
      const apply = steps.find(step => step.text.includes('terraform apply'));
      expect(apply, 'no step of the rehearsal job applies anything').toBeDefined();
      expect([...stagesForCondition(apply?.condition ?? null)]).toEqual(['create', 'deploy', 'full']);
      expect(stepsForStage('plan', steps).map(step => step.name)).not.toContain(apply?.name);
    });
  });

  /**
   * G16: the fifth stage exists to clean, and cleaning is all it may do.
   *
   * The fourth credentialed rehearsal (Actions run 35628963637) applied an environment
   * and then could not remove it: the journal bucket's own policy denied
   * `s3:DeleteBucketPolicy` and `s3:PutBucketObjectLockConfiguration` to every
   * principal, so `fss-rh-202609211659` is still standing with a bucket, four resources
   * in its state, and an hourly cost for the ones that bill. `if: always()` means the
   * teardown ran; it could not succeed, and nothing in the workflow could be dispatched
   * to try again without also creating a second environment.
   *
   * So `stage = teardown` runs identity, the production inventory, the tfvars file and
   * `terraform init` against the prefix in `run_suffix`, and then the two steps every
   * stage runs. Nothing else.
   *
   * ## The vacuous-pass trap
   *
   * Asserting that the stage exists would pass against a choice nothing reads, and
   * asserting that it runs the teardown step would pass against a `teardown` that also
   * planned, applied, deployed and wrote a record — which is a `full` run with a
   * misleading name, and the expensive mistake this stage is meant to avoid. Closed by
   * naming the steps it must run *and* by requiring the steps it must not: every step
   * whose script reaches `terraform plan`, `terraform apply`, `release-deploy.sh`, the
   * restore drill, the suite or the release record is asserted absent from its step
   * list. The mutation check adds `teardown` to the create step's condition and
   * requires this to go red.
   */
  describe('the teardown stage cleans, and does nothing else', () => {
    const steps = rehearsalJobSteps();
    const names = stepsForStage('teardown', steps).map(step => step.name);

    it('runs identity, the inventory, the variables file, the init, the teardown and the guard', () => {
      for (const name of [
        'The assumed identity is the rehearsal role and nothing else',
        'Record the production inventory before anything is created',
        'Write the variables this run plans, applies and tears down with',
        "Initialise the backend for this run's state key",
        'Tear the rehearsal run down',
        'Nothing with the production prefix was touched',
      ]) {
        expect(names, `a teardown run skips ${name}`).toContain(name);
      }
      // The production-untouched guard compares against an inventory the `before` phase
      // recorded and fails outright without one, so a teardown that skipped the
      // recording would fail its own last step.
      expect(names.indexOf('Record the production inventory before anything is created')).toBeLessThan(
        names.indexOf('Nothing with the production prefix was touched'),
      );
    });

    it('creates, deploys, drills and records nothing', () => {
      const forbidden: Record<string, string> = {
        'terraform plan': 'plans the environment it is about to destroy',
        'terraform apply': 'applies',
        'release-deploy.sh': 'deploys',
        'release-bootstrap-workspace.sh': 'writes the first workspace and its admin',
        'release-seed-drill-evidence.sh': 'seeds the evidence the restore drill reconstructs',
        'rehearsal-restore-drill.sh': 'runs the restore drill',
        'npm run test:release': 'runs the release suite',
        'rehearsal-release-record.sh': 'writes a release record',
      };
      const running = stepsForStage('teardown', steps);
      for (const [needle, what] of Object.entries(forbidden)) {
        // The floor: the needle has to appear somewhere in the job, or "no step of a
        // teardown run contains it" would be true because nothing does.
        expect(
          steps.some(step => step.text.includes(needle)),
          `no step of the rehearsal job contains ${needle}, so asserting its absence proves nothing`,
        ).toBe(true);
        expect(
          running.filter(step => step.text.includes(needle)).map(step => step.name),
          `a teardown run ${what}`,
        ).toEqual([]);
      }
    });

    it('refuses an empty run_suffix, because a teardown of a timestamp names nothing', () => {
      // Every other stage falls back to `fss-rh-<now>`, which is right for a run that
      // is about to create an environment and exactly wrong for one that is about to
      // destroy an existing one: the teardown would report `destroyed=nothing_created`
      // and the orphan would still be there.
      const prefix = stepScript('Decide the run prefix');
      expect(prefix).toContain("if [ \"${{ inputs.stage }}\" = 'teardown' ] && [ -z \"$suffix\" ]; then");
      expect(prefix).toContain('stage=teardown needs run_suffix');
      // And the fallback is still there for the four stages that want it.
      expect(prefix).toContain('suffix="$(date -u +%Y%m%d%H%M)"');
    });

    it('takes the two digests from the inputs, as every stage does', () => {
      // `terraform destroy` requires every variable `apply` did, and the teardown
      // refuses without `run.auto.tfvars.json`. For a teardown the digests need only be
      // well-formed: nothing resolves them, and the resources being destroyed are read
      // from state. So the variables step is unchanged and the digest refusal still runs.
      expect(names).toContain('Refuse anything that is not a digest');
      const tfvars = stepScript('Write the variables this run plans, applies and tears down with');
      expect(tfvars).toContain('"api_image": ');
      expect(tfvars).toContain('"worker_image": ');
      expect(tfvars).toContain('"name_prefix": ');
    });
  });

  describe('the production smoke checks', () => {
    const smoke = readRepositoryFile('scripts/productionSmoke.mjs');

    it('are the six 16.2 names and no others', () => {
      expect(smoke).toContain("'health',");
      expect(smoke).toContain("'readiness',");
      expect(smoke).toContain("'schema_range',");
      expect(smoke).toContain("'connectivity',");
      expect(smoke).toContain("'canary',");
      expect(smoke).toContain("'sending_disabled',");
    });

    it('cannot mutate anything, because only GET appears in it', () => {
      expect(smoke).not.toMatch(/method: *'(POST|PUT|PATCH|DELETE)'/u);
      expect(smoke).toContain("method: 'GET'");
    });

    it('fails rather than skips when the canary age was not supplied', () => {
      expect(smoke).toContain('SMOKE_CANARY_AGE_NOT_SUPPLIED');
    });

    it('compares sending with the state the operator expects, off unless told otherwise', () => {
      // Lane g80 (audit O12): the expectation is an input, and its default is off. The
      // behaviour, both ways, is in productionSmoke.check.ts.
      expect(smoke).toContain("typeof enabled === 'boolean' && enabled === (expectation === 'enabled')");
      expect(smoke).toContain("export const SENDING_EXPECTATIONS = Object.freeze(['disabled', 'enabled']);");
      expect(smoke).toContain('expectSending: SENDING_EXPECTATIONS[0],');
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

    it('both refuse to run a production deployment on anything but live dependencies', () => {
      for (const path of ['apps/worker/src/bootstrap/deployment.ts', 'apps/api/src/bootstrap/deployment.ts']) {
        const source = readRepositoryFile(path);
        expect(source, path).toContain('PRODUCTION_REQUIRES_LIVE');
        expect(source, path).toContain('DEPENDENCIES_UNSET');
      }
    });

    it('neither turns sending on by omission', () => {
      for (const path of ['apps/worker/src/bootstrap/deployment.ts', 'apps/api/src/bootstrap/deployment.ts']) {
        const source = readRepositoryFile(path);
        // `booleanFlag` returns false for an unset variable and refuses anything that
        // is neither `true` nor `false`, so a typo is a refusal rather than a send.
        expect(source, path).toContain("if (raw === undefined || raw.length === 0) return false;");
        expect(source, path).toContain('must be true or false');
      }
    });
  });
});

/**
 * G12f: the one exemption is one exemption.
 *
 * `rehearsal_read_production_inventory` is allowed to name production because Appendix
 * G 39's last clause is measured rather than asserted. Appendix G 42's record is the
 * other thing that reads a production name — the digests it compares are production's —
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
    writeFileSync(join(reports, 'carry-watermark.txt'), 'carry_drill=skipped_no_watermark\n');
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
 * changes). The mutation check drops the flag's branch and requires this to go red.
 */
describe('Appendix G 42: the attestation is bound to the release record (lane g71)', () => {
  const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;

  function writeRecordWithScript(): Record<string, unknown> {
    const reports = mkdtempSync(join(tmpdir(), 'fss-record-contract-'));
    for (const report of ['restore-drill.txt', 'schema-ranges.txt', 'prefix-guard.txt']) {
      writeFileSync(join(reports, report), 'prefix=fss-rh-contract result=pass');
    }
    writeFileSync(join(reports, 'carry-watermark.txt'), 'prefix=fss-rh-contract carry_drill=skipped_no_watermark');
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

  it('refuses the enable on the API side and the send on the worker side, each with its own digest', () => {
    const store = readRepositoryFile('packages/domain/settings/store.ts');
    expect(store).toContain("await bindReleaseRecord(");
    expect(store).toContain("'api',\n        input.runningApiDigest,");
    const gate = readRepositoryFile('packages/domain/outbound/gate.ts');
    expect(gate).toContain("attestedReleaseBinding(context, attestation.value, 'worker', deps.workerImageDigest)");
    // After the two switches and before the domain, so the order of refusals is kept.
    expect(gate.indexOf('attestedReleaseBinding(context')).toBeGreaterThan(gate.indexOf('effectiveSendingEnabled('));
    expect(gate.indexOf('readPrimarySendingDomain(')).toBeGreaterThan(gate.indexOf('attestedReleaseBinding(context'));
    // Both processes say which image they are, from the task metadata.
    for (const path of ['apps/api/src/bootstrap/main.ts', 'apps/worker/src/bootstrap/main.ts']) {
      const main = readRepositoryFile(path);
      expect(main, path).toContain('await discoverImageDigest(environment)');
      expect(main, path).toContain('image_digest: identity.digest');
    }
    expect(readRepositoryFile('apps/api/src/routes/settings.ts')).toContain('runningApiDigest: options.imageDigest');
    expect(readRepositoryFile('apps/worker/src/bootstrap/main.ts')).toContain('workerImageDigest: options.imageDigest');
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
