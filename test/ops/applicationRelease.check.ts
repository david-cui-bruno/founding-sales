import { isDeepStrictEqual, promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ciGateReleaseRecordSchema } from '@fss/contracts';
import { createUpgradeDatabase, MIGRATOR_LOGIN_ROLE, RUNTIME_LOGIN_ROLE } from '../../tools/upgrade/cluster.ts';
import { applyMigrations, loadMigrations, readAppliedSchemaVersion } from '@fss/domain/db/migrationRunner.ts';
import { acceptsSchemaVersion } from '@fss/domain/db/schemaRange.ts';
import { ensureRuntimeDatabaseUser } from '../../apps/worker/src/tools/fss/databaseUsers.ts';
import { runVerify } from '../../apps/worker/src/tools/fss/verify.ts';
import { readToolConfig } from '../../apps/worker/src/tools/fss/config.ts';
import { readRepositoryFile, repositoryPath } from './support/repository.ts';

interface Container {
  name: string; image: string; entryPoint: string[]; command: string[];
  environment: { name: string; value: string }[]; secrets: { name: string; valueFrom: string }[];
  logConfiguration: { options: Record<string, string> };
}
interface Definition {
  taskDefinitionArn: string; family: string; taskRoleArn: string; executionRoleArn: string;
  containerDefinitions: Container[]; tags?: { key: string; value: string }[];
}
interface Service {
  serviceName: string; status: string; desiredCount: number; runningCount: number; pendingCount: number;
  taskDefinition: string; deployments: { taskDefinition: string; rolloutState: string }[];
  deploymentConfiguration: { deploymentCircuitBreaker: { enable: boolean; rollback: boolean } };
  networkConfiguration: { awsvpcConfiguration: { subnets: string[]; securityGroups: string[]; assignPublicIp: string } };
}
interface Status {
  phase: string; outcome: string; reason?: string; observedSchema: number | string; migrationStarted: boolean; writesStarted: boolean;
  recoveryPoint: { timestamp: string; restoreTested: boolean } | null; rollback?: string;
  currentTaskArn?: string | null; currentTaskOwner?: string; temporaryReaderDefinition?: string | null;
}
interface IO {
  now(): number; equal(a: unknown, b: unknown): boolean; sleep(ms: number): Promise<void>;
  save(state: Status): void; read(key: string): unknown; run(program: string, args: string[], input?: string): Promise<string>;
}
const modulePath = repositoryPath('infra/scripts/application-release.mjs');
const release = await import(modulePath) as { runRelease(io: IO, env: Record<string, string>): Promise<Status>; offRead: string };
const execute = promisify(execFile);
const COMMIT = 'b'.repeat(40), BASE = 'a'.repeat(40), DISPATCH = 'c'.repeat(40);
const ACCOUNT = '326255650484';
const subnets = ['subnet-07ae1d846228e9e83', 'subnet-01f53573964548294'];
const workerSG = 'sg-11111111111111111', apiSG = 'sg-22222222222222222', albSG = 'sg-33333333333333333';
const registry = `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com`;
const cluster = `arn:aws:ecs:us-east-1:${ACCOUNT}:cluster/fss-prod-cluster`;
const image = (s: string) => `sha256:${s.repeat(64)}`;
const NEW = { api: image('c'), worker: image('d') };
const OLD = { api: image('a'), worker: image('b') };
const side = (name: string): 'api' | 'worker' => name === 'api' ? 'api' : 'worker';
const arn = (name: string, revision = 1) => `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/fss-prod-${name}:${String(revision)}`;
const tags = [{ key: 'NamePrefix', value: 'fss-prod' }];
const secret = (name: string) => `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:fss-prod/${name}-database-aaaaaa`;
const environment = (): Record<string, string> => ({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: DISPATCH, GITHUB_RUN_ID: '33', GITHUB_REPOSITORY: 'david-cui-bruno/founding-sales', AWS_REGION: 'us-east-1', COMMIT, RUN_ID: '11', GATE_RUN_ID: '22', FSS_RELEASE_HOLD: 'false', FSS_PRODUCTION_ORIGIN: 'https://api.usecallie.com', TASK_SUBNETS: [...subnets].reverse().join(','), TASK_SECURITY_GROUP: workerSG });
function definition(name: string, schema: number): Definition {
  return { taskDefinitionArn: arn(name), family: `fss-prod-${name}`, taskRoleArn: `arn:aws:iam::${ACCOUNT}:role/fss-prod-${name === 'migration' ? name : side(name)}-task`, executionRoleArn: `arn:aws:iam::${ACCOUNT}:role/fss-prod-${name === 'migration' ? name : side(name)}-exec`, containerDefinitions: [{
    name, image: `${registry}/fss-prod-${side(name)}@${OLD[side(name)]}`, entryPoint: name === 'api' || name === 'worker' ? ['node', 'bootstrap.ts'] : ['node', 'apps/worker/src/tools/fss.ts'], command: name === 'operations' ? ['verify'] : name === 'migration' ? ['migrate'] : [],
    environment: [{ name: 'FSS_DATABASE_HOST', value: 'private.invalid' }, { name: name === 'migration' ? 'FSS_TARGET_SCHEMA_MIN' : 'FSS_SCHEMA_MIN', value: String(schema) }, { name: name === 'migration' ? 'FSS_TARGET_SCHEMA_MAX' : 'FSS_SCHEMA_MAX', value: String(schema) }, { name: 'FSS_SENDING_ENABLED', value: 'true' }, ...(['api', 'worker'].includes(name) ? [{ name: 'FSS_MODEL_TRANSPORT', value: 'bedrock' }] : [])],
    secrets: name === 'migration' ? [{ name: 'MIGRATION_DATABASE_SECRET', valueFrom: secret('migration') }, { name: 'FSS_RUNTIME_DATABASE_SECRET_ARN', valueFrom: secret('app-runtime') }] : [{ name: 'DATABASE_SECRET_ARN', valueFrom: secret('app-runtime') }],
    logConfiguration: { options: { 'awslogs-group': '/fss/fss-prod/worker', 'awslogs-stream-prefix': name } },
  }] };
}
function service(name: string): Service {
  return { serviceName: `fss-prod-${name}`, status: 'ACTIVE', taskDefinition: arn(name), desiredCount: name === 'api' ? 2 : 1, runningCount: name === 'api' ? 2 : 1, pendingCount: 0, deployments: [{ taskDefinition: arn(name), rolloutState: 'COMPLETED' }], deploymentConfiguration: { deploymentCircuitBreaker: { enable: true, rollback: true } }, networkConfiguration: { awsvpcConfiguration: { subnets: [...subnets], securityGroups: [name === 'api' ? apiSG : workerSG], assignPublicIp: 'ENABLED' } } };
}
function securityGroups() {
  const permission = { IpProtocol: 'tcp', FromPort: 8080, ToPort: 8080, IpRanges: [] as { CidrIp: string }[], Ipv6Ranges: [] as { CidrIpv6: string }[], PrefixListIds: [] as { PrefixListId: string }[], UserIdGroupPairs: [{ GroupId: albSG, UserId: ACCOUNT }] };
  return [
    { GroupId: workerSG, GroupName: 'fss-prod-worker-task', VpcId: 'vpc-0123456789abcdef0', IpPermissions: [] as typeof permission[] },
    { GroupId: apiSG, GroupName: 'fss-prod-api-task', VpcId: 'vpc-0123456789abcdef0', IpPermissions: [permission] },
    { GroupId: albSG, GroupName: 'fss-prod-alb', VpcId: 'vpc-0123456789abcdef0', IpPermissions: [] as typeof permission[] },
  ];
}
interface Options {
  from?: number; to?: number; fault?: string;
  migrate?: () => Promise<void>; verify?: () => Promise<unknown>; off?: () => Promise<unknown>;
  docker?: (args: string[]) => Promise<string>;
}
function harness(options: Options = {}) {
  const from = options.from ?? 118, to = options.to ?? 118;
  let schema = from, clock = Date.parse('2026-10-18T18:00:00Z'), revision = 1, taskNumber = 0, recordStored = false, checks = 0;
  let promotionGateChanged = false;
  const productionTags: Partial<Record<'api' | 'worker', string>> = {};
  const calls: { program: string; args: string[]; phase: string }[] = [], states: Status[] = [];
  const definitions: Record<string, { taskDefinition: Definition; tags: typeof tags }> = {};
  for (const name of ['api', 'worker', 'migration', 'operations']) definitions[arn(name)] = { taskDefinition: definition(name, from), tags };
  const services = { api: service('api'), worker: service('worker') };
  const groups = securityGroups(), env = environment();
  const tasks = new Map<string, { definition: Definition; answer: unknown; exitCode: number; owner: string }>();
  const artifacts = { schema: 'fss.image-digests.v1', commit: COMMIT, workflowRunId: '11', workflowRunAttempt: '1', images: Object.fromEntries(['api', 'worker'].map(name => [name, { repository: `fss-rh-${name}`, tag: `ci-${COMMIT}`, digest: NEW[side(name)], schemaRange: { minimum: to, maximum: to } }])) };
  const run = (workflow: string, id: number) => ({ id, path: `.github/workflows/${workflow}.yml`, head_sha: COMMIT, event: 'push', head_branch: 'main', head_repository: { full_name: 'david-cui-bruno/founding-sales' }, status: 'completed', conclusion: 'success', run_attempt: 1, updated_at: '2026-10-18T17:50:00Z' });
  const arg = (args: string[], key: string) => args[args.indexOf(key) + 1] ?? '';
  const current = () => states.at(-1)?.phase ?? '';
  const io: IO = {
    now: () => clock, equal: isDeepStrictEqual, sleep: async ms => { clock += ms; }, save: state => { states.push(structuredClone(state)); },
    read(key) {
      if (key === 'images') return artifacts;
      if (key === 'upgradeBinding') return { from: options.fault === 'evidence' ? DISPATCH : BASE, to: COMMIT };
      return `PASS  schema ${String(from)} → ${String(to)}`;
    },
    async run(program, args) {
      calls.push({ program, args, phase: current() });
      if (options.fault === 'cancel' && current() === 'migrate') throw new Error('cancelled');
      if (program === 'gh') {
        checks++;
        if (promotionGateChanged && args[1]?.includes('/actions/runs/22')) return JSON.stringify({ ...run('greenfield', 22), conclusion: 'failure' });
        if (options.fault === 'gate-later' && checks > 12) return JSON.stringify({ ...run('greenfield', 22), conclusion: 'failure' });
        if (args[1]?.includes('/actions/runs/22')) return JSON.stringify(run('greenfield', 22));
        if (args[1]?.includes('/actions/runs/11')) return JSON.stringify({ ...run('greenfield-images', 11), run_attempt: options.fault === 'image-attempt' ? 2 : 1 });
        if (args[1]?.includes('/git/ref/')) return JSON.stringify({ object: { sha: options.fault === 'main' ? BASE : DISPATCH } });
        return JSON.stringify({ workflow_runs: [run('greenfield', 22)] });
      }
      if (program === 'curl') return JSON.stringify({ build: { commit: current() === 'runtime-verify' ? COMMIT : BASE }, schema: { databaseVersion: schema, accepted: true } });
      if (program === 'docker') {
        const result = await options.docker?.(args) ?? '';
        if (args[0] === 'buildx') {
          const which = arg(args, '--tag').includes('/fss-prod-api:') ? 'api' : 'worker';
          productionTags[which] = NEW[which];
          if (options.fault === 'promotion-gate-change') promotionGateChanged = true;
        }
        return result;
      }
      if (program === 'node') {
        if (args.includes('tools/ci/release-plan.ts')) return JSON.stringify({ fromSchema: from, toSchema: to, reasons: [] });
        if (options.fault === 'smoke') throw new Error('command_node_failed');
        return '';
      }
      expect(program).toBe('aws');
      const [kind, action] = args;
      if (kind === 'sts') return JSON.stringify({ Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/fss-prod-ci-application/fss-prod-application-33` });
      if (kind === 'rds' && action === 'describe-db-instance-automated-backups') return JSON.stringify({ DBInstanceAutomatedBackups: [{ DBInstanceArn: `arn:aws:rds:us-east-1:${ACCOUNT}:db:fss-prod-pg`, DbiResourceId: options.fault === 'pitr-drift' ? 'db-foreign' : 'db-owned', DBInstanceIdentifier: 'fss-prod-pg', Status: 'active', ...(options.fault === 'pitr-missing' ? {} : { RestoreWindow: { EarliestTime: new Date(options.fault === 'pitr-oldest' ? clock + 86400000 : clock - 86400000).toISOString(), LatestTime: new Date(options.fault === 'pitr' ? clock - 86400000 : options.fault === 'pitr-oldest' ? clock + 172800000 : clock + 1000).toISOString() } }) }] });
      if (kind === 'rds') return JSON.stringify({ DBInstances: [{ DBInstanceArn: `arn:aws:rds:us-east-1:${ACCOUNT}:db:fss-prod-pg`, DbiResourceId: 'db-owned', DBName: 'founder_sales', DBInstanceStatus: 'available', Endpoint: { Address: 'private.invalid' }, BackupRetentionPeriod: 35 }] });
      if (kind === 'secretsmanager') return JSON.stringify({ VersionIdsToStages: { current: ['AWSCURRENT'] } });
      if (kind === 'ec2') return JSON.stringify({ SecurityGroups: groups.filter(group => args.slice(args.indexOf('--group-ids') + 1, args.indexOf('--output')).includes(group.GroupId)) });
      if (kind === 'ecr') {
        if (action === 'get-login-password') return 'not-a-real-token';
        const which = arg(args, '--repository-name').endsWith('api') ? 'api' : 'worker';
        if (action === 'batch-get-image') {
          if (options.fault === 'promotion-gate-prewrite') promotionGateChanged = true;
          const imageId = { imageTag: arg(args, '--image-ids').slice('imageTag='.length) };
          if (options.fault === 'promotion-tag-unreadable') return JSON.stringify({ images: [], failures: [{ imageId, failureCode: 'Unknown' }] });
          return JSON.stringify(productionTags[which]
            ? { images: [{ imageId: { ...imageId, imageDigest: productionTags[which] } }], failures: [] }
            : { images: [], failures: [{ imageId, failureCode: 'ImageNotFound' }] });
        }
        return JSON.stringify({ imageDetails: [{ imageDigest: arg(args, '--image-ids').startsWith('imageDigest=') || options.fault === 'promotion-digest-drift' ? OLD[which] : productionTags[which], imageTags: [`ci-${BASE}`] }] });
      }
      if (kind === 'cloudwatch') return JSON.stringify({ Datapoints: [{ Maximum: 4, Timestamp: new Date(clock).toISOString() }] });
      if (kind === 'logs') {
        const task = tasks.get(arg(args, '--log-stream-name').split('/').at(-1) ?? '');
        return JSON.stringify({ events: [{ message: 'secret-shaped-raw-line-never-exported' }, { message: JSON.stringify(task?.answer) }] });
      }
      if (action === 'describe-services') {
        const copied = structuredClone(services);
        if (options.fault === 'breaker-race' && current() === 'recovery-pinned') copied.api.deploymentConfiguration.deploymentCircuitBreaker.rollback = true;
        return JSON.stringify({ services: Object.values(copied), failures: [] });
      }
      if (action === 'describe-task-definition') {
        const named = arg(args, '--task-definition');
        const found = structuredClone(definitions[named] ?? definitions[arn(named.slice('fss-prod-'.length))]);
        if (options.fault?.startsWith('runtime-bedrock') && current() === 'runtime-verify' && found?.taskDefinition.family === `fss-prod-${options.fault.endsWith('worker') ? 'worker' : 'api'}`) found.taskDefinition.containerDefinitions[0]!.environment = found.taskDefinition.containerDefinitions[0]!.environment.filter(entry => entry.name !== 'FSS_MODEL_TRANSPORT');
        return JSON.stringify(found);
      }
      if (action === 'register-task-definition') {
        const document = JSON.parse(arg(args, '--cli-input-json')) as Definition;
        const name = document.family.slice('fss-prod-'.length), registered = arn(name, ++revision);
        const definition = { ...document, taskDefinitionArn: registered }; delete definition.tags;
        if (options.fault === 'definition' && name === 'api') definition.containerDefinitions[0]!.environment.push({ name: 'UNREVIEWED', value: 'changed' });
        definitions[registered] = { taskDefinition: definition, tags: document.tags ?? [] };
        return JSON.stringify({ taskDefinition: definition });
      }
      if (action === 'deregister-task-definition') return '{}';
      if (action === 'update-service') {
        const name = arg(args, '--service').endsWith('api') ? 'api' : 'worker';
        const s = services[name];
        const next = arg(args, '--task-definition');
        if (args.includes('--deployment-configuration')) {
          s.deploymentConfiguration = JSON.parse(arg(args, '--deployment-configuration')) as Service['deploymentConfiguration'];
        }
        s.taskDefinition = next;
        if (args.includes('--desired-count')) { s.desiredCount = Number(arg(args, '--desired-count')); s.runningCount = s.desiredCount; }
        s.deployments = [{ taskDefinition: next, rolloutState: options.fault === 'rollout' && current() === 'deploy' ? 'FAILED' : 'COMPLETED' }];
        if (options.fault === 'update-unknown' && current() === 'deploy') throw new Error('command_aws_failed');
        return JSON.stringify({ service: s });
      }
      if (action === 'list-tasks') {
        if (!args.includes('--service-name')) return JSON.stringify({ taskArns: [] });
        const name = arg(args, '--service-name').endsWith('api') ? 'api' : 'worker';
        return JSON.stringify({ taskArns: Array.from({ length: services[name].desiredCount }, (_, n) => `${cluster.replace(':cluster/', ':task/')}/${name}${String(n)}`) });
      }
      if (action === 'run-task') {
        const registered = arg(args, '--task-definition');
        const def = definitions[registered]!.taskDefinition;
        const override = JSON.parse(arg(args, '--overrides')) as { containerOverrides: { command: string[] }[] };
        const words = override.containerOverrides[0]!.command;
        let answer: unknown = {}, exitCode = 0;
        if (words.length === 0) answer = options.off ? await options.off() : { releaseOff: options.fault !== 'off', storedOff: true, effectiveOff: true, finishing: options.fault === 'finishing' ? 1 : 0, versions: [4], schema, observedAt: new Date(clock).toISOString() };
        else if (words.includes('put')) {
          const record = ciGateReleaseRecordSchema.parse(JSON.parse(Buffer.from(arg(words, '--json-base64'), 'base64').toString()));
          answer = { outcome: recordStored ? 'existing' : 'created', reference: record.releaseGateReference }; recordStored = true;
        } else if (words.includes('migration-auth-check')) answer = { ok: true, readOnly: true, migrationMember: true, identity: 'fss_admin', database: 'founder_sales', schemaVersion: schema };
        else if (words.includes('release-prepare')) {
          try { await options.migrate?.(); if (options.fault === 'migration') throw new Error('failed'); schema = to; answer = { migrate: { schemaVersionAfter: schema } }; } catch { exitCode = 21; }
        } else if (words.includes('verify')) answer = options.verify ? await options.verify() : { schemaVersion: schema, apiAccepts: true, workerAccepts: true, write: true, read: true, persisted: false };
        else if (words.includes('idle-check')) answer = { idle: options.fault !== 'busy' };
        else if (words.includes('on')) answer = { active: true, until: new Date(clock + 3600000).toISOString() };
        else if (words.includes('off')) answer = { active: false };
        else throw new Error('unexpected_task_command');
        const taskId = `owned${String(++taskNumber)}`; tasks.set(taskId, { definition: def, answer, exitCode: options.fault === 'reader-nonzero' && words.length === 0 ? 1 : exitCode, owner: arg(args, '--started-by') });
        if (options.fault === 'start-unknown') throw new Error('command_aws_failed');
        return JSON.stringify({ tasks: [{ taskArn: `${cluster.replace(':cluster/', ':task/')}/${taskId}` }], failures: [] });
      }
      if (action === 'describe-tasks') {
        const ids = args.slice(args.indexOf('--tasks') + 1, args.indexOf('--output'));
        return JSON.stringify({ tasks: ids.map(named => {
          const taskId = named.split('/').at(-1) ?? '', task = tasks.get(taskId);
          if (task) return { taskArn: named, clusterArn: cluster, startedBy: options.fault === 'foreign-owner' ? 'foreign' : task.owner, taskDefinitionArn: task.definition.taskDefinitionArn, lastStatus: options.fault === 'exit-unknown' ? 'RUNNING' : 'STOPPED', containers: [{ name: task.definition.containerDefinitions[0]!.name, exitCode: task.exitCode, imageDigest: task.definition.containerDefinitions[0]!.image.split('@')[1] }] };
          const name = taskId.startsWith('api') ? 'api' : 'worker', d = definitions[services[name].taskDefinition]!.taskDefinition;
          return { taskArn: named, taskDefinitionArn: d.taskDefinitionArn, lastStatus: 'RUNNING', containers: [{ name, imageDigest: d.containerDefinitions[0]!.image.split('@')[1] }] };
        }), failures: [] });
      }
      throw new Error('unexpected_cloud_action');
    },
  };
  return { io, env, groups, calls, states, definitions, services, artifacts, productionTags, schema: () => schema, run: () => release.runRelease(io, env) };
}

describe('application image promotion and child-process pull guard (not Fargate acceptance)', () => {
  it.each([
    { fault: '', existing: 'none', reason: undefined, copies: 2, pulls: 2 },
    { fault: '', existing: 'exact', reason: undefined, copies: 0, pulls: 2 },
    { fault: '', existing: 'api-exact', reason: undefined, copies: 1, pulls: 2 },
    { fault: '', existing: 'api-conflict', reason: 'promotion_tag_conflict', copies: 0, pulls: 0 },
    { fault: '', existing: 'worker-conflict', reason: 'promotion_tag_conflict', copies: 1, pulls: 1 },
    { fault: 'promotion-tag-unreadable', existing: 'none', reason: 'promotion_tag_unreadable', copies: 0, pulls: 0 },
    { fault: 'promotion-digest-drift', existing: 'none', reason: 'promotion_digest_changed', copies: 1, pulls: 0 },
    { fault: 'promotion-digest-drift', existing: 'exact', reason: 'promotion_digest_changed', copies: 0, pulls: 0 },
    { fault: 'pull-api', existing: 'none', reason: 'image_pullability_guard_failed', copies: 1, pulls: 1 },
    { fault: 'pull-worker', existing: 'exact', reason: 'image_pullability_guard_failed', copies: 0, pulls: 2 },
    { fault: 'promotion-gate-change', existing: 'none', reason: 'provenance_changed', copies: 1, pulls: 1 },
    { fault: 'promotion-gate-prewrite', existing: 'none', reason: 'provenance_changed', copies: 0, pulls: 0 },
  ])('handles $fault / $existing with exact immutable digests', async ({ fault, existing, reason, copies, pulls }) => {
    const h = harness({ fault, docker: async args => {
      // Real child exit/stdout transport with an inert Docker stand-in, never a registry.
      const script = `const args=JSON.parse(process.argv[1]);if(args[0]==='pull'&&args.at(-1)===process.argv[2]){console.error('private-pull-error');process.exit(17);}console.log(JSON.stringify(args));`;
      const failed = fault === 'pull-api' ? `${registry}/fss-prod-api@${NEW.api}` : fault === 'pull-worker' ? `${registry}/fss-prod-worker@${NEW.worker}` : '';
      const result = await execute(process.execPath, ['--eval', script, JSON.stringify(args), failed], { env: { PATH: process.env['PATH'] } });
      expect(JSON.parse(result.stdout)).toEqual(args);
      return result.stdout;
    } });
    if (existing === 'exact') Object.assign(h.productionTags, NEW);
    if (existing === 'api-exact') h.productionTags.api = NEW.api;
    if (existing === 'api-conflict') h.productionTags.api = OLD.api;
    if (existing === 'worker-conflict') h.productionTags.worker = OLD.worker;
    const result = await h.run();
    expect(result).toMatchObject({ outcome: reason ? 'repair-required' : 'completed', migrationStarted: false });
    expect(result.reason).toBe(reason);
    const promoted = h.calls.filter(c => c.program === 'docker' && c.args[0] === 'buildx');
    const pulled = h.calls.filter(c => c.program === 'docker' && c.args[0] === 'pull');
    expect(promoted).toHaveLength(copies); expect(pulled).toHaveLength(pulls);
    for (const [n, call] of h.calls.filter(c => c.args[1] === 'batch-get-image').entries()) {
      expect(call.args).toEqual(['ecr', 'batch-get-image', '--repository-name', `fss-prod-${n === 0 ? 'api' : 'worker'}`, '--image-ids', `imageTag=ci-${COMMIT}`, '--output', 'json']);
    }
    for (const [n, call] of pulled.entries()) {
      const name = n === 0 ? 'api' : 'worker';
      expect(call.args).toEqual(['pull', '--platform', 'linux/arm64', `${registry}/fss-prod-${name}@${NEW[name]}`]);
    }
    for (const call of promoted) {
      const name = call.args.at(-1)?.includes('/fss-rh-api@') ? 'api' : 'worker';
      expect(call.args).toEqual(['buildx', 'imagetools', 'create', '--tag', `${registry}/fss-prod-${name}:ci-${COMMIT}`, '--prefer-index=false', `${registry}/fss-rh-${name}@${NEW[name]}`]);
    }
    if (reason) {
      expect(result.phase).toBe('promote-images');
      expect(h.calls.filter(c => c.phase === 'promote-images').every(c => !['register-task-definition', 'run-task', 'update-service'].includes(c.args[1] ?? ''))).toBe(true);
    } else {
      const candidate = h.calls.findIndex(c => c.args[1] === 'register-task-definition' && !c.args.join(' ').includes('--eval'));
      expect(candidate).toBeGreaterThan(h.calls.lastIndexOf(pulled[1]!));
    }
    expect(JSON.stringify(h.states)).not.toContain('private-pull-error');
  });
});

describe('application smoke child startup (offline source TypeScript import)', () => {
  it('needs explicit transform argv and passes all six checks without ambient NODE_OPTIONS', async () => {
    const h = harness();
    expect(await h.run()).toMatchObject({ outcome: 'completed', migrationStarted: false });
    const smokeCalls = h.calls.filter(call => call.program === 'node' && call.args.includes('scripts/productionSmoke.mjs'));
    expect(smokeCalls).toHaveLength(1);
    const args = smokeCalls[0]!.args;
    expect(args).toEqual(['--experimental-transform-types', '--disable-warning=ExperimentalWarning', 'scripts/productionSmoke.mjs', '--origin', 'https://api.usecallie.com', '--canary-age-seconds', '4', '--expect-sending', 'enabled']);
    const directory = mkdtempSync(join(tmpdir(), 'release-smoke-startup-'));
    try {
      const preload = join(directory, 'fetch.mjs');
      // No real fetch fallback, auth, cloud calls, or substituted schema module.
      writeFileSync(preload, `
const bodies = new Map([
  ['https://api.usecallie.com/healthz', { status: 'live' }],
  ['https://api.usecallie.com/readyz', { ready: true, schema: { declaredRange: { minimum: 118, maximum: 118 }, accepted: true, databaseVersion: 118 } }],
  ['https://api.usecallie.com/health', { sendingEnabled: true }],
]);
const seen = new Set();
globalThis.fetch = async (url, options) => {
  if (options?.method !== 'GET' || !bodies.has(url) || seen.has(url)) throw new Error('unexpected_fixture_request');
  seen.add(url);
  return new Response(JSON.stringify(bodies.get(url)), { status: 200 });
};
process.on('exit', code => { if (code === 0 && seen.size !== 3) process.exitCode = 91; });
`);
      const env = { PATH: process.env['PATH'] };
      const options = { cwd: repositoryPath('.'), env };
      const withoutTransform = args.filter(arg => arg !== '--experimental-transform-types');
      await expect(execute(process.execPath, ['--import', preload, ...withoutTransform], options)).rejects.toMatchObject({
        code: 2, stderr: expect.stringContaining('TypeScript parameter property is not supported in strip-only mode'),
      });
      const result = await execute(process.execPath, ['--import', preload, ...args], options);
      expect(result.stdout).toBe('');
      expect(result.stderr.trim().split('\n').map(line => line.split(' (')[0])).toEqual([
        'PASS health', 'PASS readiness', 'PASS schema_range', 'PASS connectivity', 'PASS canary', 'PASS sending_enabled',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('independent service network contracts', () => {
  it.each([118, 117])('preserves exact worker network for every one-off from schema %s', async from => {
    const h = harness({ from });
    h.services.api.networkConfiguration.awsvpcConfiguration.subnets.reverse();
    const network = structuredClone(h.services.worker.networkConfiguration.awsvpcConfiguration);
    expect(await h.run()).toMatchObject({ outcome: 'completed' });
    const launches = h.calls.filter(call => call.args[1] === 'run-task');
    expect(launches.length).toBeGreaterThan(0);
    for (const { args } of launches) expect(JSON.parse(args[args.indexOf('--network-configuration') + 1]!)).toEqual({ awsvpcConfiguration: network });
    expect(h.calls.filter(call => call.args[1] === 'update-service').every(call => !call.args.includes('--network-configuration'))).toBe(true);
  });
  const mutations: [string, (h: ReturnType<typeof harness>) => void][] = [
    ...(['api', 'worker'] as const).flatMap(name => [
      [`${name} empty subnets`, (h: ReturnType<typeof harness>) => { h.services[name].networkConfiguration.awsvpcConfiguration.subnets = []; }],
      [`${name} malformed subnets`, (h: ReturnType<typeof harness>) => { h.services[name].networkConfiguration.awsvpcConfiguration.subnets[0] = 'subnet-bad'; }],
      [`${name} duplicate subnets`, (h: ReturnType<typeof harness>) => { h.services[name].networkConfiguration.awsvpcConfiguration.subnets = [subnets[0]!, subnets[0]!]; }],
      [`${name} mismatched subnets`, (h: ReturnType<typeof harness>) => { h.services[name].networkConfiguration.awsvpcConfiguration.subnets[0] = 'subnet-00000000000000000'; }],
      [`${name} empty groups`, (h: ReturnType<typeof harness>) => { h.services[name].networkConfiguration.awsvpcConfiguration.securityGroups = []; }],
      [`${name} extra groups`, (h: ReturnType<typeof harness>) => { h.services[name].networkConfiguration.awsvpcConfiguration.securityGroups.push(albSG); }],
      [`${name} malformed group`, (h: ReturnType<typeof harness>) => { h.services[name].networkConfiguration.awsvpcConfiguration.securityGroups = ['sg-bad']; }],
      [`${name} private networking`, (h: ReturnType<typeof harness>) => { h.services[name].networkConfiguration.awsvpcConfiguration.assignPublicIp = 'DISABLED'; }],
    ] as [string, (h: ReturnType<typeof harness>) => void][]),
    ['worker wrong group', h => { h.services.worker.networkConfiguration.awsvpcConfiguration.securityGroups = [apiSG]; }],
    ['API worker group', h => { h.services.api.networkConfiguration.awsvpcConfiguration.securityGroups = [workerSG]; }],
    ['missing expected subnets', h => { delete h.env['TASK_SUBNETS']; }],
    ['malformed expected subnets', h => { h.env['TASK_SUBNETS'] = 'subnet-bad'; }],
    ['missing expected worker group', h => { delete h.env['TASK_SECURITY_GROUP']; }],
    ['mismatched expected worker group', h => { h.env['TASK_SECURITY_GROUP'] = albSG; }],
    ['wrong worker identity', h => { h.groups[0]!.GroupName = 'fss-prod-alb'; }],
    ['wrong API identity', h => { h.groups[1]!.GroupName = 'fss-prod-alb'; }],
    ['missing worker readback', h => { h.groups.shift(); }],
    ['worker open ingress', h => { h.groups[0]!.IpPermissions.push(structuredClone(h.groups[1]!.IpPermissions[0]!)); }],
    ['API VPC mismatch', h => { h.groups[1]!.VpcId = 'vpc-00000000000000000'; }],
    ['API empty ingress', h => { h.groups[1]!.IpPermissions = []; }],
    ['API extra ingress', h => { h.groups[1]!.IpPermissions.push(structuredClone(h.groups[1]!.IpPermissions[0]!)); }],
    ['API open IPv4', h => { h.groups[1]!.IpPermissions[0]!.IpRanges.push({ CidrIp: '0.0.0.0/0' }); }],
    ['API open IPv6', h => { h.groups[1]!.IpPermissions[0]!.Ipv6Ranges.push({ CidrIpv6: '::/0' }); }],
    ['API prefix ingress', h => { h.groups[1]!.IpPermissions[0]!.PrefixListIds.push({ PrefixListId: 'pl-00000000' }); }],
    ['API wrong port', h => { h.groups[1]!.IpPermissions[0]!.ToPort = 8081; }],
    ['API wrong protocol', h => { h.groups[1]!.IpPermissions[0]!.IpProtocol = '-1'; }],
    ['API wrong source', h => { h.groups[1]!.IpPermissions[0]!.UserIdGroupPairs[0]!.GroupId = workerSG; }],
    ['API foreign source owner', h => { h.groups[1]!.IpPermissions[0]!.UserIdGroupPairs[0]!.UserId = '000000000000'; }],
    ['ALB VPC mismatch', h => { h.groups[2]!.VpcId = 'vpc-00000000000000000'; }],
    ['ALB wrong identity', h => { h.groups[2]!.GroupName = 'foreign-alb'; }],
  ];
  it.each(mutations)('refuses %s before definitions or writes', async (_name, mutate) => {
    const h = harness(); mutate(h);
    expect(await h.run()).toMatchObject({ outcome: 'refused', writesStarted: false });
    expect(h.calls.some(call => ['describe-task-definition', 'register-task-definition', 'run-task', 'update-service'].includes(call.args[1] ?? ''))).toBe(false);
  });
});

function applicationSummaryScript(): string {
  const step = readRepositoryFile('.github/workflows/greenfield-deploy.yml').split('      - name: Actual application phase and recovery boundary\n')[1]?.split('\n  smoke:\n')[0];
  const script = step?.split('        run: |\n')[1];
  if (!script) throw new Error('Missing trusted always-finalizer');
  return script.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
}

/** Actual runRelease in an owned child. All remote transport stays in the existing parent fixture. */
async function interruptRelease(h: ReturnType<typeof harness>, statusFile: string, boundary: string, signal: NodeJS.Signals): Promise<Status> {
  const script = `
    import {runRelease} from ${JSON.stringify(modulePath)};
    import {writeFileSync} from 'node:fs';
    import {isDeepStrictEqual} from 'node:util';
    const data=JSON.parse(process.argv[1]), pending=new Map(); let clock=data.now, sequence=0;
    process.on('message',message=>{const request=pending.get(message.id);if(!request)return;pending.delete(message.id);message.error?request.reject(new Error(message.error)):request.resolve(message.output);});
    const io={now:()=>clock,equal:isDeepStrictEqual,
      save:state=>{writeFileSync(data.statusFile,JSON.stringify(state),{mode:0o600});process.send({kind:'save',state});},
      read:key=>data.files[key],sleep:async ms=>{clock+=ms;process.send({kind:'sleep',ms});},
      run:(program,args,input)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});process.send({kind:'run',id,program,args,input});})};
    await runRelease(io,data.env); process.exit(0);
  `;
  const data = { statusFile, env: h.env, now: h.io.now(), files: Object.fromEntries(['images', 'upgradeBinding', 'upgradeEvidence'].map(key => [key, h.io.read(key)])) };
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, JSON.stringify(data)], { env: { PATH: process.env['PATH'] }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let blocked = false, errors = '';
  child.stderr?.on('data', (chunk: Buffer) => { errors = `${errors}${chunk.toString()}`.slice(-4000); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Local interruption child timed out')); }, 20000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', (_code, actualSignal) => { clearTimeout(timer); if (blocked && actualSignal === signal) resolve(); else reject(new Error(`Unexpected local child exit: ${String(actualSignal)} ${errors}`)); });
      child.on('message', (message: { kind: string; state: Status; ms: number; id: number; program: string; args: string[]; input?: string }) => {
        if (message.kind === 'save') { h.io.save(message.state); return; }
        if (message.kind === 'sleep') { void h.io.sleep(message.ms); return; }
        const phase = h.states.at(-1)?.phase;
        const stop = boundary === 'preflight' ? message.program === 'gh' : phase === boundary && message.program === 'aws' && message.args[1] === (boundary === 'migrate' ? 'describe-tasks' : 'run-task');
        if (stop) { blocked = true; child.kill(signal); return; }
        void h.io.run(message.program, message.args, message.input).then(output => { if (child.connected) child.send({ id: message.id, output }); }, () => { if (child.connected) child.send({ id: message.id, error: 'synthetic_transport_failure' }); });
      });
    });
    return JSON.parse(readFileSync(statusFile, 'utf8')) as Status;
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}

describe('additive protected application release', () => {
  it('completes the simulated same-schema path without fabricating migration, preserving four CLI definitions', async () => {
    const h = harness(); const result = await h.run();
    expect(result.outcome, result.reason).toBe('completed'); expect(result.migrationStarted).toBe(false);
    expect(h.calls.some(c => c.args.join(' ').includes('release-prepare'))).toBe(false);
    expect(h.calls.filter(c => c.program === 'node' && c.args.includes('scripts/productionSmoke.mjs'))).toHaveLength(1);
    const persistent = Object.values(h.definitions).filter(d => d.taskDefinition.family === 'fss-prod-operations' && d.taskDefinition.containerDefinitions[0]!.command[0] === 'verify');
    expect(persistent).toHaveLength(2);
    expect(persistent[1]!.taskDefinition.containerDefinitions[0]!.entryPoint).toEqual(['node', 'apps/worker/src/tools/fss.ts']);
    expect(result.recoveryPoint?.restoreTested).toBe(false);
    for (const name of ['api', 'worker']) {
      for (const d of Object.values(h.definitions).filter(item => item.taskDefinition.family === `fss-prod-${name}`)) expect(d.taskDefinition.containerDefinitions[0]!.environment.filter(entry => entry.name === 'FSS_MODEL_TRANSPORT')).toEqual([{ name: 'FSS_MODEL_TRANSPORT', value: 'bedrock' }]);
    }
    expect(JSON.stringify(h.states)).not.toContain('secret-shaped-raw-line');
    expect(h.calls.every(c => !c.args.join(' ').includes('actions/variables'))).toBe(true);
    for (const c of h.calls.filter(c => c.args[1] === 'register-task-definition' && c.args.join(' ').includes('--eval'))) expect(c.args.join(' ')).toContain('BEGIN READ ONLY');
  });
  it.each(['api', 'worker'].flatMap(name => ['missing', 'wrong', 'duplicate', 'conflicting', 'secret-shadow'].map(fault => ({ name, fault }))))('refuses nonunique/non-Bedrock $name/$fault before any release write', async ({ name, fault }) => {
    const h = harness(), container = h.definitions[arn(name)]!.taskDefinition.containerDefinitions[0]!;
    if (fault === 'missing') container.environment = container.environment.filter(entry => entry.name !== 'FSS_MODEL_TRANSPORT');
    else if (fault === 'wrong') container.environment.find(entry => entry.name === 'FSS_MODEL_TRANSPORT')!.value = 'anthropic';
    else if (fault === 'secret-shadow') container.secrets.push({ name: 'FSS_MODEL_TRANSPORT', valueFrom: 'unapproved-reference' });
    else container.environment.push({ name: 'FSS_MODEL_TRANSPORT', value: fault === 'duplicate' ? 'bedrock' : 'anthropic' });
    const result = await h.run(); expect(result.reason).toBe('bedrock_not_explicit'); expect(result.writesStarted).toBe(false);
    expect(h.calls.some(c => ['register-task-definition', 'run-task', 'update-service'].includes(c.args[1] ?? ''))).toBe(false);
  });
  it.each(['api', 'worker'])('rechecks explicit %s Bedrock in candidate runtime readback', async name => {
    const h = harness({ fault: `runtime-bedrock-${name}` }); const result = await h.run();
    expect(result.outcome).toBe('repair-required'); expect(result.reason).toBe('bedrock_not_explicit');
    expect(h.calls.some(c => c.program === 'node' && c.args.includes('scripts/productionSmoke.mjs'))).toBe(false);
  });
  it.each([
    ['api', 'DATABASE_SECRET_ARN'], ['worker', 'DATABASE_SECRET_ARN'], ['operations', 'DATABASE_SECRET_ARN'],
    ['migration', 'MIGRATION_DATABASE_SECRET'], ['migration', 'FSS_RUNTIME_DATABASE_SECRET_ARN'],
  ].flatMap(([name, key]) => ['missing', 'mismatch', 'duplicate', 'conflicting', 'unexpected-reserved'].map(fault => ({ name: name!, key: key!, fault }))))('refuses reserved credential $name/$key/$fault before writes/stop/DDL', async ({ name, key, fault }) => {
    const h = harness({ from: 117 }), container = h.definitions[arn(name)]!.taskDefinition.containerDefinitions[0]!;
    const entry = container.secrets.find(item => item.name === key)!;
    const foreign = key === 'MIGRATION_DATABASE_SECRET' ? secret('app-runtime') : `${secret('app-runtime')}-foreign`;
    if (fault === 'missing') container.secrets = container.secrets.filter(item => item.name !== key);
    else if (fault === 'mismatch') entry.valueFrom = foreign;
    else if (fault === 'unexpected-reserved') container.secrets.push({ name: name === 'migration' ? 'DATABASE_SECRET_ARN' : 'MIGRATION_DATABASE_SECRET', valueFrom: foreign });
    else container.secrets.push({ ...entry, valueFrom: fault === 'duplicate' ? entry.valueFrom : foreign });
    const result = await h.run(); expect(result.outcome).toBe('refused'); expect(result.writesStarted).toBe(false); expect(result.migrationStarted).toBe(false);
    expect(h.calls.some(c => ['register-task-definition', 'run-task', 'update-service'].includes(c.args[1] ?? ''))).toBe(false);
  });
  it('refuses a leftover temporary operations entrypoint before any write', async () => {
    const h = harness(); h.definitions[arn('operations')]!.taskDefinition.containerDefinitions[0]!.entryPoint = ['node', '--eval', 'not-authorized'];
    const result = await h.run(); expect(result.reason).toBe('oneoff_cli_contract_changed'); expect(result.outcome).toBe('refused');
    expect(h.calls.some(c => c.args[1] === 'register-task-definition')).toBe(false);
  });
  it('refuses a one-off image that is not the observed worker baseline', async () => {
    const h = harness(); h.definitions[arn('migration')]!.taskDefinition.containerDefinitions[0]!.image = `${registry}/fss-prod-worker@${NEW.worker}`;
    expect((await h.run()).reason).toBe('oneoff_baseline_image_changed');
    expect(h.calls.some(c => c.args[1] === 'register-task-definition')).toBe(false);
  });
  it.each(['true', '', 'FALSE'])('refuses process-local hold %s without any write', async hold => {
    const h = harness(); h.env['FSS_RELEASE_HOLD'] = hold;
    expect((await release.runRelease(h.io, h.env)).outcome).toBe('refused'); expect(h.calls).toHaveLength(0);
  });
  it.each(['image-attempt', 'main', 'evidence'])('refuses stale %s before operational changes', async fault => {
    const h = harness({ fault, from: 117 }); const result = await h.run();
    expect(result.outcome).toBe('refused'); expect(h.calls.some(c => c.args[1] === 'register-task-definition')).toBe(false);
  });
  it.each(['off', 'finishing', 'definition', 'gate-later', 'pitr', 'pitr-missing', 'pitr-oldest', 'pitr-drift', 'busy'])('contains %s without starting migration', async fault => {
    const h = harness({ fault, from: 117 }); const result = await h.run();
    expect(result.outcome, result.reason).not.toBe('completed'); expect(result.migrationStarted).toBe(false);
    expect(h.calls.some(c => c.args.join(' ').includes('release-prepare'))).toBe(false);
  });
  it.each([['pitr', 'pitr_not_covering_quiescence'], ['pitr-oldest', 'pitr_not_covering_quiescence'], ['pitr-missing', 'backup_window_missing'], ['pitr-drift', 'backup_window_binding_changed']])('requires a real covered post-stop recovery point for %s', async (fault, reason) => {
    const h = harness({ fault, from: 117 }); const result = await h.run();
    expect(result.reason).toBe(reason); expect(result.recoveryPoint).toBeNull();
    expect(h.services.api.desiredCount).toBe(0); expect(result.migrationStarted).toBe(false);
    expect(h.calls.filter(c => c.args[1] === 'describe-db-instance-automated-backups').every(c => c.phase === 'recovery-pinned')).toBe(true);
  });
  it('keeps new-schema smoke failure forward-only with native old rollback still disabled', async () => {
    const h = harness({ from: 117, fault: 'smoke' }); const result = await h.run();
    expect(result.observedSchema).toBe(118); expect(result.rollback).toBeUndefined();
    expect(h.services.api.deploymentConfiguration.deploymentCircuitBreaker.rollback).toBe(false);
    expect(h.calls.some(c => c.phase === 'restore-compatible-circuit-breaker')).toBe(false);
  });
  it('cleans a positively stopped nonzero reader without replay or reading raw failure logs', async () => {
    const h = harness({ fault: 'reader-nonzero' }); const result = await h.run();
    expect(result.reason).toBe('task_nonzero_exit'); expect(result.temporaryReaderDefinition).toBeNull();
    expect(h.calls.filter(c => c.args[1] === 'run-task')).toHaveLength(1);
    expect(h.calls.filter(c => c.args[1] === 'deregister-task-definition')).toHaveLength(1);
    expect(h.calls.filter(c => c.program === 'aws' && c.args[0] === 'logs')).toHaveLength(0);
  });
  it.each(['start-unknown', 'exit-unknown', 'foreign-owner'])('does not replay or deregister after reader %s', async fault => {
    const h = harness({ fault }); const result = await h.run();
    expect(result.outcome).toBe('repair-required'); expect(result.temporaryReaderDefinition).toBeTruthy();
    expect(h.calls.filter(c => c.args[1] === 'run-task')).toHaveLength(1);
    expect(h.calls.filter(c => c.args[1] === 'deregister-task-definition')).toHaveLength(0);
  });
  it('does not guess rollback after an unknown service write', async () => {
    const h = harness({ fault: 'update-unknown' }); const result = await h.run();
    expect(result.outcome).toBe('repair-required'); expect(result.rollback).toBeUndefined();
    expect(h.calls.filter(c => c.args[1] === 'update-service')).toHaveLength(1);
  });
  it.each(['smoke', 'rollout'])('permits only compatible app rollback after known same-schema %s failure', async fault => {
    const h = harness({ fault }); const result = await h.run();
    expect(result.outcome).toBe('repair-required'); expect(result.rollback, result.reason).toBe('previous-application-restored');
    expect(h.services.api.taskDefinition).toBe(arn('api')); expect(h.services.worker.taskDefinition).toBe(arn('worker'));
  });
  it.each(['migration', 'cancel', 'breaker-race'])('never restores old settings/definitions after %s', async fault => {
    const h = harness({ fault, from: 117 }); const result = await h.run();
    expect(result.outcome).toBe('repair-required'); expect(result.rollback).toBeUndefined();
    expect(h.services.api.deploymentConfiguration.deploymentCircuitBreaker.rollback).toBe(false);
    expect(h.calls.some(c => c.phase === 'restore-compatible-circuit-breaker')).toBe(false);
  });
  it('disables native rollback before stop and restores it only after compatible completed smoke', async () => {
    const h = harness({ from: 117 }); const result = await h.run();
    expect(result.outcome, result.reason).toBe('completed');
    const phases = h.states.map(s => s.phase);
    expect(phases.indexOf('suppress-incompatible-rollback')).toBeLessThan(phases.indexOf('stop'));
    expect(phases.indexOf('stop')).toBeLessThan(phases.indexOf('migrate'));
    expect(phases.indexOf('smoke')).toBeLessThan(phases.indexOf('restore-compatible-circuit-breaker'));
    expect(h.services.worker.deploymentConfiguration.deploymentCircuitBreaker.rollback).toBe(true);
    expect(h.calls.filter(c => c.args.includes('run-task') && c.args.join(' ').includes('release-prepare'))).toHaveLength(1);
  });
  it('validates candidates before credentials and admits no new global writer', () => {
    const workflow = readRepositoryFile('.github/workflows/greenfield-deploy.yml');
    const job = workflow.split('\n  application:\n')[1]?.split('\n  smoke:\n')[0] ?? '';
    expect(job.indexOf('Validate immutable candidate before credentials')).toBeLessThan(job.indexOf('Assume narrow protected application identity'));
    expect(job).toContain('environment: production-release-review');
    expect(job).not.toContain('$GITHUB_ENV'); expect(job).not.toContain('actions: write');
    expect(job.split('    steps:\n')[0]).not.toContain("FSS_RELEASE_HOLD: 'false'");
    expect(workflow).toContain('default: automatic');
  });
});

describe('trusted local always-finalizer after genuine process interruption', () => {
  it.each([
    { boundary: 'preflight', signal: 'SIGTERM' as const },
    { boundary: 'observe-stored-off', signal: 'SIGINT' as const },
    { boundary: 'migrate', signal: 'SIGTERM' as const },
  ])('finalizes real $signal at $boundary without replay or remote cleanup', async ({ boundary, signal }) => {
    const directory = mkdtempSync(join(process.env['JCODE_SCRATCH_DIR'] ?? tmpdir(), 'fss-application-interrupt-'));
    try {
      mkdirSync(join(directory, 'application'));
      const statusFile = join(directory, 'application/status.json'), h = harness({ from: 117 });
      const interrupted = await interruptRelease(h, statusFile, boundary, signal);
      expect(interrupted.phase).toBe(boundary); expect(interrupted.outcome).toBe(boundary === 'preflight' ? 'pending' : 'started');
      if (boundary !== 'preflight') expect(interrupted.currentTaskOwner).toMatch(/^fss-app-33-/u);
      if (boundary === 'migrate') { expect(interrupted.observedSchema).toBe('unknown'); expect(interrupted.currentTaskArn).toContain('/owned'); }
      const calls = h.calls.length;
      const { stdout } = await execute('bash', ['-c', applicationSummaryScript()], { cwd: repositoryPath(''), env: { PATH: process.env['PATH'], RUNNER_TEMP: directory, GITHUB_STEP_SUMMARY: join(directory, 'summary') } });
      const finalized = JSON.parse(readFileSync(statusFile, 'utf8')) as Status;
      expect(finalized).toEqual({ ...interrupted, outcome: boundary === 'preflight' ? 'refused' : 'repair-required', reason: 'release_interrupted' });
      expect(h.calls).toHaveLength(calls); expect(statSync(statusFile).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(directory, 'summary'), 'utf8')).toContain('release_interrupted');
      expect(stdout).toBe(readFileSync(join(directory, 'summary'), 'utf8'));
      if (boundary === 'migrate') { expect(h.services.api.desiredCount).toBe(0); expect(h.services.api.deploymentConfiguration.deploymentCircuitBreaker.rollback).toBe(false); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it.each(['completed', 'repair-required', 'refused'])('never downgrades or replaces a terminal %s result', async outcome => {
    const directory = mkdtempSync(join(process.env['JCODE_SCRATCH_DIR'] ?? tmpdir(), 'fss-application-finalize-'));
    try {
      mkdirSync(join(directory, 'application'));
      const h = harness(outcome === 'repair-required' ? { from: 117, fault: 'migration' } : outcome === 'refused' ? { fault: 'main' } : {});
      const result = await h.run(); expect(result.outcome).toBe(outcome);
      const statusFile = join(directory, 'application/status.json');
      const privateStatus = { ...result, privateBody: 'private-business-body', credentials: 'private-credential-value' };
      writeFileSync(statusFile, JSON.stringify(privateStatus), { mode: 0o600 });
      const { stdout } = await execute('bash', ['-c', applicationSummaryScript()], { cwd: repositoryPath(''), env: { PATH: process.env['PATH'], RUNNER_TEMP: directory, GITHUB_STEP_SUMMARY: join(directory, 'summary') } });
      expect(JSON.parse(readFileSync(statusFile, 'utf8'))).toEqual(privateStatus);
      expect(stdout).toBe(readFileSync(join(directory, 'summary'), 'utf8'));
      expect(JSON.parse(stdout)).toMatchObject({ phase: result.phase, outcome, reason: result.reason ?? null, observedSchema: result.observedSchema });
      expect(stdout).not.toMatch(/private-business-body|private-credential-value|privateBody|credentials/u);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

async function prepareRuntimeFixture(db: Awaited<ReturnType<typeof createUpgradeDatabase>>, migrator: Parameters<typeof ensureRuntimeDatabaseUser>[0]): Promise<void> {
  // Shared CI groups belong to an earlier suite. PG16+ CREATEROLE alone cannot
  // grant them. Mirror the creator's automatic grant, not superuser execution.
  const owner = await db.connect('owner');
  for (const group of ['app_runtime', 'migration']) {
    await owner.session.query(`GRANT ${group} TO ${MIGRATOR_LOGIN_ROLE} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`);
  }
  const permissions = await migrator.query<{ superuser: boolean; inherit: boolean; admin: boolean }>(
    `SELECT r.rolsuper AS superuser, pg_has_role(current_user, 'app_runtime', 'USAGE') AS inherit,
       (SELECT admin_option FROM pg_auth_members WHERE roleid='app_runtime'::regrole AND member=r.oid) AS admin
     FROM pg_roles r WHERE r.rolname=current_user`,
  );
  expect(permissions.rows).toEqual([{ superuser: false, inherit: false, admin: true }]);
  const ensured = await ensureRuntimeDatabaseUser(migrator, { secretValue: db.runtimeSecretValue });
  expect(ensured.ok).toBe(true);
}

describe('real disposable PostgreSQL migration and failure boundary (not production acceptance)', () => {
  it('upgrades actual 117→118 with business data intact and refuses old app range', async () => {
    const db = await createUpgradeDatabase();
    try {
      const migrator = await db.connect(MIGRATOR_LOGIN_ROLE);
      await applyMigrations(migrator.session, { throughVersion: 117 });
      await prepareRuntimeFixture(db, migrator.session);
      await migrator.session.query("INSERT INTO workspaces(slug,display_name) VALUES ('release-test','Preserved relationship history')");
      const runtime = await db.connect(RUNTIME_LOGIN_ROLE);
      const h = harness({ from: 117, migrate: async () => { await applyMigrations(migrator.session); }, verify: async () => {
        const actual = await runVerify(runtime.session, readToolConfig({ DATABASE_URL: db.runtimeUrl }));
        expect(actual.ok).toBe(true); return actual.ok ? actual.value : {};
      } });
      const result = await h.run(); expect(result.outcome, result.reason).toBe('completed');
      expect(await readAppliedSchemaVersion(runtime.session)).toBe(118);
      expect(acceptsSchemaVersion({ minimum: 117, maximum: 117 }, 118)).toBe(false);
      expect((await runtime.session.query('SELECT display_name FROM workspaces')).rows[0]?.['display_name']).toBe('Preserved relationship history');
    } finally { await db.drop(); await db.stop(); }
  }, 120000);
  it('contains an actual transactional DDL failure, conserves writes, then repairs forward without replay', async () => {
    const db = await createUpgradeDatabase();
    try {
      const migrator = await db.connect(MIGRATOR_LOGIN_ROLE);
      await applyMigrations(migrator.session, { throughVersion: 117 });
      await migrator.session.query("INSERT INTO workspaces(slug,display_name) VALUES ('release-failure','Never restore away this write')");
      const migrations = loadMigrations().map(m => m.version === 118 ? { ...m, sql: `${m.sql}\nSELECT 1/0;` } : m);
      const h = harness({ from: 117, migrate: async () => { await applyMigrations(migrator.session, { migrations }); } });
      const result = await h.run();
      expect(result.outcome).toBe('repair-required'); expect(result.observedSchema).toBe('unknown');
      expect(await readAppliedSchemaVersion(migrator.session)).toBe(117);
      expect(h.calls.filter(c => c.args[1] === 'run-task' && c.args.join(' ').includes('release-prepare'))).toHaveLength(1);
      expect(h.services.api.desiredCount).toBe(0); expect(h.services.api.deploymentConfiguration.deploymentCircuitBreaker.rollback).toBe(false);
      await applyMigrations(migrator.session);
      expect(await readAppliedSchemaVersion(migrator.session)).toBe(118);
      expect((await migrator.session.query('SELECT display_name FROM workspaces')).rows[0]?.['display_name']).toBe('Never restore away this write');
    } finally { await db.drop(); await db.stop(); }
  }, 120000);
  it('executes the exact temporary reader as runtime READ ONLY with bounded body-free output', async () => {
    const db = await createUpgradeDatabase();
    try {
      const migrator = await db.connect(MIGRATOR_LOGIN_ROLE);
      await applyMigrations(migrator.session);
      await prepareRuntimeFixture(db, migrator.session);
      await migrator.session.query("INSERT INTO workspaces(slug,display_name) VALUES ('off-reader','Private business name never returned')");
      const owner = await db.connect('owner');
      const runReader = async () => execute(process.execPath, ['--experimental-transform-types', '--input-type=module', '--eval', release.offRead], { cwd: repositoryPath(''), env: { PATH: process.env['PATH'], DATABASE_URL: db.runtimeUrl, FSS_SENDING_ENABLED: 'true' } });
      const read = await runReader();
      const answer = JSON.parse(read.stdout) as Record<string, unknown>;
      expect(answer['releaseOff']).toBe(false); // No setting is NOT permission to assume stored OFF.
      expect(answer['schema']).toBe(118);
      expect(read.stdout).not.toContain('Private business'); expect(read.stdout).not.toContain(db.runtimeUrl);
      expect(Object.keys(answer).sort()).toEqual(['effectiveOff', 'finishing', 'observedAt', 'releaseOff', 'schema', 'storedOff', 'versions']);
      await owner.session.query("INSERT INTO workspace_settings(workspace_id,setting_key,version,value) SELECT id,'sending_enabled',4,'{\"enabled\":false}'::jsonb FROM workspaces");
      const off = JSON.parse((await runReader()).stdout) as Record<string, unknown>;
      expect(off).toMatchObject({ releaseOff: true, storedOff: true, effectiveOff: true, finishing: 0, schema: 118, versions: [4] });
      await owner.session.query("UPDATE workspace_settings SET value='{\"enabled\":true}'::jsonb");
      expect(JSON.parse((await runReader()).stdout)).toMatchObject({ releaseOff: false, storedOff: false, effectiveOff: false, versions: [4] });
    } finally { await db.drop(); await db.stop(); }
  }, 120000);
});
