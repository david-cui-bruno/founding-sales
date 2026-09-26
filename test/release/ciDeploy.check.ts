import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ciGateReleaseRecordSchema } from '@fss/contracts';
import { readRepositoryFile, repositoryPath } from './support/coverage.ts';

/**
 * Lane g91: an app-only merge to main is deployed to production by CI, and a schema,
 * infrastructure, release-script or workflow change is not (David, 25 September 2026:
 * "I'm a startup, I want to move fast"), as reworked after the review of PR 233.
 *
 * Three things are driven end to end rather than read: the workflow's inline
 * protected-path guard, in a real git history, against a stub AWS CLI that holds
 * production's images and their tags; `infra/scripts/ci-deploy-app.sh`, against the same
 * stub holding each service, each task definition and the rehearsal repositories; and
 * `infra/scripts/deployed-digests.sh`.
 *
 * ## The vacuous-pass traps, named
 *
 * **A path check over the wrong range.** The range starts at the commit production's
 * images were built from, not at the merge, and it is read commit by commit: a history
 * with an infrastructure commit between production and an app commit answers manual,
 * and so does one where a workflow was added and removed again, where an infrastructure
 * file was moved, and where a merge commit itself edited infrastructure. The same
 * history from one commit later answers pass, so "manual" cannot be the only answer.
 *
 * **Image code with a credential.** The jobs that run code from the images commit are
 * asserted to hold no `id-token` and no environment, and the credentialed job to run no
 * Node and nothing from the checkout before the guard.
 *
 * **A failed rollout that reads as a deploy, and a stray revision Terraform would
 * adopt.** The stub rolls a failing service back as the circuit breaker does; the deploy
 * must fail, never touch the API after a failed worker, and deregister the revision it
 * registered. A registration whose stored document differs in more than the image is
 * deregistered before any service names it.
 *
 * **An application log in the workflow log.** The stub's log lines carry a secret-shaped
 * field and a raw line; only `event`, `reason` and `code` may be printed.
 *
 * **A record put for a deployment that did not happen (lane g100).** `record` runs
 * against a stub production that already runs the new digests, with a stub `gh` for
 * `release-record-from-ci.sh`; the record the operations task was handed is decoded and
 * parsed with the contract the put applies. The same world before the deploy, a refused
 * `RunTask`, a put the tool refused and a gate that was not green each fail with no
 * record stored, so "the record step passes" cannot be the only answer. In the workflow
 * the record job needs the smoke, and fails red with one line when the put did not
 * happen.
 */

const SCRIPT = repositoryPath('infra/scripts/ci-deploy-app.sh');
const DEPLOYED = repositoryPath('infra/scripts/deployed-digests.sh');
const WORKFLOW = '.github/workflows/greenfield-deploy.yml';
const ACCOUNT = '123456789012';
const REGISTRY = `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com`;
const CLUSTER = `arn:aws:ecs:us-east-1:${ACCOUNT}:cluster/fss-prod-cluster`;
const IDENTITY = `arn:aws:sts::${ACCOUNT}:assumed-role/fss-prod-ci-deploy/fss-prod-ci-deploy-1`;
const COMMIT = '1234567890abcdef1234567890abcdef12345678';
const RUN_ID = '4242';
const SECRET_SHAPED = 'sk-live-not-a-real-secret-0000';

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const OLD = { api: digest('a'), worker: digest('b') } as const;
const NEW = { api: digest('c'), worker: digest('d') } as const;
type Service = 'api' | 'worker';
const RUNTIME_SECRET = `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:fss-prod/app-runtime-database-aaaaaa`;
const DATABASE_HOST = 'fss-prod-database.example.invalid';

function definitionArn(service: Service, revision: number): string {
  return `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/fss-prod-${service}:${String(revision)}`;
}

const OPERATIONS_REVISION = `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/fss-prod-operations:3`;

const TAGS = [
  { key: 'Project', value: 'callie-fss' },
  { key: 'Environment', value: 'production' },
  { key: 'NamePrefix', value: 'fss-prod' },
  { key: 'ManagedBy', value: 'terraform' },
];

/** A running task definition, with the read-only fields ECS returns. */
function runningDefinition(service: Service, revision: number, image: string, schema = 16): Record<string, unknown> {
  return {
    taskDefinition: {
      taskDefinitionArn: definitionArn(service, revision),
      family: `fss-prod-${service}`,
      revision,
      status: 'ACTIVE',
      taskRoleArn: `arn:aws:iam::${ACCOUNT}:role/fss-prod-${service}-task`,
      executionRoleArn: `arn:aws:iam::${ACCOUNT}:role/fss-prod-${service}-exec`,
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      cpu: '512',
      memory: '1024',
      runtimePlatform: { operatingSystemFamily: 'LINUX', cpuArchitecture: 'ARM64' },
      requiresAttributes: [{ name: 'com.amazonaws.ecs.capability.task-iam-role' }],
      compatibilities: ['EC2', 'FARGATE'],
      registeredAt: '2026-09-25T20:00:00Z',
      registeredBy: `arn:aws:sts::${ACCOUNT}:assumed-role/fss-prod-deploy/fss-prod-terraform`,
      volumes: [],
      placementConstraints: [],
      containerDefinitions: [
        {
          name: service,
          image: `${REGISTRY}/fss-prod-${service}@${image}`,
          essential: true,
          cpu: 0,
          environment: [
            { name: 'FSS_ROLE', value: service },
            { name: 'FSS_SCHEMA_MIN', value: String(schema) },
            { name: 'FSS_SCHEMA_MAX', value: String(schema) },
            { name: 'FSS_SENDING_ENABLED', value: 'false' },
            { name: 'FSS_DATABASE_HOST', value: DATABASE_HOST },
          ],
          secrets: [{ name: 'DATABASE_SECRET_ARN', valueFrom: RUNTIME_SECRET }],
          logConfiguration: {
            logDriver: 'awslogs',
            options: { 'awslogs-group': `/fss/fss-prod/${service}`, 'awslogs-region': 'us-east-1', 'awslogs-stream-prefix': service },
          },
          mountPoints: [],
          volumesFrom: [],
        },
      ],
    },
    tags: TAGS,
  };
}

interface OperationsOptions {
  readonly image?: string;
  readonly taskRole?: string;
  readonly streamPrefix?: string;
}

/**
 * The operations definition as Terraform registers it (`infra/modules/cluster`): the
 * worker image of the last apply, the worker's two roles, the worker's log group under
 * the prefix `operations`. It does not track, so after a CI deploy its image is older
 * than the worker's.
 */
function operationsDefinition(options: OperationsOptions = {}): Record<string, unknown> {
  return {
    taskDefinition: {
      taskDefinitionArn: OPERATIONS_REVISION,
      family: 'fss-prod-operations',
      revision: 3,
      status: 'ACTIVE',
      taskRoleArn: options.taskRole ?? `arn:aws:iam::${ACCOUNT}:role/fss-prod-worker-task`,
      executionRoleArn: `arn:aws:iam::${ACCOUNT}:role/fss-prod-worker-exec`,
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      containerDefinitions: [
        {
          name: 'operations',
          image: options.image ?? `${REGISTRY}/fss-prod-worker@${OLD.worker}`,
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
            options: {
              'awslogs-group': '/fss/fss-prod/worker',
              'awslogs-region': 'us-east-1',
              'awslogs-stream-prefix': options.streamPrefix ?? 'operations',
            },
          },
        },
      ],
    },
    tags: [...TAGS, { key: 'Name', value: 'fss-prod-operations' }],
  };
}

/**
 * The AWS CLI, as far as the guard, the deploy and `deployed-digests.sh` call it.
 * Registering adds the family's next revision — with an extra environment variable when
 * `tamper` is set, as something between the request and the store might — and
 * `update-service` points the service at it unless the service is marked `fail`, when it
 * stays where it was: the circuit breaker's rollback.
 */
