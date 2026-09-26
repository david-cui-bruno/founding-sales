import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryPath } from './support/repository.ts';

/**
 * `infra/scripts/lib.sh`, run: the one-off task runner (`release_run_task`) and the
 * symmetric namespace refusal every release script relies on.
 *
 * Each guard is run against a launch it must refuse and, beside it, the launch it must
 * allow, so a runner that refused everything fails here too. The task record, the
 * image-pull retry and the log stream are driven through a fake `aws` that counts every
 * `run-task`: "it launched" and "it retried" are judged by that count as well as by the
 * exit status, so a runner that never reuses a record, or retries everything, fails.
 */

const LIB = repositoryPath('infra/scripts/lib.sh');
const ACCOUNT = '123456789012';
const PREFIX = 'fss-rh-check';
const CLUSTER = `arn:aws:ecs:us-east-1:${ACCOUNT}:cluster/${PREFIX}-cluster`;
const DEFINITION = `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/${PREFIX}-migration:1`;
const DIGEST = `sha256:${'b'.repeat(64)}`;
const SECRET = `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:${PREFIX}/migration-database-a`;
const HOST = `${PREFIX}-pg.example`;
const network = (inbound = 0): string =>
  JSON.stringify({
    subnet_ids: ['subnet-1111111111111111a', 'subnet-1111111111111111b'],
    security_group_id: 'sg-1111111111111111b',
    assign_public_ip: 'ENABLED',
    database_host: HOST,
    inbound_rule_count: inbound,
  });
const REGISTERED = JSON.stringify({
  containerDefinitions: [
    {
      name: 'migration',
      image: `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/fss-rh-worker@${DIGEST}`,
      environment: [{ name: 'FSS_DATABASE_HOST', value: HOST }],
      secrets: [{ name: 'DATABASE_SECRET_ARN', valueFrom: SECRET }],
    },
  ],
});
const BASE = [
  '--step', 'step', '--environment', 'rehearsal', '--prefix', PREFIX, '--account', ACCOUNT, '--region', 'us-east-1',
  '--cluster', CLUSTER, '--task-definition', DEFINITION, '--container', 'migration', '--network-plan', network(),
  '--image-digest', DIGEST, '--database-host', HOST, '--secret-arn', SECRET,
];
const stopped = (...codes: number[]): string =>
  JSON.stringify({
    tasks: [
      {
        lastStatus: 'STOPPED',
        stopCode: 'EssentialContainerExited',
        stoppedReason: 'Essential container in task exited',
        containers: codes.map((exitCode, index) => ({ name: index === 0 ? 'migration' : 'sidecar', exitCode })),
      },
    ],
  });
const PULL_FAILURE = JSON.stringify({
  tasks: [
    {
      lastStatus: 'STOPPED',
      stopCode: 'TaskFailedToStart',
      stoppedReason: 'CannotPullContainerError: failed to resolve ref: not found',
      containers: [{ name: 'migration', reason: 'CannotPullContainerError: not found' }],
    },
  ],
});
const SECRET_NOT_RESOLVED = JSON.stringify({
  tasks: [{ lastStatus: 'STOPPED', stopCode: 'TaskFailedToStart', stoppedReason: 'ResourceInitializationError: unable to pull secrets', containers: [{ name: 'migration' }] }],
});
const RUNNING = JSON.stringify({ tasks: [{ lastStatus: 'RUNNING', containers: [{ name: 'migration' }] }] });
const REFUSAL = '{"level":"error","event":"fss_configuration_refused","code":"MISSING"}';

interface Outcome {
  readonly code: number;
  readonly output: string;
}

/** Nothing ambient may answer for a fixture or name the run a record belongs to. */
function cleanEnvironment(extra: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(FSS_|GITHUB_|RELEASE_)/u.test(name)) env[name] = value;
  }
  return { ...env, ...extra };
}

/** `source lib.sh; <function> "$@"`, with the status the function returned. */
function call(fn: string, args: readonly string[], env: Readonly<Record<string, string>>): Outcome {
  const result = spawnSync(
    'bash',
    ['-c', `source "$0"; status=0; ${fn} "$@" || status=$?; echo "exit $status"`, LIB, ...args],
    { encoding: 'utf8', env: cleanEnvironment(env) },
  );
  return { code: Number(/exit (\d+)\s*$/u.exec(result.stdout)?.[1] ?? '99'), output: `${result.stdout}${result.stderr}` };
}

