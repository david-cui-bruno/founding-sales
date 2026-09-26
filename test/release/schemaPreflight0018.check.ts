import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepositoryFile, repositoryPath } from './support/coverage.ts';

/**
 * Lane A4: `infra/scripts/schema-preflight-0018.sh`, migration 0018's counts read on the
 * operations task before a schema-18 release stops anything.
 *
 * Driven end to end against a stub AWS CLI (no cloud call), as `ciDeploy.check.ts`
 * drives the CI deploy: the stub holds the operations task definition as Terraform
 * registered it, registers what it is asked to, runs the task and answers its log
 * stream with what `fss admin schema-preflight 0018` prints.
 *
 * ## The vacuous-pass traps, named
 *
 * **A preflight on the previous image.** Before the apply the operations definition runs
 * the previous release's image, which has no such command, so a script that launched it
 * as registered would fail in production and pass here. The stub's definition names the
 * old digest, and the launch must be of a new revision whose only difference is the
 * digest — every other field, and the tags, compared whole.
 *
 * **A stray revision.** The family's newest ACTIVE revision is what the next plan reads,
 * so the revision is deregistered on the way out, and the case where the task fails
 * must deregister it too. A definition that already runs the digest registers nothing.
 */

const SCRIPT = 'infra/scripts/schema-preflight-0018.sh';
const ACCOUNT = '123456789012';
const PREFIX = 'fss-prod';
const REGISTRY = `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com`;
const CLUSTER = `arn:aws:ecs:us-east-1:${ACCOUNT}:cluster/${PREFIX}-cluster`;
const OPERATIONS = `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/${PREFIX}-operations:3`;
const RUNTIME_SECRET = `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:${PREFIX}/app-runtime-database-aaaaaa`;
const DATABASE_HOST = `${PREFIX}-database.example.invalid`;
const OLD = `sha256:${'a'.repeat(64)}`;
const NEW = `sha256:${'b'.repeat(64)}`;
const TAGS = [
  { key: 'Project', value: 'callie-fss' },
  { key: 'Environment', value: 'production' },
  { key: 'NamePrefix', value: PREFIX },
  { key: 'ManagedBy', value: 'terraform' },
];

function operationsDefinition(digest: string): Record<string, unknown> {
  return {
    taskDefinition: {
      taskDefinitionArn: OPERATIONS,
      family: `${PREFIX}-operations`,
      revision: 3,
      status: 'ACTIVE',
      taskRoleArn: `arn:aws:iam::${ACCOUNT}:role/${PREFIX}-worker-task`,
      executionRoleArn: `arn:aws:iam::${ACCOUNT}:role/${PREFIX}-worker-exec`,
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      cpu: '512',
      memory: '1024',
      runtimePlatform: { operatingSystemFamily: 'LINUX', cpuArchitecture: 'ARM64' },
      requiresAttributes: [{ name: 'com.amazonaws.ecs.capability.task-iam-role' }],
      compatibilities: ['EC2', 'FARGATE'],
      registeredAt: '2026-09-25T20:00:00Z',
      registeredBy: `arn:aws:sts::${ACCOUNT}:assumed-role/${PREFIX}-deploy/terraform`,
      containerDefinitions: [
        {
          name: 'operations',
          image: `${REGISTRY}/${PREFIX}-worker@${digest}`,
          essential: true,
          entryPoint: ['node', 'apps/worker/dist/tools/fss.js'],
          command: ['verify'],
          environment: [
            { name: 'FSS_ROLE', value: 'worker' },
            { name: 'FSS_DATABASE_HOST', value: DATABASE_HOST },
          ],
          secrets: [{ name: 'DATABASE_SECRET_ARN', valueFrom: RUNTIME_SECRET }],
          logConfiguration: {
            logDriver: 'awslogs',
            options: { 'awslogs-group': `/fss/${PREFIX}/worker`, 'awslogs-region': 'us-east-1', 'awslogs-stream-prefix': 'operations' },
          },
          stopTimeout: 120,
        },
      ],
    },
    tags: TAGS,
  };
}

