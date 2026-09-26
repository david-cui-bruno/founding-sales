import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryPath } from './support/repository.ts';

/**
 * What a one-off task's record means, and when an image that could not be pulled is
 * launched again (lane g80, audit items O06 and O07).
 *
 * `release_run_task` records the ARN of every task it launches, so that a script run a
 * second time waits on a migration that is still running rather than starting another
 * one behind the advisory lock. Until g80 the record was the step's file name and
 * nothing else. So a reports directory reused by another release, or a second run of
 * the same script in one job — the restore drill's step 7 runs
 * `rehearsal-schema-ranges.sh` again, after the restore, under the same four step
 * names — read an old task's verdict as its own. And a task that failed was read again
 * on every run, including the `CannotPullContainerError ... not found` a production
 * one-off hit minutes after an ECR copy, which nothing but a new launch can clear.
 *
 * Now a record carries a fingerprint of the invocation, is waited on only by the same
 * invocation, and is retired once its outcome has been read; a pull failure from
 * before any container ran is launched again, a bounded number of times, and nothing
 * else is.
 *
 * ## The vacuous-pass traps, named
 *
 * "It launched a new task" passes for a wrapper that never reuses anything, which is
 * the double-migration bug the record exists for. So every case that requires a fresh
 * launch sits beside one that requires none: the same invocation, interrupted after
 * its launch, must resume without a second `run-task`. And "it retried" passes for a
 * wrapper that retries everything, so an exit code and an unresolvable secret must each
 * fail on their only attempt. The fake CLI counts every `run-task`, and each case is
 * judged by that count as well as by the exit status.
 */

const ACCOUNT = '111111111111';
const PREFIX = 'fss-rh-rec';
const CLUSTER = `arn:aws:ecs:us-east-1:${ACCOUNT}:cluster/${PREFIX}-cluster`;
const DIGEST = `sha256:${'c'.repeat(64)}`;
const PLAN = JSON.stringify({
  subnet_ids: ['subnet-0a'],
  security_group_id: 'sg-0a',
  assign_public_ip: 'ENABLED',
  inbound_rule_count: 0,
});

const stopped = (exitCode: number): string =>
  JSON.stringify({
    tasks: [
      {
        lastStatus: 'STOPPED',
        stopCode: 'EssentialContainerExited',
        stoppedReason: 'Essential container in task exited',
        containers: [{ name: 'migration', exitCode }],
      },
    ],
  });

const PULL_FAILURE = JSON.stringify({
  tasks: [
    {
      lastStatus: 'STOPPED',
      stopCode: 'TaskFailedToStart',
      stoppedReason: `CannotPullContainerError: pull image manifest has been retried 1 time(s): failed to resolve ref ${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/fss-rh-worker@${DIGEST}: not found`,
      containers: [{ name: 'migration', reason: 'CannotPullContainerError: failed to resolve ref: not found' }],
    },
  ],
});

const SECRET_NOT_RESOLVED = JSON.stringify({
  tasks: [
    {
      lastStatus: 'STOPPED',
      stopCode: 'TaskFailedToStart',
      stoppedReason:
        "ResourceInitializationError: unable to pull secrets or registry auth: can't find the specified secret value for staging label: AWSCURRENT",
      containers: [{ name: 'migration' }],
    },
  ],
});

const RUNNING = JSON.stringify({ tasks: [{ lastStatus: 'RUNNING', containers: [{ name: 'migration' }] }] });

/**
 * A fake CLI. `run-task` numbers its tasks `task-1`, `task-2`, …; `describe-tasks`
 * answers each from `answer-<n>` (or `answer-default`); a `kill-on-describe` file makes
 * the first description kill the calling script, which is what an interrupted release
 * looks like to the next one.
 */
