import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryPath } from './support/repository.ts';

/**
 * Lane R1: `infra/scripts/release-rollback.sh` puts production back on a previous
 * release's images — the checkout's own images, on a database their ranges accept, with
 * sending as it runs — and refuses everything else before anything is written.
 *
 * The whole script is driven against three stub processes on PATH, `aws`, `terraform` and
 * `curl`, which share one state file (found through `FSS_STUB_HOME`) and log every call: the stub production runs the new
 * digests, the checkout is a real git repository at a commit whose images are the old
 * ones, and the smoke is the checkout's own `scripts/productionSmoke.mjs`, which here
 * records its arguments. `--apply` runs the real `release-deploy.sh` against the same
 * stubs, so "applies, deploys and smokes in that order" is read from the call log.
 *
 * ## The vacuous-pass traps, named
 *
 * **A refusal that is only an exit code.** Each refusal is held to exactly one `FAIL:`
 * line naming what it refused, and to no write: no `terraform apply`, no `update-service`,
 * and, before the plan, no Terraform call at all. The same world with one fact changed
 * plans, so a refusal cannot be the only answer.
 *
 * **A plan guard that only reads the happy plan.** The stub's saved plan is replaced with
 * one that updates a bucket, destroys a database and replaces a service; each must be
 * named, and the plan file must be gone.
 *
 * **A dry run that calls something.** The dry run with `--apply` must leave the call log
 * empty and still print the plan, the apply, the deploy and the smoke.
 *
 * **A committed value compared with nothing.** Since wave 1 the production root commits
 * `certificate_arn`, `api_hostname`, `alert_emails` and `sending_enabled` as literals. A
 * checkout that commits them is planned without those four `-var`s, and each literal that
 * differs from what production runs is a refusal naming it; a checkout from before wave 1,
 * which declares them as variables, is still given production's values as `-var`s. The
 * committed root also carries `certificate_arn = local.certificate_arn` in a module block,
 * which is not a literal and must not be read as one.
 */

const SCRIPT = repositoryPath('infra/scripts/release-rollback.sh');
const ACCOUNT = '123456789012';
const REGISTRY = `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com`;
const CLUSTER = `arn:aws:ecs:us-east-1:${ACCOUNT}:cluster/fss-prod-cluster`;
const CERTIFICATE = `arn:aws:acm:us-east-1:${ACCOUNT}:certificate/11111111-2222-4333-8444-555555555555`;
const TOPIC = `arn:aws:sns:us-east-1:${ACCOUNT}:fss-prod-alerts`;
const HOSTNAME = 'api.example.invalid';
const OTHER_COMMIT = 'fedcba9876543210fedcba9876543210fedcba98';

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
/** What the rollback goes back to (the checkout's images), and what production runs now. */
const OLD = { api: digest('a'), worker: digest('b') } as const;
const NEW = { api: digest('c'), worker: digest('d') } as const;
type Service = 'api' | 'worker';

const definitionArn = (service: string, revision: number): string =>
  `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/fss-prod-${service}:${String(revision)}`;

const CLUSTER_ADDRESS = 'module.stack.module.cluster';
const replaced = (name: string): Record<string, unknown> => ({
  address: `${CLUSTER_ADDRESS}.aws_ecs_task_definition.${name}`,
  mode: 'managed',
  type: 'aws_ecs_task_definition',
  name,
  change: { actions: ['delete', 'create'] },
});
const servicePlan = (name: Service, actions: readonly string[] = ['update']): Record<string, unknown> => ({
  address: `${CLUSTER_ADDRESS}.aws_ecs_service.${name}`,
  mode: 'managed',
  type: 'aws_ecs_service',
  name,
  change: { actions },
});
/** A rollback plan as Terraform shows it: five definitions replaced, two services re-pointed. */
const GOOD_PLAN: readonly Record<string, unknown>[] = [
  ...['api', 'worker', 'migration', 'operations', 'drill'].map(replaced),
  servicePlan('api'),
  servicePlan('worker'),
  { address: 'data.aws_caller_identity.current', mode: 'data', type: 'aws_caller_identity', name: 'current', change: { actions: ['read'] } },
  {
    address: 'module.stack.module.journal.aws_s3_bucket.journal',
    mode: 'managed',
    type: 'aws_s3_bucket',
    name: 'journal',
    change: { actions: ['no-op'] },
  },
];

