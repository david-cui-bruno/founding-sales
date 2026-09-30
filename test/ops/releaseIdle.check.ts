import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryPath } from './support/repository.ts';

/**
 * Slice A4: `stop.sh` asks whether production is idle before it stops anything
 * (`infra/scripts/idle.sh`).
 *
 * ## The vacuous-pass trap
 *
 * Reading the wait out of the script passes against a wait that is never reached. So the
 * real scripts run against a fake AWS CLI that keeps each service's counts and launches
 * one-off tasks, and every case is judged by the calls the CLI saw as well as the exit
 * code: a refused stop must have made no `update-service`, a forced or idle one must
 * have reached it, and the order is drain on, then the idle checks, then the scale-down.
 * The idle check's answer is scripted per poll (busy, busy, idle), so "waits then
 * proceeds" is a run that really polled three times.
 */

const STOP = 'infra/scripts/stop.sh';
const IDLE = 'infra/scripts/idle.sh';
const ACCOUNT = '111111111111';
const WORKER_DIGEST = `sha256:${'b'.repeat(64)}`;
const HOST = 'fss-pg.example.com';
const SECRET = (prefix: string): string => `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:${prefix}/app-runtime-database-bbbbbb`;

const IDLE_ANSWER = { idle: true, reasons: [], observedAt: '2026-09-30T12:00:00.000Z', details: {} };
const busy = (...reasons: string[]): Record<string, unknown> => ({ idle: false, reasons, observedAt: '2026-09-30T12:00:00.000Z', details: {} });

/**
 * The fake CLI. `run-task` records the command it was given (`task-N.cmd`); the log
 * stream of task N answers from that: an idle check takes the next line of
 * `idle-answers` (the last line repeats), a drain answers its own JSON.
 */
function stub(directory: string, prefix: string): string {
  const path = join(directory, 'aws');
  const cluster = `arn:aws:ecs:us-east-1:${ACCOUNT}:cluster/${prefix}-cluster`;
  const lines = [
    '#!/usr/bin/env bash',
    `state='${directory}'`,
    'printf "%s\\n" "$*" >> "$state/calls.log"',
    'service=$1; operation=$2; shift 2',
    'name=""; count=""; overrides=""; stream=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --service|--services) name=$2; shift ;;',
    '    --desired-count) count=$2; shift ;;',
    '    --overrides) overrides=$2; shift ;;',
    '    --log-stream-name) stream=$2; shift ;;',
    '  esac',
    '  shift',
    'done',
    'case "$service $operation" in',
    '  "ecs describe-services")',
    '    desired=$(cat "$state/$name.desired" 2>/dev/null || echo 0); running=$(cat "$state/$name.running" 2>/dev/null || echo 0)',
    '    printf \'{"services":[{"serviceName":"%s","status":"ACTIVE","desiredCount":%s,"runningCount":%s,"pendingCount":0,"deployments":[],"events":[]}],"failures":[]}\\n\' "$name" "$desired" "$running"',
    '    exit 0 ;;',
    '  "ecs update-service") echo "$count" > "$state/$name.desired"; echo "$count" > "$state/$name.running"; printf "%s\\t%s\\n" "$name" "$count"; exit 0 ;;',
    '  "ecs wait") exit 0 ;;',
    '  "ecs run-task")',
    '    n=$(( $(cat "$state/tasks" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$state/tasks"; printf "%s" "$overrides" > "$state/task-$n.cmd"',
    `    printf '{"tasks":[{"taskArn":"arn:aws:ecs:us-east-1:${ACCOUNT}:task/${prefix}-cluster/oneoff-%s"}],"failures":[]}\\n' "$n"`,
    '    exit 0 ;;',
    '  "ecs describe-tasks")',
    '    printf \'{"tasks":[{"lastStatus":"STOPPED","stopCode":"EssentialContainerExited","containers":[{"name":"operations","exitCode":0}]}],"failures":[]}\\n\'',
    '    exit 0 ;;',
    '  "logs get-log-events")',
    '    n=${stream##*oneoff-}; cmd=$(cat "$state/task-$n.cmd")',
    '    case "$cmd" in',
    '      *idle-check*)',
    '        k=$(( $(cat "$state/idle-polls" 2>/dev/null || echo 0) + 1 )); echo "$k" > "$state/idle-polls"',
    '        total=$(wc -l < "$state/idle-answers"); [ "$k" -le "$total" ] || k=$total',
    '        answer=$(sed -n "${k}p" "$state/idle-answers") ;;',
    '      *"\\"on\\""*) answer=\'{"drain":"on","minutes":20,"active":true}\' ;;',
    '      *"\\"off\\""*) answer=\'{"drain":"off","active":false}\' ;;',
    '      *) answer=\'{"ok":true}\' ;;',
    '    esac',
    '    python3 -c \'import json,sys; print(json.dumps({"events":[{"message": sys.argv[1]}]}))\' "$answer"',
    '    exit 0 ;;',
    'esac',
    'echo "unexpected: $service $operation" >&2',
    'exit 1',
    '',
  ];
  writeFileSync(path, lines.join('\n'));
  chmodSync(path, 0o755);
  return `${path}\n${cluster}`;
}