function fake(): { readonly directory: string; readonly path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'fss-records-'));
  const path = join(directory, 'aws');
  writeFileSync(
    path,
    [
      '#!/usr/bin/env bash',
      `state='${directory}'`,
      'printf "%s\\n" "$*" >> "$state/calls.log"',
      'case "$1 $2" in',
      '  "ecs run-task")',
      '    n=$(( $(cat "$state/launched" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$state/launched"',
      `    printf '{"tasks":[{"taskArn":"arn:aws:ecs:us-east-1:${ACCOUNT}:task/${PREFIX}-cluster/task-%s"}],"failures":[]}\\n' "$n"`,
      '    exit 0 ;;',
      '  "ecs describe-tasks")',
      '    arn=""; while [ "$#" -gt 0 ]; do [ "$1" = "--tasks" ] && arn=$2; shift; done',
      '    n=${arn##*task-}',
      '    if [ -f "$state/kill-on-describe" ]; then rm -f "$state/kill-on-describe"; kill -9 "$CASE_PID"; exit 1; fi',
      '    cat "$state/answer-$n" 2>/dev/null || cat "$state/answer-default"',
      '    exit 0 ;;',
      '  "ecs stop-task") exit 0 ;;',
      '  "logs get-log-events") echo \'{"events":[{"message":"{\\"step\\":\\"done\\"}"}]}\'; exit 0 ;;',
      'esac',
      'echo "unexpected: $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return { directory, path };
}

interface Invocation {
  readonly run?: string;
  readonly definition?: string;
  readonly command?: string;
  readonly step?: string;
}

interface Outcome {
  readonly code: number;
  readonly output: string;
}

function invoke(cli: { readonly directory: string; readonly path: string }, reports: string, invocation: Invocation = {}): Outcome {
  const script = join(cli.directory, `case-${String(Math.random()).slice(2)}.sh`);
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      'export CASE_PID=$$',
      `source ${repositoryPath('infra/scripts/release-common.sh')}`,
      // `|| status=$?`, not `set +e` alone: the log fetch turns errexit back on.
      'status=0',
      `release_run_task --step ${invocation.step ?? 'migrate'} --environment rehearsal --prefix ${PREFIX} --account ${ACCOUNT} --region us-east-1 \\`,
      `  --cluster ${CLUSTER} \\`,
      `  --task-definition ${invocation.definition ?? `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/${PREFIX}-migration:1`} \\`,
      `  --container migration --network-plan '${PLAN}' --image-digest ${DIGEST} \\`,
      `  --log-group /fss/${PREFIX}/worker --log-stream-prefix migration -- ${invocation.command ?? 'migrate --report /tmp/fss-migrate.json'} || status=$?`,
      'echo "wrapper exit $status"',
      '',
    ].join('\n'),
  );
  chmodSync(script, 0o755);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    // Nothing ambient may decide which run a record belongs to, or answer for the fake.
    if (value !== undefined && !name.startsWith('FSS_') && !name.startsWith('GITHUB_') && !name.startsWith('RELEASE_')) {
      env[name] = value;
    }
  }
  const result = spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    env: {
      ...env,
      FSS_REHEARSAL_REPORTS: reports,
      FSS_REHEARSAL_AWS_COMMAND: cli.path,
      FSS_RELEASE_CALLER_ACCOUNT: ACCOUNT,
      FSS_RELEASE_CLUSTER_TAGS: JSON.stringify([{ key: 'Environment', value: 'rehearsal' }]),
      FSS_RELEASE_TASK_DEFINITION: '',
      FSS_RELEASE_RUN_ID: invocation.run ?? 'release-a',
      RELEASE_LOG_POLL_SECONDS: '0',
      RELEASE_PULL_BACKOFF_SECONDS: '0',
    },
  });
  return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

const launches = (cli: { readonly directory: string }): number =>
  existsSync(join(cli.directory, 'launched')) ? Number(readFileSync(join(cli.directory, 'launched'), 'utf8').trim()) : 0;

const history = (reports: string, step = 'migrate'): string => {
  const path = join(reports, 'tasks', `${step}.history`);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
};