const AWS_STUB = String.raw`#!/usr/bin/env python3
import base64, json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(here, "state.json")
state = json.load(open(path))
args = sys.argv[1:]
entry = {"args": args}

def value(flag):
    return args[args.index(flag) + 1] if flag in args else None

def save():
    json.dump(state, open(path, "w"))

def done(answer):
    print(answer if isinstance(answer, str) else json.dumps(answer))
    sys.exit(0)

def family_of(arn):
    return arn.rsplit("/", 1)[1].split(":")[0]

if args[:2] == ["ecs", "register-task-definition"]:
    entry["input"] = json.load(open(value("--cli-input-json")[len("file://"):]))
with open(os.path.join(here, "calls.jsonl"), "a") as handle:
    handle.write(json.dumps(entry) + "\n")

account = state["account"]
if args[:2] == ["sts", "get-caller-identity"]:
    done(state["identity"] if value("--query") == "Arn" else account)
if args[:2] == ["ecs", "describe-clusters"]:
    done(state["clusterTags"])
if args[:2] == ["ecs", "describe-services"]:
    name = value("--services")
    service = state["services"].get(name)
    if service is None:
        done({"services": [], "failures": [{"arn": name, "reason": "MISSING"}]})
    deployments = [{"status": "PRIMARY", "taskDefinition": service["taskDefinition"], "rolloutState": "COMPLETED"}]
    if service.get("rolling"):
        deployments.append({"status": "ACTIVE", "taskDefinition": "older", "rolloutState": "IN_PROGRESS"})
    done({"services": [{"serviceName": name, "status": "ACTIVE", "desiredCount": service["desired"],
                        "runningCount": service.get("running", service["desired"]),
                        "pendingCount": service.get("pending", 0),
                        "taskDefinition": service["taskDefinition"], "deployments": deployments}]})
if args[:2] == ["ecs", "describe-task-definition"]:
    wanted = value("--task-definition")
    definitions = {arn: d for arn, d in state["taskDefinitions"].items() if d["taskDefinition"].get("status") == "ACTIVE" or arn == wanted}
    if wanted not in definitions:
        family = [arn for arn in definitions if family_of(arn) == wanted]
        if not family:
            sys.stderr.write("An error occurred (ClientException): Unable to describe task definition.\n")
            sys.exit(254)
        wanted = max(family, key=lambda arn: int(arn.rsplit(":", 1)[1]))
    answer = dict(definitions[wanted])
    if "--include" not in args:
        answer.pop("tags", None)
    if value("--query") == "taskDefinition":
        done(answer["taskDefinition"])
    done(answer)
if args[:2] == ["ecr", "describe-images"]:
    repository = state["images"].get(value("--repository-name"), {})
    kind, _, wanted = value("--image-ids").partition("=")
    for image_digest, tags in repository.items():
        if (kind == "imageDigest" and image_digest == wanted) or (kind == "imageTag" and wanted in tags):
            done({"imageDetails": [{"imageDigest": image_digest, "imageTags": tags}]})
    sys.stderr.write("An error occurred (ImageNotFoundException) when calling the DescribeImages operation\n")
    sys.exit(254)
if args[:2] == ["ecs", "register-task-definition"]:
    document = json.loads(json.dumps(entry["input"]))
    tags = document.pop("tags", [])
    family = document["family"]
    revision = max(int(arn.rsplit(":", 1)[1]) for arn in state["taskDefinitions"] if family_of(arn) == family) + 1
    arn = "arn:aws:ecs:us-east-1:" + account + ":task-definition/" + family + ":" + str(revision)
    if state.get("tamper"):
        document["containerDefinitions"][0]["environment"].append({"name": "INJECTED", "value": "1"})
    document.update(taskDefinitionArn=arn, revision=revision, status="ACTIVE")
    state["taskDefinitions"][arn] = {"taskDefinition": document, "tags": tags}
    save()
    done({"taskDefinition": document, "tags": tags})
if args[:2] == ["ecs", "deregister-task-definition"]:
    arn = value("--task-definition")
    state["taskDefinitions"][arn]["taskDefinition"]["status"] = "INACTIVE"
    save()
    done({"taskDefinition": state["taskDefinitions"][arn]["taskDefinition"]})
if args[:2] == ["ecs", "update-service"]:
    name = value("--service")
    service = state["services"][name]
    wanted = value("--task-definition")
    if service.get("fail"):
        service["refused"] = wanted
    else:
        service["taskDefinition"] = wanted
    save()
    done({"service": {"serviceName": name, "taskDefinition": service["taskDefinition"]}})
if args[:2] == ["ecs", "wait"]:
    sys.exit(0)
if args[:2] == ["ecs", "run-task"]:
    # The release record's put (lane g100). A refusal is the CLI's, as IAM answers it.
    if state.get("runTaskRefused"):
        sys.stderr.write("An error occurred (AccessDeniedException) when calling the RunTask operation: not authorized to perform: ecs:RunTask\n")
        sys.exit(254)
    state["ranTask"] = json.loads(value("--overrides"))
    save()
    done({"tasks": [{"taskArn": "arn:aws:ecs:us-east-1:" + account + ":task/fss-prod-cluster/ops-1", "lastStatus": "PROVISIONING"}],
          "failures": []})
if args[:2] == ["ecs", "list-tasks"]:
    name = value("--service-name")
    service = state["services"][name]
    prefix = "arn:aws:ecs:us-east-1:" + account + ":task/fss-prod-cluster/"
    if value("--desired-status") == "STOPPED":
        done({"taskArns": [prefix + name + "-refused"] if service.get("refused") else []})
    done({"taskArns": [prefix + name + "-" + str(index) for index in range(service["desired"])]})
if args[:2] == ["ecs", "describe-tasks"]:
    arns = args[args.index("--tasks") + 1:]
    arns = arns[:next((i for i, a in enumerate(arns) if a.startswith("--")), len(arns))]
    tasks = []
    for arn in arns:
        task_id = arn.rsplit("/", 1)[1]
        if task_id.startswith("ops-"):
            tasks.append({"taskArn": arn, "lastStatus": "STOPPED", "stopCode": "EssentialContainerExited",
                          "stoppedReason": "Essential container in task exited",
                          "containers": [{"name": "operations", "exitCode": 1 if state.get("putRefusal") else 0}]})
            continue
        name = task_id.rsplit("-", 1)[0]
        service = state["services"][name]
        container = name.rsplit("-", 1)[1]
        if task_id.endswith("-refused"):
            tasks.append({"taskArn": arn, "lastStatus": "STOPPED", "taskDefinitionArn": service["refused"],
                          "stopCode": "EssentialContainerExited", "stoppedReason": "Essential container in task exited",
                          "containers": [{"name": container, "exitCode": 12}]})
            continue
        image = state["taskDefinitions"][service["taskDefinition"]]["taskDefinition"]["containerDefinitions"][0]["image"]
        tasks.append({"taskArn": arn, "lastStatus": "RUNNING", "taskDefinitionArn": service["taskDefinition"],
                      "containers": [{"name": container, "image": image, "imageDigest": image.rsplit("@", 1)[1]}]})
    done({"tasks": tasks, "failures": []})
if args[:2] == ["logs", "get-log-events"] and value("--log-stream-name").startswith("operations/operations/"):
    # What fss admin release-record put prints: a structured log line, then its answer.
    command = state["ranTask"]["containerOverrides"][0]["command"]
    record = json.loads(base64.b64decode(command[command.index("--json-base64") + 1]))
    if state.get("putRefusal"):
        answer = {"ok": False, "reason": "release_record_conflict",
                  "detail": "a different record is already stored under " + record["releaseGateReference"]}
    else:
        answer = {"outcome": state.get("putOutcome", "created"), "reference": record["releaseGateReference"],
                  "source": record.get("source", "rehearsal"), "suite": record["suite"],
                  "apiDigest": record["artifacts"]["api"], "workerDigest": state.get("storedWorker", record["artifacts"]["worker"]),
                  "enablesSending": record["enablesSending"]}
    done({"events": [
        {"message": json.dumps({"level": "info", "event": "release_record_put", "reference": record["releaseGateReference"]})},
        {"message": json.dumps(answer)},
    ]})
if args[:2] == ["logs", "get-log-events"]:
    done({"events": [
        {"message": json.dumps({"level": "error", "event": "startup_refused", "code": "SCHEMA_RANGE", "detail": state["secret"]})},
        {"message": "raw line holding " + state["secret"]},
    ]})
sys.stderr.write("the aws stub does not know: " + " ".join(args) + "\n")
sys.exit(2)
`;

interface StubCall {
  readonly args: readonly string[];
  readonly input?: Record<string, unknown>;
}

interface StubService {
  taskDefinition: string;
  refused?: string;
}

interface World {
  readonly home: string;
  calls(): readonly StubCall[];
  state(): {
    services: Record<string, StubService>;
    taskDefinitions: Record<string, { taskDefinition: { status: string } }>;
    ranTask?: { containerOverrides: { name: string; command: string[] }[] };
  };
}

interface Counts {
  readonly desired?: number;
  readonly running?: number;
  readonly pending?: number;
}

interface WorldOptions {
  readonly identity?: string;
  readonly counts?: Partial<Record<Service, Counts>>;
  readonly fail?: Partial<Record<Service, boolean>>;
  readonly rolling?: Service;
  readonly schema?: number;
  readonly clusterEnvironment?: string;
  readonly tamper?: boolean;
  /** The tags production's running images carry in fss-prod-*. */
  readonly productionTags?: Partial<Record<Service, readonly string[]>>;
  /** The digest fss-rh-<image>:ci-<COMMIT> names; the new digest by default. */
  readonly sourceDigest?: Partial<Record<Service, string>>;
  /** A revision in the family newer than the running one (a rollout nobody cleaned up). */
  readonly newerRevision?: Service;
  /** The digests the services run; the old ones by default, the new ones after a deploy. */
  readonly running?: Readonly<Record<Service, string>>;
  /** The operations definition, for the release record's put (lane g100). */
  readonly operations?: OperationsOptions;
  readonly runTaskRefused?: boolean;
  readonly putRefusal?: boolean;
  /** A put whose stored record names another worker than the one put. */
  readonly storedWorker?: string;
  readonly putOutcome?: 'created' | 'existing';
}

function world(options: WorldOptions = {}): World {
  const home = mkdtempSync(join(tmpdir(), 'fss-ci-deploy-stub-'));
  const running = options.running ?? OLD;
  const taskDefinitions: Record<string, unknown> = {
    [definitionArn('api', 7)]: runningDefinition('api', 7, running.api, options.schema),
    [definitionArn('worker', 4)]: runningDefinition('worker', 4, running.worker, options.schema),
    [OPERATIONS_REVISION]: operationsDefinition(options.operations),
  };
  if (options.newerRevision !== undefined) {
    const service = options.newerRevision;
    const revision = service === 'api' ? 8 : 5;
    taskDefinitions[definitionArn(service, revision)] = runningDefinition(service, revision, digest('e'), options.schema);
  }
  const service = (name: Service, revision: number): Record<string, unknown> => ({
    taskDefinition: definitionArn(name, revision),
    desired: options.counts?.[name]?.desired ?? (name === 'api' ? 2 : 1),
    running: options.counts?.[name]?.running ?? options.counts?.[name]?.desired ?? (name === 'api' ? 2 : 1),
    pending: options.counts?.[name]?.pending ?? 0,
    fail: options.fail?.[name] ?? false,
    rolling: options.rolling === name,
  });
  const state = {
    account: ACCOUNT,
    identity: options.identity ?? IDENTITY,
    secret: SECRET_SHAPED,
    tamper: options.tamper ?? false,
    runTaskRefused: options.runTaskRefused ?? false,
    putRefusal: options.putRefusal ?? false,
    ...(options.storedWorker === undefined ? {} : { storedWorker: options.storedWorker }),
    ...(options.putOutcome === undefined ? {} : { putOutcome: options.putOutcome }),
    clusterTags: [{ key: 'Environment', value: options.clusterEnvironment ?? 'production' }],
    services: { 'fss-prod-api': service('api', 7), 'fss-prod-worker': service('worker', 4) },
    taskDefinitions,
    images: {
      'fss-prod-api': { [OLD.api]: options.productionTags?.api ?? [] },
      'fss-prod-worker': { [OLD.worker]: options.productionTags?.worker ?? [] },
      'fss-rh-api': { [options.sourceDigest?.api ?? NEW.api]: [`ci-${COMMIT}`] },
      'fss-rh-worker': { [options.sourceDigest?.worker ?? NEW.worker]: [`ci-${COMMIT}`] },
    },
  };
  writeFileSync(join(home, 'state.json'), JSON.stringify(state));
  const command = join(home, 'aws');
  writeFileSync(command, AWS_STUB);
  chmodSync(command, 0o755);
  return {
    home,
    calls: () =>
      existsSync(join(home, 'calls.jsonl'))
        ? readFileSync(join(home, 'calls.jsonl'), 'utf8')
            .split('\n')
            .filter(line => line !== '')
            .map(line => JSON.parse(line) as StubCall)
        : [],
    state: () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')) as ReturnType<World['state']>,
  };
}

const writes = (stub: World): readonly string[] =>
  stub
    .calls()
    .map(call => call.args.slice(0, 2).join(' '))
    .filter(operation =>
      ['ecs register-task-definition', 'ecs deregister-task-definition', 'ecs update-service', 'ecr put-image'].includes(operation),
    );