/**
 * `aws`, `terraform` and `curl` in one file, told apart by the name they are run as.
 * Terraform's apply does what the real one does to what the scripts read afterwards: it
 * registers the planned images as the next revision of each family and re-points the
 * services at them.
 */
const STUB = String.raw`#!/usr/bin/env python3
import json, os, sys
here = os.environ["FSS_STUB_HOME"]
path = os.path.join(here, "state.json")
state = json.load(open(path))
tool = os.path.basename(sys.argv[0])
args = sys.argv[1:]
with open(os.path.join(here, "calls.jsonl"), "a") as handle:
    handle.write(json.dumps({"tool": tool, "args": args}) + "\n")

def value(flag):
    return args[args.index(flag) + 1] if flag in args else None

def save():
    json.dump(state, open(path, "w"))

def done(answer):
    print(answer if isinstance(answer, str) else json.dumps(answer))
    sys.exit(0)

def family_of(arn):
    return arn.rsplit("/", 1)[1].split(":")[0]

def definition(service, revision, image, schema, sending, generation):
    environment = [
        {"name": "FSS_ROLE", "value": service},
        {"name": "FSS_SCHEMA_MIN", "value": str(schema[0])},
        {"name": "FSS_SCHEMA_MAX", "value": str(schema[1])},
        {"name": "FSS_SENDING_ENABLED", "value": sending},
    ]
    if generation is not None:
        environment.append({"name": "FSS_EXPECTED_SYSTEM_GENERATION", "value": generation})
    if service == "api":
        environment.append({"name": "FSS_PUBLIC_ORIGIN", "value": "https://" + state["hostname"]})
    arn = "arn:aws:ecs:us-east-1:" + state["account"] + ":task-definition/fss-prod-" + service + ":" + str(revision)
    return {"taskDefinition": {"taskDefinitionArn": arn, "family": "fss-prod-" + service, "revision": revision, "status": "ACTIVE",
                               "containerDefinitions": [{"name": service, "image": image, "environment": environment}]}}

if tool == "curl":
    if state.get("health") is None:
        sys.stderr.write("curl: (22) The requested URL returned error: 503\n")
        sys.exit(22)
    done(state["health"])

if tool == "terraform":
    chdir = args[0][len("-chdir="):]
    command = args[1]
    plan_file = os.path.join(chdir, "rollback.tfplan")
    if command == "output":
        name = args[-1]
        answer = state["outputs"][name]
        done(answer if "-raw" in args else json.dumps(answer))
    if command == "plan":
        planned = {}
        for argument in args:
            if argument.startswith("-var="):
                key, _, setting = argument[len("-var="):].partition("=")
                planned[key] = setting
        state["planned"] = planned
        save()
        open(plan_file, "w").write("a saved plan")
        print("Plan: 5 to add, 2 to change, 5 to destroy.")
        sys.exit(0)
    if command == "show":
        if not os.path.exists(plan_file):
            sys.stderr.write("no saved plan\n")
            sys.exit(1)
        done({"format_version": "1.2", "resource_changes": state["plan"]})
    if command == "apply":
        if not os.path.exists(plan_file):
            sys.stderr.write("no saved plan\n")
            sys.exit(1)
        planned = state["planned"]
        for service, revision in (("api", 8), ("worker", 5)):
            schema = planned[service + "_schema_range"].strip("{}").replace("min=", "").replace("max=", "").split(",")
            fresh = definition(service, revision, planned[service + "_image"], (int(schema[0]), int(schema[1])),
                               planned.get("sending_enabled", state["rootSending"]), planned.get("expected_system_generation"))
            for arn, known in state["taskDefinitions"].items():
                if family_of(arn) == "fss-prod-" + service:
                    known["taskDefinition"]["status"] = "INACTIVE"
            state["taskDefinitions"][fresh["taskDefinition"]["taskDefinitionArn"]] = fresh
            state["services"]["fss-prod-" + service]["taskDefinition"] = fresh["taskDefinition"]["taskDefinitionArn"]
        save()
        print("Apply complete! Resources: 5 added, 2 changed, 5 destroyed.")
        sys.exit(0)
    sys.stderr.write("the terraform stub does not know: " + " ".join(args) + "\n")
    sys.exit(2)

account = state["account"]
if args[:2] == ["sts", "get-caller-identity"]:
    done(account if value("--query") == "Account" else "arn:aws:iam::" + account + ":user/operator")
if args[:2] == ["ecs", "describe-clusters"]:
    done([{"key": "Environment", "value": "production"}])
if args[:2] == ["ecs", "describe-services"]:
    name = value("--services")
    service = state["services"][name]
    deployments = [{"status": "PRIMARY", "taskDefinition": service["taskDefinition"], "rolloutState": "COMPLETED"}]
    if service.get("rolling"):
        deployments.append({"status": "ACTIVE", "taskDefinition": "older", "rolloutState": "IN_PROGRESS"})
    done({"services": [{"serviceName": name, "status": "ACTIVE", "desiredCount": service["desired"],
                        "runningCount": service["desired"], "pendingCount": 0,
                        "taskDefinition": service["taskDefinition"], "deployments": deployments}]})
if args[:2] == ["ecs", "describe-task-definition"]:
    wanted = value("--task-definition")
    active = {arn: d for arn, d in state["taskDefinitions"].items() if d["taskDefinition"]["status"] == "ACTIVE" or arn == wanted}
    if wanted not in active:
        wanted = max((arn for arn in active if family_of(arn) == wanted), key=lambda arn: int(arn.rsplit(":", 1)[1]))
    done(active[wanted])
if args[:2] == ["ecs", "update-service"]:
    state["services"][value("--service")]["desired"] = int(value("--desired-count"))
    save()
    done("updated")
if args[:2] == ["ecs", "wait"]:
    sys.exit(0)
if args[:2] == ["ecs", "list-tasks"]:
    name = value("--service-name")
    prefix = "arn:aws:ecs:us-east-1:" + account + ":task/fss-prod-cluster/"
    done({"taskArns": [prefix + name + "-" + str(index) for index in range(state["services"][name]["desired"])]})
if args[:2] == ["ecs", "describe-tasks"]:
    arns = args[args.index("--tasks") + 1:]
    arns = arns[:next((i for i, a in enumerate(arns) if a.startswith("--")), len(arns))]
    tasks = []
    for arn in arns:
        name = arn.rsplit("/", 1)[1].rsplit("-", 1)[0]
        service = state["services"][name]
        image = state["taskDefinitions"][service["taskDefinition"]]["taskDefinition"]["containerDefinitions"][0]["image"]
        tasks.append({"taskArn": arn, "lastStatus": "RUNNING", "taskDefinitionArn": service["taskDefinition"],
                      "containers": [{"name": name.rsplit("-", 1)[1], "image": image, "imageDigest": image.rsplit("@", 1)[1]}]})
    done({"tasks": tasks, "failures": []})
if args[:2] == ["ecr", "describe-images"]:
    repository = state["images"].get(value("--repository-name"), {})
    wanted = value("--image-ids").partition("=")[2]
    if wanted in repository:
        done({"imageDetails": [{"imageDigest": wanted, "imageTags": repository[wanted]}]})
    sys.stderr.write("An error occurred (ImageNotFoundException) when calling the DescribeImages operation\n")
    sys.exit(254)
if args[:2] == ["elbv2", "describe-load-balancers"]:
    done({"LoadBalancers": [{"LoadBalancerName": value("--names"),
                              "LoadBalancerArn": "arn:aws:elasticloadbalancing:us-east-1:" + account + ":loadbalancer/app/" + value("--names") + "/50dc6c495c0c9188"}]})
if args[:2] == ["elbv2", "describe-listeners"]:
    done({"Listeners": [{"Protocol": "HTTPS", "Port": 443, "Certificates": [{"CertificateArn": state["certificate"]}]}]})
if args[:2] == ["sns", "list-subscriptions-by-topic"]:
    done({"Subscriptions": [{"Protocol": "email", "Endpoint": "ops@example.invalid", "SubscriptionArn": value("--topic-arn") + ":1"},
                            {"Protocol": "lambda", "Endpoint": "arn:aws:lambda:us-east-1:" + account + ":function:fss-prod-digest",
                             "SubscriptionArn": value("--topic-arn") + ":2"}]})
if args[:2] == ["cloudwatch", "get-metric-statistics"]:
    done({"Datapoints": [{"Timestamp": "2026-09-26T10:00:00+00:00", "Maximum": 900.0},
                         {"Timestamp": "2026-09-26T10:05:00+00:00", "Maximum": 12.5}]})
sys.stderr.write("the aws stub does not know: " + " ".join(args) + "\n")
sys.exit(2)
`;