/** A first invocation killed right after its launch: the record stays, unread. */
function interrupted(cli: { readonly directory: string; readonly path: string }, reports: string, invocation: Invocation = {}): void {
  writeFileSync(join(cli.directory, 'kill-on-describe'), '');
  const first = invoke(cli, reports, invocation);
  expect(first.output).not.toContain('wrapper exit');
  expect(existsSync(join(reports, 'tasks', `${invocation.step ?? 'migrate'}.arn`)), 'the interrupted launch left no record').toBe(true);
  expect(launches(cli)).toBe(1);
}

describe('g80: a one-off task record is bound to its invocation and read once (O07)', () => {
  it('resumes the same invocation after an interruption without launching a second task', () => {
    const cli = fake();
    const reports = mkdtempSync(join(tmpdir(), 'fss-records-reports-'));
    writeFileSync(join(cli.directory, 'answer-default'), stopped(0));
    interrupted(cli, reports);
    const again = invoke(cli, reports);
    expect(again.output).toContain('wrapper exit 0');
    expect(again.output).toContain('its outcome was never read; waiting on it rather than launching another');
    expect(launches(cli), 'the resumed step launched a second migration').toBe(1);
    // Read, so retired: the record is gone and the history says how it ended.
    expect(existsSync(join(reports, 'tasks', 'migrate.arn'))).toBe(false);
    expect(history(reports)).toContain('outcome=read_verdict_0');
    expect(history(reports)).toContain('run=release-a');
  });

  it('never reads a record from another release as this one’s, and launches its own', () => {
    const cli = fake();
    const reports = mkdtempSync(join(tmpdir(), 'fss-records-reports-'));
    // The other release's task passed; this release's fails. Reading the old record
    // would turn this release's failure into a pass.
    writeFileSync(join(cli.directory, 'answer-1'), stopped(0));
    writeFileSync(join(cli.directory, 'answer-2'), stopped(21));
    interrupted(cli, reports, { run: 'release-a' });
    const other = invoke(cli, reports, { run: 'release-b' });
    expect(launches(cli), 'a record from another release was reused').toBe(2);
    expect(other.output).toContain('FAIL: migrate exited 21');
    expect(other.output).toContain('wrapper exit 1');
    expect(other.output).toContain('was recorded for another run or command and has stopped');
    expect(history(reports)).toContain('outcome=set_aside_unread_STOPPED');
  });

  it('never reads a record from another command or another task definition revision', () => {
    for (const change of [
      { command: 'admin database-users ensure --report /tmp/fss-users.json' },
      { definition: `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/${PREFIX}-migration:2` },
    ]) {
      const cli = fake();
      const reports = mkdtempSync(join(tmpdir(), 'fss-records-reports-'));
      writeFileSync(join(cli.directory, 'answer-1'), stopped(0));
      writeFileSync(join(cli.directory, 'answer-2'), stopped(21));
      interrupted(cli, reports);
      const other = invoke(cli, reports, change);
      expect(launches(cli), `a record was reused across ${JSON.stringify(change)}`).toBe(2);
      expect(other.output).toContain('wrapper exit 1');
    }
  });

  it('launches its own task when the same step runs again after its outcome was read, as the drill’s step 7 does', () => {
    const cli = fake();
    const reports = mkdtempSync(join(tmpdir(), 'fss-records-reports-'));
    writeFileSync(join(cli.directory, 'answer-1'), stopped(0));
    writeFileSync(join(cli.directory, 'answer-2'), stopped(21));
    const first = invoke(cli, reports);
    expect(first.output).toContain('wrapper exit 0');
    const second = invoke(cli, reports);
    expect(launches(cli), 'the second run re-read the first run’s verdict').toBe(2);
    expect(second.output).toContain('FAIL: migrate exited 21');
    expect(second.output).toContain('wrapper exit 1');
    expect(history(reports).match(/outcome=read_verdict_/gu)).toHaveLength(2);
  });

  it('refuses to launch beside a task from another run that is still running', () => {
    const cli = fake();
    const reports = mkdtempSync(join(tmpdir(), 'fss-records-reports-'));
    writeFileSync(join(cli.directory, 'answer-1'), RUNNING);
    interrupted(cli, reports, { run: 'release-a' });
    const other = invoke(cli, reports, { run: 'release-b' });
    expect(other.output).toContain('is still RUNNING');
    expect(other.output).toContain('wrapper exit 1');
    expect(launches(cli), 'a second migration was launched beside the first').toBe(1);
    // Refused, not read: the record is still there for whoever owns it.
    expect(existsSync(join(reports, 'tasks', 'migrate.arn'))).toBe(true);
  });

  it('sets aside a bare ARN record written before lane g80 rather than reading it', () => {
    const cli = fake();
    const reports = mkdtempSync(join(tmpdir(), 'fss-records-reports-'));
    mkdirSync(join(reports, 'tasks'));
    writeFileSync(join(reports, 'tasks', 'migrate.arn'), `arn:aws:ecs:us-east-1:${ACCOUNT}:task/${PREFIX}-cluster/task-0\n`);
    writeFileSync(join(cli.directory, 'answer-0'), stopped(0));
    writeFileSync(join(cli.directory, 'answer-1'), stopped(21));
    const run = invoke(cli, reports);
    expect(launches(cli)).toBe(1);
    expect(run.output).toContain('wrapper exit 1');
    expect(history(reports)).toContain('fingerprint=<none: recorded before lane g80>');
  });
});

