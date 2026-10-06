import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
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
 * nothing on a laptop can ask it that. `infra/scripts/rehearsal.sh ranges` (P7) runs
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

const SCHEMA_RANGES = 'infra/scripts/rehearsal.sh';
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
    'printf "%s\\n" "$service $operation $*" >> "${FSS_STUB_CALLS:-/dev/null}"',
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
    ['ranges', CHECK_PREFIX, '--api-digest', CHECK_API_DIGEST, '--worker-digest', CHECK_WORKER_DIGEST],
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
 * Lane M4, the coordinator's check B: `rehearsal.sh meeting-audio` launches the run's API task
 * definition, at the release's digest, as one one-off task running `--meeting-audio-check`, and
 * passes only on its exit 0. The real-S3 half is the task's own (apps/api's
 * meetingAudioContract.test.ts drives its logic against a faithful fake of S3); this is the
 * launch and the verdict.
 */
function runMeetingAudio(exit: number, args: readonly string[] = ['--api-digest', CHECK_API_DIGEST]) {
  const directory = mkdtempSync(join(tmpdir(), 'fss-meeting-audio-'));
  const reports = mkdtempSync(join(tmpdir(), 'fss-meeting-audio-reports-'));
  const calls = join(directory, 'calls.log');
  const result = spawnSync(repositoryPath(SCHEMA_RANGES), ['meeting-audio', CHECK_PREFIX, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FSS_STUB_CALLS: calls,
      FSS_REHEARSAL_REPORTS: reports,
      FSS_REHEARSAL_AWS_COMMAND: stubAws(directory, { staleExit: exit }),
      AWS_REGION: 'us-east-1',
      FSS_RELEASE_ACCOUNT: '111111111111',
      FSS_RELEASE_CALLER_ACCOUNT: '111111111111',
      FSS_RELEASE_CLUSTER_TAGS: JSON.stringify([{ key: 'Environment', value: 'rehearsal' }]),
      FSS_RELEASE_OUTPUT_CLUSTER_ARN: 'arn:aws:ecs:us-east-1:111111111111:cluster/fss-rh-check-cluster',
      FSS_RELEASE_OUTPUT_APP_RUNTIME_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:fss-rh-check/app-runtime-database-bbbbbb',
      FSS_RELEASE_OUTPUT_TASK_NETWORK_CONFIGURATION: JSON.stringify({
        subnet_ids: ['subnet-0a'],
        security_group_id: 'sg-0a',
        assign_public_ip: 'ENABLED',
        database_port: 5432,
        database_host: 'fss-rh-check-pg.example.com',
        inbound_rule_count: 0,
      }),
      FSS_RELEASE_LOG_EVENTS: JSON.stringify({
        events: [{ message: '{"level":"info","event":"api_meeting_audio_check","ok":true,"put":"pass status=200 code=none"}' }],
      }),
    },
  });
  const report = join(reports, 'meeting-audio.txt');
  return {
    code: result.status ?? 1,
    output: `${result.stdout}${result.stderr}`,
    report: existsSync(report) ? readFileSync(report, 'utf8').trim() : null,
    calls: existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(line => line !== '') : [],
  };
}

describe('lane M4 check B: rehearsal.sh meeting-audio launches the API task once and judges its exit', () => {
  it('runs the API definition with --meeting-audio-check and passes on exit 0, with a report', () => {
    const run = runMeetingAudio(0);
    expect(run.code, run.output).toBe(0);
    const launches = run.calls.filter(call => call.startsWith('ecs run-task'));
    expect(launches).toHaveLength(1);
    expect(launches[0]).toContain('task-definition/fss-rh-check-api:1');
    expect(launches[0]).toContain('--meeting-audio-check');
    expect(launches[0]).not.toContain('--selftest');
    expect(run.output).toContain('api_meeting_audio_check');
    expect(run.report).toContain('put_without_upload_id=refused');
    expect(run.report).toContain('put_other_digest=refused');
  });

  it('fails, with no report, when the task exits 14 (S3 answered a step otherwise)', () => {
    const run = runMeetingAudio(14);
    expect(run.code).not.toBe(0);
    expect(run.output).toContain('FAIL: meeting-audio exited 14');
    expect(run.output).toContain('did not hold against real S3');
    expect(run.report).toBeNull();
  });

  it('refuses without the API digest, before any call', () => {
    const run = runMeetingAudio(0, []);
    expect(run.code).not.toBe(0);
    expect(run.output).toContain('--api-digest is required');
    expect(run.calls).toEqual([]);
  });
});

