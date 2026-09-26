import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ciGateReleaseRecordSchema, releaseRecordSchema, releaseRecordSource } from '@fss/contracts';
import { repositoryPath } from './support/repository.ts';

/**
 * `infra/scripts/record.sh`, run: `from-ci` against a stub `gh` (and an `aws` stub that
 * counts any call, so "no AWS call" is a count), and `put` / `read-back` against a stub
 * `aws` that answers `run-task` and logs its arguments, with every other AWS answer a
 * fixture.
 *
 * The record `from-ci` writes is parsed with the contract `fss admin release-record put`
 * applies. Each refusal starts from the world the positive control writes a record in and
 * changes one fact, and must answer exactly one `FAIL:` line with no file. `put` runs the
 * operations definition as it is now (the running release's worker image) and must store
 * exactly the file's bytes; `read-back` must fail when the put had to create the record,
 * which is the failure the separate pre-rollout put exists to prevent.
 */

const RECORD = repositoryPath('infra/scripts/record.sh');
const REPOSITORY = 'example-owner/example-repo';
const COMMIT = 'c0ffee'.repeat(6) + 'c0ff';
const OTHER_COMMIT = 'beef'.repeat(10);
const GATE_RUN = '41000000001';
const IMAGES_RUN = '41000000002';
const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;
const API = digest('a');
const WORKER = digest('b');
const REFERENCE = `ci-gate-${GATE_RUN}-${COMMIT.slice(0, 12)}`;

// ---------------------------------------------------------------------------
// from-ci
// ---------------------------------------------------------------------------

const GH_PROGRAM = `#!/usr/bin/env python3
import json, os, re, sys
here = os.path.dirname(os.path.abspath(__file__))
state = json.load(open(os.path.join(here, "state.json")))
args = sys.argv[1:]
with open(os.path.join(here, "calls-gh.jsonl"), "a") as handle:
    handle.write(json.dumps(args) + "\\n")
if args[:1] == ["api"]:
    one = re.fullmatch(r"repos/[^/]+/[^/]+/actions/runs/([0-9]+)", args[1])
    if one:
        run = (state.get("runs") or {}).get(one.group(1))
        if run is None:
            sys.stderr.write("gh: Not Found (HTTP 404)\\n")
            sys.exit(1)
        print(json.dumps(run))
        sys.exit(0)
    listed = re.fullmatch(r"repos/[^/]+/[^/]+/actions/workflows/greenfield-images\\.yml/runs\\?(.*)", args[1])
    if listed:
        query = dict(part.split("=", 1) for part in listed.group(1).split("&"))
        print(json.dumps({"workflow_runs": [run for run in state.get("imagesRuns") or [] if run.get("head_sha") == query.get("head_sha")]}))
        sys.exit(0)
if args[:2] == ["run", "download"]:
    content = (state.get("downloads") or {}).get(args[2])
    if content is None:
        sys.stderr.write("no valid artifacts found to download\\n")
        sys.exit(1)
    directory = args[args.index("--dir") + 1]
    os.makedirs(directory, exist_ok=True)
    open(os.path.join(directory, "image-digests.json"), "w").write(content)
    sys.exit(0)
sys.stderr.write("the gh stub does not know: " + " ".join(args) + "\\n")
sys.exit(2)
`;

const AWS_REFUSING = `#!/usr/bin/env bash
echo "$*" >> "$(dirname "$0")/calls-aws.log"
echo "record.sh from-ci must not call aws" >&2
exit 3
`;

type Run = Record<string, unknown>;
interface World {
  runs: Record<string, Run>;
  imagesRuns: Run[];
  downloads: Record<string, string>;
}