describe('g80: an image that could not be pulled is launched again, and nothing else is (O06)', () => {
  it('launches again after a pull failure from before any container ran, and passes on the next attempt', () => {
    const cli = fake();
    const reports = mkdtempSync(join(tmpdir(), 'fss-records-reports-'));
    writeFileSync(join(cli.directory, 'answer-1'), PULL_FAILURE);
    writeFileSync(join(cli.directory, 'answer-2'), stopped(0));
    const run = invoke(cli, reports);
    expect(run.output).toContain('wrapper exit 0');
    expect(launches(cli)).toBe(2);
    expect(run.output).toContain('attempt 1 of 3: task');
    expect(run.output).toContain('because its image could not be pulled (CannotPullContainerError');
    expect(run.output).toContain('attempt 2 of 3)');
    expect(history(reports)).toContain('outcome=image_not_pulled_attempt_1');
    expect(history(reports)).toContain('outcome=read_verdict_0');
  });

  it('stops after three attempts, logging each, and fails naming the pull error', () => {
    const cli = fake();
    const reports = mkdtempSync(join(tmpdir(), 'fss-records-reports-'));
    writeFileSync(join(cli.directory, 'answer-default'), PULL_FAILURE);
    const run = invoke(cli, reports);
    expect(run.output).toContain('wrapper exit 1');
    expect(launches(cli)).toBe(3);
    expect(run.output).toContain('attempt 1 of 3: task');
    expect(run.output).toContain('attempt 2 of 3: task');
    expect(run.output).toContain('the image could not be pulled on any of 3 attempt(s)');
    expect(run.output).toContain('stopped with no exit code');
  });

  it('resumes a recorded pull failure by launching again, rather than reading it for ever', () => {
    const cli = fake();
    const reports = mkdtempSync(join(tmpdir(), 'fss-records-reports-'));
    writeFileSync(join(cli.directory, 'answer-1'), PULL_FAILURE);
    writeFileSync(join(cli.directory, 'answer-2'), stopped(0));
    interrupted(cli, reports);
    const again = invoke(cli, reports);
    expect(again.output).toContain('wrapper exit 0');
    expect(launches(cli)).toBe(2);
  });

  it('fails on the first attempt for an exit code, or a secret that could not be resolved', () => {
    for (const answer of [stopped(21), SECRET_NOT_RESOLVED]) {
      const cli = fake();
      const reports = mkdtempSync(join(tmpdir(), 'fss-records-reports-'));
      writeFileSync(join(cli.directory, 'answer-default'), answer);
      const run = invoke(cli, reports);
      expect(run.output).toContain('wrapper exit 1');
      expect(launches(cli), `retried ${answer}`).toBe(1);
      expect(run.output).not.toContain('launching again');
    }
  });
});