function dry(args: readonly string[], extra: Readonly<Record<string, string>> = {}): Outcome {
  return call('release_run_task', args, {
    FSS_REHEARSAL_DRY_RUN: '1',
    FSS_REHEARSAL_REPORTS: mkdtempSync(join(tmpdir(), 'fss-lib-dry-')),
    FSS_RELEASE_CALLER_ACCOUNT: ACCOUNT,
    FSS_RELEASE_CLUSTER_TAGS: '[{"key":"Environment","value":"rehearsal"}]',
    FSS_RELEASE_TASK_DEFINITION: REGISTERED,
    ...extra,
  });
}

describe('lib.sh: every guard refuses the launch it must, and allows the one it must', () => {
  const FRESH = JSON.stringify({ tasks: [{ taskArn: `arn:aws:ecs:us-east-1:${ACCOUNT}:task/${PREFIX}/aaa` }], failures: [] });
  const without = (flag: string): string[] => {
    const at = BASE.indexOf(flag);
    return [...BASE.slice(0, at), ...BASE.slice(at + 2)];
  };
  // [label, expected, arguments, fixtures, the FAIL phrase a refusal must print]
  const cases: readonly (readonly [string, 'allowed' | 'refused', readonly string[], Readonly<Record<string, string>>?, string?])[] = [
    ['the launch a release makes', 'allowed', [...BASE, '--', 'migrate']],
    ['a bare cluster name', 'refused', [...without('--cluster'), '--cluster', `${PREFIX}-cluster`, '--', 'migrate'], {}, 'must be a full ecs ARN'],
    ['a cluster in another region', 'refused', [...without('--region'), '--region', 'eu-west-1', '--', 'migrate'], {}, 'is in us-east-1 and this release is in eu-west-1'],
    ['a cluster in another account', 'refused', [...without('--account'), '--account', '999999999999', '--', 'migrate'], {}, 'this release is in 999999999999'],
    ['a cluster outside the run’s namespace', 'refused', [...without('--prefix'), '--prefix', 'fss-rh-other', '--', 'migrate'], {}, 'does not carry this environment’s namespace'.replace('’', "'")],
    ['credentials of another account', 'refused', [...BASE, '--', 'migrate'], { FSS_RELEASE_CALLER_ACCOUNT: '999999999999' }, 'these credentials belong to account 999999999999'],
    ['a cluster tagged Environment=production', 'refused', [...BASE, '--', 'migrate'], { FSS_RELEASE_CLUSTER_TAGS: '[{"key":"Environment","value":"production"}]' }, 'tagged Environment=production'],
    ['an image that is not the release digest', 'refused', [...without('--image-digest'), '--image-digest', `sha256:${'c'.repeat(64)}`, '--', 'migrate'], {}, 'image is not the release digest'],
    ['a definition resolving another credential entry', 'refused', [...without('--secret-arn'), '--secret-arn', `${SECRET}-other`, '--', 'migrate'], {}, 'from an entry this release did not name'],
    ['a definition pointed at another database', 'refused', [...without('--database-host'), '--database-host', 'other-pg.example', '--', 'migrate'], {}, 'the database this release targets is'],
    ['a worker security group with an inbound rule', 'refused', [...without('--network-plan'), '--network-plan', network(1), '--', 'migrate'], {}, 'declares 1 inbound rule'],
    ['a credential-shaped environment override', 'refused', [...BASE, '--env', 'DATABASE_PASSWORD=x', '--', 'migrate'], {}, 'looks like a credential'],
    ['another endpoint as an FSS_DATABASE_HOST override', 'allowed', [...BASE, '--env', `FSS_DATABASE_HOST=${PREFIX}-pg-restored.example`, '--', 'migrate']],
    ['that endpoint as --database-host too', 'refused', [...without('--database-host'), '--database-host', `${PREFIX}-pg-restored.example`, '--env', `FSS_DATABASE_HOST=${PREFIX}-pg-restored.example`, '--', 'migrate'], {}, 'the database this release targets is'],
    ['a production name in the command itself', 'refused', [...BASE, '--', 'migrate', '--report', '/tmp/fss-prod-migrate.json'], {}, 'names a production resource'],
    ['no command at all', 'refused', [...BASE], {}, 'needs a command after --'],
    ['a run-task that answered failures', 'refused', [...BASE, '--', 'migrate'], { FSS_RELEASE_RUN_TASK: '{"tasks":[],"failures":[{"reason":"RESOURCE:MEMORY"}]}' }, 'ECS reported 1 failure'],
    ['a task stopped with no exit code', 'refused', [...BASE, '--', 'migrate'], { FSS_RELEASE_RUN_TASK: FRESH, FSS_RELEASE_DESCRIBE_TASKS: SECRET_NOT_RESOLVED }, 'stopped with no exit code'],
    ['a second container that exited non-zero', 'refused', [...BASE, '--', 'migrate'], { FSS_RELEASE_RUN_TASK: FRESH, FSS_RELEASE_DESCRIBE_TASKS: stopped(0, 3) }, 'FAIL: step exited 3'],
    ['a task whose containers all exited zero', 'allowed', [...BASE, '--', 'migrate'], { FSS_RELEASE_RUN_TASK: FRESH, FSS_RELEASE_DESCRIBE_TASKS: stopped(0) }],
    ['a step that requires exit 3, and got it', 'allowed', [...BASE, '--expect-exit', '3', '--', 'migrate'], { FSS_RELEASE_RUN_TASK: FRESH, FSS_RELEASE_DESCRIBE_TASKS: stopped(3) }],
    ['a step that requires exit 3, and got 0', 'refused', [...BASE, '--expect-exit', '3', '--', 'migrate'], { FSS_RELEASE_RUN_TASK: FRESH, FSS_RELEASE_DESCRIBE_TASKS: stopped(0) }, 'this step requires exit 3'],
  ];
  for (const [label, expected, args, extra, phrase] of cases) {
    it(`${expected === 'allowed' ? 'allows' : 'refuses'} ${label}`, () => {
      const { code, output } = dry(args, extra);
      if (expected === 'allowed') {
        expect(code, output).toBe(0);
      } else {
        expect(code, output).not.toBe(0);
        expect(output).toContain(phrase ?? '<a phrase>');
      }
    });
  }

  it('names the override as the target database while checking the definition against its own host', () => {
    const { code, output } = dry([...BASE, '--env', `FSS_DATABASE_HOST=${PREFIX}-pg-restored.example`, '--', 'migrate']);
    expect(code, output).toBe(0);
    expect(output).toContain(`step: target database host ${PREFIX}-pg-restored.example`);
  });

  it('refuses the other environment’s names in both directions, and a prefix of neither', () => {
    expect(call('release_refuse_foreign_arguments', ['production', 'fss-rh-0921-cluster'], {}).code).not.toBe(0);
    expect(call('release_refuse_foreign_arguments', ['rehearsal', 'fss-prod-cluster'], {}).code).not.toBe(0);
    expect(call('release_refuse_foreign_arguments', ['production', 'fss-prod-cluster'], {}).code).toBe(0);
    expect(call('release_aws', ['rehearsal', 'ecs', 'describe-services', '--cluster', 'fss-prod-cluster'], {}).code).not.toBe(0);
    for (const prefix of ['something-else', '']) expect(call('release_environment_for_prefix', [prefix], {}).code).not.toBe(0);
    expect(call('release_environment_for_prefix', ['fss-prod'], {}).output).toContain('production');
  });
});

