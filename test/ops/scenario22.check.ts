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
} from '@fss/domain/db/schemaRange.ts';
import { repositoryPath } from './support/repository.ts';

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

/**
 * Lane g70: a schema-change release stops the services before the apply, and the
 * deploy refuses to migrate under a service that is still running.
 *
 * The independent review of 25 September found the order backwards. `terraform apply`
 * registers the release's task definitions, whose strict `{N,N}` range refuses the
 * schema the database is still at, and repointed the running services at them;
 * `release-deploy.sh --schema-change` then scaled them to zero in its step 1, after
 * ECS had begun replacing working tasks with tasks that exit 12. The 04:41Z deploy of
 * schema 16 ran in exactly that order (`docs/greenfield/release.md` 8.0af).
 *
 * The order is now `release-stop.sh` → apply → `release-deploy.sh --schema-change`,
 * the apply cannot move a count (`ignore_changes`, asserted above and applied in
 * `infra/modules/cluster/tests/release_owns_the_count.tftest.hcl`), and step 1 is a
 * refusal rather than a scale.
 *
 * ## The vacuous-pass trap
 *
 * Reading the refusal out of the script passes against a refusal that is never reached,
 * or one that refuses every deploy. So both scripts are driven offline against a fake
 * CLI that keeps each service's counts in a file, and every run is judged by the calls
 * the CLI saw as well as by the exit code: a refused deploy must have made no
 * `run-task` and no `update-service`, a deploy with both services at zero must reach
 * the migration's `run-task`, and a stop must scale the API before the worker and then
 * read both back.
 *
 * Lane g80 (audit items O03 and O08) runs the same fake further. Without
 * `--schema-change` a deploy is one rolling deployment and nothing else — no `run-task`
 * at all, one `update-service --desired-count` per service and no forced second
 * rollout — and on both paths the deploy then reads the running tasks back. The fake
 * answers `list-tasks` and `describe-tasks` from a per-service digest file, so a
 * service that is stable on the wrong image (the circuit breaker's rollback), or on
 * fewer tasks than it declares, is a failure the checks below can ask for; and it can
 * let the one-off tasks pass, so a schema release runs from its assertion to its
 * final verify offline.
 */

const STOP = 'infra/scripts/release-stop.sh';
const DEPLOY = 'infra/scripts/release-deploy.sh';
const ORDER_PREFIX = 'fss-rh-order';
const ORDER_ACCOUNT = '111111111111';
const ORDER_CLUSTER = `arn:aws:ecs:us-east-1:${ORDER_ACCOUNT}:cluster/${ORDER_PREFIX}-cluster`;
const ORDER_WORKER_DIGEST = `sha256:${'b'.repeat(64)}`;
const ORDER_API_DIGEST = `sha256:${'a'.repeat(64)}`;
const ORDER_OLD_DIGEST = `sha256:${'9'.repeat(64)}`;
const ORDER_RUNTIME_SECRET = `arn:aws:secretsmanager:us-east-1:${ORDER_ACCOUNT}:secret:${ORDER_PREFIX}/app-runtime-database-bbbbbb`;
const ORDER_HOST = `${ORDER_PREFIX}-pg.example.com`;

interface ServiceCounts {
  readonly desired: number;
  readonly running: number;
}

interface OrderRun {
  readonly code: number;
  readonly output: string;
  /** Every CLI call, one line each, in order: `<service> <operation> <arguments>`. */
  readonly calls: readonly string[];
  /** Each service's counts afterwards, as the fake ECS holds them. */
  readonly counts: Readonly<Record<string, ServiceCounts>>;
  readonly report: string | null;
}

/**
 * A fake AWS CLI holding each service's desired and running counts in a file. An
 * `update-service --desired-count` moves both at once, which is what a stable service
 * ends at, unless `sticky` is set: then ECS acknowledges the call and nothing stops.
 *
 * Lane g80: `list-tasks` answers one RUNNING task per running count, and
 * `describe-tasks` gives each the digest in `<service>.digest` and the service's one
 * deployment's task definition. `run-task` stops the run at the migration unless
 * `one-offs-pass` exists; then every one-off task exits 0 and logs one line.
 */