interface Run {
  readonly code: number;
  readonly output: string;
  readonly calls: readonly string[];
  readonly counts: Readonly<Record<'api' | 'worker', number>>;
  readonly report: (name: string) => string | null;
  readonly tasks: readonly string[];
}

interface Options {
  readonly production?: boolean;
  /** One JSON answer per idle poll; the last repeats. */
  readonly answers?: readonly Record<string, unknown>[] | readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly services?: Readonly<Record<'api' | 'worker', number>>;
  /** For idle.sh: the mode, then the root and prefix follow, then `tail`. */
  readonly args?: readonly string[];
  readonly tail?: readonly string[];
}

function run(script: string, options: Options = {}): Run {
  const production = options.production === true;
  const prefix = production ? 'fss-prod' : 'fss-rh-idle';
  const root = production ? 'infra/roots/production' : 'infra/roots/rehearsal';
  const directory = mkdtempSync(join(tmpdir(), 'fss-idle-'));
  const reports = mkdtempSync(join(tmpdir(), 'fss-idle-reports-'));
  const [aws, cluster] = stub(directory, prefix).split('\n') as [string, string];
  const services = options.services ?? { api: 2, worker: 1 };
  for (const [name, count] of Object.entries(services)) {
    writeFileSync(join(directory, `${prefix}-${name}.desired`), `${String(count)}\n`);
    writeFileSync(join(directory, `${prefix}-${name}.running`), `${String(count)}\n`);
  }
  const answers = (options.answers ?? [IDLE_ANSWER]).map(answer => (typeof answer === 'string' ? answer : JSON.stringify(answer)));
  writeFileSync(join(directory, 'idle-answers'), `${answers.join('\n')}\n`);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith('FSS_')) env[name] = value;
  }
  const fixtures: Record<string, string> = {
    AWS_REGION: 'us-east-1',
    FSS_REHEARSAL_REPORTS: reports,
    FSS_REHEARSAL_AWS_COMMAND: aws,
    RELEASE_LOG_POLL_SECONDS: '0',
    FSS_PROD_IDLE_POLL_SECONDS: '0',
    FSS_RELEASE_ACCOUNT: ACCOUNT,
    FSS_RELEASE_CALLER_ACCOUNT: ACCOUNT,
    FSS_RELEASE_CLUSTER_TAGS: JSON.stringify([{ key: 'Environment', value: production ? 'production' : 'rehearsal' }]),
    FSS_RELEASE_OUTPUT_CLUSTER_ARN: cluster,
    FSS_RELEASE_OUTPUT_MIGRATION_TASK_DEFINITION_ARN: `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/${prefix}-migration:1`,
    FSS_RELEASE_OUTPUT_OPERATIONS_TASK_DEFINITION_ARN: `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/${prefix}-operations:1`,
    FSS_RELEASE_OUTPUT_APP_RUNTIME_DATABASE_SECRET_ARN: SECRET(prefix),
    FSS_RELEASE_OUTPUT_WORKER_LOG_GROUP_NAME: `/fss/${prefix}/worker`,
    FSS_RELEASE_OUTPUT_TASK_NETWORK_CONFIGURATION: JSON.stringify({
      subnet_ids: ['subnet-0a'],
      security_group_id: 'sg-0a',
      assign_public_ip: 'ENABLED',
      database_port: 5432,
      database_host: HOST,
      inbound_rule_count: 0,
    }),
    FSS_RELEASE_OUTPUT_DEPLOYMENT_PLAN: JSON.stringify({
      bootstrap: false,
      api: { service_name: `${prefix}-api`, declared_desired_count: 2 },
      worker: { service_name: `${prefix}-worker`, declared_desired_count: 1 },
    }),
    FSS_RELEASE_TASK_DEFINITION: JSON.stringify({
      containerDefinitions: [
        {
          name: 'operations',
          image: `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/${prefix}-worker@${WORKER_DIGEST}`,
          environment: [{ name: 'FSS_DATABASE_HOST', value: HOST }],
          secrets: [{ name: 'DATABASE_SECRET_ARN', valueFrom: SECRET(prefix) }],
        },
      ],
    }),
  };
  const args =
    script === STOP
      ? [root, prefix, ...(production ? ['--environment', 'production'] : [])]
      : [...(options.args ?? []), root, prefix, ...(options.tail ?? [])];
  const result = spawnSync(repositoryPath(script), args, {
    encoding: 'utf8',
    env: { ...env, ...fixtures, ...options.env },
  });
  const read = (file: string): string | null => (existsSync(join(directory, file)) ? readFileSync(join(directory, file), 'utf8').trim() : null);
  const taskCount = Number(read('tasks') ?? '0');
  return {
    code: result.status ?? 1,
    output: `${result.stdout}${result.stderr}`,
    calls: (read('calls.log') ?? '').split('\n').filter(line => line !== ''),
    counts: { api: Number(read(`${prefix}-api.desired`) ?? 'NaN'), worker: Number(read(`${prefix}-worker.desired`) ?? 'NaN') },
    report: name => (existsSync(join(reports, name)) ? readFileSync(join(reports, name), 'utf8').trim() : null),
    tasks: Array.from({ length: taskCount }, (_, index) => {
      const cmd = read(`task-${String(index + 1)}.cmd`) ?? '';
      return cmd.includes('idle-check') ? 'idle-check' : cmd.includes('"on"') ? 'drain-on' : cmd.includes('"off"') ? 'drain-off' : 'other';
    }),
  };
}