/**
 * A fake `aws`. `run-task` numbers its tasks; `describe-tasks` answers task n from
 * `answer-<n>` (or `answer-default`); a `kill-on-describe` file kills the calling script
 * at the first description, which is what an interrupted release looks like to the next
 * one; `logs get-log-events` answers empty `log-empty` times, then with `log-message`.
 */
function fake(): { readonly directory: string; readonly path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'fss-lib-fake-'));
  const path = join(directory, 'aws');
  writeFileSync(
    path,
    [
      '#!/usr/bin/env bash',
      `state='${directory}'`,
      'case "$1 $2" in',
      '  "ecs run-task")',
      '    n=$(( $(cat "$state/launched" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$state/launched"',
      `    printf '{"tasks":[{"taskArn":"arn:aws:ecs:us-east-1:${ACCOUNT}:task/${PREFIX}-cluster/task-%s"}],"failures":[]}\\n' "$n"`,
      '    exit 0 ;;',
      '  "ecs describe-tasks")',
      '    arn=""; while [ "$#" -gt 0 ]; do [ "$1" = "--tasks" ] && arn=$2; shift; done',
      '    if [ -f "$state/kill-on-describe" ]; then rm -f "$state/kill-on-describe"; kill -9 "$CASE_PID"; exit 1; fi',
      '    cat "$state/answer-${arn##*task-}" 2>/dev/null || cat "$state/answer-default"',
      '    exit 0 ;;',
      '  "ecs stop-task") exit 0 ;;',
      '  "logs get-log-events")',
      '    left=$(cat "$state/log-empty" 2>/dev/null || echo 0)',
      '    if [ "$left" -gt 0 ]; then echo $((left - 1)) > "$state/log-empty"; echo \'{"events":[]}\'; exit 0; fi',
      '    python3 -c \'import json,sys; print(json.dumps({"events":[{"message":open(sys.argv[1]).read().strip()}]}))\' "$state/log-message"',
      '    exit 0 ;;',
      'esac',
      'echo "unexpected: $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  writeFileSync(join(directory, 'log-message'), '{"step":"done"}');
  return { directory, path };
}

type Fake = ReturnType<typeof fake>;

function launch(cli: Fake, reports: string, options: { readonly run?: string; readonly command?: string; readonly logGroup?: string } = {}): Outcome {
  const script = join(cli.directory, `case-${String(Math.random()).slice(2)}.sh`);
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      'export CASE_PID=$$',
      `source ${LIB}`,
      'status=0',
      `release_run_task --step migrate --environment rehearsal --prefix ${PREFIX} --account ${ACCOUNT} --region us-east-1 \\`,
      `  --cluster ${CLUSTER} --task-definition ${DEFINITION} --container migration --network-plan '${network()}' \\`,
      `  --image-digest ${DIGEST} --log-group ${options.logGroup ?? `/fss/${PREFIX}/worker`} --log-stream-prefix migration \\`,
      `  -- ${options.command ?? 'migrate --report /tmp/fss-migrate.json'} || status=$?`,
      'echo "wrapper exit $status"',
      '',
    ].join('\n'),
  );
  chmodSync(script, 0o755);
  const result = spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    env: cleanEnvironment({
      FSS_REHEARSAL_REPORTS: reports,
      FSS_REHEARSAL_AWS_COMMAND: cli.path,
      FSS_RELEASE_CALLER_ACCOUNT: ACCOUNT,
      FSS_RELEASE_CLUSTER_TAGS: '[{"key":"Environment","value":"rehearsal"}]',
      FSS_RELEASE_TASK_DEFINITION: '',
      FSS_RELEASE_RUN_ID: options.run ?? 'release-a',
      RELEASE_LOG_POLL_SECONDS: '0',
      RELEASE_PULL_BACKOFF_SECONDS: '0',
    }),
  });
  return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