const gateRun = (overrides: Run = {}): Run => ({
  id: Number(GATE_RUN),
  name: 'Greenfield gate',
  path: '.github/workflows/greenfield.yml',
  status: 'completed',
  conclusion: 'success',
  head_sha: COMMIT,
  head_branch: 'main',
  head_repository: { full_name: REPOSITORY },
  event: 'push',
  html_url: `https://github.com/${REPOSITORY}/actions/runs/${GATE_RUN}`,
  updated_at: '2026-09-25T21:40:12Z',
  ...overrides,
});

const imagesRun = (overrides: Run = {}): Run => ({
  id: Number(IMAGES_RUN),
  name: 'Greenfield images',
  path: '.github/workflows/greenfield-images.yml',
  status: 'completed',
  conclusion: 'success',
  head_sha: COMMIT,
  head_branch: 'main',
  head_repository: { full_name: REPOSITORY },
  event: 'push',
  html_url: `https://github.com/${REPOSITORY}/actions/runs/${IMAGES_RUN}`,
  created_at: '2026-09-25T21:31:00Z',
  ...overrides,
});

function imageDigests(overrides: { commit?: string; api?: string; worker?: string } = {}): string {
  const commit = overrides.commit ?? COMMIT;
  return JSON.stringify({
    schema: 'fss.image-digests.v1',
    commit,
    workflowRunId: IMAGES_RUN,
    workflowRunAttempt: '1',
    images: {
      api: { repository: 'fss-rh-api', tag: `ci-${commit}`, digest: overrides.api ?? API },
      worker: { repository: 'fss-rh-worker', tag: `ci-${commit}`, digest: overrides.worker ?? WORKER },
    },
  });
}

const greenWorld = (): World => ({
  runs: { [GATE_RUN]: gateRun() },
  imagesRuns: [imagesRun(), imagesRun({ id: 41000000003, event: 'pull_request', head_branch: 'branch', conclusion: 'failure' })],
  downloads: { [IMAGES_RUN]: imageDigests() },
});

interface FromCi {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly gh: readonly (readonly string[])[];
  readonly aws: number;
  readonly out: string;
}

function fromCi(world: World, args: readonly string[], environment: Record<string, string> = {}, script = RECORD, prefix = ['from-ci']): FromCi {
  const home = mkdtempSync(join(tmpdir(), 'fss-record-gh-'));
  writeFileSync(join(home, 'gh'), GH_PROGRAM);
  writeFileSync(join(home, 'aws'), AWS_REFUSING);
  chmodSync(join(home, 'gh'), 0o755);
  chmodSync(join(home, 'aws'), 0o755);
  writeFileSync(join(home, 'state.json'), JSON.stringify(world));
  const out = join(home, 'out', 'release-record.json');
  const inherited = { ...process.env };
  delete inherited['GITHUB_REPOSITORY'];
  delete inherited['FSS_GH_COMMAND'];
  const result = spawnSync('bash', [script, ...prefix, ...args.map(arg => (arg === '<out>' ? out : arg))], {
    encoding: 'utf8',
    env: { ...inherited, PATH: `${home}:${process.env['PATH'] ?? ''}`, ...environment },
  });
  const lines = (name: string): string[] =>
    existsSync(join(home, name)) ? readFileSync(join(home, name), 'utf8').split('\n').filter(line => line !== '') : [];
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    gh: lines('calls-gh.jsonl').map(line => JSON.parse(line) as string[]),
    aws: lines('calls-aws.log').length,
    out,
  };
}

const GREEN = [GATE_RUN, COMMIT, API, WORKER] as const;