const HEALTH = (databaseVersion = 16, declared = 16): string =>
  JSON.stringify({
    status: 'serving',
    component: 'api',
    schema: { declaredRange: { minimum: declared, maximum: declared }, databaseVersion, accepted: true, reason: null },
    systemGeneration: 1,
    sendingEnabled: false,
  });

function digestsFile(
  overrides: {
    readonly commit?: string;
    readonly images?: Readonly<Record<Service, string>>;
    readonly runId?: string;
    readonly attempt?: string;
  } = {},
): string {
  const commit = overrides.commit ?? COMMIT;
  const images = overrides.images ?? NEW;
  const file = join(mkdtempSync(join(tmpdir(), 'fss-ci-digests-')), 'image-digests.json');
  writeFileSync(
    file,
    JSON.stringify({
      schema: 'fss.image-digests.v1',
      commit,
      workflowRunId: overrides.runId ?? RUN_ID,
      workflowRunAttempt: overrides.attempt ?? '1',
      images: {
        api: { repository: 'fss-rh-api', tag: `ci-${commit}`, digest: images.api },
        worker: { repository: 'fss-rh-worker', tag: `ci-${commit}`, digest: images.worker },
      },
    }),
  );
  return file;
}

interface Run {
  readonly code: number;
  readonly output: string;
  readonly outputs: Readonly<Record<string, string>>;
}

function readOutputs(file: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) parsed[line.slice(0, at)] = line.slice(at + 1);
  }
  return parsed;
}

function runScript(
  subcommand: 'check' | 'deploy',
  stub: World,
  extra: {
    readonly ranges?: readonly [string, string];
    readonly health?: string;
    readonly digests?: string;
    readonly identity?: string;
    readonly region?: string;
  } = {},
): Run {
  const outputs = join(mkdtempSync(join(tmpdir(), 'fss-ci-outputs-')), 'github-output');
  writeFileSync(outputs, '');
  const [apiRange, workerRange] = extra.ranges ?? ['16-16', '16-16'];
  const args = [
    subcommand,
    '--digests',
    extra.digests ?? digestsFile(),
    '--commit',
    COMMIT,
    '--run-id',
    RUN_ID,
    '--run-attempt',
    '1',
    '--api-range',
    apiRange,
    '--worker-range',
    workerRange,
  ];
  if (subcommand === 'check') args.push('--origin', 'https://api.example.invalid');
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    FSS_REHEARSAL_AWS_COMMAND: join(stub.home, 'aws'),
    FSS_CI_CALLER_IDENTITY: extra.identity ?? IDENTITY,
    FSS_CI_HEALTH_JSON: extra.health ?? HEALTH(),
    FSS_PRODUCTION_ACCOUNT_ID: ACCOUNT,
    GITHUB_OUTPUT: outputs,
    AWS_REGION: extra.region ?? 'us-east-1',
  };
  delete env['FSS_REHEARSAL_DRY_RUN'];
  delete env['FSS_PRODUCTION_REGION'];
  const result = spawnSync(SCRIPT, args, { encoding: 'utf8', env });
  return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}`, outputs: readOutputs(outputs) };
}

describe('check decides, and writes nothing', () => {
  it('deploys when production runs at its counts on the schema the images declare', () => {
    const stub = world();
    const run = runScript('check', stub);
    expect(run.code, run.output).toBe(0);
    expect(run.outputs['decision']).toBe('deploy');
    expect(run.output).toContain(`fss-rh-api and fss-rh-worker hold ci-${COMMIT} as the two digests the artifact names`);
    expect(run.output).toContain('the running API declares 16-16 and the database is at 16');
    expect(writes(stub)).toEqual([]);
  });

  it('leaves a service that is not running at its declared count to the operator', () => {
    for (const [counts, expected] of [
      [
        { worker: { desired: 1, running: 0 } },
        'fss-prod-worker runs 0 of 1 task(s) with 0 pending, which is an outage or an unfinished rollout',
      ],
      [{ api: { desired: 2, running: 2, pending: 1 } }, 'fss-prod-api runs 2 of 2 task(s) with 1 pending'],
      [{ api: { desired: 0 }, worker: { desired: 0 } }, 'fss-prod-api is at desired count zero, which is a schema release in progress'],
    ] as const) {
      const stub = world({ counts });
      const run = runScript('check', stub);
      expect(run.code, run.output).toBe(0);
      expect(run.outputs['decision'], JSON.stringify(counts)).toBe('manual');
      expect(run.outputs['reason']).toContain(expected);
      expect(writes(stub)).toEqual([]);
    }
  });

  it('refuses images that declare a schema range production does not run', () => {
    const run = runScript('check', world(), { ranges: ['17-17', '16-16'] });
    expect(run.outputs['decision'], run.output).toBe('manual');
    expect(run.outputs['reason']).toContain('images declare schema api 17-17 and worker 16-16');
    expect(run.outputs['reason']).toContain('is a schema change');
  });

  it('refuses when the database is at a version the images do not accept, from /health', () => {
    const run = runScript('check', world(), { health: HEALTH(17) });
    expect(run.outputs['decision'], run.output).toBe('manual');
    expect(run.outputs['reason']).toContain('the database is at schema 17');
  });

  it('fails, rather than deploys, when /health is unreadable or its API disagrees with its task definition', () => {
    const broken = runScript('check', world(), { health: '<html>502</html>' });
    expect(broken.code).toBe(1);
    expect(broken.outputs['decision']).toBeUndefined();
    const disagreeing = runScript('check', world(), { health: HEALTH(16, 15) });
    expect(disagreeing.code).toBe(1);
    expect(disagreeing.output).toContain('the running API declares schema 15-15 and its task definition 16-16');
  });

  it('answers current when production already runs these digests', () => {
    const stub = world({ sourceDigest: OLD });
    const run = runScript('check', stub, { digests: digestsFile({ images: OLD }) });
    expect(run.outputs['decision'], run.output).toBe('current');
  });

  it('acts as the CI role in the production account and region, or not at all', () => {
    for (const identity of [
      `arn:aws:sts::${ACCOUNT}:assumed-role/fss-prod-deploy/someone`,
      `arn:aws:iam::${ACCOUNT}:user/fss-prod-ci-deploy`,
      'arn:aws:sts::999999999999:assumed-role/fss-prod-ci-deploy/fss-prod-ci-deploy-1',
      `arn:aws:sts::${ACCOUNT}:assumed-role/fss-prod-ci-deploy-extra/session`,
    ]) {
      const stub = world();
      const run = runScript('check', stub, { identity });
      expect(run.code, identity).toBe(1);
      expect(run.output).toContain(`not an assumed-role session of arn:aws:iam::${ACCOUNT}:role/fss-prod-ci-deploy`);
      expect(stub.calls().filter(call => call.args[0] !== 'sts')).toEqual([]);
    }
    const elsewhere = runScript('check', world(), { region: 'us-west-2' });
    expect(elsewhere.code).toBe(1);
    expect(elsewhere.output).toContain('the session is configured for us-west-2, and production is in us-east-1');
    const mislabelled = runScript('check', world({ clusterEnvironment: 'rehearsal' }));
    expect(mislabelled.code).toBe(1);
    expect(mislabelled.output).toContain('the cluster is tagged Environment=rehearsal');
  });

  it('refuses a digests file that is not the images run’s, and a digest the rehearsal tag does not name', () => {
    const otherRun = runScript('check', world(), { digests: digestsFile({ runId: '4243' }) });
    expect(otherRun.code).toBe(1);
    expect(otherRun.output).toContain('the digests file was written by run 4243, and the images run is 4242');
    const otherAttempt = runScript('check', world(), { digests: digestsFile({ attempt: '2' }) });
    expect(otherAttempt.code).toBe(1);
    expect(otherAttempt.output).toContain('attempt 2 of the images run, and its latest attempt is 1');
    const otherCommit = runScript('check', world(), { digests: digestsFile({ commit: 'f'.repeat(40) }) });
    expect(otherCommit.code).toBe(1);
    const stub = world({ sourceDigest: { worker: digest('9') } });
    const swapped = runScript('check', stub);
    expect(swapped.code).toBe(1);
    expect(swapped.output).toContain(`fss-rh-worker:ci-${COMMIT} is ${digest('9')}, and the digests file says ${NEW.worker}`);
    expect(writes(stub)).toEqual([]);
  });

  it('refuses a rollout already under way', () => {
    const rolling = runScript('check', world({ rolling: 'worker' }));
    expect(rolling.code).toBe(1);
    expect(rolling.output).toContain('a rollout is under way');
  });
});

describe('deploy registers the next revisions, rolls the worker then the API, and holds each to its digest', () => {
  const operations = (stub: World): readonly string[] =>
    stub
      .calls()
      .map(call => {
        const service = call.args[call.args.indexOf('--service') + 1] ?? '';
        if (call.args[1] === 'register-task-definition') return `register ${String(call.input?.['family'])}`;
        if (call.args[1] === 'deregister-task-definition')
          return `deregister ${call.args[call.args.indexOf('--task-definition') + 1] ?? ''}`;
        if (call.args[1] === 'update-service') return `update ${service}`;
        return '';
      })
      .filter(line => line !== '');

  it('changes only the image in each registered document, and deploys the worker first', () => {
    const stub = world();
    const run = runScript('deploy', stub);
    expect(run.code, run.output).toBe(0);
    expect(operations(stub)).toEqual([
      'register fss-prod-worker',
      'update fss-prod-worker',
      'register fss-prod-api',
      'update fss-prod-api',
    ]);
    expect(run.outputs).toMatchObject({
      previous_worker_task_definition: definitionArn('worker', 4),
      worker_task_definition: definitionArn('worker', 5),
      previous_api_task_definition: definitionArn('api', 7),
      api_task_definition: definitionArn('api', 8),
      expect_sending: 'disabled',
    });
    for (const service of ['worker', 'api'] as const) {
      const registered = stub
        .calls()
        .find(call => call.args[1] === 'register-task-definition' && call.input?.['family'] === `fss-prod-${service}`);
      const running = runningDefinition(service, service === 'api' ? 7 : 4, OLD[service]) as {
        taskDefinition: Record<string, unknown> & { containerDefinitions: Record<string, unknown>[] };
      };
      const expected: Record<string, unknown> = { ...running.taskDefinition, tags: TAGS };
      for (const field of [
        'taskDefinitionArn',
        'revision',
        'status',
        'requiresAttributes',
        'compatibilities',
        'registeredAt',
        'registeredBy',
      ]) {
        delete expected[field];
      }
      expected['containerDefinitions'] = [
        { ...running.taskDefinition.containerDefinitions[0], image: `${REGISTRY}/fss-prod-${service}@${NEW[service]}` },
      ];
      expect(registered?.input, service).toEqual(expected);
    }
    const updates = stub.calls().filter(call => call.args[1] === 'update-service');
    expect(
      updates.map(call => [call.args[call.args.indexOf('--service') + 1], call.args[call.args.indexOf('--task-definition') + 1]]),
    ).toEqual([
      ['fss-prod-worker', definitionArn('worker', 5)],
      ['fss-prod-api', definitionArn('api', 8)],
    ]);
    // Only the task definition, against the cluster's full ARN: never a count, never a forced deployment.
    expect(updates.some(call => call.args.includes('--desired-count') || call.args.includes('--force-new-deployment'))).toBe(false);
    expect(updates.every(call => call.args[call.args.indexOf('--cluster') + 1] === CLUSTER)).toBe(true);
  });

  it('deregisters a registration that differs from the running revision in more than the image, and rolls nothing', () => {
    const stub = world({ tamper: true });
    const run = runScript('deploy', stub);
    expect(run.code).toBe(1);
    expect(operations(stub)).toEqual(['register fss-prod-worker', `deregister ${definitionArn('worker', 5)}`]);
    expect(run.output).toContain(
      'the revision ECS registered for fss-prod-worker differs from the running one: field containerDefinitions',
    );
    expect(stub.state().taskDefinitions[definitionArn('worker', 5)]?.taskDefinition.status).toBe('INACTIVE');
  });

  it('stops at a worker the circuit breaker rolled back, deregisters its revision, and never touches the API', () => {
    const stub = world({ fail: { worker: true } });
    const run = runScript('deploy', stub);
    expect(run.code).toBe(1);
    expect(operations(stub)).toEqual(['register fss-prod-worker', 'update fss-prod-worker', `deregister ${definitionArn('worker', 5)}`]);
    expect(run.output).toContain(`fss-prod-worker was rolled back by ECS to ${definitionArn('worker', 4)} and does not run ${NEW.worker}`);
    expect(run.outputs['observed_worker_task_definition']).toBe(definitionArn('worker', 4));
    // Why it stopped, and nothing from the log but its event, reason and code.
    expect(run.output).toContain('stopped task fss-prod-worker-refused: EssentialContainerExited');
    expect(run.output).toContain('container worker exit 12');
    expect(run.output).toContain('| event=startup_refused code=SCHEMA_RANGE');
    expect(run.output).not.toContain(SECRET_SHAPED);
    expect(run.output).not.toContain('raw line holding');
    expect(stub.state().services['fss-prod-api']?.taskDefinition).toBe(definitionArn('api', 7));
    expect(stub.state().taskDefinitions[definitionArn('worker', 5)]?.taskDefinition.status).toBe('INACTIVE');
  });

  it('fails on an API that was rolled back, with the worker already on its new revision', () => {
    const stub = world({ fail: { api: true } });
    const run = runScript('deploy', stub);
    expect(run.code).toBe(1);
    expect(run.output).toContain(`fss-prod-api was rolled back by ECS to ${definitionArn('api', 7)}`);
    expect(stub.state().services['fss-prod-worker']?.taskDefinition).toBe(definitionArn('worker', 5));
    expect(stub.state().services['fss-prod-api']?.taskDefinition).toBe(definitionArn('api', 7));
    expect(stub.state().taskDefinitions[definitionArn('api', 8)]?.taskDefinition.status).toBe('INACTIVE');
  });

  it('writes nothing to a production that is not at its counts, runs another schema, or already runs these images', () => {
    for (const [options, extra] of [
      [{ counts: { worker: { desired: 1, running: 0 } } }, {}],
      [{ counts: { worker: { desired: 0 } } }, {}],
      [{}, { ranges: ['16-16', '17-17'] as const }],
      [{ sourceDigest: { api: digest('9') } }, {}],
    ] as const) {
      const stub = world(options);
      const run = runScript('deploy', stub, extra);
      expect(run.code, JSON.stringify(options)).toBe(1);
      expect(writes(stub)).toEqual([]);
    }
    const current = world({ sourceDigest: OLD });
    const run = runScript('deploy', current, { digests: digestsFile({ images: OLD }) });
    expect(run.code, run.output).toBe(0);
    expect(writes(current)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// record: the release record for the deployed digests, after the smoke (lane g100).
// ---------------------------------------------------------------------------

const GATE_RUN = '4100';
const GH_REPOSITORY = 'example-owner/example-repo';
const SUBNETS = 'subnet-0a1b2c3d4e5f60718,subnet-0f1e2d3c4b5a69788';
const SECURITY_GROUP = 'sg-0123456789abcdef0';
const REFERENCE = `ci-gate-${GATE_RUN}-${COMMIT.slice(0, 12)}`;

/** `gh`, as far as `release-record-from-ci.sh` asks it: the gate run, the images runs, the artifact. */
const GH_STUB = String.raw`#!/usr/bin/env python3
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
state = json.load(open(os.path.join(here, "gh-state.json")))
args = sys.argv[1:]
with open(os.path.join(here, "gh-calls.jsonl"), "a") as handle:
    handle.write(json.dumps(args) + "\n")