function orderStub(directory: string): string {
  const path = join(directory, 'aws');
  const lines = [
    '#!/usr/bin/env bash',
    `state='${directory}'`,
    'printf "%s\\n" "$*" >> "$state/calls.log"',
    'service=$1; operation=$2; shift 2',
    'name=""; count=""; tasks=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --service|--services|--service-name) name=$2; shift ;;',
    '    --desired-count) count=$2; shift ;;',
    '    --tasks) shift; while [ "$#" -gt 0 ] && [ "${1#--}" = "$1" ]; do tasks="$tasks $1"; shift; done; continue ;;',
    '  esac',
    '  shift',
    'done',
    `definition() { echo "arn:aws:ecs:us-east-1:${ORDER_ACCOUNT}:task-definition/$1:7"; }`,
    'case "$service $operation" in',
    '  "ecs describe-services")',
    '    desired=$(cat "$state/$name.desired" 2>/dev/null || echo 0)',
    '    running=$(cat "$state/$name.running" 2>/dev/null || echo 0)',
    '    rollout=$(cat "$state/$name.rollout" 2>/dev/null || echo COMPLETED)',
    '    printf \'{"services":[{"serviceName":"%s","status":"ACTIVE","desiredCount":%s,"runningCount":%s,"pendingCount":0,"deployments":[{"status":"PRIMARY","taskDefinition":"%s","rolloutState":"%s"}]}],"failures":[]}\\n\' "$name" "$desired" "$running" "$(definition "$name")" "$rollout"',
    '    exit 0 ;;',
    '  "ecs update-service")',
    '    if [ -n "$count" ]; then',
    '      echo "$count" > "$state/$name.desired"',
    '      [ -f "$state/sticky" ] || echo "$count" > "$state/$name.running"',
    '    fi',
    '    printf "%s\\t%s\\n" "$name" "${count:-unchanged}"',
    '    exit 0 ;;',
    '  "ecs wait") exit 0 ;;',
    '  "ecs list-tasks")',
    '    running=$(cat "$state/$name.running" 2>/dev/null || echo 0)',
    '    arns=""; i=1',
    `    while [ "$i" -le "$running" ]; do arns="$arns\${arns:+,}\\"arn:aws:ecs:us-east-1:${ORDER_ACCOUNT}:task/${ORDER_PREFIX}-cluster/$name-$i\\""; i=$((i + 1)); done`,
    '    printf \'{"taskArns":[%s]}\\n\' "$arns"',
    '    exit 0 ;;',
    '  "ecs describe-tasks")',
    '    out=""',
    '    for arn in $tasks; do',
    '      id=${arn##*/}',
    '      case "$id" in',
    '        oneoff-*) entry=\'{"lastStatus":"STOPPED","stopCode":"EssentialContainerExited","containers":[{"name":"one-off","exitCode":0}]}\' ;;',
    '        *) owner=${id%-*}; container=${owner##*-}',
    '           entry=$(printf \'{"taskArn":"%s","lastStatus":"RUNNING","taskDefinitionArn":"%s","containers":[{"name":"%s","image":"registry/%s","imageDigest":"%s"}]}\' "$arn" "$(definition "$owner")" "$container" "$container" "$(cat "$state/$owner.digest")") ;;',
    '      esac',
    '      out="$out${out:+,}$entry"',
    '    done',
    '    printf \'{"tasks":[%s],"failures":[]}\\n\' "$out"',
    '    exit 0 ;;',
    '  "ecs run-task")',
    '    if [ -f "$state/one-offs-pass" ]; then',
    '      n=$(( $(cat "$state/one-offs" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$state/one-offs"',
    `      printf '{"tasks":[{"taskArn":"arn:aws:ecs:us-east-1:${ORDER_ACCOUNT}:task/${ORDER_PREFIX}-cluster/oneoff-%s"}],"failures":[]}\\n' "$n"`,
    '      exit 0',
    '    fi',
    '    # The migration is where these runs stop: reaching it is the assertion.',
    '    echo \'{"tasks": [], "failures": [{"arn": "stub", "reason": "STUB_STOPS_AT_THE_MIGRATION"}]}\'',
    '    exit 0 ;;',
    '  "logs get-log-events") echo \'{"events":[{"message":"{\\"ok\\":true}"}]}\'; exit 0 ;;',
    'esac',
    'echo "unexpected: $service $operation" >&2',
    'exit 1',
    '',
  ];
  writeFileSync(path, lines.join('\n'));
  chmodSync(path, 0o755);
  return path;
}

