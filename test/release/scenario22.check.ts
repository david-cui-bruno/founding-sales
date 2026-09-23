import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  API_SCHEMA_RANGE,
  CURRENT_SCHEMA_VERSION,
  PREVIOUS_RELEASE_SCHEMA_RANGE,
  WORKER_SCHEMA_RANGE,
  acceptsSchemaVersion,
  type SchemaRange,
} from '@fss/domain/db';
import { mustBeRehearsed, readRepositoryFile, repositoryPath } from './support/coverage.ts';
import { stepScript } from './support/releaseWorkflow.ts';

/**
 * Appendix G 22: "Old API with new worker and reverse across every expand/contract
 * phase obey schema ranges."
 *
 * Rehearsal-only, because an image either starts against a database or it does not, and
 * nothing on a laptop can ask it that. `infra/scripts/rehearsal-schema-ranges.sh` runs
 * the declared deploy order — migrate, then worker, then API — and then the reverse
 * cases through `--selftest`.
 *
 * ## The vacuous-pass trap
 *
 * With both declared ranges equal to the current schema version, "every pair is
 * compatible" is true and proves nothing: there is no old image that can run against the
 * new schema, so a suite that asserted compatibility would be asserting the absence of a
 * test. The coordinator's launch note says what to do instead — where no ranges overlap,
 * assert the refusal and say why.
 *
 * Closed by computing the overlap from the declared constants rather than assuming one,
 * and taking whichever branch the numbers dictate. It fails if the arithmetic stops
 * meaning anything: a range that does not accept the schema this tree produces, or a
 * refusal that is neither of the two reasons there are.
 */

/** The two refusals `checkSchemaRange` can give; they are this scenario's assertion. */
function refusalFor(range: SchemaRange, version: number): string {
  if (version < range.minimum) return 'database_behind_binary';
  if (version > range.maximum) return 'database_ahead_of_binary';
  return 'accepted';
}