def value(flag):
    return args[args.index(flag) + 1] if flag in args else None
if args[:2] == ["run", "view"]:
    run = state["runs"].get(args[2])
    if run is None:
        sys.stderr.write("could not find any workflow run with ID " + args[2] + "\n")
        sys.exit(1)
    print(json.dumps(run))
    sys.exit(0)
if args[:2] == ["run", "list"]:
    print(json.dumps([run for run in state["imagesRuns"] if run["headSha"] == value("--commit")]))
    sys.exit(0)
if args[:2] == ["run", "download"]:
    directory = value("--dir")
    os.makedirs(directory, exist_ok=True)
    open(os.path.join(directory, "image-digests.json"), "w").write(state["downloads"][args[2]])
    sys.exit(0)
sys.stderr.write("the gh stub does not know: " + " ".join(args) + "\n")
sys.exit(2)
`;

function ghWorld(stub: World, gateConclusion = 'success'): string {
  const runPage = (id: string): string => `https://github.com/${GH_REPOSITORY}/actions/runs/${id}`;
  writeFileSync(
    join(stub.home, 'gh-state.json'),
    JSON.stringify({
      runs: {
        [GATE_RUN]: {
          databaseId: Number(GATE_RUN),
          workflowName: 'Greenfield gate',
          status: 'completed',
          conclusion: gateConclusion,
          headSha: COMMIT,
          headBranch: 'main',
          event: 'push',
          url: runPage(GATE_RUN),
          updatedAt: '2026-09-25T22:10:00Z',
        },
      },
      imagesRuns: [
        {
          databaseId: Number(RUN_ID),
          workflowName: 'Greenfield images',
          status: 'completed',
          conclusion: 'success',
          headSha: COMMIT,
          headBranch: 'main',
          event: 'push',
          url: runPage(RUN_ID),
          createdAt: '2026-09-25T22:00:00Z',
        },
      ],
      downloads: { [RUN_ID]: readFileSync(digestsFile(), 'utf8') },
    }),
  );
  const command = join(stub.home, 'gh');
  writeFileSync(command, GH_STUB);
  chmodSync(command, 0o755);
  return command;
}

const ghCalls = (stub: World): readonly string[][] =>
  existsSync(join(stub.home, 'gh-calls.jsonl'))
    ? readFileSync(join(stub.home, 'gh-calls.jsonl'), 'utf8')
        .split('\n')
        .filter(line => line !== '')
        .map(line => JSON.parse(line) as string[])
    : [];

const runTasks = (stub: World): readonly StubCall[] => stub.calls().filter(call => call.args[1] === 'run-task');