const launches = (cli: Fake): number =>
  existsSync(join(cli.directory, 'launched')) ? Number(readFileSync(join(cli.directory, 'launched'), 'utf8').trim()) : 0;
const history = (reports: string): string =>
  existsSync(join(reports, 'tasks', 'migrate.history')) ? readFileSync(join(reports, 'tasks', 'migrate.history'), 'utf8') : '';
const answer = (cli: Fake, task: number | 'default', body: string): void => writeFileSync(join(cli.directory, `answer-${String(task)}`), body);
const reportsDirectory = (): string => mkdtempSync(join(tmpdir(), 'fss-lib-reports-'));

/** A first launch killed right after `run-task`: the record stays, unread. */
function interrupted(cli: Fake, reports: string, run = 'release-a'): void {
  writeFileSync(join(cli.directory, 'kill-on-describe'), '');
  expect(launch(cli, reports, { run }).output).not.toContain('wrapper exit');
  expect(existsSync(join(reports, 'tasks', 'migrate.arn'))).toBe(true);
}

describe('lib.sh: a task record is bound to its invocation and read once (lane g80)', () => {
  it('resumes the same invocation after an interruption without a second launch, then retires the record', () => {
    const cli = fake();
    const reports = reportsDirectory();
    answer(cli, 'default', stopped(0));
    interrupted(cli, reports);
    const again = launch(cli, reports);
    expect(again.output).toContain('wrapper exit 0');
    expect(again.output).toContain('its outcome was never read; waiting on it rather than launching another');
    expect(launches(cli)).toBe(1);
    expect(existsSync(join(reports, 'tasks', 'migrate.arn'))).toBe(false);
    expect(history(reports)).toContain('outcome=read_verdict_0');
  });

  it('sets another run’s stopped record aside unread and launches its own', () => {
    const cli = fake();
    const reports = reportsDirectory();
    answer(cli, 1, stopped(0));
    answer(cli, 2, stopped(21));
    interrupted(cli, reports, 'release-a');
    const other = launch(cli, reports, { run: 'release-b' });
    expect(launches(cli)).toBe(2);
    expect(other.output).toContain('FAIL: migrate exited 21');
    expect(history(reports)).toContain('outcome=set_aside_unread_STOPPED');
  });

  it('refuses to launch beside another run’s task that is still running, and leaves its record', () => {
    const cli = fake();
    const reports = reportsDirectory();
    answer(cli, 1, RUNNING);
    interrupted(cli, reports, 'release-a');
    const other = launch(cli, reports, { run: 'release-b' });
    expect(other.output).toContain('is still RUNNING');
    expect(other.output).toContain('wrapper exit 1');
    expect(launches(cli)).toBe(1);
    expect(existsSync(join(reports, 'tasks', 'migrate.arn'))).toBe(true);
  });

  it('launches again for the same step once its outcome was read, and for another command', () => {
    const cli = fake();
    const reports = reportsDirectory();
    answer(cli, 1, stopped(0));
    answer(cli, 2, stopped(21));
    expect(launch(cli, reports).output).toContain('wrapper exit 0');
    expect(launch(cli, reports).output).toContain('wrapper exit 1');
    expect(launches(cli)).toBe(2);

    const changed = fake();
    const reused = reportsDirectory();
    answer(changed, 1, stopped(0));
    answer(changed, 2, stopped(21));
    interrupted(changed, reused);
    expect(launch(changed, reused, { command: 'admin database-users ensure' }).output).toContain('wrapper exit 1');
    expect(launches(changed)).toBe(2);
  });

  it('sets aside a bare ARN record written before lane g80', () => {
    const cli = fake();
    const reports = reportsDirectory();
    mkdirSync(join(reports, 'tasks'));
    writeFileSync(join(reports, 'tasks', 'migrate.arn'), `arn:aws:ecs:us-east-1:${ACCOUNT}:task/${PREFIX}-cluster/task-0\n`);
    answer(cli, 0, stopped(0));
    answer(cli, 1, stopped(21));
    expect(launch(cli, reports).output).toContain('wrapper exit 1');
    expect(launches(cli)).toBe(1);
    expect(history(reports)).toContain('fingerprint=<none: recorded before lane g80>');
  });
});