/**
 * Lane g70: a schema-change release stops the services before the apply, and the
 * deploy refuses to migrate under a service that is still running.
 *
 * The independent review of 25 September found the order backwards. `terraform apply`
 * registers the release's task definitions, whose strict `{N,N}` range refuses the
 * schema the database is still at, and repointed the running services at them;
 * `deploy.sh release --schema-change` then scaled them to zero in its step 1, after
 * ECS had begun replacing working tasks with tasks that exit 12. The 04:41Z deploy of
 * schema 16 ran in exactly that order (`docs/greenfield/release.md` 8.0af).
 *
 * The order is now `stop.sh` → apply → `deploy.sh release --schema-change`,
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

const STOP = 'infra/scripts/stop.sh';
const DEPLOY = 'infra/scripts/deploy.sh';
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
  /** The reports directory, for the files a script wrote beside its report. */
  readonly reports: string;
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
    'name=""; count=""; tasks=""; pointed=""; rolled=""; latest=""; taskdef=""; created=""',
  'key=""; container=""; status=""; revimage=""; revmin=""; revmax=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --service|--services|--service-name) name=$2; shift ;;',
    // Lane RS-2: `describe-task-definition --task-definition <family>` is asked for the
    // newest ACTIVE revision of a family, whose name is the service\'s.
    '    --task-definition) name=$2; shift ;;',
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
    // Lane RS-2: a rollout that finishes while the deploy watches. `<name>.rollout-next`
    // becomes `<name>.rollout` after the first read *of a scaled-up service*, so the
    // reads the stop and the applied-definition check make at zero do not consume it.
    '    if [ "$desired" != 0 ] && [ -f "$state/$name.rollout-next" ]; then mv "$state/$name.rollout-next" "$state/$name.rollout"; fi',
    // The service's events, newest first, as ECS answers them. Absent unless a case
    // writes them, so every other check sees the empty list a fresh service has.
    '    events=$(cat "$state/$name.events" 2>/dev/null || echo "")',
    // What the service points at, and what its one deployment runs. They are the same
    // revision unless a case makes them differ, which is what a rollback looks like.
    '    pointed=$(cat "$state/$name.service-definition" 2>/dev/null || definition "$name")',
    '    rolled=$(cat "$state/$name.rollout-definition" 2>/dev/null || definition "$name")',
    // When ECS created this deployment. `release-timing:` will only count a target
    // registration that is not older than it, so a registration from the rollout before
    // this one cannot be paired with this release's stop.
    '    created=$(cat "$state/$name.deployment-created" 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)',
    '    printf \'{"services":[{"serviceName":"%s","status":"ACTIVE","taskDefinition":"%s","desiredCount":%s,"runningCount":%s,"pendingCount":0,"deployments":[{"status":"PRIMARY","id":"ecs-svc/1","createdAt":"%s","taskDefinition":"%s","rolloutState":"%s"}],"events":[%s]}],"failures":[]}\\n\' "$name" "$pointed" "$desired" "$running" "$created" "$rolled" "$rollout" "$events"',
    '    exit 0 ;;',
    // A revision, by ARN: its status, its one container, that container's image and the
    // schema range it declares. `<service>.revision-*` files make each of them wrong in
    // turn, which is what the pre-migration checks are asked to catch.
    '  "ecs describe-task-definition")',
    '    key=${name##*/}; key=${key%%:*}',
    '    container=${key##*-}',
    '    status=$(cat "$state/$key.revision-status" 2>/dev/null || echo ACTIVE)',
    '    revimage=$(cat "$state/$key.revision-image" 2>/dev/null || echo "registry/$container@$(cat "$state/$key.digest")")',
    '    revmin=$(cat "$state/$key.revision-schema-min" 2>/dev/null || echo 30)',
    '    revmax=$(cat "$state/$key.revision-schema-max" 2>/dev/null || echo 30)',
    '    latest=$(cat "$state/$key.latest" 2>/dev/null || definition "$key")',
    '    printf \'{"taskDefinition":{"taskDefinitionArn":"%s","status":"%s","containerDefinitions":[{"name":"%s","image":"%s","environment":[{"name":"FSS_SCHEMA_MIN","value":"%s"},{"name":"FSS_SCHEMA_MAX","value":"%s"}]}]}}\\n\' "$latest" "$status" "$container" "$revimage" "$revmin" "$revmax"',
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
    // A task belongs to the deployment that started it, so it carries whatever revision
    // that deployment runs — the rolled-back one in a rollback case.
    '           taskdef=$(cat "$state/$owner.rollout-definition" 2>/dev/null || definition "$owner")',
    '           entry=$(printf \'{"taskArn":"%s","lastStatus":"RUNNING","taskDefinitionArn":"%s","containers":[{"name":"%s","image":"registry/%s","imageDigest":"%s"}]}\' "$arn" "$taskdef" "$container" "$container" "$(cat "$state/$owner.digest")") ;;',
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
    '  "logs get-log-events") if [ -f "$state/log-events.json" ]; then cat "$state/log-events.json"; else echo \'{"events":[{"message":"{\\"ok\\":true}"}]}\'; fi; exit 0 ;;',
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
  /** What every one-off task's log stream holds, as `logs get-log-events` answers it. */
  readonly logEvents?: string;
  /** The report file judged; release-stop.txt or release-deploy.txt by default. */
  readonly report?: string;
  /**
   * Lane RS-2: the API service's events, newest first, as the JSON body of an
   * `events` array — what `release-timing:`'s `api_unreachable` is read from.
   */
  readonly apiEvents?: string;
  /**
   * PR 310 review, P1. Per service, the revisions and rollout states ECS answers with:
   *
   *   `latest`            the newest ACTIVE revision of the family — the apply's
   *   `pointed`           the revision the *service* names
   *   `rolled`            the revision its one deployment runs, and its tasks with it
   *   `rollout`           `rolloutState` on the first read of a scaled-up service
   *   `rolloutNext`       and on every read after it
   */
  readonly revisions?: Readonly<Partial<Record<'api' | 'worker', {
    readonly pointed?: string;
    readonly rolled?: string;
    readonly rollout?: string;
    readonly rolloutNext?: string;
    /** What `describe-task-definition` says about the revision: PR 310 second review. */
    readonly revisionStatus?: string;
    readonly revisionImage?: string;
    readonly revisionSchemaMin?: string;
    readonly revisionSchemaMax?: string;
    /** When ECS created the service's PRIMARY deployment, as an ISO instant. */
    readonly deploymentCreated?: string;
  }>>>;
  /** The stop marker `stop.sh` leaves, as the contents of release-stop-instant.txt. */
  readonly stopInstant?: string;
  /** Other files of the reports directory, by name: what earlier scripts of the release left. */
  readonly reportFiles?: Readonly<Record<string, string>>;
  /** The task-definition ARN the apply's `deployment_plan` names, per service. */
  readonly plan?: Readonly<Partial<Record<'api' | 'worker', string>>>;
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
  if (options.apiEvents !== undefined) writeFileSync(join(directory, `${ORDER_PREFIX}-api.events`), options.apiEvents);
  for (const [service, revisions] of Object.entries(options.revisions ?? {})) {
    const files: Readonly<Record<string, string | undefined>> = {
      'service-definition': revisions.pointed,
      'rollout-definition': revisions.rolled,
      rollout: revisions.rollout,
      'rollout-next': revisions.rolloutNext,
      'revision-status': revisions.revisionStatus,
      'revision-image': revisions.revisionImage,
      'revision-schema-min': revisions.revisionSchemaMin,
      'revision-schema-max': revisions.revisionSchemaMax,
      'deployment-created': revisions.deploymentCreated,
    };
    for (const [suffix, value] of Object.entries(files)) {
      if (value !== undefined) writeFileSync(join(directory, `${ORDER_PREFIX}-${service}.${suffix}`), `${value}\n`);
    }
  }
  if (options.stopInstant !== undefined) writeFileSync(join(reports, 'release-stop-instant.txt'), `${options.stopInstant}\n`);
  for (const [name, text] of Object.entries(options.reportFiles ?? {})) writeFileSync(join(reports, name), `${text}\n`);
  if (options.oneOffsPass === true) writeFileSync(join(directory, 'one-offs-pass'), '');
  if (options.logEvents !== undefined) writeFileSync(join(directory, 'log-events.json'), options.logEvents);
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
    // PR 310 review, P1: the rollout read is a bounded poll now. Offline it must not
    // sleep, and a case that never settles must give up in a handful of reads.
    FSS_RELEASE_SETTLE_READS: '5',
    FSS_RELEASE_SETTLE_SECONDS: '0',
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
    // PR 310 second review: the apply's own answer to which revision, of what, for
    // which schema. `:7` is what the fake CLI has both services pointing at.
    FSS_RELEASE_OUTPUT_DEPLOYMENT_PLAN: JSON.stringify({
      bootstrap: options.bootstrap === true,
      api: {
        service_name: `${ORDER_PREFIX}-api`,
        declared_desired_count: 2,
        planned_desired_count: 2,
        task_definition: options.plan?.api ?? `arn:aws:ecs:us-east-1:${ORDER_ACCOUNT}:task-definition/${ORDER_PREFIX}-api:7`,
        image: `registry/api@${ORDER_API_DIGEST}`,
        schema_min: '30',
        schema_max: '30',
      },
      worker: {
        service_name: `${ORDER_PREFIX}-worker`,
        declared_desired_count: 1,
        planned_desired_count: 1,
        task_definition: options.plan?.worker ?? `arn:aws:ecs:us-east-1:${ORDER_ACCOUNT}:task-definition/${ORDER_PREFIX}-worker:7`,
        image: `registry/worker@${ORDER_WORKER_DIGEST}`,
        schema_min: '30',
        schema_max: '30',
      },
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
  const report = join(reports, options.report ?? (script.endsWith('stop.sh') ? 'release-stop.txt' : 'release-deploy.txt'));
  return {
    code: result.status ?? 1,
    output: `${result.stdout}${result.stderr}`,
    calls: (read('calls.log') ?? '').split('\n').filter(line => line !== ''),
    counts,
    report: existsSync(report) ? readFileSync(report, 'utf8').trim() : null,
    reports,
  };
}

/**
 * The root as the scripts canonicalise it (`cd … && pwd -P`), which is what the stop
 * marker carries. Resolved the same way here, so a checkout reached through a symlink
 * — a CI runner's, for instance — does not make these cases pass or fail by accident.
 */
const canonicalRehearsalRoot = (): string => realpathSync(repositoryPath('infra/roots/rehearsal'));

const RUNNING = { api: { desired: 2, running: 2 }, worker: { desired: 1, running: 1 } } as const;
const STOPPED = { api: { desired: 0, running: 0 }, worker: { desired: 0, running: 0 } } as const;
const deployArgs = (...extra: readonly string[]): readonly string[] => [
  'release',
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
    expect(run.output).toContain(`infra/scripts/stop.sh infra/roots/rehearsal ${ORDER_PREFIX}, then the apply, then this command`);
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
    expect(run.output).toContain('2/6 fss release-prepare');
    expect(launched(run.calls)).toHaveLength(1);
    expect(scaled(run.calls)).toEqual([]);
    // The stub ends the run at the migration; that it ended there is the point.
    expect(run.output).toContain('STUB_STOPS_AT_THE_MIGRATION');
  });

  it('runs a schema release from the assertion to the final verify, and reads the running digests before it', () => {
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, { oneOffsPass: true });
    expect(run.code, run.output).toBe(0);
    // Lane RS-2: three one-off tasks, not four — `release-prepare` (migrate and then
    // the database users, in one task), `verify` before, `verify` after.
    expect(launched(run.calls)).toHaveLength(3);
    const at = (needle: string): number => {
      const index = run.output.indexOf(needle);
      expect(index, `the schema release did not log ${needle}`).toBeGreaterThan(-1);
      return index;
    };
    const verify = at('3/6 fss verify');
    const digests = at(`5/6 the running tasks of ${ORDER_PREFIX}-worker and ${ORDER_PREFIX}-api`);
    const deployed = at('6/6 fss verify (deployed)');
    expect(digests).toBeGreaterThan(verify);
    expect(deployed).toBeGreaterThan(digests);
    expect(run.output).toContain(`${ORDER_PREFIX}-api: task ${ORDER_PREFIX}-api-2 runs ${ORDER_API_DIGEST}`);
    expect(run.report).toContain('running_digests=verified');
    expect(run.counts).toEqual({ api: { desired: 2, running: 2 }, worker: { desired: 1, running: 1 } });
  });
});