const ANSWER = {
  applicable: true,
  schemaVersion: 17,
  migration: 18,
  refusesWithoutSetting: true,
  counts: {
    contactUrls: 4,
    contactUrlsThatDoNotFit: 0,
    stepMessages: 1,
    linkedInSteps: 1,
    recordedLinkedInResults: 0,
    linkedInExecutions: 1,
    unfinishedLinkedInExecutions: 1,
    linkedInGraceShifts: 0,
    enrollmentsEndedByLinkedInReply: 0,
    linkedInTodayItems: 0,
    todayCardsCountingLinkedIn: 0,
    holdsNamingLinkedIn: 7,
    holdsOnlyLinkedIn: 0,
    linkedInPauses: 0,
    versionsWithLinkedInReply: 3,
    publishedVersionsWithLinkedInReply: 2,
  },
};

/**
 * The AWS CLI, as far as the preflight and `release_run_task` call it. Registering adds
 * the family's next revision; the task exits `exitCode` and its log stream holds one
 * structured log line and the tool's answer.
 */
const AWS_STUB = String.raw`#!/usr/bin/env python3
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(here, "state.json")
state = json.load(open(path))
args = sys.argv[1:]

def value(flag):
    return args[args.index(flag) + 1] if flag in args else None

def save():
    json.dump(state, open(path, "w"))

def done(answer):
    print(json.dumps(answer))
    sys.exit(0)

entry = {"args": args}
if args[:2] == ["ecs", "register-task-definition"]:
    entry["input"] = json.load(open(value("--cli-input-json")[len("file://"):]))
state.setdefault("calls", []).append(entry)
save()

if args[:2] == ["ecs", "describe-task-definition"]:
    document = state["definitions"].get(value("--task-definition"))
    if document is None:
        sys.stderr.write("An error occurred (ClientException): Unable to describe task definition.\n")
        sys.exit(254)
    if value("--query") == "taskDefinition":
        done(document["taskDefinition"])
    answer = dict(document)
    if "--include" not in args:
        answer.pop("tags", None)
    done(answer)
if args[:2] == ["ecs", "register-task-definition"]:
    document = dict(entry["input"])
    tags = document.pop("tags", [])
    revision = max(d["taskDefinition"]["revision"] for d in state["definitions"].values()) + 1
    arn = "arn:aws:ecs:us-east-1:" + state["account"] + ":task-definition/" + document["family"] + ":" + str(revision)
    document.update(taskDefinitionArn=arn, revision=revision, status="ACTIVE")
    state["definitions"][arn] = {"taskDefinition": document, "tags": tags}
    save()
    done({"taskDefinition": document, "tags": tags})
if args[:2] == ["ecs", "deregister-task-definition"]:
    arn = value("--task-definition")
    if state.get("deregisterRefused"):
        sys.stderr.write("An error occurred (ThrottlingException) when calling the DeregisterTaskDefinition operation: Rate exceeded\n")
        sys.exit(254)
    state["definitions"][arn]["taskDefinition"]["status"] = "INACTIVE"
    save()
    done({"taskDefinition": state["definitions"][arn]["taskDefinition"]})
if args[:2] == ["ecs", "run-task"]:
    state["ran"] = {"taskDefinition": value("--task-definition"), "overrides": json.loads(value("--overrides"))}
    save()
    done({"tasks": [{"taskArn": "arn:aws:ecs:us-east-1:" + state["account"] + ":task/fss-prod-cluster/preflight-1", "lastStatus": "PROVISIONING"}], "failures": []})
if args[:2] == ["ecs", "describe-tasks"]:
    done({"tasks": [{"taskArn": "arn:aws:ecs:us-east-1:" + state["account"] + ":task/fss-prod-cluster/preflight-1",
                     "lastStatus": "STOPPED", "stopCode": "EssentialContainerExited",
                     "stoppedReason": "Essential container in task exited",
                     "containers": [{"name": "operations", "exitCode": state.get("exitCode", 0)}]}], "failures": []})
if args[:2] == ["logs", "get-log-events"]:
    lines = [json.dumps({"level": "info", "event": "fss_started", "component": "fss"})]
    if state.get("exitCode", 0) == 0:
        lines.append(json.dumps(state["answer"]))
    done({"events": [{"timestamp": 1, "message": line} for line in lines]})
if args[:2] == ["ecs", "stop-task"]:
    done({})
sys.stderr.write("the stub does not know " + " ".join(args) + "\n")
sys.exit(2)
`;