const scaled = (calls: readonly string[]): readonly string[] => calls.filter(call => call.startsWith('ecs update-service'));

describe('stop.sh in production waits for idle before it stops anything', () => {
  it('turns the drain on, polls busy, busy, idle, and only then scales both services down', () => {
    const r = run(STOP, { production: true, answers: [busy('1 call is in progress; wait for it to end'), busy('1 call is in progress'), IDLE_ANSWER] });
    expect(r.code, r.output).toBe(0);
    expect(r.tasks).toEqual(['drain-on', 'idle-check', 'idle-check', 'idle-check']);
    expect(scaled(r.calls)).toHaveLength(2);
    expect(r.counts).toEqual({ api: 0, worker: 0 });
    // The order: every task (drain, then the three checks) before the first scale-down, and
    // the drain is not turned off by a stop that succeeded (deploy.sh does that after verify).
    const lastTask = r.calls.map(call => call.startsWith('ecs run-task')).lastIndexOf(true);
    const firstScale = r.calls.findIndex(call => call.startsWith('ecs update-service'));
    expect(lastTask).toBeLessThan(firstScale);
    expect(r.tasks).not.toContain('drain-off');
    expect(r.output).toContain('production is busy: 1 call is in progress');
    expect(r.report('release-stop.txt')).toContain('idle=idle');
    expect(r.report('release-idle.txt')).toMatch(/result=idle idle_wait_seconds=[0-9]+ polls=3 forced=0$/u);
    expect(r.report('release-stop-timing.txt')).toMatch(/idle=idle idle_wait_seconds=[0-9]+ stop_started_at=[0-9]+ stop_finished_at=[0-9]+$/u);
  });

  it('refuses after the wait with the reasons, changes nothing, and turns the drain off again', () => {
    const r = run(STOP, {
      production: true,
      answers: [busy('2 API commands were accepted in the last 5 minutes; someone is working')],
      env: { FSS_PROD_IDLE_WAIT_SECONDS: '0' },
    });
    expect(r.code).not.toBe(0);
    expect(r.output).toContain('production is not idle');
    expect(r.output).toContain('2 API commands were accepted in the last 5 minutes; someone is working');
    expect(scaled(r.calls), 'a refused stop scaled a service').toEqual([]);
    expect(r.counts).toEqual({ api: 2, worker: 1 });
    expect(r.tasks).toEqual(['drain-on', 'idle-check', 'drain-off']);
    expect(r.report('release-stop.txt')).toBeNull();
    expect(r.report('release-stop-instant.txt')).toBeNull();
    expect(r.report('release-idle.txt')).toContain('result=refused');
  });

  it('polls until the wait is spent, not once: a check that turns idle on the last allowed poll still stops', () => {
    // The positive control for the refusal above: with a real wait and an answer that
    // changes, the same run proceeds, so the refusal is the timeout and not a script that
    // refuses every busy answer at once.
    const r = run(STOP, { production: true, answers: [busy('a job'), busy('a job'), busy('a job'), busy('a job'), IDLE_ANSWER], env: { FSS_PROD_IDLE_WAIT_SECONDS: '600' } });
    expect(r.code, r.output).toBe(0);
    expect(r.tasks.filter(task => task === 'idle-check')).toHaveLength(5);
  });

  it('FSS_PROD_FORCE_IDLE=1 skips the wait, prints forced, and records it', () => {
    const r = run(STOP, { production: true, answers: [busy('1 call is in progress')], env: { FSS_PROD_FORCE_IDLE: '1' } });
    expect(r.code, r.output).toBe(0);
    expect(r.tasks, 'a forced stop still asked').not.toContain('idle-check');
    expect(r.output).toContain('FORCED');
    expect(scaled(r.calls)).toHaveLength(2);
    expect(r.report('release-stop.txt')).toContain('idle=forced');
    expect(r.report('release-idle.txt')).toContain('result=forced');
    expect(r.report('release-stop-timing.txt')).toContain('idle=forced');
  });

  it('refuses when the idle check cannot be read, rather than treating silence as idle', () => {
    const r = run(STOP, { production: true, answers: ['{"ok":true}'], env: { FSS_PROD_IDLE_WAIT_SECONDS: '0' } });
    expect(r.code).not.toBe(0);
    expect(r.output).toContain("has no idle true or false");
    expect(scaled(r.calls)).toEqual([]);
    expect(r.counts).toEqual({ api: 2, worker: 1 });
  });

  it('refuses an unreadable wait setting before any call', () => {
    const r = run(STOP, { production: true, env: { FSS_PROD_IDLE_WAIT_SECONDS: 'soon' } });
    expect(r.code).not.toBe(0);
    expect(r.output).toContain('FSS_PROD_IDLE_WAIT_SECONDS');
    expect(r.calls).toEqual([]);
  });
});

