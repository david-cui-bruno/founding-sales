import { isDeepStrictEqual } from 'node:util';
import { expect } from 'vitest';
import { ciGateReleaseRecordSchema } from '@fss/contracts';
import { repositoryPath } from './repository.ts';

interface Container {
  name: string; image: string; entryPoint: string[]; command: string[];
  environment: { name: string; value: string }[]; secrets: { name: string; valueFrom: string }[];
  logConfiguration: { options: Record<string, string> };
}
interface Definition {
  taskDefinitionArn: string; family: string; taskRoleArn: string; executionRoleArn: string;
  containerDefinitions: Container[]; tags?: { key: string; value: string }[];
  status?: string; registeredBy?: string;
}
interface Service {
  serviceName: string; status: string; desiredCount: number; runningCount: number; pendingCount: number;
  taskDefinition: string; deployments: { taskDefinition: string; rolloutState: string }[];
  deploymentConfiguration: { deploymentCircuitBreaker: { enable: boolean; rollback: boolean } };
  networkConfiguration: { awsvpcConfiguration: { subnets: string[]; securityGroups: string[]; assignPublicIp: string } };
}
export interface Status {
  phase: string; outcome: string; reason?: string; observedSchema: number | string; migrationStarted: boolean; writesStarted: boolean;
  recoveryPoint: { timestamp: string; restoreTested: boolean } | null; rollback?: string;
  currentTaskArn?: string | null; currentTaskOwner?: string; temporaryReaderDefinition?: string | null;
  offObservation?: { outcome: string; readerDefinitionArn: string | null };
  off?: { storedOff: boolean; observedAt: string };
  readerRecovery?: { outcome: string; taskArn: string; readerDefinitionArn: string; sourceOperationsDefinitionArn: string; startedBy: string };
}
export interface IO {
  now(): number; equal(a: unknown, b: unknown): boolean; sleep(ms: number): Promise<void>;
  save(state: Status): void; read(key: string): unknown; run(program: string, args: string[], input?: string): Promise<string>;
}
export const modulePath = repositoryPath('infra/scripts/application-release.mjs');
export const release = await import(modulePath) as { runRelease(io: IO, env: Record<string, string>): Promise<Status>; offRead: string };
export const COMMIT = 'bced9eebcc4c3fef4ee51d7eefd0f92e66f318c7', BASE = 'a'.repeat(40), DISPATCH = 'c'.repeat(40);
const ACCOUNT = '326255650484';
export const subnets = ['subnet-07ae1d846228e9e83', 'subnet-01f53573964548294'];
export const workerSG = 'sg-11111111111111111', apiSG = 'sg-22222222222222222', albSG = 'sg-33333333333333333';
export const registry = `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com`;
export const cluster = `arn:aws:ecs:us-east-1:${ACCOUNT}:cluster/fss-prod-cluster`;
export const image = (s: string) => `sha256:${s.repeat(64)}`;
export const NEW = { api: image('c'), worker: image('d') };
export const OLD = { api: image('a'), worker: image('b') };
const side = (name: string): 'api' | 'worker' => name === 'api' ? 'api' : 'worker';
export const arn = (name: string, revision = 1) => `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/fss-prod-${name}:${String(revision)}`;
export const tags = [{ key: 'NamePrefix', value: 'fss-prod' }];
export const secret = (name: string) => `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:fss-prod/${name}-database-aaaaaa`;
export const environment = (): Record<string, string> => ({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: DISPATCH, GITHUB_RUN_ID: '33', GITHUB_REPOSITORY: 'david-cui-bruno/founding-sales', AWS_REGION: 'us-east-1', COMMIT, RUN_ID: '11', GATE_RUN_ID: '22', FSS_RELEASE_HOLD: 'false', FSS_PRODUCTION_ORIGIN: 'https://api.usecallie.com', TASK_SUBNETS: [...subnets].reverse().join(','), TASK_SECURITY_GROUP: workerSG });
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
  recovery?: boolean; historical?: boolean; historyEscapes?: boolean;
  migrate?: () => Promise<void>; verify?: () => Promise<unknown>; off?: () => Promise<unknown>;
  docker?: (args: string[]) => Promise<string>;
}
export function harness(options: Options = {}) {
  const from = options.from ?? 118, to = options.to ?? 118;
  let schema = from, clock = Date.parse('2026-10-18T18:00:00Z'), revision = options.recovery ? 337 : 1, taskNumber = 0, recordStored = options.recovery === true, checks = 0;
  let recoveryRemoved = false, storedRecord: unknown;
  let promotionGateChanged = false;
  const productionTags: Partial<Record<'api' | 'worker', string>> = {};
  const calls: { program: string; args: string[]; phase: string }[] = [], states: Status[] = [];
  const definitions: Record<string, { taskDefinition: Definition; tags: typeof tags }> = {};
  for (const name of ['api', 'worker', 'migration', 'operations']) definitions[arn(name)] = { taskDefinition: definition(name, from), tags };
  const services = { api: service('api'), worker: service('worker') };
  const groups = securityGroups(), env = environment();
  const tasks = new Map<string, { definition: Definition; answer: unknown; exitCode: number; owner: string }>();
  const artifacts = { schema: 'fss.image-digests.v1', commit: COMMIT, workflowRunId: '11', workflowRunAttempt: '1', images: Object.fromEntries(['api', 'worker'].map(name => [name, { repository: `fss-rh-${name}`, tag: `ci-${COMMIT}`, digest: NEW[side(name)], schemaRange: { minimum: to, maximum: to } }])) };
  const failedTask = `${cluster.replace(':cluster/', ':task/')}/a91d7da900aa401789560498b29d7b12`;
  const failedOwner = 'fss-app-40522197864-off-3';
  if (options.recovery) {
    env['FSS_FAILED_READER_CUSTODY'] = JSON.stringify({ taskArn: failedTask, readerDefinitionArn: arn('operations', 337), startedBy: failedOwner, sourceOperationsDefinitionArn: arn('operations', 335), ...(options.historical ? { evidenceBasis: 'historical-readonly-retirement' } : {}) });
    for (const name of ['api', 'worker', 'operations', 'migration']) definitions[arn(name)]!.taskDefinition.containerDefinitions[0]!.image = `${registry}/fss-prod-${side(name)}@${NEW[side(name)]}`;
    const source = structuredClone(definitions[arn('operations')]!);
    source.taskDefinition.taskDefinitionArn = arn('operations', 335); source.taskDefinition.status = 'ACTIVE';
    source.taskDefinition.registeredBy = `arn:aws:sts::${ACCOUNT}:assumed-role/fss-prod-ci-application/fss-prod-application-40522197864`;
    definitions[arn('operations', 335)] = source;
    const reader = structuredClone(source); reader.taskDefinition.taskDefinitionArn = arn('operations', 337);
    reader.taskDefinition.containerDefinitions[0]!.entryPoint = ['node', '--experimental-transform-types', '--input-type=module', '--eval', release.offRead];
    reader.taskDefinition.containerDefinitions[0]!.command = [];
    definitions[arn('operations', 337)] = reader;
    productionTags.api = NEW.api; productionTags.worker = NEW.worker;
    storedRecord = ciGateReleaseRecordSchema.parse({ schema: 'fss.release-record.v1', source: 'ci-gate', releaseGateReference: `ci-gate-22-${COMMIT.slice(0, 12)}`, recordedAt: options.fault === 'record-conflict' ? '2026-10-18T17:49:00Z' : '2026-10-18T17:50:00Z', suite: 'pass', commit: COMMIT, gateRunId: '22', gateRunUrl: 'https://github.com/david-cui-bruno/founding-sales/actions/runs/22', imagesRunId: '11', artifacts: { api: NEW.api, worker: NEW.worker, desktopCommitStamp: COMMIT }, enablesSending: false });
  }
  const serviceTaskArn = (name: string, n: number) => `${cluster.replace(':cluster/', ':task/')}/${options.recovery ? `${name === 'api' ? 'a' : 'b'}${String(n).padStart(31, '0')}` : `${name}${String(n)}`}`;
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
        if (options.historical && args[1]?.includes('/actions/jobs/')) {
          if (args[1].endsWith('/logs')) {
            if (options.historyEscapes && !args.includes('--allow-escape-sequences')) throw new Error('command_gh_failed');
            const priorStatus = { phase: 'smoke', outcome: 'repair-required', writesStarted: true, migrationStarted: false, fromSchema: 142, targetSchema: 142, observedSchema: 142, recoveryPoint: null, reason: 'task_failed_or_foreign', rollback: null, currentTaskArn: failedTask, currentTaskOwner: failedOwner, lastStoppedTaskArn: null, lastTaskExitCode: 0, temporaryReaderDefinition: arn('operations', 337), previousDefinitions: {}, candidateDefinitions: { operations: arn('operations', 335) } };
            return [...(options.historyEscapes ? ['\u001b[32mEarlier runner output\u001b[0m'] : []), '##[group]Run if [ -f "$RUNNER_TEMP/application/status.json" ]; then', `  COMMIT: ${COMMIT}`, '  RUN_ID: 40519161322', '  RUN_ATTEMPT: 1', '  GATE_RUN_ID: 40519161282', '##[endgroup]', ...JSON.stringify(priorStatus, null, 2).split('\n'), 'Post job cleanup.', 'Cleaning up orphan processes'].map((line, n) => `2026-10-27T14:51:22.${String(n).padStart(7, '0')}Z ${line}`).join('\n') + '\n';
          }
          return JSON.stringify({ id: 122252105573, run_id: 40522197864, run_attempt: 1, head_sha: COMMIT, name: 'Opt-in protected application release (legacy remains default)', status: 'completed', conclusion: 'failure', steps: [{ number: 6, name: 'Execute only this approved application release', status: 'completed', conclusion: 'failure', started_at: '2026-10-27T14:34:28Z', completed_at: '2026-10-27T14:51:22Z' }, { number: 7, name: 'Actual application phase and recovery boundary', status: 'completed', conclusion: 'success', started_at: '2026-10-27T14:51:22Z', completed_at: '2026-10-27T14:51:22Z' }] });
        }
        if (options.historical && args[1]?.endsWith('/attempts/1/jobs?per_page=100')) return JSON.stringify({ total_count: 1, jobs: [JSON.parse(await io.run('gh', ['api', 'repos/david-cui-bruno/founding-sales/actions/jobs/122252105573'])) as unknown] });
        if (options.historical && args[1]?.endsWith('/attempts/1')) return JSON.stringify({ ...run('greenfield-deploy', 40522197864), event: 'workflow_dispatch', conclusion: 'failure' });
        if (args[1]?.endsWith('/actions/runs/40522197864')) return JSON.stringify({ ...run('greenfield-deploy', 40522197864), event: 'workflow_dispatch', conclusion: 'failure' });
        if (promotionGateChanged && args[1]?.includes('/actions/runs/22')) return JSON.stringify({ ...run('greenfield', 22), conclusion: 'failure' });
        if (options.fault === 'gate-later' && checks > 12) return JSON.stringify({ ...run('greenfield', 22), conclusion: 'failure' });
        if (args[1]?.includes('/actions/runs/22')) return JSON.stringify(run('greenfield', 22));
        if (args[1]?.includes('/actions/runs/11')) return JSON.stringify({ ...run('greenfield-images', 11), run_attempt: options.fault === 'image-attempt' ? 2 : 1 });
        if (args[1]?.includes('/git/ref/')) return JSON.stringify({ object: { sha: options.fault === 'main' ? BASE : DISPATCH } });
        return JSON.stringify({ workflow_runs: [run('greenfield', 22)] });
      }
      if (program === 'curl') return JSON.stringify({ build: { commit: options.recovery || current() === 'runtime-verify' ? COMMIT : BASE }, schema: { databaseVersion: schema, accepted: true } });
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
          if (options.fault === 'recovery-tag-lost') return JSON.stringify({ images: [], failures: [{ imageId, failureCode: 'ImageNotFound' }] });
          return JSON.stringify(productionTags[which]
            ? { images: [{ imageId: { ...imageId, imageDigest: productionTags[which] } }], failures: [] }
            : { images: [], failures: [{ imageId, failureCode: 'ImageNotFound' }] });
        }
        return JSON.stringify({ imageDetails: [{ imageDigest: arg(args, '--image-ids').startsWith('imageDigest=') || options.fault === 'promotion-digest-drift' ? (options.recovery ? NEW[which] : OLD[which]) : productionTags[which], imageTags: [`ci-${options.recovery ? COMMIT : BASE}`] }] });
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
        let named = arg(args, '--task-definition');
        if (options.recovery && named === 'fss-prod-operations') named = Object.entries(definitions).filter(([, value]) => value.taskDefinition.family === 'fss-prod-operations' && value.taskDefinition.status === 'ACTIVE').sort(([a], [b]) => Number(b.split(':').at(-1)) - Number(a.split(':').at(-1)))[0]?.[0] ?? arn('operations', recoveryRemoved ? 335 : 337);
        const found = structuredClone(definitions[named] ?? definitions[arn(named.slice('fss-prod-'.length))]);
        if (options.fault?.startsWith('runtime-bedrock') && current() === 'runtime-verify' && found?.taskDefinition.family === `fss-prod-${options.fault.endsWith('worker') ? 'worker' : 'api'}`) found.taskDefinition.containerDefinitions[0]!.environment = found.taskDefinition.containerDefinitions[0]!.environment.filter(entry => entry.name !== 'FSS_MODEL_TRANSPORT');
        return JSON.stringify(found);
      }
      if (action === 'register-task-definition') {
        const document = JSON.parse(arg(args, '--cli-input-json')) as Definition;
        const name = document.family.slice('fss-prod-'.length), registered = arn(name, ++revision);
        const definition = { ...document, taskDefinitionArn: registered, status: 'ACTIVE' }; delete definition.tags;
        if (options.fault === 'definition' && name === 'api') definition.containerDefinitions[0]!.environment.push({ name: 'UNREVIEWED', value: 'changed' });
        definitions[registered] = { taskDefinition: definition, tags: document.tags ?? [] };
        return JSON.stringify({ taskDefinition: definition });
      }
      if (action === 'deregister-task-definition') {
        if (options.recovery && arg(args, '--task-definition') === arn('operations', 337)) {
          recoveryRemoved = true; definitions[arn('operations', 337)]!.taskDefinition.status = 'INACTIVE';
          if (options.fault === 'recovery-lost-write') throw new Error('command_aws_failed');
        }
        if (definitions[arg(args, '--task-definition')]) definitions[arg(args, '--task-definition')]!.taskDefinition.status = 'INACTIVE';
        return '{}';
      }
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
        if (!args.includes('--service-name')) return JSON.stringify({ taskArns: options.recovery && current() === 'reader-recovery' ? (args.includes('STOPPED') ? (options.historical ? [] : [failedTask]) : ['api', 'worker'].flatMap(name => Array.from({ length: name === 'api' ? 2 : 1 }, (_, n) => serviceTaskArn(name, n)))) : [] });
        const name = arg(args, '--service-name').endsWith('api') ? 'api' : 'worker';
        return JSON.stringify({ taskArns: Array.from({ length: services[name].desiredCount }, (_, n) => serviceTaskArn(name, n)) });
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
          if (recordStored && !isDeepStrictEqual(storedRecord, record)) { exitCode = 1; answer = { reason: 'release_record_conflict' }; }
          else { answer = { outcome: recordStored ? 'existing' : 'created', reference: record.releaseGateReference }; recordStored = true; storedRecord = record; }
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
        if (options.historical && ids.length === 1 && ids[0] === failedTask) return JSON.stringify({ tasks: [], failures: [{ arn: failedTask, reason: 'MISSING' }] });
        return JSON.stringify({ tasks: ids.map(named => {
          if (options.recovery && named === failedTask) return { taskArn: named, clusterArn: cluster, startedBy: failedOwner, taskDefinitionArn: arn('operations', 337), lastStatus: 'STOPPED', stopCode: 'TaskFailedToStart', stoppedReason: 'CannotPullContainerError: unavailable', containers: [{ name: 'operations', image: `${registry}/fss-prod-worker@${NEW.worker}` }], overrides: { containerOverrides: [{ name: 'operations', command: [] }], inferenceAcceleratorOverrides: [] } };
          const taskId = named.split('/').at(-1) ?? '', task = tasks.get(taskId);
          if (task) return { taskArn: named, clusterArn: cluster, startedBy: options.fault === 'foreign-owner' ? 'foreign' : task.owner, taskDefinitionArn: task.definition.taskDefinitionArn, lastStatus: options.fault === 'exit-unknown' ? 'RUNNING' : 'STOPPED', containers: [{ name: task.definition.containerDefinitions[0]!.name, exitCode: task.exitCode, imageDigest: task.definition.containerDefinitions[0]!.image.split('@')[1] }] };
          const name = taskId.startsWith('api') || options.recovery && taskId.startsWith('a') ? 'api' : 'worker', d = definitions[services[name].taskDefinition]!.taskDefinition;
          return { taskArn: named, clusterArn: cluster, group: `service:fss-prod-${name}`, taskDefinitionArn: d.taskDefinitionArn, lastStatus: 'RUNNING', containers: [{ name, imageDigest: d.containerDefinitions[0]!.image.split('@')[1] }] };
        }), failures: [] });
      }
      throw new Error('unexpected_cloud_action');
    },
  };
  return { io, env, groups, calls, states, definitions, services, artifacts, productionTags, schema: () => schema, run: () => release.runRelease(io, env) };
}