/** The checkout's smoke: it records what it was asked, as the real one would be asked it. */
const SMOKE = `import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
appendFileSync(join(process.env.FSS_STUB_HOME, 'calls.jsonl'), JSON.stringify({ tool: 'smoke', args: process.argv.slice(2) }) + '\\n');
console.error('PASS health');
process.exitCode = Number(process.env.FSS_STUB_SMOKE_EXIT ?? '0');
`;

interface Call {
  readonly tool: string;
  readonly args: readonly string[];
}

interface WorldOptions {
  /** The ranges the checkout declares; 16-16 for both by default. */
  readonly ranges?: { readonly api: readonly [number, number]; readonly worker: readonly [number, number] };
  /** The database version the running API reports; 16 by default. */
  readonly databaseVersion?: number;
  /** FSS_SENDING_ENABLED on each running task definition; false for both by default. */
  readonly sending?: Readonly<Record<Service, string>>;
  readonly generation?: string;
  readonly rolling?: Service;
  /** The tags each old image carries; ci-<commit> on the API and the bare commit on the worker by default. */
  readonly tags?: (commit: string) => Partial<Record<Service, readonly string[]>>;
  /** Leave an old image out of production's registry. */
  readonly missing?: Service;
  readonly plan?: readonly Record<string, unknown>[];
  readonly dirty?: boolean;
  /**
   * The shape of the checkout's production root: `literals` (the default, a commit from
   * wave 1 on) commits the four settings, `variables` (a commit from before) declares them.
   */
  readonly root?: 'literals' | 'variables';
  /** Committed literals that differ from what production runs; production's by default. */
  readonly committed?: Partial<Record<'certificate_arn' | 'api_hostname' | 'alert_emails' | 'sending_enabled', string>>;
}