function runRecord(
  stub: World,
  extra: {
    readonly gateConclusion?: string;
    readonly clusterName?: string;
    readonly family?: string;
    readonly subnets?: string;
    readonly securityGroup?: string;
  } = {},
): Run {
  const outputs = join(mkdtempSync(join(tmpdir(), 'fss-ci-outputs-')), 'github-output');
  writeFileSync(outputs, '');
  const args = [
    'record',
    '--digests',
    digestsFile(),
    '--commit',
    COMMIT,
    '--run-id',
    RUN_ID,
    '--run-attempt',
    '1',
    '--api-range',
    '16-16',
    '--worker-range',
    '16-16',
    '--gate-run-id',
    GATE_RUN,
    '--cluster-name',
    extra.clusterName ?? 'fss-prod-cluster',
    '--operations-family',
    extra.family ?? 'fss-prod-operations',
    '--subnets',
    extra.subnets ?? SUBNETS,
    '--security-group',
    extra.securityGroup ?? SECURITY_GROUP,
  ];
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    FSS_REHEARSAL_AWS_COMMAND: join(stub.home, 'aws'),
    FSS_GH_COMMAND: ghWorld(stub, extra.gateConclusion),
    FSS_CI_CALLER_IDENTITY: IDENTITY,
    FSS_PRODUCTION_ACCOUNT_ID: ACCOUNT,
    GITHUB_OUTPUT: outputs,
    GITHUB_REPOSITORY: GH_REPOSITORY,
    AWS_REGION: 'us-east-1',
    RELEASE_LOG_POLL_SECONDS: '0',
  };
  for (const name of [
    'FSS_REHEARSAL_DRY_RUN',
    'FSS_PRODUCTION_REGION',
    'FSS_REHEARSAL_REPORTS',
    'FSS_RELEASE_TASK_DEFINITION',
    'FSS_RELEASE_DESCRIBE_TASKS',
    'FSS_RELEASE_LOG_EVENTS',
    'FSS_RELEASE_CALLER_ACCOUNT',
    'FSS_RELEASE_CLUSTER_TAGS',
    'FSS_RELEASE_RUN_ID',
  ]) {
    delete env[name];
  }
  const result = spawnSync(SCRIPT, args, { encoding: 'utf8', env });
  return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}`, outputs: readOutputs(outputs) };
}

describe('record puts the ci-gate release record for the deployed digests, on the operations task', () => {
  it('builds the record from the green gate run and puts it the way release-deploy.sh does', () => {
    const stub = world({ running: NEW });
    const run = runRecord(stub);
    expect(run.code, run.output).toBe(0);
    expect(run.outputs).toMatchObject({ release_record_reference: REFERENCE, release_record_outcome: 'created' });

    // One task: the operations family's revision, in the production cluster, on the
    // network the repository variables name, carrying its definition's tags.
    const tasks = runTasks(stub);
    expect(tasks).toHaveLength(1);
    const task = tasks[0]?.args ?? [];
    const flag = (name: string): string => task[task.indexOf(name) + 1] ?? '';
    expect(flag('--cluster')).toBe(CLUSTER);
    expect(flag('--task-definition')).toBe(OPERATIONS_REVISION);
    expect(flag('--launch-type')).toBe('FARGATE');
    expect(flag('--propagate-tags')).toBe('TASK_DEFINITION');
    expect(JSON.parse(flag('--network-configuration'))).toEqual({
      awsvpcConfiguration: { subnets: SUBNETS.split(','), securityGroups: [SECURITY_GROUP], assignPublicIp: 'ENABLED' },
    });

    // The one command, and a record the put's own contract accepts: this deploy's digests.
    const command = stub.state().ranTask?.containerOverrides[0]?.command ?? [];
    expect(command.slice(0, 4)).toEqual(['admin', 'release-record', 'put', '--json-base64']);
    expect(command.slice(5)).toEqual(['--report', '/tmp/fss-release-record.json']);
    const record = ciGateReleaseRecordSchema.parse(JSON.parse(Buffer.from(command[4] ?? '', 'base64').toString('utf8')));
    expect(record).toMatchObject({
      source: 'ci-gate',
      releaseGateReference: REFERENCE,
      commit: COMMIT,
      gateRunId: GATE_RUN,
      imagesRunId: RUN_ID,
      artifacts: { api: NEW.api, worker: NEW.worker, desktopCommitStamp: COMMIT },
      enablesSending: false,
    });
    // It writes nothing else: no registration, no service touched.
    expect(writes(stub)).toEqual([]);
  });

  it('answers existing for a record already stored, which a re-run puts again', () => {
    const run = runRecord(world({ running: NEW, putOutcome: 'existing' }));
    expect(run.code, run.output).toBe(0);
    expect(run.outputs['release_record_outcome']).toBe('existing');
  });

  it('fails, with nothing put, when production does not run the deployed digests', () => {
    const stub = world();
    const run = runRecord(stub);
    expect(run.code).toBe(1);
    expect(run.output).toContain('A release record is put only for a deployment that runs its digests');
    expect(runTasks(stub)).toEqual([]);
    expect(ghCalls(stub)).toEqual([]);
  });

  it('fails when the put is refused: RunTask denied, or the tool refusing the record', () => {
    const denied = world({ running: NEW, runTaskRefused: true });
    const refusedTask = runRecord(denied);
    expect(refusedTask.code).toBe(1);
    expect(refusedTask.output).toContain(`FAIL: the operations task did not put the release record ${REFERENCE}`);
    expect(refusedTask.outputs['release_record_reference']).toBeUndefined();

    const conflicting = world({ running: NEW, putRefusal: true });
    const refusedPut = runRecord(conflicting);
    expect(refusedPut.code).toBe(1);
    expect(refusedPut.output).toContain('FAIL: release-record-put exited 1');
    expect(refusedPut.output).toContain(`FAIL: the operations task did not put the release record ${REFERENCE}`);
    expect(refusedPut.outputs['release_record_reference']).toBeUndefined();

    const different = runRecord(world({ running: NEW, storedWorker: digest('e') }));
    expect(different.code).toBe(1);
    expect(different.output).toContain('the stored record differs from the one put in workerDigest');
  });

  it('fails before any task when the gate run was not green', () => {
    const stub = world({ running: NEW });
    const run = runRecord(stub, { gateConclusion: 'failure' });
    expect(run.code).toBe(1);
    expect(run.output).toContain(`FAIL: gate run ${GATE_RUN} is completed/failure, not completed/success`);
    expect(runTasks(stub)).toEqual([]);
  });

  it('refuses an operations definition that is not the worker image under the worker’s roles and log group', () => {
    for (const [operations, expected] of [
      [{ image: `${REGISTRY}/fss-prod-api@${OLD.api}` }, `which is not ${REGISTRY}/fss-prod-worker by digest`],
      [{ image: `${REGISTRY}/fss-prod-worker:latest` }, `which is not ${REGISTRY}/fss-prod-worker by digest`],
      [{ taskRole: `arn:aws:iam::${ACCOUNT}:role/fss-prod-migration-task` }, 'the put may pass only the worker’s roles'.replace('’', "'")],
      [{ streamPrefix: 'worker' }, "not to the worker's group under 'operations'"],
    ] as const) {
      const stub = world({ running: NEW, operations });
      const run = runRecord(stub);
      expect(run.code, JSON.stringify(operations)).toBe(1);
      expect(run.output).toContain(expected);
      expect(runTasks(stub)).toEqual([]);
    }
  });

  it('judges the five identifiers before anything is asked, and holds the cluster variable to the one it acts on', () => {
    for (const [extra, expected] of [
      [{ subnets: '' }, 'FSS_PRODUCTION_TASK_SUBNET_IDS'],
      [{ subnets: 'subnet-1; rm -rf /' }, 'FSS_PRODUCTION_TASK_SUBNET_IDS'],
      [{ securityGroup: 'sg-bad' }, 'FSS_PRODUCTION_TASK_SECURITY_GROUP_ID'],
      [{ family: 'fss-rh-operations' }, 'FSS_PRODUCTION_OPERATIONS_TASK_FAMILY'],
      [{ clusterName: '' }, 'FSS_PRODUCTION_CLUSTER_NAME'],
    ] as const) {
      const stub = world({ running: NEW });
      const run = runRecord(stub, extra);
      expect(run.code, JSON.stringify(extra)).toBe(1);
      expect(run.output).toContain(expected);
      expect(stub.calls()).toEqual([]);
    }
    const elsewhere = world({ running: NEW });
    const run = runRecord(elsewhere, { clusterName: 'fss-prod-other' });
    expect(run.code).toBe(1);
    expect(run.output).toContain('FSS_PRODUCTION_CLUSTER_NAME names fss-prod-other, and this deploy acts on fss-prod-cluster');
    expect(runTasks(elsewhere)).toEqual([]);
  });

  it('runs the operations task as Terraform declares it: the worker image, roles and log group', () => {
    const cluster = readRepositoryFile('infra/modules/cluster/main.tf');
    const start = cluster.indexOf('resource "aws_ecs_task_definition" "operations" {');
    const block = cluster.slice(start, cluster.indexOf('\n}\n', start));
    expect(block).toContain('execution_role_arn       = aws_iam_role.worker_execution.arn');
    expect(block).toContain('task_role_arn            = aws_iam_role.worker_task.arn');
    expect(block).toContain('image      = var.worker_image');
    expect(block).toContain('"awslogs-group"         = var.worker_log_group_name');
    expect(block).toContain('"awslogs-stream-prefix" = "operations"');
  });
});

// ---------------------------------------------------------------------------
// The workflow's protected-path guard, extracted and run in a real git history.
// ---------------------------------------------------------------------------

/** A job's steps, each from its `- name:` or `- uses:` line to the next. */
function steps(workflow: string): readonly { readonly name: string; readonly text: string }[] {
  const lines = workflow.split('\n');
  const starts = lines.flatMap((line, index) => (/^ {6}- (name|uses):/u.test(line) ? [index] : []));
  return starts.map((start, position) => {
    const text = lines.slice(start, starts[position + 1] ?? lines.length).join('\n');
    const name = /^ {6}- name: (.*)$/mu.exec(text)?.[1] ?? /^ {6}- uses: (.*)$/mu.exec(text)?.[1] ?? '';
    return { name, text };
  });
}

/** The `run: |` body of a step, unindented, up to the first line indented less than it. */
function runBody(step: string): string {
  const at = step.indexOf('run: |');
  if (at < 0) throw new Error('the step has no run block');
  const lines = step
    .slice(at + 'run: |'.length)
    .split('\n')
    .slice(1);
  const end = lines.findIndex(line => line.trim() !== '' && !line.startsWith(' '.repeat(10)));
  return ['', ...(end < 0 ? lines : lines.slice(0, end))].map(line => line.slice(10)).join('\n');
}

/** A job, by its two-space header, until the next job. */
function job(workflow: string, name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`no job ${name}`);
  const next = workflow.slice(start + 1).search(/\n {2}[a-z-]+:\n/u);
  return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

const DEPLOY_WORKFLOW = readRepositoryFile(WORKFLOW);
const GUARD = runBody(steps(DEPLOY_WORKFLOW).find(step => step.name === "Protected paths in any commit since production's")?.text ?? '');

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
}

function commitFiles(directory: string, message: string, files: readonly string[], removals: readonly string[] = []): string {
  for (const file of files) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), `${message}\n`);
  }
  for (const file of removals) rmSync(join(directory, file));
  git(directory, 'add', '-A');
  git(directory, 'commit', '-q', '-m', message);
  return git(directory, 'rev-parse', 'HEAD');
}

/**
 * main: c0; c1 application code; c2 infrastructure; c3 application code; r1 adds a
 * workflow and r2 removes it; c4 application code; n1 moves an infrastructure file under
 * apps/; mg merges an app-only branch and edits infrastructure in the merge itself; m1 a
 * migration. x1 is on another branch, off c1.
 */
const HISTORY = (() => {
  const directory = mkdtempSync(join(tmpdir(), 'fss-ci-deploy-history-'));
  git(directory, 'init', '-q', '-b', 'main');
  git(directory, 'config', 'user.email', 'ci@example.invalid');
  git(directory, 'config', 'user.name', 'CI');
  git(directory, 'config', 'commit.gpgsign', 'false');
  const c0 = commitFiles(directory, 'c0', ['apps/api/src/a.ts', 'README.md', 'infra/modules/alerts/main.tf']);
  const c1 = commitFiles(directory, 'c1', [
    'apps/api/src/b.ts',
    'packages/domain/today/x.ts',
    'docs/greenfield/x.md',
    'test/release/x.check.ts',
    'scripts/releaseMutationCheck.mjs',
    'package-lock.json',
    'Dockerfile.api',
  ]);
  const c2 = commitFiles(directory, 'c2', ['infra/modules/cluster/main.tf']);
  const c3 = commitFiles(directory, 'c3', ['apps/worker/src/c.ts']);
  commitFiles(directory, 'r1', ['.github/workflows/extra.yml']);
  const r2 = commitFiles(directory, 'r2', [], ['.github/workflows/extra.yml']);
  const c4 = commitFiles(directory, 'c4', ['apps/api/src/f.ts']);
  git(directory, 'mv', 'infra/modules/alerts/main.tf', 'apps/api/src/moved.ts');
  git(directory, 'commit', '-q', '-m', 'n1');
  const n1 = git(directory, 'rev-parse', 'HEAD');
  git(directory, 'checkout', '-q', '-b', 'feature');
  commitFiles(directory, 'b1', ['apps/api/src/g.ts']);
  git(directory, 'checkout', '-q', 'main');
  git(directory, 'merge', '-q', '--no-ff', '--no-commit', 'feature');
  mkdirSync(join(directory, 'infra/scripts'), { recursive: true });
  writeFileSync(join(directory, 'infra/scripts/release-deploy.sh'), 'edited in the merge\n');
  git(directory, 'add', '-A');
  git(directory, 'commit', '-q', '-m', 'mg');
  const mg = git(directory, 'rev-parse', 'HEAD');
  const m1 = commitFiles(directory, 'm1', ['packages/domain/db/migrations/0018_x.sql', 'apps/api/src/d.ts']);
  git(directory, 'checkout', '-q', '-b', 'elsewhere', c1);
  const x1 = commitFiles(directory, 'x1', ['apps/api/src/e.ts']);
  git(directory, 'checkout', '-q', 'main');
  return { directory, c0, c1, c2, c3, r2, c4, n1, mg, m1, x1 };
})();

function guard(stub: World, commit: string, directory = HISTORY.directory): Run {
  const temp = mkdtempSync(join(tmpdir(), 'fss-guard-'));
  const outputs = join(temp, 'github-output');
  const summary = join(temp, 'summary');
  writeFileSync(outputs, '');
  writeFileSync(summary, '');
  const result = spawnSync('bash', ['-c', GUARD], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${stub.home}:${process.env['PATH'] ?? ''}`,
      COMMIT: commit,
      AWS_REGION: 'us-east-1',
      GITHUB_OUTPUT: outputs,
      GITHUB_STEP_SUMMARY: summary,
      RUNNER_TEMP: temp,
    },
  });
  return {
    code: result.status ?? 1,
    output: `${result.stdout}${result.stderr}${readFileSync(summary, 'utf8')}`,
    outputs: readOutputs(outputs),
  };
}