interface OrderOptions {
  readonly sticky?: boolean;
  readonly bootstrap?: boolean;
  /** The digest each service's running tasks report; the release's own by default. */
  readonly running?: Readonly<Partial<Record<'api' | 'worker', string>>>;
  /** The one-off tasks exit 0 instead of the run stopping at the migration. */
  readonly oneOffsPass?: boolean;
  /** Fixtures to replace, to prove a refusal. */
  readonly fixtures?: Readonly<Record<string, string>>;
}

function runOrder(
  script: string,
  args: readonly string[],
  services: Readonly<Record<'api' | 'worker', ServiceCounts>>,
  options: OrderOptions = {},
): OrderRun {
  const directory = mkdtempSync(join(tmpdir(), 'fss-order-'));
  const reports = mkdtempSync(join(tmpdir(), 'fss-order-reports-'));
  for (const [name, counts] of Object.entries(services)) {
    writeFileSync(join(directory, `${ORDER_PREFIX}-${name}.desired`), `${String(counts.desired)}\n`);
    writeFileSync(join(directory, `${ORDER_PREFIX}-${name}.running`), `${String(counts.running)}\n`);
  }
  writeFileSync(join(directory, `${ORDER_PREFIX}-api.digest`), `${options.running?.api ?? ORDER_API_DIGEST}\n`);
  writeFileSync(join(directory, `${ORDER_PREFIX}-worker.digest`), `${options.running?.worker ?? ORDER_WORKER_DIGEST}\n`);
  if (options.sticky === true) writeFileSync(join(directory, 'sticky'), '');
  if (options.oneOffsPass === true) writeFileSync(join(directory, 'one-offs-pass'), '');
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    // No dry run and no ambient fixture may leak into a run judged by its CLI calls.
    if (value !== undefined && !name.startsWith('FSS_')) env[name] = value;
  }
  const fixtures: Record<string, string> = {
    AWS_REGION: 'us-east-1',
    FSS_REHEARSAL_REPORTS: reports,
    FSS_REHEARSAL_AWS_COMMAND: orderStub(directory),
    RELEASE_LOG_POLL_SECONDS: '0',
    FSS_RELEASE_ACCOUNT: ORDER_ACCOUNT,
    FSS_RELEASE_CALLER_ACCOUNT: ORDER_ACCOUNT,
    FSS_RELEASE_CLUSTER_TAGS: JSON.stringify([{ key: 'Environment', value: 'rehearsal' }]),
    FSS_RELEASE_OUTPUT_CLUSTER_ARN: ORDER_CLUSTER,
    FSS_RELEASE_OUTPUT_MIGRATION_TASK_DEFINITION_ARN: `arn:aws:ecs:us-east-1:${ORDER_ACCOUNT}:task-definition/${ORDER_PREFIX}-migration:1`,
    FSS_RELEASE_OUTPUT_OPERATIONS_TASK_DEFINITION_ARN: `arn:aws:ecs:us-east-1:${ORDER_ACCOUNT}:task-definition/${ORDER_PREFIX}-operations:1`,
    FSS_RELEASE_OUTPUT_APP_RUNTIME_DATABASE_SECRET_ARN: ORDER_RUNTIME_SECRET,
    FSS_RELEASE_OUTPUT_WORKER_LOG_GROUP_NAME: `/fss/${ORDER_PREFIX}/worker`,
    FSS_RELEASE_OUTPUT_TASK_NETWORK_CONFIGURATION: JSON.stringify({
      subnet_ids: ['subnet-0a'],
      security_group_id: 'sg-0a',
      assign_public_ip: 'ENABLED',
      database_port: 5432,
      database_host: ORDER_HOST,
      inbound_rule_count: 0,
    }),
    FSS_RELEASE_OUTPUT_DEPLOYMENT_PLAN: JSON.stringify({
      bootstrap: options.bootstrap === true,
      api: { service_name: `${ORDER_PREFIX}-api`, declared_desired_count: 2, planned_desired_count: 2 },
      worker: { service_name: `${ORDER_PREFIX}-worker`, declared_desired_count: 1, planned_desired_count: 1 },
    }),
    FSS_RELEASE_TASK_DEFINITION: JSON.stringify({
      containerDefinitions: [
        {
          name: 'migration',
          image: `${ORDER_ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/fss-rh-worker@${ORDER_WORKER_DIGEST}`,
          environment: [{ name: 'FSS_DATABASE_HOST', value: ORDER_HOST }],
          secrets: [],
        },
        {
          name: 'operations',
          image: `${ORDER_ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/fss-rh-worker@${ORDER_WORKER_DIGEST}`,
          environment: [{ name: 'FSS_DATABASE_HOST', value: ORDER_HOST }],
          secrets: [{ name: 'DATABASE_SECRET_ARN', valueFrom: ORDER_RUNTIME_SECRET }],
        },
      ],
    }),
  };
  const result = spawnSync(repositoryPath(script), [...args], {
    encoding: 'utf8',
    env: { ...env, ...fixtures, ...options.fixtures },
  });
  const read = (file: string): string | null =>
    existsSync(join(directory, file)) ? readFileSync(join(directory, file), 'utf8').trim() : null;
  const counts: Record<string, ServiceCounts> = {};
  for (const name of ['api', 'worker']) {
    counts[name] = {
      desired: Number(read(`${ORDER_PREFIX}-${name}.desired`) ?? 'NaN'),
      running: Number(read(`${ORDER_PREFIX}-${name}.running`) ?? 'NaN'),
    };
  }
  const report = join(reports, script === STOP ? 'release-stop.txt' : 'release-deploy.txt');
  return {
    code: result.status ?? 1,
    output: `${result.stdout}${result.stderr}`,
    calls: (read('calls.log') ?? '').split('\n').filter(line => line !== ''),
    counts,
    report: existsSync(report) ? readFileSync(report, 'utf8').trim() : null,
  };
}