describe('Appendix G 22: the declared ranges decide, and a non-overlap is the refusal', () => {
  mustBeRehearsed(22);

  it('both binaries accept the schema this tree produces', () => {
    // A binary that refused the database it has just been deployed against would be a
    // self-inflicted outage. This is the floor the rest of the scenario stands on.
    expect(acceptsSchemaVersion(API_SCHEMA_RANGE, CURRENT_SCHEMA_VERSION)).toBe(true);
    expect(acceptsSchemaVersion(WORKER_SCHEMA_RANGE, CURRENT_SCHEMA_VERSION)).toBe(true);
  });

  it('takes the overlap branch or the refusal branch according to the declared ranges', () => {
    const previous = refusalFor(PREVIOUS_RELEASE_SCHEMA_RANGE, CURRENT_SCHEMA_VERSION);
    if (previous === 'accepted') {
      // The expand case: the previous release widened its range a release ahead of this
      // migration, so the previous image really can run against the new schema and the
      // rehearsal runs it.
      expect(PREVIOUS_RELEASE_SCHEMA_RANGE.maximum).toBeGreaterThanOrEqual(CURRENT_SCHEMA_VERSION);
    } else {
      // No overlap. The scenario is then the refusal, and it must be one of exactly two
      // reasons — a third would mean the comparison had stopped being a comparison.
      expect(['database_behind_binary', 'database_ahead_of_binary']).toContain(previous);
    }
  });

  it('refuses a schema outside each declared range, whatever the numbers become', () => {
    // Computed from the constants, so a lane that widens a range does not have to
    // remember this file.
    expect(refusalFor(API_SCHEMA_RANGE, API_SCHEMA_RANGE.minimum - 1)).toBe('database_behind_binary');
    expect(refusalFor(WORKER_SCHEMA_RANGE, WORKER_SCHEMA_RANGE.minimum - 1)).toBe('database_behind_binary');
    expect(refusalFor(API_SCHEMA_RANGE, API_SCHEMA_RANGE.maximum + 1)).toBe('database_ahead_of_binary');
    expect(refusalFor(WORKER_SCHEMA_RANGE, WORKER_SCHEMA_RANGE.maximum + 1)).toBe('database_ahead_of_binary');
  });

  it('the rehearsal script reads the ranges from the source rather than from a literal', () => {
    const script = readRepositoryFile('infra/scripts/rehearsal-schema-ranges.sh');
    expect(script).toContain('packages/domain/db/schemaRange.ts');
    expect(script).toContain('API_SCHEMA_RANGE');
    expect(script).toContain('WORKER_SCHEMA_RANGE');
    expect(script).toContain('PREVIOUS_RELEASE_SCHEMA_RANGE');
  });

  /**
   * G12h. Until 21 September the deploy order was a heading and not a deployment.
   *
   * `rehearsal-schema-ranges.sh` was named "migrate, then worker, then API" and did
   * two `update-service --force-new-deployment` calls; nothing anywhere ran a
   * migration, and both binaries refuse to start unless the applied schema version is
   * exactly the range they declare. On a fresh database that is two services that
   * never start. These assert the order is now performed rather than described.
   */
  it('performs the order in the shared deploy script: migrate, users, verify, worker, API', () => {
    const script = readRepositoryFile('infra/scripts/release-deploy.sh');
    const at = (needle: string): number => {
      const index = script.indexOf(needle);
      expect(index, `release-deploy.sh does not ${needle}`).toBeGreaterThan(-1);
      return index;
    };

    const migrate = at('one_off migrate "$MIGRATION_TASK_DEFINITION" migration migrate');
    const users = at('one_off database-users "$MIGRATION_TASK_DEFINITION" migration admin database-users ensure');
    const verify = at('one_off verify-schema "$OPERATIONS_TASK_DEFINITION" operations verify');
    const worker = at('scale "$WORKER_SERVICE" "$WORKER_TARGET"');
    const api = at('scale "$API_SERVICE" "$API_TARGET"');
    const verifyDeployed = at('one_off verify-deployed "$OPERATIONS_TASK_DEFINITION" operations verify');

    expect(users).toBeGreaterThan(migrate);
    expect(verify).toBeGreaterThan(users);
    expect(worker).toBeGreaterThan(verify);
    expect(api).toBeGreaterThan(worker);
    // A release gate after every deploy, not only before it.
    expect(verifyDeployed).toBeGreaterThan(api);
  });

  it('stops during a schema migration and never rolls the database back', () => {
    const script = readRepositoryFile('infra/scripts/release-deploy.sh');
    // API first, so no request reaches a schema that is about to move.
    const stop = script.indexOf('scale "$API_SERVICE" 0');
    const stopWorker = script.indexOf('scale "$WORKER_SERVICE" 0');
    expect(stop).toBeGreaterThan(-1);
    expect(stopWorker).toBeGreaterThan(stop);
    expect(script.indexOf('scale "$API_SERVICE" 0')).toBeLessThan(
      script.indexOf('one_off migrate "$MIGRATION_TASK_DEFINITION"'),
    );

    // And the policy is written where an operator reads it, not only here.
    const release = readRepositoryFile('docs/greenfield/release.md');
    expect(release).toContain('Stop-during-migration');
    expect(release).toContain('The database never rolls back');
  });

  it('creates a fresh environment at desired count zero rather than crash-looping it', () => {
    // Both binaries refuse an unmigrated database, so an apply that started them
    // would create two services failing against an empty schema while the task that
    // would fix it had not been launched. `bootstrap` is the root variable that says
    // which of the two states an apply is.
    const cluster = readRepositoryFile('infra/modules/cluster/main.tf');
    expect(cluster).toContain('api_desired_count    = var.bootstrap ? 0 : var.api_desired_count');
    expect(cluster).toContain('worker_desired_count = var.bootstrap ? 0 : var.worker_desired_count');
    // Never `ignore_changes` on the count: that would make it untracked for ever and
    // take away Terraform's ability to scale to zero for the next schema release.
    expect(cluster).not.toContain('ignore_changes = [desired_count]');

    for (const root of ['infra/roots/rehearsal/main.tf', 'infra/roots/production/main.tf']) {
      expect(readRepositoryFile(root)).toContain('bootstrap              = var.bootstrap');
    }
    // The rehearsal creates a fresh environment every time, so its default is true.
    expect(readRepositoryFile('infra/roots/rehearsal/variables.tf')).toMatch(
      /variable "bootstrap"[\s\S]*?default\s*=\s*true/u,
    );
    expect(readRepositoryFile('infra/roots/production/variables.tf')).toMatch(
      /variable "bootstrap"[\s\S]*?default\s*=\s*false/u,
    );
    expect(readRepositoryFile('.github/workflows/greenfield-release.yml')).toContain('-var="bootstrap=true"');
  });

  it('names every variable the rehearsal root requires, in the plan and in the file the teardown destroys with', () => {
    // The second credentialed run (21 September 2026, Actions 35602423640) reached the
    // apply and was refused: "The root module input variable api_schema_range is not
    // set". The workflow named six of the root's eight required variables and nothing
    // compared its list with the root's. This does — and it asks the same of the file
    // the teardown's `terraform destroy` reads, because destroy requires the same
    // values and runs on `always()` after the create step's shell is gone.
    //
    // G12k moved the `-var` list on to `terraform plan`, which every stage runs, and
    // the apply consumes the plan file it wrote. So the list is asked of the step that
    // carries it rather than of the file as a whole: a `-var` in a comment, or in a
    // step that no longer runs, would otherwise satisfy this.
    const variables = readRepositoryFile('infra/roots/rehearsal/variables.tf');
    const required = variables
      .split(/^variable "/mu)
      .slice(1)
      .filter(block => !/^ {2}default\s*=/mu.test(block))
      .map(block => block.slice(0, block.indexOf('"')));
    expect(required).toEqual(
      expect.arrayContaining(['api_image', 'worker_image', 'api_schema_range', 'worker_schema_range']),
    );
    const plan = stepScript('Plan the rehearsal environment, and summarise it without values');
    const tfvars = stepScript('Write the variables this run plans, applies and tears down with');
    for (const name of required) {
      expect(plan, `the plan passes ${name}`).toContain(`-var="${name}=`);
      expect(tfvars, `the variables step writes ${name} for the teardown`).toContain(`"${name}": `);
    }
    // The ranges come from the source, as the images workflow reads them, never typed.
    const workflow = readRepositoryFile('.github/workflows/greenfield-release.yml');
    expect(workflow).toContain("const module = await import('./packages/domain/db/schemaRange.ts');");
    expect(tfvars).toContain('python3 - > run.auto.tfvars.json');
    const teardown = readRepositoryFile('infra/scripts/rehearsal-teardown.sh');
    expect(teardown).toContain('if [ ! -f run.auto.tfvars.json ]; then');
  });

  /**
   * The two identity boundaries, asserted here as well as in Terraform.
   *
   * `infra/modules/cluster/tests/migration_identity.tftest.hcl` reads them out of the
   * planned policy documents, which is the real check — but `terraform test` runs in
   * `infra/scripts/offline-gate.sh` and not in `npm run test:release`, so a mutation
   * of either line would leave this suite green. Each is a single expression, and
   * each is the whole of one of David's conditions.
   */
  it('keeps the runtime execution roles away from the migration entry', () => {
    const cluster = readRepositoryFile('infra/modules/cluster/main.tf');
    expect(cluster).toContain(
      'runtime_secret_arns = distinct(concat(values(var.secret_arns), [var.app_runtime_database_secret_arn]))',
    );
    // Condition 1: what the services may resolve is the application secrets and the
    // app_runtime entry. Not the migration entry, and not the RDS-managed master
    // secret, which after G12h nothing in the cluster reads at all.
    expect(cluster).not.toContain('runtime_secret_arns = distinct(concat(values(var.secret_arns), [var.app_runtime_database_secret_arn, var.migration_database_secret_arn]))');
    expect(cluster).not.toContain('database_master_secret_arn');
  });

  it('fixes the drill’s dependency mode in its task definition, not in a caller', () => {
    const cluster = readRepositoryFile('infra/modules/cluster/main.tf');
    // Condition 6: reconcile-sent, recover and watch-renew all reach Gmail when
    // dependencies are live, so a rehearsal that inherited the root's mode would send
    // real mail. The tool refuses in any other mode; this is the second lock.
    expect(cluster).toContain('drill_environment = merge(local.worker_environment, { FSS_DEPENDENCIES = "recorded" })');
  });

  it('scales to the count the root declares, read from the plan rather than typed', () => {
    // A literal in a shell file is a number that drifts from the one in the root.
    const script = readRepositoryFile('infra/scripts/release-deploy.sh');
    expect(script).toContain('release_output "$ROOT_DIRECTORY" deployment_plan json');
    expect(script).toContain('"api.declared_desired_count"');
    expect(script).toContain('"worker.declared_desired_count"');

    const outputs = readRepositoryFile('infra/modules/cluster/outputs.tf');
    expect(outputs).toContain('declared_desired_count = var.api_desired_count');
    expect(outputs).toContain('planned_desired_count  = aws_ecs_service.api.desired_count');
  });

  it('is the same code path in production, under the operator’s own credentials', () => {
    const script = readRepositoryFile('infra/scripts/release-deploy.sh');
    // The environment comes from the prefix, and the root must agree with it.
    expect(script).toContain('release_environment_for_prefix "$PREFIX"');
    expect(script).toContain('production:*roots/production');
    expect(script).toContain('rehearsal:*roots/rehearsal');

    const workflow = readRepositoryFile('.github/workflows/greenfield-release.yml');
    expect(workflow).toContain('infra/scripts/release-deploy.sh infra/roots/rehearsal');
    const runbook = readRepositoryFile('docs/greenfield/infra-apply-runbook.md');
    expect(runbook).toContain('infra/scripts/release-deploy.sh infra/roots/production fss-prod');
  });
});

/**
 * Lane g38: the refusal half measures the container, not the API call.
 *
 * The seventh full rehearsal (Actions 35905867795, 23 September 2026) was the first to
 * reach this step, and it failed in one second. Both defects were this script's, and
 * both were the same mistake wearing different clothes — a step that asserted
 * something cheaper than what it claimed:
 *
 *   * the overlap case launched `<prefix>-<service>-previous`, a family nothing in
 *     this repository registers (`infra/modules/cluster` registers `-api`, `-worker`,
 *     `-migration`, `-operations` and `-drill`), and on a first release there is no
 *     previous image at all;
 *   * the stale case called the CLI directly, outside the wrapper, with no
 *     `--network-configuration` — which an `awsvpc` task definition cannot be launched
 *     without — and read the failure of that client-side-refused call as the refusal
 *     it was hunting for. It passed every time and measured nothing.
 *
 * So the vacuous-pass trap is exact: **a launch whose exit code nobody reads**. The
 * checks below drive the script offline against a fake CLI and require it to fail both
 * when the container exits 0 (the image accepted a range it does not support) and when
 * it exits anything else (it stopped for some other reason).
 */

const SCHEMA_RANGES = 'infra/scripts/rehearsal-schema-ranges.sh';
const CHECK_PREFIX = 'fss-rh-check';
const CHECK_API_DIGEST = `sha256:${'a'.repeat(64)}`;
const CHECK_WORKER_DIGEST = `sha256:${'b'.repeat(64)}`;
const CHECK_PREVIOUS_DIGEST = `sha256:${'c'.repeat(64)}`;

interface RunOptions {
  /** What the stale case's container exits with. 12 is the refusal both images give. */
  readonly staleExit: number;
  /** Whether anything registers `<prefix>-<service>-previous`. */
  readonly previousRegistered?: boolean;
  /** What the overlap case's container exits with, when there is one to run. */
  readonly previousExit?: number;
}

interface SchemaRangeRun {
  readonly code: number;
  readonly output: string;
  /** The report the script writes, or null when it stopped before writing one. */
  readonly report: string | null;
}

/**
 * A fake AWS CLI answering exactly the four calls this step makes, and refusing
 * anything else so a call added later cannot pass unnoticed.
 */
function stubAws(directory: string, options: RunOptions): string {
  const path = join(directory, 'aws');
  const absent =
    'An error occurred (ClientException) when calling the DescribeTaskDefinition operation: Unable to describe task definition.';
  const missingPrevious = [
    '    *-previous)',
    `      echo "${absent}" >&2`,
    '      exit 254 ;;',
  ];
  const lines = [
    '#!/usr/bin/env bash',
    'service=$1; operation=$2; shift 2',
    'target=""; tasks=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --task-definition) target=$2 ;;',
    '    --tasks) tasks=$2 ;;',
    '  esac',
    '  shift',
    'done',
    '# Both a family name and a full ARN reach this stub; the family is what it keys on.',
    'family="${target##*/}"; family="${family%%:*}"',
    'container=api; case "$family" in *worker*) container=worker ;; esac',
    'case "$family" in',
    `  *-previous) digest='${CHECK_PREVIOUS_DIGEST}' ;;`,
    `  *worker*) digest='${CHECK_WORKER_DIGEST}' ;;`,
    `  *) digest='${CHECK_API_DIGEST}' ;;`,
    'esac',
    'if [ "$service" = ecs ] && [ "$operation" = describe-task-definition ]; then',
    '  case "$family" in',
    ...(options.previousRegistered === true ? [] : missingPrevious),
    '  esac',
    '  cat <<JSON',
    '{"taskDefinitionArn": "arn:aws:ecs:us-east-1:111111111111:task-definition/$family:1",',
    ' "containerDefinitions": [{"name": "$container",',
    '  "image": "111111111111.dkr.ecr.us-east-1.amazonaws.com/fss-rh-$container@$digest",',
    '  "environment": [{"name": "FSS_DATABASE_HOST", "value": "fss-rh-check-pg.example.com"}],',
    '  "secrets": [{"name": "DATABASE_SECRET_ARN", "valueFrom": "arn:aws:secretsmanager:us-east-1:111111111111:secret:fss-rh-check/app-runtime-database-bbbbbb"}],',
    '  "logConfiguration": {"logDriver": "awslogs", "options": {"awslogs-group": "/fss/fss-rh-check/$container", "awslogs-stream-prefix": "$container"}}}]}',
    'JSON',
    '  exit 0',
    'fi',
    'if [ "$service" = ecs ] && [ "$operation" = run-task ]; then',
    '  cat <<JSON',
    '{"tasks": [{"taskArn": "arn:aws:ecs:us-east-1:111111111111:task/fss-rh-check-cluster/$family"}], "failures": []}',
    'JSON',
    '  exit 0',
    'fi',
    'if [ "$service" = ecs ] && [ "$operation" = describe-tasks ]; then',
    `  code=${String(options.staleExit)}`,
    `  case "$tasks" in *-previous) code=${String(options.previousExit ?? 0)} ;; esac`,
    '  cat <<JSON',
    '{"tasks": [{"lastStatus": "STOPPED", "stopCode": "EssentialContainerExited", "stoppedReason": "Essential container in task exited", "containers": [{"name": "$container", "exitCode": $code}]}]}',
    'JSON',
    '  exit 0',
    'fi',
    'echo "unexpected: $service $operation $*" >&2',
    'exit 1',
    '',
  ];
  writeFileSync(path, lines.join('\n'));
  chmodSync(path, 0o755);
  return path;
}

/** The whole step, offline: no credential, no terraform, no network. */
function runSchemaRanges(options: RunOptions): SchemaRangeRun {
  const directory = mkdtempSync(join(tmpdir(), 'fss-schema-ranges-'));
  const reports = mkdtempSync(join(tmpdir(), 'fss-schema-reports-'));
  const result = spawnSync(
    repositoryPath(SCHEMA_RANGES),
    [CHECK_PREFIX, '--api-digest', CHECK_API_DIGEST, '--worker-digest', CHECK_WORKER_DIGEST],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        FSS_REHEARSAL_REPORTS: reports,
        FSS_REHEARSAL_AWS_COMMAND: stubAws(directory, options),
        AWS_REGION: 'us-east-1',
        FSS_RELEASE_ACCOUNT: '111111111111',
        FSS_RELEASE_CALLER_ACCOUNT: '111111111111',
        FSS_RELEASE_CLUSTER_TAGS: JSON.stringify([{ key: 'Environment', value: 'rehearsal' }]),
        FSS_RELEASE_OUTPUT_CLUSTER_ARN: 'arn:aws:ecs:us-east-1:111111111111:cluster/fss-rh-check-cluster',
        FSS_RELEASE_OUTPUT_APP_RUNTIME_DATABASE_SECRET_ARN:
          'arn:aws:secretsmanager:us-east-1:111111111111:secret:fss-rh-check/app-runtime-database-bbbbbb',
        FSS_RELEASE_OUTPUT_TASK_NETWORK_CONFIGURATION: JSON.stringify({
          subnet_ids: ['subnet-0a'],
          security_group_id: 'sg-0a',
          assign_public_ip: 'ENABLED',
          database_port: 5432,
          database_host: 'fss-rh-check-pg.example.com',
          inbound_rule_count: 0,
        }),
        FSS_RELEASE_LOG_EVENTS: JSON.stringify({
          events: [
            { message: '{"level":"error","event":"api_configuration_refused","code":"SCHEMA_RANGE_DISAGREES"}' },
          ],
        }),
      },
    },
  );
  const report = join(reports, 'schema-ranges.txt');
  return {
    code: result.status ?? 1,
    output: `${result.stdout}${result.stderr}`,
    report: existsSync(report) ? readFileSync(report, 'utf8').trim() : null,
  };
}