interface World {
  readonly home: string;
  readonly root: string;
  readonly commit: string;
  calls(): readonly Call[];
}

function world(options: WorldOptions = {}): World {
  const home = mkdtempSync(join(tmpdir(), 'fss-rollback-stub-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  for (const tool of ['aws', 'terraform', 'curl']) {
    writeFileSync(join(bin, tool), STUB);
    chmodSync(join(bin, tool), 0o755);
  }

  // The checkout: a real repository at one commit, with the two files the script reads.
  const checkout = mkdtempSync(join(tmpdir(), 'fss-rollback-checkout-'));
  const ranges = options.ranges ?? { api: [16, 16], worker: [16, 16] };
  mkdirSync(join(checkout, 'packages/domain/db'), { recursive: true });
  mkdirSync(join(checkout, 'scripts'));
  mkdirSync(join(checkout, 'infra/roots/production'), { recursive: true });
  writeFileSync(
    join(checkout, 'packages/domain/db/schemaRange.ts'),
    [
      `export const API_SCHEMA_RANGE = { minimum: ${String(ranges.api[0])}, maximum: ${String(ranges.api[1])} };`,
      `export const WORKER_SCHEMA_RANGE = { minimum: ${String(ranges.worker[0])}, maximum: ${String(ranges.worker[1])} };`,
      '',
    ].join('\n'),
  );
  writeFileSync(join(checkout, 'scripts/productionSmoke.mjs'), SMOKE);
  const sending = options.sending ?? { api: 'false', worker: 'false' };
  const committed = {
    certificate_arn: `"${CERTIFICATE}"`,
    api_hostname: `"${HOSTNAME}"`,
    alert_emails: '["ops@example.invalid"]',
    sending_enabled: sending.api,
    ...options.committed,
  };
  if (options.root === 'variables') {
    writeFileSync(join(checkout, 'infra/roots/production/main.tf'), '# the production root before wave 1\n');
    writeFileSync(
      join(checkout, 'infra/roots/production/variables.tf'),
      Object.keys(committed).map(name => `variable "${name}" {\n}\n`).join('\n'),
    );
  } else {
    writeFileSync(
      join(checkout, 'infra/roots/production/main.tf'),
      [
        'locals {',
        ...Object.entries(committed).map(([name, value]) => `  ${name} = ${value}`),
        '}',
        '',
        'module "stack" {',
        ...Object.keys(committed).map(name => `  ${name} = local.${name}`),
        '}',
        '',
      ].join('\n'),
    );
  }
  const git = (...args: string[]): string =>
    execFileSync(
      'git',
      ['-c', 'user.name=Rollback Check', '-c', 'user.email=rollback@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      { cwd: checkout, encoding: 'utf8' },
    ).trim();
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'the previous release');
  const commit = git('rev-parse', 'HEAD');
  if (options.dirty === true) writeFileSync(join(checkout, 'infra/roots/production/override.tf'), '# not committed\n');

  const tags = options.tags?.(commit) ?? { api: [`ci-${commit}`], worker: [commit] };
  const running = (service: Service, revision: number): Record<string, unknown> => {
    const environment = [
      { name: 'FSS_ROLE', value: service },
      { name: 'FSS_SCHEMA_MIN', value: '16' },
      { name: 'FSS_SCHEMA_MAX', value: '16' },
      { name: 'FSS_SENDING_ENABLED', value: sending[service] },
      ...(options.generation === undefined ? [] : [{ name: 'FSS_EXPECTED_SYSTEM_GENERATION', value: options.generation }]),
      ...(service === 'api' ? [{ name: 'FSS_PUBLIC_ORIGIN', value: `https://${HOSTNAME}` }] : []),
    ];
    return {
      taskDefinition: {
        taskDefinitionArn: definitionArn(service, revision),
        family: `fss-prod-${service}`,
        revision,
        status: 'ACTIVE',
        containerDefinitions: [{ name: service, image: `${REGISTRY}/fss-prod-${service}@${NEW[service]}`, environment }],
      },
    };
  };
  const image = (service: Service): Record<string, readonly string[]> => ({
    [NEW[service]]: [`ci-${OTHER_COMMIT}`],
    ...(options.missing === service ? {} : { [OLD[service]]: tags[service] ?? [] }),
  });
  const state = {
    account: ACCOUNT,
    rootSending: options.root === 'variables' ? null : committed.sending_enabled,
    hostname: HOSTNAME,
    certificate: CERTIFICATE,
    health: JSON.stringify({
      status: 'serving',
      schema: { declaredRange: { minimum: 16, maximum: 16 }, databaseVersion: options.databaseVersion ?? 16, accepted: true, reason: null },
      sendingEnabled: sending.api === 'true',
    }),
    services: {
      'fss-prod-api': { taskDefinition: definitionArn('api', 7), desired: 2, rolling: options.rolling === 'api' },
      'fss-prod-worker': { taskDefinition: definitionArn('worker', 4), desired: 1, rolling: options.rolling === 'worker' },
    },
    taskDefinitions: { [definitionArn('api', 7)]: running('api', 7), [definitionArn('worker', 4)]: running('worker', 4) },
    images: { 'fss-prod-api': image('api'), 'fss-prod-worker': image('worker') },
    plan: options.plan ?? GOOD_PLAN,
    outputs: {
      cluster_arn: CLUSTER,
      migration_task_definition_arn: definitionArn('migration', 3),
      operations_task_definition_arn: definitionArn('operations', 3),
      app_runtime_database_secret_arn: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:fss-prod/app-runtime-database-aaaaaa`,
      task_network_configuration: { database_host: 'fss-prod-database.example.invalid' },
      deployment_plan: {
        api: { service_name: 'fss-prod-api', declared_desired_count: 2 },
        worker: { service_name: 'fss-prod-worker', declared_desired_count: 1 },
        bootstrap: false,
      },
      worker_log_group_name: '/fss/fss-prod/worker',
      alert_topic_arn: TOPIC,
    },
  };
  writeFileSync(join(home, 'state.json'), JSON.stringify(state));
  return {
    home,
    root: join(checkout, 'infra/roots/production'),
    commit,
    calls: () =>
      existsSync(join(home, 'calls.jsonl'))
        ? readFileSync(join(home, 'calls.jsonl'), 'utf8')
            .split('\n')
            .filter(line => line !== '')
            .map(line => JSON.parse(line) as Call)
        : [],
  };
}

interface Run {
  readonly code: number;
  readonly output: string;
}

function rollback(stub: World, extra: readonly string[] = [], environment: Record<string, string> = {}): Run {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${join(stub.home, 'bin')}:${process.env['PATH'] ?? ''}`,
    AWS_REGION: 'us-east-1',
    FSS_STUB_HOME: stub.home,
    FSS_REHEARSAL_REPORTS: mkdtempSync(join(tmpdir(), 'fss-rollback-reports-')),
    FSS_ROLLBACK_CANARY_SECONDS: '0',
    FSS_ROLLBACK_SMOKE_SECONDS: '0',
    ...environment,
  };
  for (const name of Object.keys(env)) {
    if (name.startsWith('FSS_RELEASE_')) delete env[name];
  }
  for (const name of ['FSS_REHEARSAL_AWS_COMMAND', 'TERRAFORM']) delete env[name];
  if (environment['FSS_REHEARSAL_DRY_RUN'] === undefined) delete env['FSS_REHEARSAL_DRY_RUN'];
  const result = spawnSync(
    SCRIPT,
    [stub.root, 'fss-prod', '--api-digest', OLD.api, '--worker-digest', OLD.worker, ...extra],
    { encoding: 'utf8', env },
  );
  return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

const failLines = (run: Run): readonly string[] => run.output.split('\n').filter(line => line.startsWith('FAIL:'));
const operation = (call: Call): string =>
  call.tool === 'aws' ? `aws ${call.args.slice(0, 2).join(' ')}` : call.tool === 'terraform' ? `terraform ${call.args[1] ?? ''}` : call.tool;
const operations = (stub: World): readonly string[] => stub.calls().map(operation);
const WRITES = ['terraform apply', 'aws ecs update-service', 'aws ecs register-task-definition', 'aws ecs run-task', 'smoke'];
const writes = (stub: World): readonly string[] => operations(stub).filter(name => WRITES.includes(name));
const planVariables = (stub: World): readonly string[] =>
  (stub.calls().find(call => operation(call) === 'terraform plan')?.args ?? []).filter(argument => argument.startsWith('-var='));

/** A refusal: one FAIL line holding every fragment, exit 1, nothing written. */
function expectRefusal(stub: World, run: Run, fragments: readonly string[], options: { readonly planned?: boolean } = {}): void {
  expect(run.code, run.output).toBe(1);
  const lines = failLines(run);
  expect(lines, run.output).toHaveLength(1);
  for (const fragment of fragments) expect(lines[0], run.output).toContain(fragment);
  expect(writes(stub), run.output).toEqual([]);
  if (options.planned !== true) {
    expect(operations(stub).filter(name => name.startsWith('terraform')), run.output).toEqual([]);
  }
  expect(existsSync(join(stub.root, 'rollback.tfplan'))).toBe(false);
}

describe('release-rollback.sh plans the previous release and stops', () => {
  it('plans the checkout’s images and ranges, with production’s settings as the root commits them, prints the plan, and writes nothing', () => {
    const stub = world();
    const run = rollback(stub);
    expect(run.code, run.output).toBe(0);
    expect(failLines(run)).toEqual([]);
    // The four committed settings equal what production runs, so none is passed.
    expect(planVariables(stub)).toEqual([
      `-var=api_image=${REGISTRY}/fss-prod-api@${OLD.api}`,
      `-var=worker_image=${REGISTRY}/fss-prod-worker@${OLD.worker}`,
      '-var=api_schema_range={min=16,max=16}',
      '-var=worker_schema_range={min=16,max=16}',
      '-var=bootstrap=false',
    ]);
    expect(run.output).toContain(
      "the checkout's root: certificate_arn committed, api_hostname committed, alert_emails committed, sending_enabled committed",
    );
    // The ci-<commit> tag and the bare commit tag both tie an image to the checkout.
    expect(run.output).toContain(`fss-prod-api ${OLD.api} is tagged ci-${stub.commit}`);
    expect(run.output).toContain(`fss-prod-worker ${OLD.worker} is tagged ${stub.commit}`);
    expect(run.output).toContain('the database is at schema 16, which api 16-16 and worker 16-16 accept');
    expect(run.output).toContain('Plan: 5 to add, 2 to change, 5 to destroy.');
    expect(run.output).toContain(`replace ${CLUSTER_ADDRESS}.aws_ecs_task_definition.api`);
    expect(run.output).toContain(`update ${CLUSTER_ADDRESS}.aws_ecs_service.worker`);
    expect(run.output).toContain('Then run this again with --apply');
    expect(writes(stub)).toEqual([]);
    expect(existsSync(join(stub.root, 'rollback.tfplan'))).toBe(true);
  });

  it('gives a checkout from before wave 1, which declares the four as variables, production’s values as -vars', () => {
    const stub = world({ root: 'variables', sending: { api: 'true', worker: 'true' } });
    const run = rollback(stub);
    expect(run.code, run.output).toBe(0);
    expect(planVariables(stub)).toEqual([
      `-var=certificate_arn=${CERTIFICATE}`,
      `-var=api_hostname=${HOSTNAME}`,
      `-var=api_image=${REGISTRY}/fss-prod-api@${OLD.api}`,
      `-var=worker_image=${REGISTRY}/fss-prod-worker@${OLD.worker}`,
      '-var=api_schema_range={min=16,max=16}',
      '-var=worker_schema_range={min=16,max=16}',
      '-var=alert_emails=["ops@example.invalid"]',
      '-var=sending_enabled=true',
      '-var=bootstrap=false',
    ]);
  });

  it('with --apply applies, then deploys on the rolling path, then smokes, keeping sending and the pin as they run', () => {
    const stub = world({ sending: { api: 'true', worker: 'true' }, generation: '1' });
    const run = rollback(stub, ['--apply']);
    expect(run.code, run.output).toBe(0);
    // Sending is the committed `true`, which is what runs; the pin is always a -var.
    expect(planVariables(stub).some(variable => variable.startsWith('-var=sending_enabled'))).toBe(false);
    expect(planVariables(stub)).toContain('-var=expected_system_generation=1');
    const names = operations(stub);
    const applied = names.indexOf('terraform apply');
    const deployed = names.indexOf('aws ecs update-service');
    const smoked = names.indexOf('smoke');
    expect(applied, names.join('\n')).toBeGreaterThan(names.indexOf('terraform show'));
    expect(deployed).toBeGreaterThan(applied);
    expect(smoked).toBeGreaterThan(deployed);
    // No --schema-change: nothing migrates, so no one-off task runs.
    expect(names).not.toContain('aws ecs run-task');
    expect(run.output).toContain('deployed: one rolling deployment of the worker and the API, running digests');
    const smoke = stub.calls().find(call => call.tool === 'smoke');
    expect(smoke?.args).toEqual(['--origin', `https://${HOSTNAME}`, '--canary-age-seconds', '12.5', '--expect-sending', 'enabled']);
    expect(run.output).toContain(`rolled back to ${stub.commit}`);
    expect(existsSync(join(stub.root, 'rollback.tfplan'))).toBe(false);
  });

  it('keeps sending off when it runs off, in the plan and in the smoke', () => {
    const stub = world({ root: 'variables' });
    const run = rollback(stub, ['--apply']);
    expect(run.code, run.output).toBe(0);
    expect(planVariables(stub)).toContain('-var=sending_enabled=false');
    expect(planVariables(stub).some(variable => variable.startsWith('-var=expected_system_generation'))).toBe(false);
    expect(stub.calls().find(call => call.tool === 'smoke')?.args.slice(-2)).toEqual(['--expect-sending', 'disabled']);
  });
});

describe('release-rollback.sh refuses in one FAIL line, before anything is written', () => {
  it('refuses a digest that is not an image of the checked-out commit', () => {
    const stub = world({ tags: () => ({ api: [`ci-${OTHER_COMMIT}`] }) });
    expectRefusal(stub, rollback(stub), [
      `fss-prod-api's ${OLD.api} is tagged ci-${OTHER_COMMIT}, not ci-${stub.commit} or ${stub.commit}`,
    ]);
    const missing = world({ missing: 'worker' });
    expectRefusal(missing, rollback(missing), [`fss-prod-worker holds no image ${OLD.worker}`]);
  });

  it('refuses a rollback across a schema change, naming the database version and the checkout’s ranges', () => {
    const stub = world({ databaseVersion: 17 });
    expectRefusal(stub, rollback(stub), [
      `the database is at schema 17 and ${stub.commit} declares api 16-16 and worker 16-16`,
      'the database never rolls back',
    ]);
    // One side is enough: the worker's range too must accept the version.
    const worker = world({ ranges: { api: [15, 17], worker: [16, 16] }, databaseVersion: 17 });
    expectRefusal(worker, rollback(worker), ['declares api 15-17 and worker 16-16']);
  });

  it('refuses while a service is mid-rollout', () => {
    const stub = world({ rolling: 'api' });
    expectRefusal(stub, rollback(stub), ['fss-prod-api has 2 deployments: a rollout is under way']);
  });

  it('refuses when the API and the worker disagree about sending, rather than choosing one', () => {
    const stub = world({ sending: { api: 'true', worker: 'false' } });
    expectRefusal(stub, rollback(stub), ['FSS_SENDING_ENABLED is true on the API and false on the worker']);
  });

  it('refuses a checkout that is not clean, because its code is not the commit’s', () => {
    const stub = world({ dirty: true });
    expectRefusal(stub, rollback(stub), ['is not clean', 'override.tf']);
  });

  it('refuses a plan that touches a bucket or a database, naming each, and deletes the plan file', () => {
    const bucket = {
      address: 'module.stack.module.journal.aws_s3_bucket.journal',
      mode: 'managed',
      type: 'aws_s3_bucket',
      name: 'journal',
      change: { actions: ['update'] },
    };
    const database = {
      address: 'module.stack.module.database.aws_db_instance.main',
      mode: 'managed',
      type: 'aws_db_instance',
      name: 'main',
      change: { actions: ['delete'] },
    };
    const stub = world({ plan: [...GOOD_PLAN, bucket, database] });
    const run = rollback(stub, ['--apply']);
    expectRefusal(
      stub,
      run,
      [`update ${String(bucket.address)}`, `delete ${String(database.address)}`, 'the plan file is deleted'],
      { planned: true },
    );
    expect(operations(stub)).toContain('terraform plan');
  });

  it('refuses a committed value that is not what production runs, naming each, with the manual recovery', () => {
    // Production runs sending off and the listener's certificate; the checkout commits
    // sending on and another certificate. Planning it would switch sending on.
    const other = `arn:aws:acm:us-east-1:${ACCOUNT}:certificate/99999999-2222-4333-8444-555555555555`;
    const stub = world({ committed: { sending_enabled: 'true', certificate_arn: `"${other}"` } });
    const run = rollback(stub, ['--apply']);
    expectRefusal(
      stub,
      run,
      [
        `certificate_arn is ${CERTIFICATE} in production and ${other} in ${stub.commit}`,
        `sending_enabled is false in production and true in ${stub.commit}`,
        'nothing was planned',
        'Manual recovery',
        'release.md 4.0',
      ],
      { planned: true },
    );
    // The only Terraform call is the read of the alert topic's output: no plan.
    expect(operations(stub).filter(name => name.startsWith('terraform'))).toEqual(['terraform output']);
    // The same world with the committed values production's plans.
    const agreeing = world();
    expect(rollback(agreeing).code).toBe(0);
  });

  it('refuses a checkout whose root neither declares nor commits a setting', () => {
    const stub = world({ committed: { alert_emails: 'var.alert_emails' } });
    expectRefusal(stub, rollback(stub), [`${stub.commit} neither declares alert_emails as a variable nor commits it as one literal`], {
      planned: true,
    });
    expect(operations(stub)).not.toContain('terraform plan');
  });

  it('refuses a plan that replaces a service', () => {
    const plan = [...GOOD_PLAN.filter(change => change['address'] !== `${CLUSTER_ADDRESS}.aws_ecs_service.api`), servicePlan('api', ['delete', 'create'])];
    const stub = world({ plan });
    expectRefusal(stub, rollback(stub, ['--apply']), [`replace ${CLUSTER_ADDRESS}.aws_ecs_service.api`], { planned: true });
  });
});

describe('release-rollback.sh in a dry run', () => {
  it('prints every command, the apply, the deploy and the smoke included, and calls nothing', () => {
    const stub = world();
    const run = rollback(stub, ['--apply'], { FSS_REHEARSAL_DRY_RUN: '1' });
    expect(run.code, run.output).toBe(0);
    expect(stub.calls()).toEqual([]);
    expect(run.output).toContain(`PLAN aws ecr describe-images --repository-name fss-prod-api --image-ids imageDigest=${OLD.api}`);
    expect(run.output).toContain('deployed-digests.sh fss-prod');
    expect(run.output).toContain(`PLAN curl -fsS --max-time 15 https://`);
    expect(run.output).toContain("PLAN refuse unless production's sending_enabled equals the committed false");
    expect(run.output).toContain(`PLAN terraform -chdir=${stub.root} plan -input=false -no-color -out=rollback.tfplan`);
    expect(run.output).toContain(`PLAN terraform -chdir=${stub.root} apply -input=false -no-color rollback.tfplan`);
    expect(run.output).toContain(`release-deploy.sh ${stub.root} fss-prod --api-digest ${OLD.api} --worker-digest ${OLD.worker}`);
    expect(run.output).toContain('scripts/productionSmoke.mjs');
    expect(existsSync(join(stub.root, 'rollback.tfplan'))).toBe(false);
  });
});
