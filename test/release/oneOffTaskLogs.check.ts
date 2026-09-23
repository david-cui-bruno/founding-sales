import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepositoryFile, repositoryPath } from './support/coverage.ts';

/**
 * A one-off task's log stream is the only thing of it that survives, and the teardown
 * destroys the log group minutes later. Two rehearsal runs on 23 September 2026
 * (35812168524 and 35817370929) ended with `migrate: container migration exited 20`
 * and not one line of what the container said: `release_print_task_logs` read the
 * stream in the seconds between ECS reporting the stop and the awslogs driver
 * delivering the last lines, found it empty, and printed nothing — and it also
 * returned silently when the log group name it was given was empty. The cause of the
 * exit had to be reconstructed from the source instead.
 *
 * So the fetch now waits for a stream that exists but is still empty, the same way it
 * already waited for one that did not exist yet; it always says which stream it read
 * or why it read nothing; and the wrapper keeps a copy beside the task's ARN record so
 * the reports artifact carries the container's own words.
 */

const TASK_ARN = 'arn:aws:ecs:us-east-1:111111111111:task/fss-rh-x-cluster/abc123';
const REFUSAL = '{"level":"error","event":"fss_configuration_refused","code":"MISSING"}';

interface Outcome {
  readonly code: number;
  readonly output: string;
}