describe('record.sh from-ci writes the ci-gate record from a green gate and its images', () => {
  it('writes a record the worker stores, asking GitHub for three things and AWS for nothing', () => {
    const outcome = fromCi(greenWorld(), GREEN, { GITHUB_REPOSITORY: REPOSITORY });
    expect(outcome.status, outcome.stderr).toBe(0);
    const record = JSON.parse(outcome.stdout) as Record<string, unknown>;
    expect(record).toEqual({
      schema: 'fss.release-record.v1',
      source: 'ci-gate',
      releaseGateReference: REFERENCE,
      recordedAt: '2026-09-25T21:40:12Z',
      suite: 'pass',
      commit: COMMIT,
      gateRunId: GATE_RUN,
      gateRunUrl: `https://github.com/${REPOSITORY}/actions/runs/${GATE_RUN}`,
      imagesRunId: IMAGES_RUN,
      artifacts: { api: API, worker: WORKER, desktopCommitStamp: COMMIT },
      enablesSending: false,
    });
    const parsed = releaseRecordSchema.safeParse(record);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    if (parsed.success) expect(releaseRecordSource(parsed.data)).toBe('ci-gate');
    expect(ciGateReleaseRecordSchema.safeParse(record).success).toBe(true);
    expect(Buffer.from(outcome.stdout).toString('base64').length).toBeLessThan(6000);
    expect(outcome.aws).toBe(0);
    expect(outcome.gh).toEqual([
      ['api', `repos/${REPOSITORY}/actions/runs/${GATE_RUN}`],
      ['api', `repos/${REPOSITORY}/actions/workflows/greenfield-images.yml/runs?head_sha=${COMMIT}&event=push&branch=main&per_page=20`],
      expect.arrayContaining(['run', 'download', IMAGES_RUN, '--repo', REPOSITORY, '--name', 'fss-image-digests']),
    ]);
    const local = fromCi(greenWorld(), GREEN);
    expect(local.gh[0]).toEqual(['api', `repos/{owner}/{repo}/actions/runs/${GATE_RUN}`]);
  });

  it('says enablesSending only when told to, and writes the same bytes twice to --out', () => {
    const first = fromCi(greenWorld(), [...GREEN, '--enables-sending', '--out', '<out>']);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toBe('');
    expect(first.stderr).toContain(REFERENCE);
    const written = readFileSync(first.out, 'utf8');
    expect(JSON.parse(written)).toMatchObject({ source: 'ci-gate', enablesSending: true });
    const second = fromCi(greenWorld(), [...GREEN, '--enables-sending', '--out', '<out>']);
    expect(readFileSync(second.out, 'utf8')).toBe(written);
  });

  it('is what the old name release-record-from-ci.sh runs', () => {
    const old = fromCi(greenWorld(), GREEN, {}, repositoryPath('infra/scripts/release-record-from-ci.sh'), []);
    expect(old.status, old.stderr).toBe(0);
    expect(JSON.parse(old.stdout)).toMatchObject({ releaseGateReference: REFERENCE });
  });

  it('accepts the gate file under another display name, and a path with a ref', () => {
    for (const change of [{ name: 'Renamed gate' }, { path: '.github/workflows/greenfield.yml@refs/heads/main' }]) {
      const world = greenWorld();
      world.runs[GATE_RUN] = gateRun(change);
      expect(fromCi(world, GREEN).status).toBe(0);
    }
  });

  const refusals: readonly (readonly [string, (world: World) => void, string, Record<string, string>?])[] = [
    ['a gate run that failed', world => (world.runs[GATE_RUN] = gateRun({ conclusion: 'failure' })), 'not completed/success'],
    ['a gate run still running', world => (world.runs[GATE_RUN] = gateRun({ status: 'in_progress', conclusion: '' })), 'not completed/success'],
    ['a green run of another file named Greenfield gate', world => (world.runs[GATE_RUN] = gateRun({ path: '.github/workflows/impostor.yml' })), "is a run of '.github/workflows/impostor.yml' (named 'Greenfield gate')"],
    ['a gate run of a fork', world => (world.runs[GATE_RUN] = gateRun({ head_repository: { full_name: 'someone/fork' } })), "built someone/fork's commit"],
    ['a gate run in another repository', () => undefined, 'not other-owner/other-repo', { GITHUB_REPOSITORY: 'other-owner/other-repo' }],
    ['a gate run on another commit', world => (world.runs[GATE_RUN] = gateRun({ head_sha: OTHER_COMMIT })), `ran on ${OTHER_COMMIT}`],
    ['a gate run that is not a push to main', world => (world.runs[GATE_RUN] = gateRun({ event: 'pull_request', head_branch: 'x' })), 'not a push to main'],
    ['a gate run GitHub does not have', world => delete world.runs[GATE_RUN], 'gh could not read run'],
    ['a commit with no images run of its own', world => (world.imagesRuns = []), 'no Greenfield images run pushed to main'],
    ['an images run that failed', world => (world.imagesRuns = [imagesRun({ conclusion: 'failure' })]), 'not completed/success'],
    ['an api digest the images run did not publish', world => (world.downloads[IMAGES_RUN] = imageDigests({ api: digest('c') })), 'published the api digest'],
    ['a worker digest the images run did not publish', world => (world.downloads[IMAGES_RUN] = imageDigests({ worker: digest('c') })), 'published the worker digest'],
    ['digests of another commit', world => (world.downloads[IMAGES_RUN] = imageDigests({ commit: OTHER_COMMIT })), `name commit ${OTHER_COMMIT}`],
    ['an images run with no artifact', world => delete world.downloads[IMAGES_RUN], 'has no fss-image-digests artifact'],
  ];
  for (const [label, change, phrase, environment] of refusals) {
    it(`refuses ${label}, in one line and with no file`, () => {
      const world = greenWorld();
      change(world);
      const outcome = fromCi(world, [...GREEN, '--out', '<out>'], environment);
      expect(outcome.status, outcome.stderr).not.toBe(0);
      const lines = outcome.stderr.split('\n').filter(line => line !== '');
      expect(lines, outcome.stderr).toHaveLength(1);
      expect(lines[0]).toMatch(/^FAIL: /u);
      expect(lines[0]).toContain(phrase);
      expect(existsSync(outcome.out)).toBe(false);
      expect(outcome.aws).toBe(0);
    });
  }

  it('refuses malformed arguments before asking GitHub anything', () => {
    for (const [args, phrase] of [
      [['not-a-run', COMMIT, API, WORKER], 'not a GitHub Actions run id'],
      [[GATE_RUN, COMMIT.slice(0, 12), API, WORKER], 'not a full forty-character commit'],
      [[GATE_RUN, COMMIT, 'latest', WORKER], 'not an image digest'],
      [[GATE_RUN, COMMIT, API, API], 'identical'],
      [[...GREEN, '--sending'], "does not take '--sending'"],
    ] as const) {
      const outcome = fromCi(greenWorld(), [...args, '--out', '<out>']);
      expect(outcome.status).not.toBe(0);
      expect(outcome.stderr).toContain(phrase);
      expect(outcome.gh).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// put and read-back
// ---------------------------------------------------------------------------

const ACCOUNT = '123456789012';
const CLUSTER = `arn:aws:ecs:us-east-1:${ACCOUNT}:cluster/fss-prod-cluster`;
const OPERATIONS = `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/fss-prod-operations:3`;
const RUNTIME_SECRET = `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:fss-prod/app-runtime-database-a`;
const HOST = 'fss-prod-pg.example';
const WORKER_REPOSITORY = `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/fss-prod-worker`;
const RUNNING_WORKER = digest('c');

const ciRecord = (): Record<string, unknown> => ({
  schema: 'fss.release-record.v1',
  source: 'ci-gate',
  releaseGateReference: REFERENCE,
  recordedAt: '2026-09-25T21:40:12Z',
  suite: 'pass',
  commit: COMMIT,
  gateRunId: GATE_RUN,
  gateRunUrl: `https://github.com/${REPOSITORY}/actions/runs/${GATE_RUN}`,
  imagesRunId: IMAGES_RUN,
  artifacts: { api: API, worker: WORKER, desktopCommitStamp: COMMIT },
  enablesSending: false,
});

const operationsDefinition = (image = `${WORKER_REPOSITORY}@${RUNNING_WORKER}`): string =>
  JSON.stringify({
    taskDefinitionArn: OPERATIONS,
    containerDefinitions: [
      {
        name: 'operations',
        image,
        environment: [{ name: 'FSS_DATABASE_HOST', value: HOST }],
        secrets: [{ name: 'DATABASE_SECRET_ARN', valueFrom: RUNTIME_SECRET }],
      },
    ],
  });

interface Store {
  readonly code: number;
  readonly output: string;
  readonly report: string;
  readonly runTasks: readonly string[][];
  readonly bytes: Buffer;
}

interface StoreOptions {
  readonly outcome?: string;
  readonly stored?: Record<string, unknown>;
  readonly exit?: number;
  readonly definition?: string;
  readonly record?: Record<string, unknown> | string;
  readonly bootstrap?: boolean;
  readonly dry?: boolean;
}

/** `record.sh <stage> infra/roots/production fss-prod ...`, or any script and arguments. */
function store(args: readonly string[], options: StoreOptions = {}, script = RECORD): Store {
  const home = mkdtempSync(join(tmpdir(), 'fss-record-store-'));
  const aws = join(home, 'aws');
  writeFileSync(
    aws,
    [
      '#!/usr/bin/env python3',
      'import json, os, sys',
      'here = os.path.dirname(os.path.abspath(__file__))',
      'open(os.path.join(here, "calls.jsonl"), "a").write(json.dumps(sys.argv[1:]) + "\\n")',
      'if sys.argv[1:3] == ["ecs", "run-task"]:',
      `    print(json.dumps({"tasks": [{"taskArn": "arn:aws:ecs:us-east-1:${ACCOUNT}:task/fss-prod-cluster/put-1"}], "failures": []}))`,
      '    sys.exit(0)',
      'sys.stderr.write("the aws stub does not know: " + " ".join(sys.argv[1:]) + "\\n")',
      'sys.exit(2)',
      '',
    ].join('\n'),
  );
  chmodSync(aws, 0o755);
  const file = join(home, 'release-record.json');
  writeFileSync(file, typeof options.record === 'string' ? options.record : `${JSON.stringify(options.record ?? ciRecord(), null, 2)}\n`);
  const reports = join(home, 'reports');
  const answer = {
    outcome: options.outcome ?? 'created',
    reference: REFERENCE,
    source: 'ci-gate',
    suite: 'pass',
    apiDigest: API,
    workerDigest: WORKER,
    ...options.stored,
  };
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(FSS_|GITHUB_|RELEASE_)/u.test(name)) env[name] = value;
  }
  Object.assign(env, {
    FSS_REHEARSAL_AWS_COMMAND: aws,
    FSS_REHEARSAL_REPORTS: reports,
    FSS_RELEASE_CALLER_ACCOUNT: ACCOUNT,
    AWS_REGION: 'us-east-1',
    RELEASE_LOG_POLL_SECONDS: '0',
    FSS_RELEASE_CLUSTER_TAGS: '[{"key":"Environment","value":"production"}]',
    FSS_RELEASE_TASK_DEFINITION: options.definition ?? operationsDefinition(),
    FSS_RELEASE_DESCRIBE_TASKS: JSON.stringify({
      tasks: [{ lastStatus: 'STOPPED', stopCode: 'EssentialContainerExited', containers: [{ name: 'operations', exitCode: options.exit ?? 0 }] }],
    }),
    FSS_RELEASE_LOG_EVENTS: JSON.stringify({ events: [{ message: JSON.stringify(answer) }] }),
    FSS_RELEASE_OUTPUT_CLUSTER_ARN: CLUSTER,
    FSS_RELEASE_OUTPUT_OPERATIONS_TASK_DEFINITION_ARN: OPERATIONS,
    FSS_RELEASE_OUTPUT_MIGRATION_TASK_DEFINITION_ARN: `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/fss-prod-migration:3`,
    FSS_RELEASE_OUTPUT_APP_RUNTIME_DATABASE_SECRET_ARN: RUNTIME_SECRET,
    FSS_RELEASE_OUTPUT_TASK_NETWORK_CONFIGURATION: JSON.stringify({
      subnet_ids: ['subnet-1111111111111111a'],
      security_group_id: 'sg-1111111111111111b',
      assign_public_ip: 'ENABLED',
      database_host: HOST,
      inbound_rule_count: 0,
    }),
    FSS_RELEASE_OUTPUT_DEPLOYMENT_PLAN: JSON.stringify({
      api: { service_name: 'fss-prod-api', declared_desired_count: 1 },
      worker: { service_name: 'fss-prod-worker', declared_desired_count: 1 },
      bootstrap: options.bootstrap ?? false,
    }),
    FSS_RELEASE_OUTPUT_WORKER_LOG_GROUP_NAME: '/fss/fss-prod/worker',
    ...(options.dry ? { FSS_REHEARSAL_DRY_RUN: '1' } : {}),
  });
  const result = spawnSync('bash', [script, ...args.map(arg => (arg === '<file>' ? file : arg))], {
    cwd: repositoryPath(''),
    encoding: 'utf8',
    env,
  });
  const calls = existsSync(join(home, 'calls.jsonl'))
    ? readFileSync(join(home, 'calls.jsonl'), 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as string[])
    : [];
  const reportPath = join(reports, 'release-record.txt');
  return {
    code: result.status ?? 1,
    output: `${result.stdout}${result.stderr}`,
    report: existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '',
    runTasks: calls.filter(call => call[0] === 'ecs' && call[1] === 'run-task'),
    bytes: readFileSync(file),
  };
}

const ARGS = (stage: string, api = API, worker = WORKER): string[] => [
  stage, 'infra/roots/production', 'fss-prod', '--api-digest', api, '--worker-digest', worker, '--release-record', '<file>',
];

const command = (task: readonly string[]): string[] => {
  const overrides = JSON.parse(task[task.indexOf('--overrides') + 1] ?? '{}') as { containerOverrides: { command: string[] }[] };
  return overrides.containerOverrides[0]?.command ?? [];
};

describe('record.sh put stores the record before the rollout, on the operations definition as it runs', () => {
  it('puts the file’s own bytes once, held to the running worker image, and prints the stored answer', () => {
    const run = store(ARGS('put'));
    expect(run.code, run.output).toBe(0);
    expect(run.runTasks).toHaveLength(1);
    const task = run.runTasks[0] ?? [];
    expect(task[task.indexOf('--task-definition') + 1]).toBe(OPERATIONS);
    expect(task[task.indexOf('--cluster') + 1]).toBe(CLUSTER);
    const words = command(task);
    expect(words.slice(0, 4)).toEqual(['admin', 'release-record', 'put', '--json-base64']);
    expect(Buffer.from(words[4] ?? '', 'base64').equals(run.bytes)).toBe(true);
    expect(words.join(' ')).not.toContain('fss-rh-');
    expect(run.output).toContain('"outcome": "created"');
    expect(run.report).toContain('stage=put');
    expect(run.report).toContain(`operations_digest=${RUNNING_WORKER}`);
    expect(run.report).toContain('release_record=created');
  });

  it('answers existing for a record already stored', () => {
    const run = store(ARGS('put'), { outcome: 'existing' });
    expect(run.code, run.output).toBe(0);
    expect(run.report).toContain('release_record=existing');
  });

  it('fails when the stored record is not the one put, or the tool refused the put, with no report', () => {
    const different = store(ARGS('put'), { stored: { workerDigest: digest('e') } });
    expect(different.code).toBe(1);
    expect(different.output).toContain('the stored record differs from the one put in workerDigest');
    const refused = store(ARGS('put'), { exit: 1 });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain('FAIL: release-record-put-before-rollout exited 1');
    expect(refused.output).toContain(`the operations task did not put the release record ${REFERENCE}`);
    expect(refused.report).toBe('');
  });

  it('refuses, before any task, an operations definition that is not the worker image by digest', () => {
    for (const image of [`${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/fss-prod-api@${RUNNING_WORKER}`, `${WORKER_REPOSITORY}:latest`]) {
      const run = store(ARGS('put'), { definition: operationsDefinition(image) });
      expect(run.code, image).toBe(1);
      expect(run.output).toContain('is not the worker image by digest');
      expect(run.runTasks).toEqual([]);
    }
  });

  it('refuses, before anything is asked, a record for other digests, a file that is not a record, and missing flags', () => {
    const other = store(ARGS('put', API, digest('e')));
    expect(other.code).toBe(1);
    expect(other.output).toContain(`names worker ${WORKER} (this release: ${digest('e')})`);
    const notRecord = store(ARGS('put'), { record: JSON.stringify({ schema: 'something.else' }) });
    expect(notRecord.code).toBe(1);
    expect(notRecord.output).toContain('is not a release record');
    const noRecord = store(['put', 'infra/roots/production', 'fss-prod', '--api-digest', API, '--worker-digest', WORKER]);
    expect(noRecord.output).toContain('needs --release-record');
    const noDigest = store(['put', 'infra/roots/production', 'fss-prod', '--worker-digest', WORKER, '--release-record', '<file>']);
    expect(noDigest.output).toContain('needs --api-digest and --worker-digest');
    const crossed = store(['put', 'infra/roots/rehearsal', 'fss-prod', '--api-digest', API, '--worker-digest', WORKER, '--release-record', '<file>']);
    expect(crossed.output).toContain('is not the production root');
    const bootstrap = store(ARGS('put'), { bootstrap: true });
    expect(bootstrap.output).toContain('bootstrap=true');
    for (const run of [other, notRecord, noRecord, noDigest, crossed, bootstrap]) {
      expect(run.code).not.toBe(0);
      expect(run.runTasks).toEqual([]);
    }
  });

  it('plans the one put in a dry run', () => {
    const run = store(ARGS('put'), { dry: true });
    expect(run.code, run.output).toBe(0);
    expect(run.output).toMatch(/PLAN aws ecs run-task .*"command": \["admin", "release-record", "put", "--json-base64"/u);
    expect(run.report).toContain('release_record=planned');
  });

  it('is what release-deploy.sh --record-only runs, which still refuses a schema change', () => {
    const script = repositoryPath('infra/scripts/release-deploy.sh');
    const args = ['infra/roots/production', 'fss-prod', '--record-only', '--api-digest', API, '--worker-digest', WORKER, '--release-record', '<file>'];
    const run = store(args, {}, script);
    expect(run.code, run.output).toBe(0);
    expect(run.runTasks).toHaveLength(1);
    expect(run.output).toContain('"outcome": "created"');
    expect(run.report).toContain('stage=put');
    const schema = store([...args, '--schema-change'], {}, script);
    expect(schema.code).not.toBe(0);
    expect(schema.output).toContain('means nothing here');
    expect(schema.runTasks).toEqual([]);
  });
});

describe('record.sh read-back puts the same record after the rollout and requires existing', () => {
  it('passes on existing', () => {
    const run = store(ARGS('read-back'), { outcome: 'existing' });
    expect(run.code, run.output).toBe(0);
    expect(run.report).toContain('stage=read-back');
    expect(run.report).toContain('release_record=existing');
  });

  it('fails when it had to create the record, unless told a creation is acceptable', () => {
    const created = store(ARGS('read-back'));
    expect(created.code).toBe(1);
    expect(created.output).toContain('the read-back had to create the release record');
    expect(created.report).toBe('');
    const allowed = store([...ARGS('read-back'), '--allow-created']);
    expect(allowed.code, allowed.output).toBe(0);
  });
});