const RUNNING = { api: { desired: 2, running: 2 }, worker: { desired: 1, running: 1 } } as const;
const STOPPED = { api: { desired: 0, running: 0 }, worker: { desired: 0, running: 0 } } as const;
const deployArgs = (...extra: readonly string[]): readonly string[] => [
  'infra/roots/rehearsal',
  ORDER_PREFIX,
  ...extra,
  '--api-digest',
  ORDER_API_DIGEST,
  '--worker-digest',
  ORDER_WORKER_DIGEST,
];
const scaled = (calls: readonly string[]): readonly string[] =>
  calls.filter(call => call.startsWith('ecs update-service'));
const launched = (calls: readonly string[]): readonly string[] => calls.filter(call => call.startsWith('ecs run-task'));

describe('Appendix G 22 (g70): a schema release stops before the apply, and the deploy refuses otherwise', () => {
  it('refuses a schema-change deploy while the API still runs, naming the stop, and touches nothing', () => {
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), RUNNING);
    expect(run.code).not.toBe(0);
    expect(run.output).toContain(`${ORDER_PREFIX}-api is not stopped: desired 2, running 2, pending 0`);
    expect(run.output).toContain(`infra/scripts/release-stop.sh infra/roots/rehearsal ${ORDER_PREFIX}, then the apply, then this command`);
    // The harm has already happened by now, so the script must not quietly scale.
    expect(scaled(run.calls), 'a refused deploy scaled a service').toEqual([]);
    expect(launched(run.calls), 'a refused deploy launched the migration').toEqual([]);
    expect(run.counts['api']).toEqual({ desired: 2, running: 2 });
    expect(run.report).toBeNull();
  });

  it('refuses when only the worker still runs', () => {
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), {
      api: { desired: 0, running: 0 },
      worker: { desired: 0, running: 1 },
    });
    expect(run.code).not.toBe(0);
    expect(run.output).toContain(`${ORDER_PREFIX}-worker is not stopped: desired 0, running 1, pending 0`);
    expect(scaled(run.calls)).toEqual([]);
    expect(launched(run.calls)).toEqual([]);
  });

  it('refuses on a bootstrap too, because bootstrap=true no longer stops a standing stack', () => {
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), RUNNING, { bootstrap: true });
    expect(run.code).not.toBe(0);
    expect(run.output).toContain('is not stopped');
    expect(launched(run.calls)).toEqual([]);
  });

  it('reaches the migration when both services are already at zero', () => {
    // The positive control for the three refusals: a refusal that refused everything
    // would pass them and deploy nothing, ever.
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED);
    expect(run.output).toContain(`${ORDER_PREFIX}-api is stopped: desired 0, running 0, pending 0`);
    expect(run.output).toContain(`${ORDER_PREFIX}-worker is stopped: desired 0, running 0, pending 0`);
    expect(run.output).toContain('2/7 fss migrate');
    expect(launched(run.calls)).toHaveLength(1);
    expect(scaled(run.calls)).toEqual([]);
    // The stub ends the run at the migration; that it ended there is the point.
    expect(run.output).toContain('STUB_STOPS_AT_THE_MIGRATION');
  });

  it('runs a schema release from the assertion to the final verify, and reads the running digests before it', () => {
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, { oneOffsPass: true });
    expect(run.code, run.output).toBe(0);
    // Every one-off step, in order, and nothing forced to replace what the scale-up started
    // beyond the one `--force-new-deployment` per service the path has always had.
    expect(launched(run.calls)).toHaveLength(4);
    const at = (needle: string): number => {
      const index = run.output.indexOf(needle);
      expect(index, `the schema release did not log ${needle}`).toBeGreaterThan(-1);
      return index;
    };
    const verify = at('4/7 fss verify');
    const digests = at(`6/7 the running tasks of ${ORDER_PREFIX}-worker and ${ORDER_PREFIX}-api`);
    const deployed = at('7/7 fss verify (deployed)');
    expect(digests).toBeGreaterThan(verify);
    expect(deployed).toBeGreaterThan(digests);
    expect(run.output).toContain(`${ORDER_PREFIX}-api: task ${ORDER_PREFIX}-api-2 runs ${ORDER_API_DIGEST}`);
    expect(run.report).toContain('running_digests=verified');
    expect(run.counts).toEqual({ api: { desired: 2, running: 2 }, worker: { desired: 1, running: 1 } });
  });
});