interface World {
  readonly directory: string;
  readonly reports: string;
  readonly state: () => Record<string, unknown>;
}

function world(options: { readonly registered?: string; readonly exitCode?: number; readonly deregisterRefused?: boolean } = {}): World {
  const directory = mkdtempSync(join(tmpdir(), 'fss-preflight-stub-'));
  const reports = mkdtempSync(join(tmpdir(), 'fss-preflight-reports-'));
  writeFileSync(join(directory, 'aws'), AWS_STUB);
  chmodSync(join(directory, 'aws'), 0o755);
  writeFileSync(
    join(directory, 'state.json'),
    JSON.stringify({
      account: ACCOUNT,
      definitions: { [OPERATIONS]: operationsDefinition(options.registered ?? OLD) },
      answer: ANSWER,
      exitCode: options.exitCode ?? 0,
      deregisterRefused: options.deregisterRefused ?? false,
    }),
  );
  return {
    directory,
    reports,
    state: () => JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')) as Record<string, unknown>,
  };
}

function environment(stub: World, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FSS_REHEARSAL_AWS_COMMAND: join(stub.directory, 'aws'),
    FSS_REHEARSAL_REPORTS: stub.reports,
    FSS_RELEASE_ACCOUNT: ACCOUNT,
    FSS_RELEASE_CALLER_ACCOUNT: ACCOUNT,
    FSS_RELEASE_CLUSTER_TAGS: JSON.stringify(TAGS),
    FSS_RELEASE_OUTPUT_CLUSTER_ARN: CLUSTER,
    FSS_RELEASE_OUTPUT_OPERATIONS_TASK_DEFINITION_ARN: OPERATIONS,
    FSS_RELEASE_OUTPUT_APP_RUNTIME_DATABASE_SECRET_ARN: RUNTIME_SECRET,
    FSS_RELEASE_OUTPUT_WORKER_LOG_GROUP_NAME: `/fss/${PREFIX}/worker`,
    FSS_RELEASE_OUTPUT_TASK_NETWORK_CONFIGURATION: JSON.stringify({
      subnet_ids: ['subnet-1111111111111111a', 'subnet-1111111111111111b'],
      security_group_id: 'sg-1111111111111111b',
      assign_public_ip: 'ENABLED',
      database_port: 5432,
      database_host: DATABASE_HOST,
      inbound_rule_count: 0,
    }),
    RELEASE_LOG_POLL_SECONDS: '0',
    AWS_REGION: 'us-east-1',
    ...extra,
  };
}