const at = (commit: string): WorldOptions => ({ productionTags: { api: [`ci-${commit}`], worker: [`ci-${commit}`] } });

describe('the protected-path guard reads every commit since production’s, before any repository code runs', () => {
  it('passes a range of application code, reading production’s commit from its images’ tags', () => {
    const run = guard(world(at(HISTORY.c0)), HISTORY.c1);
    expect(run.code, run.output).toBe(0);
    expect(run.outputs['decision']).toBe('pass');
    expect(run.output).toContain(`production's api image was built from ${HISTORY.c0}`);
  });

  it('refuses a range with an infrastructure commit in it, although the last merge was application code', () => {
    const run = guard(world(at(HISTORY.c0)), HISTORY.c3);
    expect(run.code, run.output).toBe(0);
    expect(run.outputs['decision']).toBe('manual');
    expect(run.outputs['reason']).toContain('infra/modules/cluster/main.tf (infrastructure');
    expect(run.outputs['reason']).toContain('Release this one by hand');
    expect(run.output).toContain('### Paths that keep this release on the manual path');
  });

  it('passes the next app commit once production runs images built past the change', () => {
    const run = guard(world(at(HISTORY.c2)), HISTORY.c3);
    expect(run.outputs['decision'], run.output).toBe('pass');
  });

  it('sees a workflow that was added and removed again, which a net diff misses', () => {
    expect(git(HISTORY.directory, 'diff', '--name-only', HISTORY.c3, HISTORY.c4)).toBe('apps/api/src/f.ts');
    const run = guard(world(at(HISTORY.c3)), HISTORY.c4);
    expect(run.outputs['decision'], run.output).toBe('manual');
    expect(run.outputs['reason']).toContain('.github/workflows/extra.yml (a workflow)');
  });

  it('sees both paths of a moved infrastructure file', () => {
    const run = guard(world(at(HISTORY.c4)), HISTORY.n1);
    expect(run.outputs['decision'], run.output).toBe('manual');
    expect(run.outputs['reason']).toContain('infra/modules/alerts/main.tf (infrastructure');
  });

  it('sees an infrastructure edit made in a merge commit itself', () => {
    const run = guard(world(at(HISTORY.n1)), HISTORY.mg);
    expect(run.outputs['decision'], run.output).toBe('manual');
    expect(run.outputs['reason']).toContain('infra/scripts/release-deploy.sh');
  });

  it('refuses a migration', () => {
    const run = guard(world(at(HISTORY.mg)), HISTORY.m1);
    expect(run.outputs['decision'], run.output).toBe('manual');
    expect(run.outputs['reason']).toContain('packages/domain/db/migrations/0018_x.sql (a migration');
  });

  it('refuses when it cannot tell which commit production runs, or that commit is not behind the images', () => {
    const untagged = guard(world({ productionTags: { api: ['latest'], worker: [`ci-${HISTORY.c0}`] } }), HISTORY.c1);
    expect(untagged.outputs['decision'], untagged.output).toBe('manual');
    expect(untagged.outputs['reason']).toContain('carries no ci-<commit> or commit tag');
    const ahead = guard(world(at(HISTORY.c3)), HISTORY.c1);
    expect(ahead.outputs['decision'], ahead.output).toBe('manual');
    expect(ahead.outputs['reason']).toContain('would not move production forward');
    const sideways = guard(world(at(HISTORY.x1)), HISTORY.c3);
    expect(sideways.outputs['decision'], sideways.output).toBe('manual');
  });

  it('reads the -image tag a wrapping copy leaves and an operator push’s bare commit, and every service’s range', () => {
    const forms = guard(
      world({ productionTags: { api: [`ci-${HISTORY.c2}`, 'latest'], worker: [HISTORY.c2, `ci-${HISTORY.c2}-image`] } }),
      HISTORY.c3,
    );
    expect(forms.outputs['decision'], forms.output).toBe('pass');
    // The worker built at c0 and the API at c2: the worker's range holds c2's infrastructure.
    const split = guard(world({ productionTags: { api: [`ci-${HISTORY.c2}`], worker: [`ci-${HISTORY.c0}`] } }), HISTORY.c3);
    expect(split.outputs['decision'], split.output).toBe('manual');
  });

  it('classifies application code as app-only and everything else as manual, one path at a time', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fss-guard-paths-'));
    git(directory, 'init', '-q', '-b', 'main');
    git(directory, 'config', 'user.email', 'ci@example.invalid');
    git(directory, 'config', 'user.name', 'CI');
    git(directory, 'config', 'commit.gpgsign', 'false');
    const base = commitFiles(directory, 'base', ['README.md']);
    const app = commitFiles(directory, 'app', [
      'apps/desktop/src/renderer/home.tsx',
      'packages/domain/db/schemaRange.ts',
      'scripts/lintTracked.mjs',
      'tests/e2e/x.spec.ts',
      'package.json',
      'Dockerfile.worker.dockerignore',
      'certs/rds-global-bundle.pem',
      'tsconfig.base.json',
      'eslint.greenfield.mjs',
    ]);
    const passed = guard(world(at(base)), app, directory);
    expect(passed.outputs['decision'], passed.output).toBe('pass');
    for (const path of [
      'infra/scripts/ci-deploy-app.sh',
      'infra/policies/deployment-role-policy.json.tftpl',
      'packages/domain/db/migrations/0019_calls.sql',
      'scripts/productionSmoke.mjs',
      'scripts/releaseArtifact.mjs',
      '.github/workflows/ci.yml',
      'cloud/terraform/main.tf',
      'src/main/index.ts',
    ]) {
      git(directory, 'checkout', '-q', '-B', 'probe', app);
      const probe = commitFiles(directory, path, [path]);
      const run = guard(world(at(app)), probe, directory);
      expect(run.outputs['decision'], path).toBe('manual');
      expect(run.outputs['reason'], path).toContain(`${path} (`);
    }
  });
});

describe('deployed-digests.sh prints what an operator plan must be given, and refuses what would roll production back', () => {
  const deployed = (stub: World, ...args: string[]): { readonly code: number; readonly stdout: string; readonly stderr: string } => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      FSS_REHEARSAL_AWS_COMMAND: join(stub.home, 'aws'),
      AWS_REGION: 'us-east-1',
    };
    delete env['FSS_RELEASE_ACCOUNT'];
    delete env['FSS_REHEARSAL_DRY_RUN'];
    const result = spawnSync(DEPLOYED, ['fss-prod', ...args], { encoding: 'utf8', env });
    return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  };
  const apiImage = `${REGISTRY}/fss-prod-api@${OLD.api}`;
  const workerImage = `${REGISTRY}/fss-prod-worker@${OLD.worker}`;

  it('prints the running images and ranges, as values and as -var flags', () => {
    const values = deployed(world());
    expect(values.code, values.stderr).toBe(0);
    expect(values.stdout).toBe(
      [
        `api_image=${apiImage}`,
        `worker_image=${workerImage}`,
        'api_schema_range={min=16,max=16}',
        'worker_schema_range={min=16,max=16}',
        '',
      ].join('\n'),
    );
    const flags = deployed(world(), '--var-flags');
    expect(flags.stdout.split('\n')[0]).toBe(`-var=api_image=${apiImage}`);
  });

  it('refuses mid-rollout, and refuses a family whose newest revision is not the one that runs', () => {
    const rolling = deployed(world({ rolling: 'api' }));
    expect(rolling.code).toBe(1);
    expect(rolling.stderr).toContain('a rollout is under way');
    const ahead = deployed(world({ newerRevision: 'worker' }));
    expect(ahead.code).toBe(1);
    expect(ahead.stdout).toBe('');
    expect(ahead.stderr).toContain(`its family's newest ACTIVE revision is ${definitionArn('worker', 5)}`);
    expect(ahead.stderr).toContain(`aws ecs deregister-task-definition --task-definition ${definitionArn('worker', 5)}`);
  });

  it('compares a saved plan’s images with the running ones before an apply, unless the release changes them on purpose', () => {
    expect(deployed(world(), '--compare', apiImage, workerImage).code).toBe(0);
    const stale = deployed(world(), '--compare', `${REGISTRY}/fss-prod-api@${digest('9')}`, workerImage);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("the plan's images are not the ones production runs: api");
    const release = deployed(world(), '--compare', `${REGISTRY}/fss-prod-api@${digest('9')}`, workerImage, '--allow-digest-change');
    expect(release.code, release.stderr).toBe(0);
    expect(deployed(world(), '--allow-digest-change').code).toBe(2);
  });
});