describe('lib.sh: an image that could not be pulled is launched again, three times at most, and nothing else is', () => {
  it('launches again after a pull failure and passes on the next attempt', () => {
    const cli = fake();
    const reports = reportsDirectory();
    answer(cli, 1, PULL_FAILURE);
    answer(cli, 2, stopped(0));
    const run = launch(cli, reports);
    expect(run.output).toContain('wrapper exit 0');
    expect(launches(cli)).toBe(2);
    expect(run.output).toContain('attempt 1 of 3: task');
    expect(history(reports)).toContain('outcome=image_not_pulled_attempt_1');
  });

  it('stops after three attempts and fails naming the pull error', () => {
    const cli = fake();
    answer(cli, 'default', PULL_FAILURE);
    const run = launch(cli, reportsDirectory());
    expect(run.output).toContain('wrapper exit 1');
    expect(launches(cli)).toBe(3);
    expect(run.output).toContain('the image could not be pulled on any of 3 attempt(s)');
  });

  it('fails on the first attempt for an exit code or a secret that could not be resolved', () => {
    for (const body of [stopped(21), SECRET_NOT_RESOLVED]) {
      const cli = fake();
      answer(cli, 'default', body);
      const run = launch(cli, reportsDirectory());
      expect(run.output).toContain('wrapper exit 1');
      expect(launches(cli)).toBe(1);
    }
  });
});

describe('lib.sh: the task’s log stream is read, printed and kept, whatever the verdict', () => {
  it('waits for a stream that exists but is still empty, and keeps a failed task’s lines beside its record', () => {
    const cli = fake();
    const reports = reportsDirectory();
    answer(cli, 'default', stopped(21));
    writeFileSync(join(cli.directory, 'log-empty'), '2');
    writeFileSync(join(cli.directory, 'log-message'), REFUSAL);
    const run = launch(cli, reports);
    expect(run.output).toContain('FAIL: migrate exited 21');
    expect(run.output).toContain('wrapper exit 1');
    expect(run.output.indexOf('exited 21')).toBeLessThan(run.output.indexOf('fss_configuration_refused'));
    expect(run.output).toContain('log stream migration/migration/task-1');
    expect(readFileSync(join(reports, 'tasks', 'migrate.log'), 'utf8').trim()).toBe(REFUSAL);
  });

  it('says so when it was given no log group, rather than returning in silence', () => {
    const cli = fake();
    answer(cli, 'default', stopped(0));
    const run = launch(cli, reportsDirectory(), { logGroup: '""' });
    expect(run.output).toContain('wrapper exit 0');
    expect(run.output).toContain('no log group or stream prefix was given');
  });
});