/**
 * Lane RS-2 (29 September 2026): the schema release's interruption, and what shortened it.
 *
 * Measured on the 0022 release: API unreachable 00:41:04 → 00:49:43, 8.7 minutes, of
 * which the work was seconds. Three sequential one-off tasks cost about a minute each in
 * RunTask start latency; the services were then started one after the other, each with a
 * forced second rollout, four waits in all, and the API was not asked for until the
 * worker had finished both of its.
 *
 * ## The vacuous-pass trap
 *
 * "Two tasks instead of three" is also true of a deploy that skipped a step, and "one
 * wait" is also true of a deploy that never started the API. So every check below is a
 * check on the *calls the fake CLI saw*, in order, with the counts both services end at
 * asserted too: the tasks must be the right two commands on the right task definitions,
 * both `update-service --desired-count` calls must come before the single wait, and the
 * run must still end with both services at their declared counts on the release digest.
 */
describe('RS-2: a schema release is two one-off tasks and one wait for both services', () => {
  let eventNow=0;
  beforeEach(()=>{eventNow=Date.now();});
  const oneOffCommands = (calls: readonly string[]): readonly string[] =>
    launched(calls).map(call => {
      // `--overrides <json>`: the container override's command is what ran.
      const overrides = /--overrides (\{.*?\}) --/u.exec(call)?.[1];
      const command = overrides === undefined ? [] : ((JSON.parse(overrides) as {
        readonly containerOverrides?: readonly { readonly command?: readonly string[] }[];
      }).containerOverrides?.[0]?.command ?? []);
      const flagAt = command.findIndex(word => word.startsWith('--'));
      return (flagAt < 0 ? command : command.slice(0, flagAt)).join(' ');
    });

  it('runs migrate and the database users in ONE task, and verify in its own', () => {
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, { oneOffsPass: true });
    expect(run.code, run.output).toBe(0);
    // Three launches, in this order. `release-prepare` is the migration identity's two
    // steps under one RunTask start; `verify` needs the runtime secret the migration
    // task definition does not carry, so it stays its own task, before and after.
    expect(oneOffCommands(run.calls)).toEqual(['release-prepare', 'verify', 'verify']);
    expect(launched(run.calls)[0]).toContain(`${ORDER_PREFIX}-migration`);
    expect(launched(run.calls)[1]).toContain(`${ORDER_PREFIX}-operations`);
    // Both reports still written, under the names anything downstream reads.
    expect(launched(run.calls)[0]).toContain('/tmp/fss-migrate.json');
    expect(launched(run.calls)[0]).toContain('/tmp/fss-users.json');
    // And the run went all the way through: a check over a deploy that stopped early
    // would pass the count above.
    expect(run.counts).toEqual({ api: { desired: 2, running: 2 }, worker: { desired: 1, running: 1 } });
  });

  it('updates both services before the one wait, and forces no second deployment', () => {
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, { oneOffsPass: true });
    expect(scaled(run.calls)).toEqual([
      `ecs update-service --cluster ${ORDER_CLUSTER} --service ${ORDER_PREFIX}-worker --desired-count 1 --query service.[serviceName,desiredCount,taskDefinition] --output text`,
      `ecs update-service --cluster ${ORDER_CLUSTER} --service ${ORDER_PREFIX}-api --desired-count 2 --query service.[serviceName,desiredCount,taskDefinition] --output text`,
    ]);
    // The forced rollout is gone: the apply already pointed each service at the task
    // definition it registered, and the digest read after the wait is the guard.
    expect(run.calls.filter(call => call.includes('--force-new-deployment'))).toEqual([]);
    // Exactly one wait, naming both — the API is not queued behind the worker's.
    expect(run.calls.filter(call => call.startsWith('ecs wait'))).toEqual([
      `ecs wait services-stable --cluster ${ORDER_CLUSTER} --services ${ORDER_PREFIX}-worker ${ORDER_PREFIX}-api`,
    ]);
    const waited = run.calls.findIndex(call => call.startsWith('ecs wait'));
    for (const service of ['worker', 'api']) {
      const updated = run.calls.findIndex(call => call.includes(`--service ${ORDER_PREFIX}-${service} --desired-count`));
      expect(updated, `${service} was not updated before the wait`).toBeGreaterThan(-1);
      expect(updated, `${service} was updated after the wait`).toBeLessThan(waited);
    }
  });

  /**
   * The instants below are built from the clock this test runs on, not written out.
   *
   * `api_unreachable` is now bound to *this* release: the registration must not be older
   * than the moment the deploy scaled the services up, and the stop must be older than
   * it. Fixed calendar dates would drift out of that window and every case would answer
   * `unknown` — which is exactly the vacuous pass this whole measurement is guarding
   * against, so the numbers are asserted exactly.
   */
  const iso = (offsetSeconds: number): string =>
    new Date(eventNow + offsetSeconds * 1000).toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const event = (offsetSeconds: number, message: string): string =>
    `{"createdAt":"${iso(offsetSeconds)}","message":"(service ${ORDER_PREFIX}-api) ${message}"}`;
  const REGISTERED = 'registered 2 targets in (target-group tg)';
  const STOPPED_TASKS = 'has stopped 2 running tasks: (task a) (task b).';
  const timing = (output: string): RegExpExecArray | null =>
    /release-timing: stop_to_migrate=(\S+?) migrate_tasks=(\S+?) services_start_to_stable=(\S+?) api_unreachable≈(\S+)/u.exec(output);

  it('times every step and ends with one release-timing line, in the log and in the report', () => {
    // The API registered its targets 300 s after its last task went away. Both instants
    // straddle the scale-up this run performs, which is what ties them to this release.
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, {
      oneOffsPass: true,
      apiEvents: [event(60, REGISTERED), event(-240, STOPPED_TASKS)].join(','),
    });
    expect(run.code, run.output).toBe(0);
    const parts = timing(run.output);
    expect(parts, `no release-timing line in:\n${run.output}`).not.toBeNull();
    // Offline the three `date` parts are whole seconds and tiny; their shape is the
    // assertion, and the one number that comes from ECS is asserted exactly.
    for (const part of [parts?.[1], parts?.[2], parts?.[3]]) expect(part).toMatch(/^[0-9]+s$/u);
    expect(parts?.[4]).toBe('300s');
    expect(run.report).toContain('release-timing: stop_to_migrate=');
    expect(run.report).toContain('api_unreachable≈300s');
    // Every step line carries the instant it started.
    expect(run.output).toMatch(/\[deploy\.sh\] [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z 2\/6 fss release-prepare/u);
    expect(run.output).toMatch(/\[deploy\.sh\] [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z 6\/6 fss verify \(deployed\)/u);
  });

  it('prefers the stop instant stop.sh recorded over the service’s own stop event', () => {
    // stop.sh knows the moment to the second; the event is ECS's paraphrase of it. When
    // the marker is there it wins — 600 s here, against the 240 s the event would give.
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, {
      oneOffsPass: true,
      apiEvents: [event(60, REGISTERED), event(-240, STOPPED_TASKS)].join(','),
      stopInstant: `root=${canonicalRehearsalRoot()} prefix=${ORDER_PREFIX} api_stopped_at=${String(Math.floor(eventNow / 1000) - 540)}`,
    });
    expect(run.code, run.output).toBe(0);
    expect(timing(run.output)?.[4]).toBe('600s');
  });

  it('ignores a marker another release left, however fresh, and falls back to the event', () => {
    // The shared report directory is the trap: a marker from a different prefix is a
    // perfectly recent number about a different outage.
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, {
      oneOffsPass: true,
      apiEvents: [event(60, REGISTERED), event(-240, STOPPED_TASKS)].join(','),
      stopInstant: `root=${canonicalRehearsalRoot()} prefix=fss-rh-somewhere-else api_stopped_at=${String(Math.floor(eventNow / 1000) - 540)}`,
    });
    expect(run.code, run.output).toBe(0);
    expect(timing(run.output)?.[4]).toBe('300s');
  });

  it('ignores a marker too old to be this release, and falls back to the event', () => {
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, {
      oneOffsPass: true,
      apiEvents: [event(60, REGISTERED), event(-240, STOPPED_TASKS)].join(','),
      // Seven hours ago: past the window, so it is another release's stop.
      stopInstant: `root=${canonicalRehearsalRoot()} prefix=${ORDER_PREFIX} api_stopped_at=${String(Math.floor(eventNow / 1000) - 7 * 60 * 60)}`,
    });
    expect(run.code, run.output).toBe(0);
    expect(timing(run.output)?.[4]).toBe('300s');
  });

  it('says unknown rather than guessing: no registration, and a registration older than this scale-up', () => {
    // A plausible wrong number would be worse than none: the next release is judged
    // against this one. Both halves of the pair must belong to this release.
    const noRegistration = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, {
      oneOffsPass: true,
      apiEvents: event(-240, STOPPED_TASKS),
    });
    expect(noRegistration.code, noRegistration.output).toBe(0);
    expect(noRegistration.output).toContain('api_unreachable≈unknown');

    // A registration from before this rollout's own deployment existed. It is recent —
    // two minutes ago — so "recent enough" would have taken it; attribution does not.
    const stale = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, {
      oneOffsPass: true,
      apiEvents: [event(-120, REGISTERED), event(-240, STOPPED_TASKS)].join(','),
    });
    expect(stale.code, stale.output).toBe(0);
    expect(stale.output).toContain('api_unreachable≈unknown');

    // And it stays unknown when this rollout's deployment is old enough to *look* like
    // its owner. The deployment's age is the weaker of the two bounds; a registration
    // from before the scale-up cannot be this release finishing, and reporting 120s
    // here was the wrong answer the third review caught.
    const olderDeployment = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, {
      oneOffsPass: true,
      apiEvents: [event(-120, REGISTERED), event(-240, STOPPED_TASKS)].join(','),
      revisions: { api: { deploymentCreated: iso(-180) } },
    });
    expect(olderDeployment.code, olderDeployment.output).toBe(0);
    expect(olderDeployment.output).toContain('api_unreachable≈unknown');

    // The positive control for that bound: the same run, with the registration on the
    // far side of the scale-up, does produce a number.
    const after = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, {
      oneOffsPass: true,
      apiEvents: [event(60, REGISTERED), event(-240, STOPPED_TASKS)].join(','),
      revisions: { api: { deploymentCreated: iso(-180) } },
    });
    expect(after.code, after.output).toBe(0);
    expect(after.output).toContain('api_unreachable≈300s');
  });

  it('will not reach back past the release window for a stop event', () => {
    // No marker, and the only stop on record is from yesterday's release. Pairing it
    // with today's registration would print a number in the hours.
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, {
      oneOffsPass: true,
      apiEvents: [event(60, REGISTERED), event(-40 * 60, STOPPED_TASKS)].join(','),
    });
    expect(run.code, run.output).toBe(0);
    expect(run.output).toContain('api_unreachable≈unknown');
  });

  it('matches the marker when the root is spelled differently from the one stop.sh was given', () => {
    // The rehearsal workflow hands stop.sh an absolute root and deploy.sh a relative
    // one. Comparing the raw strings would have missed every time, silently, and the
    // marker would never have been used in the one environment it was written for.
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, {
      oneOffsPass: true,
      apiEvents: [event(60, REGISTERED), event(-240, STOPPED_TASKS)].join(','),
      stopInstant: `root=${canonicalRehearsalRoot()} prefix=${ORDER_PREFIX} api_stopped_at=${String(Math.floor(eventNow / 1000) - 540)}`,
    });
    expect(run.code, run.output).toBe(0);
    expect(timing(run.output)?.[4]).toBe('600s');
  });

  it('makes no AWS call of its own for the timing: the events come out of the rollout read', () => {
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, {
      oneOffsPass: true,
      apiEvents: [event(60, REGISTERED), event(-240, STOPPED_TASKS)].join(','),
    });
    expect(run.code, run.output).toBe(0);
    // Step 1 reads each service twice (stopped, then its applied revision) and the
    // rollout read once each: six describe-services, and not a seventh for the timing.
    expect(run.calls.filter(call => call.startsWith('ecs describe-services'))).toHaveLength(6);
  });
});