/**
 * Lane g80, audit item O03: the app-only fast path is one rolling deployment.
 *
 * Until g80 a release with no `--schema-change` still launched four one-off tasks —
 * `fss migrate`, `fss admin database-users ensure`, `fss verify` twice — and forced a
 * second rollout of each service after the one the apply had started. David's release
 * cadence of 25 September makes app-only "deploy and smoke".
 *
 * ## The vacuous-pass trap
 *
 * "No run-task" is also what a deploy that did nothing at all would show, and "stable"
 * is also what a service the circuit breaker rolled back shows. So the checks require the
 * two `update-service` calls with the declared counts, one wait naming both services,
 * and the reads of every running task — and they fail the deploy when a service is
 * stable on the old digest or on fewer tasks than it declares.
 */
describe('g80: an app-only release is one rolling deployment, and ends only when the release is what runs', () => {
  const RELEASE_RUNNING = { api: { desired: 2, running: 2 }, worker: { desired: 1, running: 1 } } as const;

  it('launches no one-off task, scales each service once to its declared count, waits once, and reads what runs', () => {
    const run = runOrder(DEPLOY, deployArgs(), { api: { desired: 1, running: 1 }, worker: { desired: 1, running: 1 } });
    expect(run.code, run.output).toBe(0);
    expect(launched(run.calls), 'an app-only deploy launched a one-off task').toEqual([]);
    expect(scaled(run.calls)).toEqual([
      `ecs update-service --cluster ${ORDER_CLUSTER} --service ${ORDER_PREFIX}-worker --desired-count 1 --query service.[serviceName,desiredCount,taskDefinition] --output text`,
      `ecs update-service --cluster ${ORDER_CLUSTER} --service ${ORDER_PREFIX}-api --desired-count 2 --query service.[serviceName,desiredCount,taskDefinition] --output text`,
    ]);
    expect(run.calls.filter(call => call.includes('--force-new-deployment'))).toEqual([]);
    expect(run.calls.filter(call => call.startsWith('ecs wait'))).toEqual([
      `ecs wait services-stable --cluster ${ORDER_CLUSTER} --services ${ORDER_PREFIX}-worker ${ORDER_PREFIX}-api`,
    ]);
    // Read back after the wait: the service, its running tasks, and each task.
    const waited = run.calls.findIndex(call => call.startsWith('ecs wait'));
    for (const service of ['worker', 'api']) {
      const listed = run.calls.findIndex(call => call.startsWith(`ecs list-tasks --cluster ${ORDER_CLUSTER} --service-name ${ORDER_PREFIX}-${service}`));
      expect(listed, `the running tasks of ${service} were not listed`).toBeGreaterThan(waited);
    }
    expect(run.calls.filter(call => call.startsWith('ecs describe-tasks'))).toHaveLength(2);
    expect(run.output).toContain(`${ORDER_PREFIX}-worker: task ${ORDER_PREFIX}-worker-1 runs ${ORDER_WORKER_DIGEST}`);
    expect(run.output).toContain(`${ORDER_PREFIX}-api: task ${ORDER_PREFIX}-api-2 runs ${ORDER_API_DIGEST}`);
    expect(run.output).toContain('1/3 one rolling deployment');
    expect(run.counts).toEqual(RELEASE_RUNNING);
    expect(run.report).toContain('schema_change=0');
    expect(run.report).toContain('running_digests=verified');
  });

  it('fails when a service is stable on a digest that is not the release’s, as a rolled-back one is', () => {
    const run = runOrder(DEPLOY, deployArgs(), RELEASE_RUNNING, { running: { api: ORDER_OLD_DIGEST } });
    expect(run.code).not.toBe(0);
    expect(run.output).toContain(`container api runs ${ORDER_OLD_DIGEST} and this release is ${ORDER_API_DIGEST}`);
    expect(run.output).toContain('is a schema-change release');
    // The worker was read too, and was right; the failure names only the API.
    expect(run.output).toContain(`${ORDER_PREFIX}-worker: task ${ORDER_PREFIX}-worker-1 runs ${ORDER_WORKER_DIGEST}`);
    expect(run.output).toContain(`FAIL: ${ORDER_PREFIX}-api is not running this release`);
    expect(run.report).toBeNull();
  });

  it('fails on the worker’s digest as well as the API’s', () => {
    const run = runOrder(DEPLOY, deployArgs(), RELEASE_RUNNING, { running: { worker: ORDER_OLD_DIGEST } });
    expect(run.code).not.toBe(0);
    expect(run.output).toContain(`container worker runs ${ORDER_OLD_DIGEST} and this release is ${ORDER_WORKER_DIGEST}`);
    expect(run.report).toBeNull();
  });

  it('fails when fewer tasks run than the root declares, which is where a check over no tasks would pass', () => {
    // Sticky: ECS takes the count and starts nothing, so one API task runs against two.
    const run = runOrder(DEPLOY, deployArgs(), { api: { desired: 1, running: 1 }, worker: { desired: 0, running: 0 } }, { sticky: true });
    expect(run.code).not.toBe(0);
    expect(run.output).toContain('1 task(s) are RUNNING and the root declares 2');
    expect(run.output).toContain('0 task(s) are RUNNING and the root declares 1');
    expect(run.report).toBeNull();
  });

  it('fails when the deployment itself failed, whatever the tasks say', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fss-rollout-'));
    // The stub reads `<service>.rollout`; a run on its own directory cannot set it, so
    // this drives the helper directly against the same fake.
    const stub = orderStub(directory);
    writeFileSync(join(directory, `${ORDER_PREFIX}-api.desired`), '1\n');
    writeFileSync(join(directory, `${ORDER_PREFIX}-api.running`), '1\n');
    writeFileSync(join(directory, `${ORDER_PREFIX}-api.digest`), `${ORDER_API_DIGEST}\n`);
    writeFileSync(join(directory, `${ORDER_PREFIX}-api.rollout`), 'FAILED\n');
    const script = join(directory, 'case.sh');
    writeFileSync(
      script,
      [
        '#!/usr/bin/env bash',
        `source ${repositoryPath('infra/scripts/release-common.sh')}`,
        'set +e',
        `release_require_running_digest rehearsal ${ORDER_CLUSTER} ${ORDER_PREFIX}-api api ${ORDER_API_DIGEST} 1`,
        'echo "helper exit $?"',
        '',
      ].join('\n'),
    );
    const result = spawnSync('/bin/bash', [script], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', FSS_REHEARSAL_AWS_COMMAND: stub },
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('its deployment failed');
    expect(output).toContain('helper exit 1');
  });

  it('refuses without --api-digest, or with a tag, or a bootstrap without --schema-change, before any call', () => {
    const noApi = runOrder(DEPLOY, ['infra/roots/rehearsal', ORDER_PREFIX, '--worker-digest', ORDER_WORKER_DIGEST], RELEASE_RUNNING);
    expect(noApi.code).not.toBe(0);
    expect(noApi.output).toContain('--api-digest is required');
    expect(noApi.calls).toEqual([]);

    const tagged = runOrder(
      DEPLOY,
      ['infra/roots/rehearsal', ORDER_PREFIX, '--api-digest', 'latest', '--worker-digest', ORDER_WORKER_DIGEST],
      RELEASE_RUNNING,
    );
    expect(tagged.code).not.toBe(0);
    expect(tagged.output).toContain("'latest' is not an image digest");
    expect(tagged.calls).toEqual([]);

    const bootstrap = runOrder(DEPLOY, deployArgs(), STOPPED, { bootstrap: true });
    expect(bootstrap.code).not.toBe(0);
    expect(bootstrap.output).toContain('Run this with --schema-change');
    expect(bootstrap.calls).toEqual([]);
  });

  it('carries the guards the one-off wrapper used to supply, now that the first call is update-service', () => {
    const tagged = runOrder(DEPLOY, deployArgs(), RELEASE_RUNNING, {
      fixtures: { FSS_RELEASE_CLUSTER_TAGS: JSON.stringify([{ key: 'Environment', value: 'production' }]) },
    });
    expect(tagged.code).not.toBe(0);
    expect(tagged.output).toContain('the cluster is tagged Environment=production and this is a rehearsal deploy');
    expect(tagged.calls).toEqual([]);

    const elsewhere = runOrder(DEPLOY, deployArgs(), RELEASE_RUNNING, {
      fixtures: { FSS_RELEASE_OUTPUT_CLUSTER_ARN: `arn:aws:ecs:us-east-1:222222222222:cluster/${ORDER_PREFIX}-cluster` },
    });
    expect(elsewhere.code).not.toBe(0);
    expect(elsewhere.output).toContain('is in account 222222222222 and this release is in 111111111111');
    expect(elsewhere.calls).toEqual([]);

    const credentials = runOrder(DEPLOY, deployArgs(), RELEASE_RUNNING, {
      fixtures: { FSS_RELEASE_CALLER_ACCOUNT: '333333333333' },
    });
    expect(credentials.code).not.toBe(0);
    expect(credentials.output).toContain('these credentials belong to account 333333333333');
    expect(credentials.calls).toEqual([]);
  });
});