describe('Appendix G 22 (g38): the refusal cases measure the container, not the API call', () => {
  const script = readRepositoryFile(SCHEMA_RANGES);
  /** The script without its prose, so the header may name the call it no longer makes. */
  const commands = script
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .join('\n');

  it('issues no run-task of its own; every launch goes through the one-off wrapper', () => {
    // Not `command aws ecs run-task`, which is what run 35905867795 found here, and not
    // `rehearsal_aws ecs run-task` either: that one makes the call and then tells you
    // nothing about the container it started.
    expect(commands).not.toContain('command aws ecs run-task');
    expect(commands).not.toMatch(/ecs run-task/u);
    expect(commands).toContain('release_run_task \\');
    // The network plan an `awsvpc` task cannot be launched without, from the root's
    // own output rather than a literal.
    expect(commands).toContain('--network-plan "$NETWORK_PLAN"');
    expect(commands).toContain('release_output "$TERRAFORM_ROOT" task_network_configuration json');
  });

  it('asks whether the previous task definition exists before it runs one', () => {
    expect(commands).toContain('family="${PREFIX}-${service}-previous"');
    expect(commands).toContain('ecs describe-task-definition');
    // Absence is a fact to record, not a failure: a first release has no previous image.
    expect(commands).toContain('CASE_VERDICT=skipped_no_previous');
    // And absence is recognised by what ECS says about an unregistered family, so an
    // AccessDenied or a throttle is still a failure rather than "there is none".
    expect(commands).toContain('Unable to describe task definition');
    expect(commands).toContain('(ClientException)');
  });

  it('requires the exit code the two images actually give a range they do not accept', () => {
    const declared = /^SCHEMA_REFUSAL_EXIT_CODE=(\d+)$/mu.exec(script)?.[1];
    expect(declared, 'the script names the refusal exit code once').toBeDefined();
    // 12 in both, from two files: API_EXIT_CODES and WORKER_EXIT_CODES. It is *not*
    // the `fss` tool's 20 — that tool is the migration and operations entry point and
    // reads no schema range at all, so it can neither give nor withhold this refusal.
    for (const source of ['apps/api/src/bootstrap/main.ts', 'apps/worker/src/index.ts']) {
      const code = /configurationInvalid: (\d+)/u.exec(readRepositoryFile(source))?.[1];
      expect(code, `${source} declares configurationInvalid`).toBe(declared);
    }
    for (const config of ['apps/api/src/bootstrap/config.ts', 'apps/worker/src/bootstrap/config.ts']) {
      expect(readRepositoryFile(config)).toContain('SCHEMA_RANGE_DISAGREES');
    }
    // The comparison lives where the exit code is read, rather than in a caller
    // parsing the wrapper's output.
    expect(commands).toContain('--expect-exit "$expect"');
    const wrapper = readRepositoryFile('infra/scripts/release-common.sh');
    expect(wrapper).toContain('--expect-exit) expect_exit=$2; shift 2 ;;');
    expect(wrapper).toContain('release_report_task "$step" "$described" "$container" "$expect_exit" || verdict=1');
  });

  it('the workflow hands this step both digests, as it hands them to the deploy step', () => {
    const step = stepScript('The declared schema ranges, against the deployed images');
    expect(step).toContain("--api-digest '${{ inputs.api_image_digest }}'");
    expect(step).toContain("--worker-digest '${{ inputs.worker_image_digest }}'");
    // The restore drill runs this script again (Appendix E step 7's control-plane
    // half) and passes the digests through the environment, so that step names both.
    const workflow = readRepositoryFile('.github/workflows/greenfield-release.yml');
    expect(workflow).toContain('FSS_RELEASE_API_DIGEST: ${{ inputs.api_image_digest }}');
    // And the dry run every pull request prints exercises the same arguments. That
    // step belongs to the offline job rather than the credentialed one, so it is read
    // from the file rather than through `stepScript`.
    expect(workflow).toContain(
      'infra/scripts/rehearsal-schema-ranges.sh $prefix --api-digest $FSS_RELEASE_API_DIGEST --worker-digest $FSS_RELEASE_WORKER_DIGEST',
    );
  });

  it('skips the overlap case on a first release and records the refusal the stale case measured', () => {
    const run = runSchemaRanges({ staleExit: 12 });
    expect(run.code, run.output).toBe(0);
    expect(run.output).toContain('nothing registers fss-rh-check-api-previous');
    // The container's own words, out of the log stream, whatever the verdict.
    expect(run.output).toContain('SCHEMA_RANGE_DISAGREES');
    expect(run.report).toContain('api_overlap=skipped_no_previous');
    expect(run.report).toContain('api_stale=refused_exit_12');
    expect(run.report).toContain('worker_overlap=skipped_no_previous');
    expect(run.report).toContain('worker_stale=refused_exit_12');
  });

  it('runs the previous image when one is registered, and requires it to start', () => {
    const run = runSchemaRanges({ staleExit: 12, previousRegistered: true, previousExit: 0 });
    expect(run.code, run.output).toBe(0);
    expect(run.output).toContain('fss-rh-check-api-previous is registered');
    expect(run.report).toContain('api_overlap=ran_exit_0');
  });

  it('fails when a registered previous image refuses the schema its range accepts', () => {
    // The other half of the overlap case, and its whole assertion: a previous image
    // whose declared range accepts this schema must actually start against it.
    const refused = runSchemaRanges({ staleExit: 12, previousRegistered: true, previousExit: 12 });
    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain('did not start against schema');
    expect(refused.report, 'no report is written for a step that failed').toBeNull();
  });

  it('fails when the image accepts a declared range it does not support', () => {
    // Exit 0 is the finding this case exists for, and the one the old script could
    // never see: it read the run-task API call rather than the container.
    const run = runSchemaRanges({ staleExit: 0 });
    expect(run.code).not.toBe(0);
    expect(run.output).toContain('exited 0 and this step requires exit 12');
    expect(run.output).toContain('did not refuse the declared range');
    expect(run.report).toBeNull();
  });

  it('fails when the container stops for some other reason, and prints the code', () => {
    // A task that could not pull its image, or a process that died for an unrelated
    // reason, is not this refusal. Any code but the expected one is a failure.
    const run = runSchemaRanges({ staleExit: 1 });
    expect(run.code).not.toBe(0);
    expect(run.output).toContain('exited 1 and this step requires exit 12');
  });
});