/** A fake `aws` that answers `logs get-log-events` empty `emptyAnswers` times, then with one line. */
function stubAws(directory: string, emptyAnswers: number): { readonly path: string; readonly calls: string } {
  const calls = join(directory, 'calls');
  writeFileSync(calls, '0\n');
  const path = join(directory, 'aws');
  writeFileSync(
    path,
    [
      '#!/usr/bin/env bash',
      'if [ "$1" = "logs" ] && [ "$2" = "get-log-events" ]; then',
      `  n=$(cat "${calls}"); n=$((n + 1)); echo "$n" > "${calls}"`,
      `  if [ "$n" -le ${emptyAnswers} ]; then echo '{"events":[]}'; else echo '{"events":[{"message":${JSON.stringify(REFUSAL)}}]}'; fi`,
      '  exit 0',
      'fi',
      'echo "unexpected: $*" >&2; exit 1',
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return { path, calls };
}

function fetchLogs(
  args: string,
  environment: Readonly<Record<string, string>>,
  settings = 'RELEASE_LOG_GRACE_SECONDS=30; RELEASE_LOG_POLL_SECONDS=0',
): Outcome {
  const directory = mkdtempSync(join(tmpdir(), 'fss-task-logs-'));
  const script = join(directory, 'case.sh');
  writeFileSync(
    script,
    `#!/usr/bin/env bash\nsource ${repositoryPath('infra/scripts/release-common.sh')}\n${settings}\nset +e\nrelease_print_task_logs ${args}\n`,
  );
  chmodSync(script, 0o755);
  const result = spawnSync('/bin/bash', [script], { encoding: 'utf8', env: { ...process.env, ...environment } });
  return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

describe('the one-off task log fetch, after the two silent runs of 23 September 2026', () => {
  it('waits for a stream that exists but is still empty, then prints and keeps what it held', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fss-task-logs-'));
    const aws = stubAws(directory, 2);
    const capture = join(directory, 'migrate.log');
    const { code, output } = fetchLogs(`rehearsal /fss/fss-rh-x/worker migration migration ${TASK_ARN} ${capture}`, {
      FSS_REHEARSAL_AWS_COMMAND: aws.path,
    });
    expect(code).toBe(0);
    expect(readFileSync(aws.calls, 'utf8').trim(), 'two empty answers, then the lines').toBe('3');
    expect(output).toContain('fss_configuration_refused');
    expect(output).toContain('log stream migration/migration/abc123 in /fss/fss-rh-x/worker');
    expect(output).toContain(`kept in ${capture}`);
    expect(readFileSync(capture, 'utf8').trim()).toBe(REFUSAL);
  });

  it('says so when the stream stays empty for the whole grace period', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fss-task-logs-'));
    const aws = stubAws(directory, 1000);
    const { code, output } = fetchLogs(
      `rehearsal /fss/fss-rh-x/worker migration migration ${TASK_ARN}`,
      { FSS_REHEARSAL_AWS_COMMAND: aws.path },
      'RELEASE_LOG_GRACE_SECONDS=0; RELEASE_LOG_POLL_SECONDS=0',
    );
    expect(code).toBe(0);
    expect(output).toContain('held no events after 0s');
    expect(output).not.toContain('fss_configuration_refused');
  });

  it('says so when it was given no log group, rather than returning in silence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fss-task-logs-'));
    const aws = stubAws(directory, 0);
    const { code, output } = fetchLogs(`rehearsal "" migration migration ${TASK_ARN}`, {
      FSS_REHEARSAL_AWS_COMMAND: aws.path,
    });
    expect(code).toBe(0);
    expect(output).toContain('no log group or stream prefix was given');
    expect(readFileSync(aws.calls, 'utf8').trim(), 'nothing was fetched').toBe('0');
  });

  it('the wrapper prints and keeps a FAILED task’s log before it returns the failure', () => {
    // Run 35876269976 (23 September 2026) printed "container migration exited 21" and
    // nothing else: the wrapper returned on the verdict before it ever fetched the log.
    // Every guard the wrapper runs first has a fixture hook, so this drives the whole
    // path with a recorded ARN (no launch), a stopped task with exit 21, and one log line.
    const reports = mkdtempSync(join(tmpdir(), 'fss-reports-'));
    mkdirSync(join(reports, 'tasks'));
    writeFileSync(join(reports, 'tasks', 'migrate.arn'), `${TASK_ARN}\n`);
    const digest = `sha256:${'a'.repeat(64)}`;
    const plan = JSON.stringify({
      subnet_ids: ['subnet-0a'],
      security_group_id: 'sg-0a',
      assign_public_ip: 'ENABLED',
      inbound_rule_count: 0,
    });
    const directory = mkdtempSync(join(tmpdir(), 'fss-task-logs-'));
    const script = join(directory, 'case.sh');
    writeFileSync(
      script,
      [
        '#!/usr/bin/env bash',
        `source ${repositoryPath('infra/scripts/release-common.sh')}`,
        'set +e',
        'release_run_task --step migrate --environment rehearsal --prefix fss-rh-x --account 111111111111 --region us-east-1 \\',
        '  --cluster arn:aws:ecs:us-east-1:111111111111:cluster/fss-rh-x-cluster \\',
        '  --task-definition arn:aws:ecs:us-east-1:111111111111:task-definition/fss-rh-x-migration:1 \\',
        `  --container migration --network-plan '${plan}' --image-digest ${digest} \\`,
        '  --log-group /fss/fss-rh-x/worker --log-stream-prefix migration -- migrate',
        'echo "wrapper exit $?"',
        '',
      ].join('\n'),
    );
    chmodSync(script, 0o755);
    const result = spawnSync('/bin/bash', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FSS_REHEARSAL_REPORTS: reports,
        FSS_RELEASE_CALLER_ACCOUNT: '111111111111',
        FSS_RELEASE_CLUSTER_TAGS: JSON.stringify([{ key: 'Environment', value: 'rehearsal' }]),
        FSS_RELEASE_TASK_DEFINITION: '',
        FSS_RELEASE_DESCRIBE_TASKS: JSON.stringify({
          tasks: [
            {
              lastStatus: 'STOPPED',
              stopCode: 'EssentialContainerExited',
              stoppedReason: 'Essential container in task exited',
              containers: [{ name: 'migration', exitCode: 21 }],
            },
          ],
        }),
        FSS_RELEASE_LOG_EVENTS: JSON.stringify({ events: [{ message: REFUSAL }] }),
      },
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(output, output).toContain('FAIL: migrate exited 21');
    expect(output).toContain('wrapper exit 1');
    // The log came out, after the verdict and before the return.
    expect(output.indexOf('exited 21')).toBeLessThan(output.indexOf('fss_configuration_refused'));
    expect(output).toContain('kept in');
    expect(readFileSync(join(reports, 'tasks', 'migrate.log'), 'utf8').trim()).toBe(REFUSAL);
  });

  it('the wrapper keeps every one-off task’s log beside its ARN record unless the caller named a capture', () => {
    // release_run_task runs a dozen guards against real AWS answers before it reaches
    // this line, so the contract is read from the source: the default capture is the
    // record path with `.arn` replaced by `.log`, decided before anything is launched.
    const source = readRepositoryFile('infra/scripts/release-common.sh');
    const record = source.indexOf('record="$(release_task_record_path "$step")"');
    expect(record).toBeGreaterThan(0);
    const next = source.slice(record, record + 600);
    expect(next).toContain('capture=${capture:-${record%.arn}.log}');
    // And the reports artifact collects the whole directory the record lives in.
    expect(readRepositoryFile('.github/workflows/greenfield-release.yml')).toContain('.rehearsal-reports');
  });

  it('the wait between looks is a setting, so the tests above run in milliseconds and the release in seconds', () => {
    const source = readRepositoryFile('infra/scripts/release-common.sh');
    expect(source).toContain('RELEASE_LOG_POLL_SECONDS=${RELEASE_LOG_POLL_SECONDS:-5}');
    expect(existsSync(repositoryPath('infra/scripts/release-common.sh'))).toBe(true);
  });
});