describe('Appendix G 22 (g70), continued: the stop', () => {
  it('stops the API, then the worker, and reads both back', () => {
    const run = runOrder(STOP, ['infra/roots/rehearsal', ORDER_PREFIX], RUNNING);
    expect(run.code, run.output).toBe(0);
    expect(scaled(run.calls)).toEqual([
      `ecs update-service --cluster ${ORDER_CLUSTER} --service ${ORDER_PREFIX}-api --desired-count 0 --query service.[serviceName,desiredCount] --output text`,
      `ecs update-service --cluster ${ORDER_CLUSTER} --service ${ORDER_PREFIX}-worker --desired-count 0 --query service.[serviceName,desiredCount] --output text`,
    ]);
    // Each scale is waited on and then read back before the next service is touched.
    const apiScaled = run.calls.findIndex(call => call.includes(`--service ${ORDER_PREFIX}-api --desired-count 0`));
    const apiWaited = run.calls.findIndex(call => call.startsWith('ecs wait services-stable') && call.includes(`${ORDER_PREFIX}-api`));
    const workerScaled = run.calls.findIndex(call => call.includes(`--service ${ORDER_PREFIX}-worker --desired-count 0`));
    expect(apiWaited).toBeGreaterThan(apiScaled);
    expect(workerScaled).toBeGreaterThan(apiWaited);
    expect(run.counts).toEqual(STOPPED);
    expect(run.report).toBe(
      `prefix=${ORDER_PREFIX} environment=rehearsal ${ORDER_PREFIX}-api=stopped_from_2 ${ORDER_PREFIX}-worker=stopped_from_1`,
    );
    // And the deploy that follows it is the one that reaches the migration.
    expect(launched(run.calls)).toEqual([]);
  });

  it('is idempotent: services already at zero are reported and not touched', () => {
    const run = runOrder(STOP, ['infra/roots/rehearsal', ORDER_PREFIX], STOPPED);
    expect(run.code, run.output).toBe(0);
    expect(scaled(run.calls)).toEqual([]);
    expect(run.output).toContain(`${ORDER_PREFIX}-api is already stopped`);
    expect(run.report).toContain(`${ORDER_PREFIX}-worker=already_stopped`);
  });

  it('fails, naming the counts, when a service is still running after the wait', () => {
    const run = runOrder(STOP, ['infra/roots/rehearsal', ORDER_PREFIX], RUNNING, { sticky: true });
    expect(run.code).not.toBe(0);
    expect(run.output).toContain(`${ORDER_PREFIX}-api is not stopped: desired 0, running 2, pending 0`);
    // It stopped at the API: the worker is not scaled behind a failure it cannot see.
    expect(scaled(run.calls)).toHaveLength(1);
    expect(run.report).toBeNull();
  });

  it('refuses production unless it is named out loud, and a root that is not the prefix’s, before any call', () => {
    const unnamed = runOrder(STOP, ['infra/roots/production', 'fss-prod'], RUNNING);
    expect(unnamed.code).not.toBe(0);
    expect(unnamed.output).toContain('re-run with --environment production');
    expect(unnamed.calls).toEqual([]);

    const crossed = runOrder(STOP, ['infra/roots/production', ORDER_PREFIX], RUNNING);
    expect(crossed.code).not.toBe(0);
    expect(crossed.output).toContain('is not the rehearsal root');
    expect(crossed.calls).toEqual([]);

    const misnamed = runOrder(STOP, ['infra/roots/rehearsal', ORDER_PREFIX, '--environment', 'production'], RUNNING);
    expect(misnamed.code).not.toBe(0);
    expect(misnamed.output).toContain('--environment production was given');
    expect(misnamed.calls).toEqual([]);
  });

});