/**
 * PR 310 review, P1: a stable service is not a finished one.
 *
 * `aws ecs wait services-stable` returns when a service has one deployment and
 * `runningCount == desiredCount`. It does **not** require `rolloutState=COMPLETED`, so
 * it can return while health checks are still running; and the read after it compared
 * the digest, which cannot tell two revisions of one image apart — an infrastructure-only
 * release registers a new revision of the *same* image, so a circuit-breaker rollback
 * would have passed every check the deploy made.
 *
 * ## The vacuous-pass trap
 *
 * The fake CLI's waiter always succeeds, so "the deploy passed" proves nothing about
 * either. Each case below therefore drives a state the waiter is happy with and the
 * deploy must not be: a rollout ECS still calls IN_PROGRESS (which must be *waited on*,
 * not failed — a check that failed it would break every healthy release), and a PRIMARY
 * deployment on the previous revision carrying this release's digest (which must fail,
 * and would have passed before). Both are paired with the positive control above.
 */
describe('RS-2: the rollout is finished when ECS says so, on the revision the apply registered', () => {
  const revision = (service: 'api' | 'worker', number: number): string =>
    `arn:aws:ecs:us-east-1:${ORDER_ACCOUNT}:task-definition/${ORDER_PREFIX}-${service}:${String(number)}`;

  it('refuses before the migration when a service is not on the revision this apply registered', () => {
    // A skipped or half-finished apply: the plan says :7 and the service is on :6. The
    // schema has not moved yet, so the refusal costs nothing — the reason for the order.
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, {
      oneOffsPass: true,
      revisions: { api: { pointed: revision('api', 6) } },
    });
    expect(run.code).not.toBe(0);
    expect(run.output).toContain(`${ORDER_PREFIX}-api is on ${revision('api', 6)}, and this apply registered ${revision('api', 7)}`);
    // Not the family lookup: the repair names the apply, because a newer ACTIVE revision
    // is something `deploy.sh ci` legitimately registers between hand releases.
    expect(run.output).not.toContain('newest ACTIVE');
    expect(run.output).toContain('apply this root again');
    // Nothing was migrated and nothing was started: that is the point of the ordering.
    expect(launched(run.calls), 'a refused deploy migrated the database').toEqual([]);
    expect(scaled(run.calls), 'a refused deploy scaled a service').toEqual([]);
    expect(run.report).toBeNull();
  });

  it('refuses a revision that is not ACTIVE, is not this release’s image, or is another schema', () => {
    // "An apply ran" is not "the right apply ran". Each of the three is asked for on its
    // own, because a check that only looked at the ARN would pass all three.
    const deregistered = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, {
      oneOffsPass: true,
      revisions: { api: { revisionStatus: 'INACTIVE' } },
    });
    expect(deregistered.code).not.toBe(0);
    expect(deregistered.output).toContain('ECS reports it as INACTIVE, not ACTIVE');
    expect(launched(deregistered.calls)).toEqual([]);
    expect(scaled(deregistered.calls), 'a refused deploy scaled a service').toEqual([]);

    const otherImage = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, {
      oneOffsPass: true,
      revisions: { api: { revisionImage: `registry/api@${ORDER_OLD_DIGEST}` } },
    });
    expect(otherImage.code).not.toBe(0);
    expect(otherImage.output).toContain(`and this release is ${ORDER_API_DIGEST}`);
    expect(launched(otherImage.calls)).toEqual([]);
    expect(scaled(otherImage.calls), 'a refused deploy scaled a service').toEqual([]);

    const otherSchema = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, {
      oneOffsPass: true,
      revisions: { worker: { revisionSchemaMax: '31' } },
    });
    expect(otherSchema.code).not.toBe(0);
    expect(otherSchema.output).toContain('it declares FSS_SCHEMA_MAX=31 and this apply was made with 30');
    expect(launched(otherSchema.calls)).toEqual([]);
    expect(scaled(otherSchema.calls), 'a refused deploy scaled a service').toEqual([]);
  });

  it('waits out a rollout ECS still calls IN_PROGRESS, then passes when it completes', () => {
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, {
      oneOffsPass: true,
      revisions: {
        api: { rollout: 'IN_PROGRESS', rolloutNext: 'COMPLETED' },
        worker: { rollout: 'IN_PROGRESS', rolloutNext: 'COMPLETED' },
      },
    });
    expect(run.code, run.output).toBe(0);
    expect(run.output).toContain('its rollout is IN_PROGRESS, not COMPLETED');
    expect(run.output).toContain('the rollout has not finished (read 1 of 5); reading again');
    // It read again rather than giving up, and the second read was enough.
    expect(run.output).not.toContain('the rollout has not finished (read 2 of 5)');
    expect(run.report).toContain('running_digests=verified');
  });

  it('gives up, naming both services’ events, on a rollout that never completes', () => {
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, {
      oneOffsPass: true,
      apiEvents: '{"createdAt":"2026-09-29T00:46:04Z","message":"(service fss-rh-order-api) was unable to place a task"}',
      revisions: { api: { rollout: 'IN_PROGRESS', rolloutNext: 'IN_PROGRESS' } },
    });
    expect(run.code).not.toBe(0);
    expect(run.output).toContain('did not both finish their rollout');
    // Five reads, four of which said "reading again"; the fifth gave up instead.
    expect(run.output).toContain('the rollout has not finished (read 4 of 5); reading again');
    expect(run.output.match(/the rollout has not finished/gu) ?? []).toHaveLength(4);
    expect(run.output).toContain('was unable to place a task');
    expect(run.report).toBeNull();
  });

  it('fails a circuit-breaker rollback whose old revision carries this release’s digest', () => {
    // The case a digest comparison alone cannot see: an infrastructure-only release, so
    // revisions 6 and 7 are the same image, and ECS rolled back to 6. Before this the
    // deploy would have reported a successful release of code that is not running.
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, {
      oneOffsPass: true,
      revisions: { api: { rolled: revision('api', 6) } },
    });
    expect(run.code).not.toBe(0);
    expect(run.output).toContain('and the apply registered');
    expect(run.output).toContain(`FAIL: ${ORDER_PREFIX}-api is not running this release`);
    expect(run.report).toBeNull();
  });

  it('fails the same rollback on the rolling path, which carries the applied ARN too', () => {
    // PR 310 second review, P1: the rolling path left the applied ARN empty, so a
    // completed rollback to a same-digest revision returned 0 and the deploy reported a
    // release that is not running. It is an infrastructure-only release that makes this
    // reachable, and an infrastructure-only release is exactly the rolling path.
    const run = runOrder(DEPLOY, deployArgs(), { api: { desired: 2, running: 2 }, worker: { desired: 1, running: 1 } }, {
      revisions: { api: { rolled: revision('api', 6) } },
    });
    expect(run.code).not.toBe(0);
    expect(run.output).toContain(`its deployment runs ${ORDER_PREFIX}-api:6 and the apply registered ${ORDER_PREFIX}-api:7`);
    expect(run.output).toContain(`FAIL: ${ORDER_PREFIX}-api is not running this release`);
    expect(run.report).toBeNull();
  });

  it('refuses a root whose deployment_plan names no revision — on the rolling path too', () => {
    // PR 310 third review, P1. An empty applied ARN used to mean "fall back to the
    // digest and the count", which is the check a same-digest rollback slips through.
    // The rolling path is where it mattered most: an infrastructure-only release.
    const oldRoot = JSON.stringify({
      bootstrap: false,
      api: { service_name: `${ORDER_PREFIX}-api`, declared_desired_count: 2, planned_desired_count: 2 },
      worker: { service_name: `${ORDER_PREFIX}-worker`, declared_desired_count: 1, planned_desired_count: 1 },
    });
    for (const [label, args] of [['rolling', deployArgs()], ['schema', deployArgs('--schema-change')]] as const) {
      const running = { api: { desired: 2, running: 2 }, worker: { desired: 1, running: 1 } } as const;
      const run = runOrder(DEPLOY, args, label === 'schema' ? STOPPED : running, {
        oneOffsPass: true,
        fixtures: { FSS_RELEASE_OUTPUT_DEPLOYMENT_PLAN: oldRoot },
      });
      expect(run.code, `${label}: ${run.output}`).not.toBe(0);
      expect(run.output).toContain('names no task definition for');
      expect(run.output).toContain('Apply the current root first');
      // Before anything moved: nothing scaled, nothing launched, no report.
      expect(scaled(run.calls), `${label}: a refused deploy scaled a service`).toEqual([]);
      expect(launched(run.calls), `${label}: a refused deploy launched a task`).toEqual([]);
      expect(run.report).toBeNull();
    }
  });

  it('refuses a missing PRIMARY task definition rather than reading it as a match', () => {
    // `if definition and definition != applied` skipped the comparison when ECS omitted
    // the field, which let same-digest tasks on the old revision through. An empty
    // string here is that answer.
    const run = runOrder(DEPLOY, deployArgs(), { api: { desired: 2, running: 2 }, worker: { desired: 1, running: 1 } }, {
      revisions: { api: { rolled: '' } },
    });
    expect(run.code).not.toBe(0);
    expect(run.output).toContain('ECS does not say which task definition its deployment runs');
    expect(run.report).toBeNull();
  });

  it('fails a prestart step with both services still at zero, and says so', () => {
    // `oneOffsPass` is off, so the stub stops the run at the prepare task.
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED);
    expect(run.code).not.toBe(0);
    expect(run.output).toContain('services remain stopped; repair and rerun release-prepare, or restore');
    expect(run.counts).toEqual({ api: { desired: 0, running: 0 }, worker: { desired: 0, running: 0 } });
    expect(scaled(run.calls), 'a failed prepare started a service').toEqual([]);
    expect(run.report).toBeNull();
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
    expect(run.output).toContain('1/2 one rolling deployment');
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
        `source ${repositoryPath('infra/scripts/lib.sh')}`,
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
    const noApi = runOrder(DEPLOY, ['release', 'infra/roots/rehearsal', ORDER_PREFIX, '--worker-digest', ORDER_WORKER_DIGEST], RELEASE_RUNNING);
    expect(noApi.code).not.toBe(0);
    expect(noApi.output).toContain('--api-digest is required');
    expect(noApi.calls).toEqual([]);

    const tagged = runOrder(
      DEPLOY,
      ['release', 'infra/roots/rehearsal', ORDER_PREFIX, '--api-digest', 'latest', '--worker-digest', ORDER_WORKER_DIGEST],
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

/**
 * `stop.sh` first asks whether the stack is idle (slice A4): a one-off `release idle-check`
 * on the operations task. These cases are about the stop, so the fake lets that one task
 * pass and answers it idle; `releaseIdle.check.ts` judges the idle check itself. The
 * operations definition is this prefix's worker image by digest, as the task is held to it.
 */
const IDLE_ANSWER = '{"events":[{"message":"{\\"idle\\":true,\\"reasons\\":[]}"}]}';
const runStop = (
  args: readonly string[],
  services: Readonly<Record<'api' | 'worker', ServiceCounts>>,
  options: OrderOptions = {},
): OrderRun =>
  runOrder(STOP, args, services, {
    oneOffsPass: true,
    logEvents: IDLE_ANSWER,
    ...options,
    fixtures: {
      FSS_RELEASE_TASK_DEFINITION: JSON.stringify({
        containerDefinitions: [
          {
            name: 'operations',
            image: `${ORDER_ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/${ORDER_PREFIX}-worker@${ORDER_WORKER_DIGEST}`,
            environment: [{ name: 'FSS_DATABASE_HOST', value: ORDER_HOST }],
            secrets: [{ name: 'DATABASE_SECRET_ARN', valueFrom: ORDER_RUNTIME_SECRET }],
          },
        ],
      }),
      ...options.fixtures,
    },
  });

describe('Appendix G 22 (g70), continued: the stop', () => {
  it('stops the API, then the worker, and reads both back', () => {
    const run = runStop(['infra/roots/rehearsal', ORDER_PREFIX], RUNNING);
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
      `prefix=${ORDER_PREFIX} environment=rehearsal idle=idle drain=not_used ${ORDER_PREFIX}-api=stopped_from_2 ${ORDER_PREFIX}-worker=stopped_from_1`,
    );
    // And the deploy that follows it is the one that reaches the migration: the only task
    // the stop launched is the idle check, before anything was scaled.
    expect(launched(run.calls)).toHaveLength(1);
    const firstScale = run.calls.findIndex(call => call.startsWith('ecs update-service'));
    const idleAsked = run.calls.findIndex(call => call.startsWith('ecs run-task'));
    expect(idleAsked).toBeGreaterThanOrEqual(0);
    expect(idleAsked).toBeLessThan(firstScale);
    expect(run.calls.find(call => call.startsWith('ecs run-task'))).toContain('"idle-check"');
  });

  it('records the instant the API’s last task went away, for the deploy to measure against', () => {
    // PR 310 review, P2. `api_unreachable` pairs this marker with the registration the
    // deploy's own scale-up produces; nothing else in the release knows this instant.
    const before = Math.floor(Date.now() / 1000);
    const run = runStop(['infra/roots/rehearsal', ORDER_PREFIX], RUNNING, { report: 'release-stop-instant.txt' });
    expect(run.code, run.output).toBe(0);
    const recorded = new RegExp(
      `^root=${canonicalRehearsalRoot().replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)} prefix=fss-rh-order api_stopped_at=([0-9]+)$`,
      'u',
    ).exec(run.report ?? '');
    expect(recorded, `no stop instant in ${String(run.report)}`).not.toBeNull();
    // A real instant from this run, not a zero or a constant: it is between the moment
    // this test started and the moment it read the file back.
    expect(Number(recorded?.[1])).toBeGreaterThanOrEqual(before);
    expect(Number(recorded?.[1])).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it('records nothing when there was nothing to stop, and deletes any marker left before', () => {
    // Both already at zero: a marker here would name a moment this release did not cause,
    // and the deploy would print a confident wrong number instead of `unknown`. A stop
    // that stops nothing must also clear an earlier one out of the shared report
    // directory, rather than leave it to age out (PR 310 second review, P2).
    const reports = mkdtempSync(join(tmpdir(), 'fss-order-stale-'));
    const earlier = join(reports, 'release-stop-instant.txt');
    writeFileSync(earlier, `root=${canonicalRehearsalRoot()} prefix=${ORDER_PREFIX} api_stopped_at=${String(Math.floor(Date.now() / 1000) - 60)}\n`);
    const run = runStop(['infra/roots/rehearsal', ORDER_PREFIX], STOPPED, {
      report: 'release-stop-instant.txt',
      fixtures: { FSS_REHEARSAL_REPORTS: reports },
    });
    expect(run.code, run.output).toBe(0);
    expect(run.output).toContain('the earlier stop instant is discarded');
    expect(existsSync(earlier), 'a no-op stop left an older release’s instant behind').toBe(false);
  });

  it('is idempotent: services already at zero are reported and not touched', () => {
    const run = runStop(['infra/roots/rehearsal', ORDER_PREFIX], STOPPED);
    expect(run.code, run.output).toBe(0);
    expect(scaled(run.calls)).toEqual([]);
    expect(run.output).toContain(`${ORDER_PREFIX}-api is already stopped`);
    expect(run.report).toContain(`${ORDER_PREFIX}-worker=already_stopped`);
  });

  it('fails, naming the counts, when a service is still running after the wait', () => {
    const run = runStop(['infra/roots/rehearsal', ORDER_PREFIX], RUNNING, { sticky: true });
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

/**
 * P7 (26 September 2026): the read-back.
 *
 * The hand release stores the record before the plan (`record.sh put`), because the
 * worker admits a send only while a stored record names its digest. So the put at the
 * end of `deploy.sh release --release-record` is a read-back: it must answer `existing`,
 * and `created` means the services started without their record, which fails the deploy
 * (the record is stored by then, and the message names the order). A bootstrap may create
 * it: before its apply there was no database to put it into.
 *
 * ## The vacuous-pass trap
 *
 * A read-back that failed everything would pass the `created` case, so the `existing`
 * case must reach `deployed:` through the same fake, with the put as its only one-off.
 */
describe('P7: deploy.sh release reads the record back', () => {
  const REFERENCE = `${ORDER_PREFIX}-20260926`;
  const AT_COUNT = { api: { desired: 2, running: 2 }, worker: { desired: 1, running: 1 } } as const;
  const recordFile = (): string => {
    const path = join(mkdtempSync(join(tmpdir(), 'fss-order-record-')), 'release-record.json');
    writeFileSync(
      path,
      `${JSON.stringify({
        schema: 'fss.release-record.v1',
        releaseGateReference: REFERENCE,
        suite: 'pass',
        artifacts: { api: ORDER_API_DIGEST, worker: ORDER_WORKER_DIGEST, desktopCommitStamp: 'c'.repeat(40) },
      })}\n`,
    );
    return path;
  };
  const answered = (outcome: 'created' | 'existing'): string =>
    JSON.stringify({
      events: [
        {
          message: JSON.stringify({
            outcome,
            reference: REFERENCE,
            source: 'rehearsal',
            suite: 'pass',
            apiDigest: ORDER_API_DIGEST,
            workerDigest: ORDER_WORKER_DIGEST,
          }),
        },
      ],
    });

  it('passes a rolling deploy whose put answers existing: the record was stored before the plan', () => {
    const run = runOrder(DEPLOY, deployArgs('--release-record', recordFile()), AT_COUNT, {
      oneOffsPass: true,
      logEvents: answered('existing'),
    });
    expect(run.code, run.output).toBe(0);
    expect(launched(run.calls), 'the put is the rolling path’s only one-off').toHaveLength(1);
    expect(run.output).toContain('"outcome": "existing"');
    expect(run.output).toContain('deployed: one rolling deployment of the worker and the API, running digests, release record');
    expect(run.report).toContain('release_record=existing');
  });

  it('fails a deploy whose read-back had to create the record: the services started without it', () => {
    const run = runOrder(DEPLOY, deployArgs('--release-record', recordFile()), AT_COUNT, {
      oneOffsPass: true,
      logEvents: answered('created'),
    });
    expect(run.code).not.toBe(0);
    expect(run.output).toContain('the read-back had to create the release record');
    expect(run.output).toContain('record.sh put (before the plan)');
    expect(run.output).not.toContain('deployed:');
    expect(run.report).toBeNull();
  });

  it('lets a bootstrap create it, because before its apply there was no database to put it into', () => {
    const run = runOrder(DEPLOY, deployArgs('--schema-change', '--release-record', recordFile()), STOPPED, {
      bootstrap: true,
      oneOffsPass: true,
      logEvents: answered('created'),
    });
    expect(run.code, run.output).toBe(0);
    // Lane RS-2: three schema steps (release-prepare, verify, verify) and the put.
    expect(launched(run.calls), 'three schema steps and the put').toHaveLength(4);
    expect(run.report).toContain('bootstrap=true');
    expect(run.report).toContain('release_record=created');
  });

  it('bootstraps the first workspace in one one-off task, and refuses without a worker digest', () => {
    const flags = ['--slug', 'rehearsal', '--display-name', 'Rehearsal', '--admin-email', 'rehearsal-admin@usecallie.com'];
    const args = ['infra/roots/rehearsal', ORDER_PREFIX, '--worker-digest', ORDER_WORKER_DIGEST, ...flags];
    const workspace = '0b6f7d2e-1c3a-4e5f-8a9b-0c1d2e3f4a5b';
    const options = {
      oneOffsPass: true,
      report: 'bootstrap-workspace.txt',
      fixtures: { FSS_RELEASE_RUN_ID: 'bootstrap-parity' },
      logEvents: JSON.stringify({
        events: [
          {
            message: JSON.stringify({
              workspace: { id: workspace, slug: 'rehearsal', outcome: 'created' },
              admin: { outcome: 'created' },
              membership: { outcome: 'created', role: 'admin' },
            }),
          },
        ],
      }),
    };
    const current = runOrder(DEPLOY, ['bootstrap', ...args], RUNNING, options);
    expect(current.code, current.output).toBe(0);
    expect(launched(current.calls), 'one one-off task: the bootstrap').toHaveLength(1);
    expect(current.report).toContain(`workspace_id=${workspace} slug=rehearsal workspace=created admin=created membership=created role=admin`);

    // A refusal: one FAIL line, and nothing asked of AWS.
    const failLines = (run: OrderRun): readonly string[] => run.output.split('\n').filter(line => line.startsWith('FAIL:'));
    const refused = runOrder(DEPLOY, ['bootstrap', 'infra/roots/rehearsal', ORDER_PREFIX, ...flags], RUNNING, options);
    expect(refused.code).toBe(1);
    expect(failLines(refused)).toHaveLength(1);
    expect(failLines(refused)[0]).toContain('--worker-digest is required');
    expect(refused.calls).toEqual([]);
    expect(refused.report).toBeNull();
  });
});

/**
 * Slice A4: the release's time in four separate parts, and the idle wait. The numbers
 * come from files earlier scripts of the release left in the reports directory, each
 * naming the digests, root and prefix it is for; a number no script can see is null and
 * named, never estimated.
 */
describe('release-timings: preparation, automated checks, operator, downtime, idle wait', () => {
  const now = (): number => Math.floor(Date.now() / 1000);
  const timings = (output: string): RegExpExecArray | null =>
    /release-timings: preparation=(\S+) automated_checks=(\S+) operator=(\S+) downtime=(\S+) idle_wait=(\S+)/u.exec(output);
  const seconds = (value: string | undefined): number => Number(String(value).replace('s', ''));
  const PREPARE = (api: string, worker: string): string =>
    `api_digest=${api} worker_digest=${worker} commit=${'c'.repeat(40)} images_run_seconds=300 gate_run_seconds=600`;
  const PROMOTE = (api: string, worker: string): string => `api_digest=${api} worker_digest=${worker} promote_seconds=40`;
  const STOP_TIMING = (finishedAt: number, idle = 'idle'): string =>
    `root=${canonicalRehearsalRoot()} prefix=${ORDER_PREFIX} idle=${idle} idle_wait_seconds=30 stop_started_at=${String(finishedAt - 100)} stop_finished_at=${String(finishedAt)}`;
  const read = (reports: string): { timings: Record<string, number | null>; nulls: Record<string, string>; idle: { result: string | null; forced: boolean } } =>
    JSON.parse(readFileSync(join(reports, 'release-timings.json'), 'utf8')) as never;

  it('reports all five from the files the release left, and writes release-timings.json', () => {
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, {
      oneOffsPass: true,
      stopInstant: `root=${canonicalRehearsalRoot()} prefix=${ORDER_PREFIX} api_stopped_at=${String(now() - 540)}`,
      reportFiles: {
        'release-prepare-timing.txt': PREPARE(ORDER_API_DIGEST, ORDER_WORKER_DIGEST),
        'release-promote-timing.txt': PROMOTE(ORDER_API_DIGEST, ORDER_WORKER_DIGEST),
        'release-stop-timing.txt': STOP_TIMING(now() - 120),
      },
    });
    expect(run.code, run.output).toBe(0);
    const line = timings(run.output);
    expect(line, run.output).not.toBeNull();
    expect(line?.[1]).toBe('340s');
    expect(line?.[2]).toBe('600s');
    // Stop finished 120 s before this deploy began; the deploy itself takes a few seconds.
    expect(seconds(line?.[3])).toBeGreaterThanOrEqual(119);
    expect(seconds(line?.[3])).toBeLessThan(180);
    // Downtime: the stop marker (540 s ago) to the deployed verify that just passed.
    expect(seconds(line?.[4])).toBeGreaterThanOrEqual(540);
    expect(seconds(line?.[4])).toBeLessThan(600);
    expect(line?.[5]).toBe('30s');
    expect(run.report).toContain('release-timings: preparation=340s');
    const json = read(run.reports);
    expect(json.timings['preparationSeconds']).toBe(340);
    expect(json.timings['idleWaitSeconds']).toBe(30);
    expect(json.nulls).toEqual({});
    expect(json.idle).toEqual({ result: 'idle', forced: false, drain: null });
  });

  it('says a forced stop was forced, in the line and in the JSON', () => {
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, {
      oneOffsPass: true,
      reportFiles: { 'release-stop-timing.txt': STOP_TIMING(now() - 60, 'forced') },
    });
    expect(run.code, run.output).toBe(0);
    expect(run.output).toContain('FORCED (the idle check was skipped)');
    expect(read(run.reports).idle).toEqual({ result: 'forced', forced: true, drain: null });
  });

  it('records null, and says why, for every number no script could see', () => {
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, { oneOffsPass: true });
    expect(run.code, run.output).toBe(0);
    expect(timings(run.output)?.slice(1, 6)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
    const json = read(run.reports);
    expect(json.timings).toEqual({
      preparationSeconds: null,
      automatedChecksSeconds: null,
      operatorSeconds: null,
      downtimeSeconds: null,
      idleWaitSeconds: null,
    });
    expect(Object.keys(json.nulls).sort()).toEqual(['automatedChecksSeconds', 'downtimeSeconds', 'idleWaitSeconds', 'operatorSeconds', 'preparationSeconds']);
    for (const reason of Object.values(json.nulls)) expect(reason.length).toBeGreaterThan(20);
  });

  it('takes no number from another release: other digests, another prefix, a stale stop', () => {
    const other = `sha256:${'e'.repeat(64)}`;
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, {
      oneOffsPass: true,
      reportFiles: {
        'release-prepare-timing.txt': PREPARE(other, ORDER_WORKER_DIGEST),
        'release-promote-timing.txt': PROMOTE(ORDER_API_DIGEST, other),
        'release-stop-timing.txt': `root=${canonicalRehearsalRoot()} prefix=fss-rh-elsewhere idle=idle idle_wait_seconds=30 stop_started_at=${String(now() - 200)} stop_finished_at=${String(now() - 100)}`,
      },
    });
    expect(run.code, run.output).toBe(0);
    expect(timings(run.output)?.slice(1, 6)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
    // Seven hours between the stop and this deploy is another release's stop.
    const stale = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, {
      oneOffsPass: true,
      reportFiles: { 'release-stop-timing.txt': STOP_TIMING(now() - 7 * 60 * 60) },
    });
    expect(timings(stale.output)?.[3], 'a seven-hour gap was called operator time').toBe('unknown');
  });

  it('never reports half a preparation: images without a promotion is unknown', () => {
    const run = runOrder(DEPLOY, deployArgs('--schema-change'), STOPPED, {
      oneOffsPass: true,
      reportFiles: { 'release-prepare-timing.txt': PREPARE(ORDER_API_DIGEST, ORDER_WORKER_DIGEST) },
    });
    const line = timings(run.output);
    expect(line?.[1]).toBe('unknown');
    expect(line?.[2], 'the gate run is its own fact').toBe('600s');
    expect(read(run.reports).nulls['preparationSeconds']).toContain('no promotion timing');
  });

  it('has no downtime on a rolling release, which stops nothing', () => {
    const run = runOrder(DEPLOY, deployArgs(), RUNNING, {
      stopInstant: `root=${canonicalRehearsalRoot()} prefix=${ORDER_PREFIX} api_stopped_at=${String(now() - 540)}`,
    });
    expect(run.code, run.output).toBe(0);
    expect(timings(run.output)?.[4]).toBe('unknown');
    expect(read(run.reports).nulls['downtimeSeconds']).toContain('rolling release');
  });
});