function runScript(args: readonly string[], env: NodeJS.ProcessEnv): { readonly code: number | null; readonly output: string } {
  const result = spawnSync(repositoryPath(SCRIPT), [...args], { encoding: 'utf8', env });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

interface Call {
  readonly args: readonly string[];
  readonly input?: Record<string, unknown>;
}

const callsOf = (state: Record<string, unknown>): readonly Call[] => (state['calls'] as Call[] | undefined) ?? [];
const verb = (call: Call): string => call.args.slice(0, 2).join(' ');

describe('A4: migration 0018’s preflight runs on the operations task before the stop', () => {
  it('registers the operations definition with this release’s image and nothing else changed, runs the preflight on it, prints the counts and deregisters it', () => {
    const stub = world();
    const run = runScript(['infra/roots/production', PREFIX, '--worker-digest', NEW], environment(stub));
    expect(run.code, run.output).toBe(0);
    const state = stub.state();
    const calls = callsOf(state);

    const registrations = calls.filter(call => verb(call) === 'ecs register-task-definition');
    expect(registrations).toHaveLength(1);
    const expected = JSON.parse(JSON.stringify(operationsDefinition(OLD))) as {
      taskDefinition: Record<string, unknown> & { containerDefinitions: Record<string, unknown>[] };
      tags: unknown;
    };
    const document = { ...expected.taskDefinition };
    for (const field of ['taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities', 'registeredAt', 'registeredBy']) {
      delete document[field];
    }
    document['containerDefinitions'] = [{ ...expected.taskDefinition.containerDefinitions[0], image: `${REGISTRY}/${PREFIX}-worker@${NEW}` }];
    expect(registrations[0]?.input).toEqual({ ...document, tags: TAGS });

    const revision = `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/${PREFIX}-operations:4`;
    const ran = state['ran'] as { taskDefinition: string; overrides: { containerOverrides: { name: string; command: string[] }[] } };
    expect(ran.taskDefinition).toBe(revision);
    expect(ran.overrides.containerOverrides).toEqual([
      { name: 'operations', command: ['admin', 'schema-preflight', '0018', '--report', '/tmp/fss-preflight-0018.json'] },
    ]);

    // Deregistered last, and only the revision this script registered.
    const deregistered = calls.filter(call => verb(call) === 'ecs deregister-task-definition');
    expect(deregistered.map(call => call.args[call.args.indexOf('--task-definition') + 1])).toEqual([revision]);
    expect(verb(calls.at(-1) as Call)).toBe('ecs deregister-task-definition');
    const definitions = state['definitions'] as Record<string, { taskDefinition: { status: string } }>;
    expect(definitions[OPERATIONS]?.taskDefinition.status).toBe('ACTIVE');
    expect(definitions[revision]?.taskDefinition.status).toBe('INACTIVE');

    // The answer, printed, and the summary the coordinator shows the owner.
    expect(JSON.parse(readFileSync(join(stub.reports, 'schema-preflight-0018.json'), 'utf8'))).toEqual(ANSWER);
    const summary = readFileSync(join(stub.reports, 'schema-preflight-0018.txt'), 'utf8');
    expect(summary).toContain('refuses_without_setting=true');
    expect(summary).toContain('step_messages=1');
    expect(summary).toContain('recorded_linkedin_results=0');
    expect(summary).toContain('contact_urls=4');
    expect(run.output).toContain('DECISION NEEDED');
  });

  it('launches the definition as registered when it already runs the digest, and registers nothing', () => {
    const stub = world({ registered: NEW });
    const run = runScript(['infra/roots/production', PREFIX, '--worker-digest', NEW], environment(stub));
    expect(run.code, run.output).toBe(0);
    const calls = callsOf(stub.state());
    expect(calls.filter(call => verb(call) === 'ecs register-task-definition')).toEqual([]);
    expect(calls.filter(call => verb(call) === 'ecs deregister-task-definition')).toEqual([]);
    expect((stub.state()['ran'] as { taskDefinition: string }).taskDefinition).toBe(OPERATIONS);
  });

  it('fails when the task fails, and still deregisters its revision', () => {
    const stub = world({ exitCode: 20 });
    const run = runScript(['infra/roots/production', PREFIX, '--worker-digest', NEW], environment(stub));
    expect(run.code, run.output).not.toBe(0);
    const calls = callsOf(stub.state());
    expect(calls.filter(call => verb(call) === 'ecs deregister-task-definition')).toHaveLength(1);
    expect(existsSync(join(stub.reports, 'schema-preflight-0018.txt'))).toBe(false);
  });

  it('fails when ECS refuses to deregister its revision after a successful count, and names the revision', () => {
    const stub = world({ deregisterRefused: true });
    const run = runScript(['infra/roots/production', PREFIX, '--worker-digest', NEW], environment(stub));
    expect(run.code, run.output).not.toBe(0);
    expect(run.output).toContain('FAIL: could not deregister');
    expect(run.output).toContain('aws ecs deregister-task-definition --task-definition arn:aws:ecs:');
    // The count itself succeeded: the answer was read before the cleanup failed.
    expect(run.output).toContain('refusesWithoutSetting');
    const definitions = stub.state()['definitions'] as Record<string, { taskDefinition: { status: string } }>;
    const active = Object.entries(definitions).filter(([arn, entry]) => arn !== OPERATIONS && entry.taskDefinition.status === 'ACTIVE');
    expect(active).toHaveLength(1);
  });

  it('plans the same three steps in a dry run, with no credential and no call', () => {
    const stub = world();
    const run = runScript(['infra/roots/production', PREFIX, '--worker-digest', NEW], environment(stub, { FSS_REHEARSAL_DRY_RUN: '1' }));
    expect(run.code, run.output).toBe(0);
    expect(run.output).toContain('aws ecs register-task-definition');
    expect(run.output).toContain('aws ecs deregister-task-definition');
    const launch = run.output.split('\n').find(line => line.includes('aws ecs run-task'));
    expect(launch).toContain(`${PREFIX}-operations`);
    expect(launch).toContain('"admin", "schema-preflight", "0018"');
    expect(callsOf(stub.state())).toEqual([]);
  });

  it('refuses a tag for a digest, a mismatched root, and an unknown flag, before any call', () => {
    for (const args of [
      ['infra/roots/production', PREFIX, '--worker-digest', 'latest'],
      ['infra/roots/rehearsal', PREFIX, '--worker-digest', NEW],
      ['infra/roots/production', PREFIX, '--worker-digest', NEW, '--nope', 'x'],
      ['infra/roots/production', PREFIX],
    ]) {
      const stub = world();
      const run = runScript(args, environment(stub));
      expect(run.code, args.join(' ')).not.toBe(0);
      expect(callsOf(stub.state()), args.join(' ')).toEqual([]);
    }
  });

  it('calls a command the tool has, as the runtime identity, and release-deploy passes the owner’s decision to migrate', async () => {
    const { drillInvocations, parseFssCommand } = await import('../../apps/worker/src/tools/fss/commands.ts');
    const { MIGRATION_IDENTITY_COMMANDS } = await import('../../apps/worker/src/tools/fss.ts');
    const invocations = drillInvocations(readRepositoryFile(SCRIPT));
    expect(invocations.length).toBeGreaterThanOrEqual(1);
    for (const invocation of invocations) expect(parseFssCommand(invocation.argv), invocation.text).toMatchObject({ ok: true });
    expect(MIGRATION_IDENTITY_COMMANDS).not.toContain('admin schema-preflight 0018');

    // `release-deploy.sh --remove-linkedin-history` reaches `fss migrate` and nothing else,
    // and means nothing without a schema change.
    const deploy = readRepositoryFile('infra/scripts/release-deploy.sh');
    expect(deploy).toContain('MIGRATE_SWITCHES+=(--remove-linkedin-history)');
    expect(deploy).toMatch(/one_off migrate "\$MIGRATION_TASK_DEFINITION" migration migrate --report \/tmp\/fss-migrate\.json \$\{MIGRATE_SWITCHES/u);
    expect(parseFssCommand(['migrate', '--report', '/tmp/fss-migrate.json', '--remove-linkedin-history'])).toMatchObject({ ok: true });
    const refused = spawnSync(
      repositoryPath('infra/scripts/release-deploy.sh'),
      ['infra/roots/production', PREFIX, '--api-digest', NEW, '--worker-digest', NEW, '--remove-linkedin-history'],
      { encoding: 'utf8', env: { ...process.env, FSS_REHEARSAL_DRY_RUN: '1' } },
    );
    expect(refused.status).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toContain('--remove-linkedin-history is an instruction to migration 0018');
  });
});