describe('stop.sh in a rehearsal runs the check and never waits longer than one poll', () => {
  it('checks at most twice when busy, refuses, uses no drain, and scales nothing', () => {
    // A one-second poll, so the one allowed pause is real: check, wait a poll, check, refuse.
    const r = run(STOP, { answers: [busy('1 running job cannot be interrupted safely')], env: { FSS_PROD_IDLE_POLL_SECONDS: '1' } });
    expect(r.code).not.toBe(0);
    // One check, or two if the first returned inside the poll: never more, never a drain.
    expect(r.tasks.length).toBeGreaterThanOrEqual(1);
    expect(r.tasks.length).toBeLessThanOrEqual(2);
    expect(r.tasks.every(task => task === 'idle-check')).toBe(true);
    expect(scaled(r.calls)).toEqual([]);
    expect(r.output).toContain('1 running job cannot be interrupted safely');
  });

  it('stops when the rehearsal is idle, having asked once', () => {
    const r = run(STOP, { answers: [IDLE_ANSWER] });
    expect(r.code, r.output).toBe(0);
    expect(r.tasks).toEqual(['idle-check']);
    expect(scaled(r.calls)).toHaveLength(2);
  });

  it('ignores FSS_PROD_FORCE_IDLE: a rehearsal has nothing to force past', () => {
    const r = run(STOP, { answers: [busy('busy')], env: { FSS_PROD_FORCE_IDLE: '1' } });
    expect(r.code).not.toBe(0);
    expect(scaled(r.calls)).toEqual([]);
  });
});

describe('stop.sh in a dry run', () => {
  it('prints the drain, the idle check and the scale-downs, and calls nothing', () => {
    const r = run(STOP, { production: true, env: { FSS_REHEARSAL_DRY_RUN: '1' } });
    expect(r.code, r.output).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.output).toContain('release-drain-on: fss admin release drain on');
    expect(r.output).toContain('release-idle-check-1: fss admin release idle-check');
    expect(r.output).toContain('PLAN read ');
    expect(r.output).toContain('--desired-count 0');
  });
});

describe('idle.sh on its own', () => {
  it('check exits 0 idle and 3 busy, printing the reasons', () => {
    expect(run(IDLE, { args: ['check'], answers: [IDLE_ANSWER] }).code).toBe(0);
    const busyRun = run(IDLE, { args: ['check'], answers: [busy('1 call is in progress')] });
    expect(busyRun.code).toBe(3);
    expect(busyRun.output).toContain('BUSY: 1 call is in progress');
  });

  it('drain-off is production only, and is one operations task that asks the command to turn it off', () => {
    const rehearsal = run(IDLE, { args: ['drain-off'] });
    expect(rehearsal.code).not.toBe(0);
    expect(rehearsal.output).toContain("production's");
    const r = run(IDLE, { production: true, args: ['drain-off'], tail: ['--environment', 'production'] });
    expect(r.code, r.output).toBe(0);
    expect(r.tasks).toEqual(['drain-off']);
  });

  it('drain-on passes --minutes through, and refuses a rehearsal', () => {
    const r = run(IDLE, { production: true, args: ['drain-on'], tail: ['--environment', 'production', '--minutes', '45'] });
    expect(r.code, r.output).toBe(0);
    expect(r.calls.find(call => call.startsWith('ecs run-task'))).toMatch(/"--minutes",\s*"45"/u);
    expect(run(IDLE, { args: ['drain-on'] }).code).not.toBe(0);
  });
});