describe('the deploy workflow', () => {
  const workflow = DEPLOY_WORKFLOW;
  const jobSteps = steps(workflow);
  const named = (fragment: string): string => {
    const step = jobSteps.find(candidate => candidate.name.includes(fragment));
    if (step === undefined) throw new Error(`no step named like ${fragment}`);
    return step.text;
  };

  it('runs after a green images run on main, or by hand on main, and never on a pull request', () => {
    expect(workflow).toContain('  workflow_run:\n    workflows: [Greenfield images]\n    types: [completed]\n    branches: [main]');
    expect(readRepositoryFile('.github/workflows/greenfield-images.yml')).toMatch(/^name: Greenfield images$/mu);
    expect(workflow).toContain('  workflow_dispatch:');
    expect(workflow).not.toMatch(/^ {2}(push|pull_request|pull_request_target):/mu);
    const run = job(workflow, 'run');
    expect(run).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(run).toContain("github.event.workflow_run.event == 'push'");
    expect(run).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(run).toContain('github.event.workflow_run.head_repository.full_name == github.repository');
    expect(run).toContain("(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')");
  });

  it('has no dispatch input that turns a protected change into an app-only one', () => {
    for (const text of [workflow, readRepositoryFile('infra/scripts/ci-deploy-app.sh'), readRepositoryFile('docs/greenfield/release.md')]) {
      expect(text).not.toMatch(/infrastructure[_-]applied/u);
    }
    expect(workflow.slice(workflow.indexOf('  workflow_dispatch:'), workflow.indexOf('\npermissions:'))).not.toContain('type: boolean');
  });

  it('gives a credential to two jobs, deploy and record, which run no code from the images commit before its guard and no Node at all', () => {
    const jobs = ['run', 'ranges', 'deploy', 'smoke', 'record', 'summary'];
    for (const name of jobs) {
      const text = job(workflow, name);
      if (name === 'deploy' || name === 'record') {
        expect(text).toContain('      id-token: write');
        expect(text).toContain('    environment: production-deploy');
        expect(text, name).not.toContain('setup-node');
        expect(text, name).not.toMatch(/^\s*node /mu);
        continue;
      }
      expect(text, name).not.toContain('id-token');
      expect(text, name).not.toContain('environment:');
      expect(text, name).not.toContain('configure-aws-credentials');
      expect(text, name).not.toContain('secrets.');
    }
    // The two jobs that run images-commit code hold contents: read and nothing else.
    for (const name of ['ranges', 'smoke']) {
      expect(job(workflow, name)).toMatch(/ {4}permissions:\n {6}contents: read\n {4}[a-z]/u);
    }
    const deploy = job(workflow, 'deploy');
    expect(deploy).not.toContain('setup-node');
    expect(deploy).not.toMatch(/^\s*node /mu);
    expect(deploy).toContain('          ref: ${{ needs.run.outputs.commit }}\n          fetch-depth: 0');
    // Nothing from the checkout runs before the guard, and everything after it is gated on it.
    const deploySteps = steps(deploy);
    const guardAt = deploySteps.findIndex(step => step.name === "Protected paths in any commit since production's");
    const assumeAt = deploySteps.findIndex(step => step.name === 'Assume the production CI deploy role');
    const checkoutAt = deploySteps.findIndex(step => step.name.startsWith('actions/checkout@'));
    expect(checkoutAt).toBeGreaterThan(-1);
    expect(assumeAt).toBeGreaterThan(checkoutAt);
    expect(guardAt).toBeGreaterThan(assumeAt);
    for (const step of deploySteps.slice(0, guardAt + 1)) {
      // A command that is a repository path, or one handed to an interpreter. A `case`
      // pattern ends in `)` and is not a command.
      expect(step.text, step.name).not.toMatch(
        /^\s*(?:bash |sh |node |source |\. )?(?:\.\/)?(?:infra\/scripts|scripts|packages|apps)\/[^\s'"]*\.(?:sh|mjs|ts|js)(?![)|*])/mu,
      );
      expect(step.text, step.name).not.toMatch(/\b(?:node|npm|npx|bash infra|source infra)\b/u);
    }
    const repositoryCode = deploySteps.filter(step => /infra\/scripts\//u.test(step.text.replace(/^\s*#.*$/gmu, '')));
    expect(repositoryCode.map(step => step.name)).toEqual([
      'Decide - app-only, already running, or the manual path',
      'Promote both images into the production repositories, by digest',
      'Register, roll the worker and then the API, and hold each to its digest',
    ]);
    expect(named('Decide')).toContain("if: steps.guard.outputs.decision == 'pass'");
    for (const fragment of ['Promote both images', 'Register, roll the worker']) {
      expect(named(fragment)).toContain("if: steps.check.outputs.decision == 'deploy'");
    }
    expect(named('Promote both images')).toContain(
      'infra/scripts/release-promote.sh "$RUNNER_TEMP/fss-image-digests/image-digests.json" --app-only',
    );
  });

  it('takes the schema ranges from the uncredentialed job as scalars it validates again, and smokes without a credential', () => {
    expect(job(workflow, 'ranges')).toContain("import('./packages/domain/db/schemaRange.ts')");
    expect(named('The scalars from the other jobs are what they claim to be')).toContain('[[ "$range" =~ ^[0-9]{1,4}-[0-9]{1,4}$ ]]');
    const smoke = job(workflow, 'smoke');
    expect(smoke).toContain('node scripts/productionSmoke.mjs --origin "$FSS_PRODUCTION_ORIGIN"');
    expect(smoke).toContain('--canary-age-seconds "$CANARY_AGE" --expect-sending "$EXPECT_SENDING"');
    expect(smoke).toContain('[[ "$CANARY_AGE" =~ ^[0-9]{1,7}(\\.[0-9]{1,6})?$ ]]');
    expect(named('Read the canary age the smoke judges')).toContain('--namespace FSS/fss-prod');
  });

  it('checks the session is exactly the CI role in the account its secret names', () => {
    const preflight = named('The session is exactly the CI role');
    expect(preflight).toContain('[[ "$ROLE_ARN" =~ ^arn:aws:iam::([0-9]{12}):role/fss-prod-ci-deploy$ ]]');
    expect(preflight).toContain('"arn:aws:sts::${account}:assumed-role/fss-prod-ci-deploy/fss-prod-ci-deploy-${GITHUB_RUN_ID}"');
    expect(named('Assume the production CI deploy role')).toContain('role-session-name: fss-prod-ci-deploy-${{ github.run_id }}');
  });

  it('queues, excludes a rehearsal through one shared group, and budgets twice the worst rollout', () => {
    expect(workflow).toContain('concurrency:\n  group: fss-production-deploy\n  cancel-in-progress: false');
    const deploy = job(workflow, 'deploy');
    expect(deploy).toContain('    concurrency:\n      group: fss-production-inventory\n      cancel-in-progress: false');
    const release = readRepositoryFile('.github/workflows/greenfield-release.yml');
    expect(job(release, 'rehearsal')).toContain('    concurrency:\n      group: fss-production-inventory\n      cancel-in-progress: false');
    // Two services, three ten-minute waits each, doubled, and the two-hour credential.
    expect(deploy).toContain('    timeout-minutes: 150');
    expect(named('Assume the production CI deploy role')).toContain('role-duration-seconds: 7200');
    expect(readRepositoryFile('infra/scripts/ci-deploy-app.sh')).toContain('CI_WAIT_ATTEMPTS="${FSS_CI_WAIT_ATTEMPTS:-3}"');
  });

  it('reports the revisions it observed, never a rollback it did not see', () => {
    expect(named('The revisions each service names now')).toContain('if: always()');
    const summary = job(workflow, 'summary');
    expect(summary).toContain("if: always() && needs.run.result != 'skipped'");
    expect(summary).toContain('Observed now: $OBSERVED');
    expect(summary).not.toMatch(/rolled back by ECS/u);
    expect(summary).toContain('    permissions: {}');
  });

  it('puts the release record in a job of its own, only after a deploy that rolled out and a smoke that passed', () => {
    const record = job(workflow, 'record');
    expect(record).toContain('    needs: [run, ranges, deploy, smoke]');
    expect(record).toContain(
      "    if: needs.deploy.result == 'success' && needs.deploy.outputs.decision == 'deploy' && needs.smoke.result == 'success'",
    );
    // No record from the deploy job itself: nothing there writes one before the smoke.
    const uncommentedDeploy = job(workflow, 'deploy').replace(/^\s*#.*$/gmu, '');
    expect(uncommentedDeploy).not.toContain('record');
    expect(workflow.replace(/^\s*#.*$/gmu, '')).not.toContain('release-deploy.sh');
    expect(workflow).not.toContain('HOOK (lane g96)');

    // The order inside it: the gate is waited for with no credential, then the role, then
    // the one step that runs repository code, which is the record put.
    const recordSteps = steps(record);
    const at = (name: string): number => recordSteps.findIndex(step => step.name === name);
    expect(at('The gate run on the images commit, green')).toBeGreaterThan(-1);
    expect(at('The gate run on the images commit, green')).toBeLessThan(at('Assume the production CI deploy role'));
    expect(at('Assume the production CI deploy role')).toBeLessThan(
      at('The session is exactly the CI role, in the account its ARN names, in the region this deploys to'),
    );
    const repositoryCode = recordSteps.filter(step => /infra\/scripts\//u.test(step.text.replace(/^\s*#.*$/gmu, '')));
    expect(repositoryCode.map(step => step.name)).toEqual(['Build the ci-gate record and put it on the operations task']);
    const put = recordSteps[at('Build the ci-gate record and put it on the operations task')]?.text ?? '';
    expect(put).toContain('infra/scripts/ci-deploy-app.sh record');
    expect(put).toContain('--gate-run-id "$GATE_RUN_ID"');
    expect(put).toContain('GATE_RUN_ID: ${{ steps.gate.outputs.gate_run_id }}');
    // The four network identifiers from repository variables, never from state.
    for (const variable of [
      'FSS_PRODUCTION_CLUSTER_NAME',
      'FSS_PRODUCTION_OPERATIONS_TASK_FAMILY',
      'FSS_PRODUCTION_TASK_SUBNET_IDS',
      'FSS_PRODUCTION_TASK_SECURITY_GROUP_ID',
    ]) {
      expect(put).toContain(`\${{ vars.${variable} }}`);
    }
    expect(record).not.toMatch(/terraform|tfstate/u);
    expect(recordSteps[at('Assume the production CI deploy role')]?.text).toContain('role-duration-seconds: 3600');
  });

  it('fails red with one line when the record was not put, and the summary says so', () => {
    const record = job(workflow, 'record');
    // The last step, on any failure of the job: one error annotation, then a red exit.
    const last = steps(record).at(-1)?.text ?? '';
    expect(last).toContain('if: failure()');
    const body = runBody(last).trim().split('\n');
    expect(body).toHaveLength(2);
    expect(body[0]).toMatch(/^echo "::error::[^"\n]+docs\/greenfield\/release\.md 4\.2[^"\n]*"$/u);
    expect(body[1]?.trim()).toBe('exit 1');
    // The summary waits for the record job, and a deploy whose record failed is an error.
    const summary = job(workflow, 'summary');
    expect(summary).toContain('    needs: [run, ranges, deploy, smoke, record]');
    const branch = summary.slice(summary.indexOf('elif [ "$DECISION" = deploy ] && [ "$RECORD_RESULT" != success ]; then'));
    expect(branch.length).toBeLessThan(summary.length);
    expect(branch.slice(0, branch.indexOf('\n          else'))).toContain('echo "::error::$line"');
  });

  it('finds the gate run on the images commit through the API, waits for it, and refuses one that is not green', () => {
    const gate = runBody(steps(job(workflow, 'record')).find(step => step.name === 'The gate run on the images commit, green')?.text ?? '');
    const green = {
      id: 4100,
      path: '.github/workflows/greenfield.yml',
      event: 'push',
      head_branch: 'main',
      head_sha: COMMIT,
      head_repository: { full_name: GH_REPOSITORY },
      status: 'completed',
      conclusion: 'success',
      created_at: '2026-09-25T22:00:00Z',
    };
    const attempt = (runs: readonly Record<string, unknown>[]): Run => {
      const bin = mkdtempSync(join(tmpdir(), 'fss-gh-gate-'));
      writeFileSync(join(bin, 'runs.json'), JSON.stringify({ workflow_runs: runs }));
      writeFileSync(
        join(bin, 'gh'),
        [
          '#!/usr/bin/env bash',
          `echo "$*" >> '${bin}/calls'`,
          `if [[ "$2" == *"/actions/workflows/greenfield.yml/runs?head_sha=${COMMIT}&event=push&branch=main&"* ]]; then cat '${bin}/runs.json'; else echo "unexpected $*" >&2; exit 1; fi`,
          '',
        ].join('\n'),
      );
      chmodSync(join(bin, 'gh'), 0o755);
      const outputs = join(bin, 'github-output');
      writeFileSync(outputs, '');
      const result = spawnSync('bash', ['-c', gate], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env['PATH'] ?? ''}`,
          COMMIT,
          GITHUB_REPOSITORY: GH_REPOSITORY,
          GITHUB_OUTPUT: outputs,
          RUNNER_TEMP: bin,
          WAIT_MINUTES: '0',
        },
      });
      return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}`, outputs: readOutputs(outputs) };
    };
    const accepted = attempt([green, { ...green, id: 4000, created_at: '2026-09-25T21:00:00Z', conclusion: 'failure' }]);
    expect(accepted.code, accepted.output).toBe(0);
    expect(accepted.outputs).toEqual({ gate_run_id: '4100' });

    const red = attempt([{ ...green, conclusion: 'failure' }]);
    expect(red.code).toBe(1);
    expect(red.output).toContain('did not pass (run and conclusion: 4100 failure)');
    expect(red.outputs['gate_run_id']).toBeUndefined();

    const running = attempt([{ ...green, status: 'in_progress', conclusion: null }]);
    expect(running.code).toBe(1);
    expect(running.output).toContain('no green Greenfield gate run on');
    expect(running.output).toContain('(last seen: waiting 4100)');

    for (const change of [
      { head_branch: 'feature' },
      { event: 'pull_request' },
      { head_sha: 'f'.repeat(40) },
      { head_repository: { full_name: 'someone/fork' } },
      { path: '.github/workflows/greenfield-images.yml' },
    ]) {
      const refused = attempt([{ ...green, ...change }]);
      expect(refused.code, JSON.stringify(change)).toBe(1);
      expect(refused.output).toContain('(last seen: none)');
      expect(refused.outputs['gate_run_id']).toBeUndefined();
    }
  });

  it('checks the images run it was handed: a green push to main of the images workflow, and nothing else', () => {
    const script = runBody(named('Read and judge the images run'));
    const good = {
      path: '.github/workflows/greenfield-images.yml',
      event: 'push',
      head_branch: 'main',
      conclusion: 'success',
      head_repository: { full_name: 'example-owner/example-repo' },
      head_sha: 'f'.repeat(40),
      run_attempt: 2,
    };
    const attempt = (run: Record<string, unknown>, runId = '4242'): Run => {
      const bin = mkdtempSync(join(tmpdir(), 'fss-gh-stub-'));
      writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\ncat <<'JSON'\n${JSON.stringify(run)}\nJSON\n`);
      chmodSync(join(bin, 'gh'), 0o755);
      const outputs = join(bin, 'github-output');
      writeFileSync(outputs, '');
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env['PATH'] ?? ''}`,
          RUN_ID: runId,
          GITHUB_REPOSITORY: 'example-owner/example-repo',
          GITHUB_OUTPUT: outputs,
          RUNNER_TEMP: bin,
        },
      });
      return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}`, outputs: readOutputs(outputs) };
    };
    const accepted = attempt(good);
    expect(accepted.code, accepted.output).toBe(0);
    expect(accepted.outputs).toEqual({ commit: 'f'.repeat(40), run_id: '4242', run_attempt: '2' });
    for (const [change, expected] of [
      [{ event: 'pull_request', head_branch: 'feature' }, 'not a push to main'],
      [{ conclusion: 'failure' }, 'it concluded failure'],
      [{ path: '.github/workflows/greenfield-release.yml' }, 'not of greenfield-images.yml'],
      [{ head_repository: { full_name: 'someone/fork' } }, "another repository's commit"],
    ] as const) {
      const refused = attempt({ ...good, ...change });
      expect(refused.code, JSON.stringify(change)).not.toBe(0);
      expect(refused.output).toContain(expected);
      expect(refused.outputs['commit']).toBeUndefined();
    }
    expect(attempt(good, '42; rm -rf /').code).not.toBe(0);
  });
});

describe('the deploy waits for a rehearsal job in progress, and checks again before its first write', () => {
  const poll = steps(DEPLOY_WORKFLOW).find(step => step.name === 'No credentialed rehearsal is running')?.text ?? '';
  const recheck =
    steps(DEPLOY_WORKFLOW).find(step => step.name === 'Still no rehearsal job in progress, immediately before the first write')?.text ?? '';

  const attempt = (
    runs: readonly Record<string, unknown>[],
    jobs: Readonly<Record<string, readonly Record<string, unknown>[]>>,
  ): { readonly code: number; readonly output: string } => {
    const bin = mkdtempSync(join(tmpdir(), 'fss-gh-runs-'));
    writeFileSync(join(bin, 'runs.json'), JSON.stringify({ workflow_runs: runs }));
    for (const [id, list] of Object.entries(jobs)) writeFileSync(join(bin, `jobs-${id}.json`), JSON.stringify({ jobs: list }));
    writeFileSync(
      join(bin, 'gh'),
      [
        '#!/usr/bin/env bash',
        `here='${bin}'`,
        'case "$2" in',
        '  */actions/runs/*/jobs*) id="${2#*/actions/runs/}"; id="${id%%/*}"; cat "$here/jobs-$id.json" 2>/dev/null || echo \'{"jobs":[]}\' ;;',
        '  */actions/runs\\?*) cat "$here/runs.json" ;;',
        '  *) echo "unexpected $*" >&2; exit 1 ;;',
        'esac',
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'gh'), 0o755);
    const result = spawnSync('bash', ['-c', runBody(recheck)], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        GITHUB_REPOSITORY: 'example-owner/example-repo',
        RUNNER_TEMP: bin,
        WAIT_MINUTES: '0',
      },
    });
    return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
  };
  const rehearsalJob = (status: string): Record<string, unknown> => ({
    name: 'Create, deploy, drill and destroy a rehearsal environment',
    status,
  });

  it('is one script in both places, waiting twenty minutes before the role and none before the write', () => {
    expect(runBody(poll)).toBe(runBody(recheck));
    expect(poll).toContain("WAIT_MINUTES: '20'");
    expect(recheck).toContain("WAIT_MINUTES: '0'");
    const names = steps(job(DEPLOY_WORKFLOW, 'deploy')).map(step => step.name);
    expect(names.indexOf('No credentialed rehearsal is running')).toBeLessThan(names.indexOf('Assume the production CI deploy role'));
    expect(names.indexOf('Still no rehearsal job in progress, immediately before the first write')).toBe(
      names.indexOf('Promote both images into the production repositories, by digest') - 1,
    );
  });

  it('refuses while a rehearsal job is in progress, and not for a rehearsal waiting behind it or another workflow', () => {
    // The two workflows whose job holds a rehearsal credential: the release rehearsal and
    // the monthly drill (lane g97 renamed the weekly rehearsal and dropped its schedule).
    expect(runBody(poll)).toContain(
      'wanted = {".github/workflows/greenfield-release.yml", ".github/workflows/greenfield-monthly-drill.yml"}',
    );
    expect(DEPLOY_WORKFLOW).not.toContain('greenfield-weekly-rehearsal.yml');
    expect(attempt([], {}).code).toBe(0);
    const release = { id: 7, path: '.github/workflows/greenfield-release.yml' };
    const drill = { id: 8, path: '.github/workflows/greenfield-monthly-drill.yml' };
    const other = { id: 9, path: '.github/workflows/ci.yml' };
    expect(
      attempt([release], { 7: [{ name: 'Print the rehearsal plan without credentials', status: 'in_progress' }, rehearsalJob('queued')] })
        .code,
    ).toBe(0);
    expect(attempt([other], { 9: [rehearsalJob('in_progress')] }).code).toBe(0);
    const busy = attempt([release], { 7: [rehearsalJob('in_progress')] });
    expect(busy.code).toBe(1);
    expect(busy.output).toContain('a rehearsal job is in progress (run 7)');
    expect(
      attempt([drill], {
        8: [
          {
            ...rehearsalJob('in_progress'),
            name: 'Full rehearsal at the pinned commit / Create, deploy, drill and destroy a rehearsal environment',
          },
        ],
      }).code,
    ).toBe(1);
  });
});

describe('Terraform reads CI’s revisions as its own and still re-points the services', () => {
  const cluster = readRepositoryFile('infra/modules/cluster/main.tf');
  const block = (header: string): string => {
    const start = cluster.indexOf(header);
    if (start < 0) throw new Error(`no ${header}`);
    const end = cluster.indexOf('\n}\n', start);
    return cluster.slice(start, end);
  };

  it('ignores only the count on both services, never the task definition', () => {
    for (const service of ['api', 'worker']) {
      const text = block(`resource "aws_ecs_service" "${service}" {`);
      expect(text).toContain(`task_definition = aws_ecs_task_definition.${service}.arn`);
      expect(text.match(/ignore_changes = \[[^\]]*\]/gu)).toEqual(['ignore_changes = [desired_count]']);
    }
  });

  it('tracks the newest revision on the two service definitions and on no one-off', () => {
    for (const family of ['api', 'worker']) {
      expect(block(`resource "aws_ecs_task_definition" "${family}" {`)).toMatch(/^ {2}track_latest = true$/mu);
    }
    for (const family of ['migration', 'operations', 'drill']) {
      expect(block(`resource "aws_ecs_task_definition" "${family}" {`)).not.toContain('track_latest');
    }
  });
});
