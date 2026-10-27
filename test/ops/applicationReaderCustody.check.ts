import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { readRepositoryFile, repositoryPath } from './support/repository.ts';

type Json = Record<string, unknown>;
interface TestContainer { name: string; image: string; reason?: string; imageDigest?: string; exitCode?: number }
interface TestTask {
  taskArn: string; clusterArn: string; startedBy: string; taskDefinitionArn: string;
  lastStatus?: string; stopCode: string; stoppedReason: string; startedAt?: string;
  containers: TestContainer[]; overrides: unknown;
}
interface Custody { taskArn: string; readerDefinitionArn: string; sourceOperationsDefinitionArn: string; startedBy: string; failedRunId: string }
interface RecoveryOptions {
  custody: Custody; cluster: string; source: { definition: Json; tags: Json[] };
  baseline: Record<string, Json>; network: Json; state: Json; save(): void;
  beforeWrite(): Promise<void>;
  aws(service: string, action: string, args?: string[], write?: boolean): Promise<unknown>;
  gh(path: string): Promise<unknown>; commit: string; repository: string;
}
const { recoverApplicationReader, readerRecoveryCommandEnvironment } = await import(repositoryPath('infra/scripts/application-reader-recovery.mjs')) as {
  recoverApplicationReader(options: RecoveryOptions): Promise<void>;
  readerRecoveryCommandEnvironment(environment: Record<string, string>, program: string, args: string[]): Record<string, string>;
};
const { parseFailedReaderCustody } = await import(repositoryPath('infra/scripts/application-reader-custody.mjs')) as {
  parseFailedReaderCustody(value: unknown, currentRunId: string): Custody | null;
};
const { offRead } = await import(repositoryPath('infra/scripts/release-safety.mjs')) as { offRead: string };
const cluster = 'arn:aws:ecs:us-east-1:326255650484:cluster/fss-prod-cluster';
const definition = (revision: number) => `arn:aws:ecs:us-east-1:326255650484:task-definition/fss-prod-operations:${String(revision)}`;
const taskArn = `${cluster.replace(':cluster/', ':task/')}/a91d7da900aa401789560498b29d7b12`;
const digest = `sha256:${'a'.repeat(64)}`;
const image = `326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-prod-worker@${digest}`;
const registeredBy = 'arn:aws:sts::326255650484:assumed-role/fss-prod-ci-application/fss-prod-application-40522197864';
const commit = 'b'.repeat(40);
const custody: Custody = { taskArn, readerDefinitionArn: definition(337), sourceOperationsDefinitionArn: definition(335), startedBy: 'fss-app-40522197864-off-3', failedRunId: '40522197864' };
const network = { subnets: ['subnet-1', 'subnet-2'], securityGroups: ['sg-1'], assignPublicIp: 'ENABLED' };
function fixture() {
  const c = { name: 'operations', image, entryPoint: ['node', 'apps/worker/src/tools/fss.ts'], command: ['verify'], environment: [{ name: 'FSS_SCHEMA_MIN', value: '142' }], secrets: [{ name: 'DATABASE_SECRET_ARN', valueFrom: 'runtime-reference' }] };
  const source = { definition: { taskDefinitionArn: definition(335), family: 'fss-prod-operations', status: 'ACTIVE', registeredBy, containerDefinitions: [c], taskRoleArn: 'runtime-role', executionRoleArn: 'execution-role' }, tags: [{ key: 'NamePrefix', value: 'fss-prod' }] };
  const reader = structuredClone(source);
  reader.definition.taskDefinitionArn = definition(337);
  reader.definition.containerDefinitions[0]!.entryPoint = ['node', '--experimental-transform-types', '--input-type=module', '--eval', offRead];
  reader.definition.containerDefinitions[0]!.command = [];
  const task: TestTask = { taskArn, clusterArn: cluster, startedBy: custody.startedBy, taskDefinitionArn: definition(337), lastStatus: 'STOPPED', stopCode: 'TaskFailedToStart', stoppedReason: 'CannotPullContainerError: image unavailable', containers: [{ name: 'operations', image, reason: 'CannotPullContainerError: image unavailable' }], overrides: { containerOverrides: [{ name: 'operations', command: [] }] } };
  const baseline = Object.fromEntries(['api', 'worker'].map(name => [name, { serviceName: `fss-prod-${name}`, status: 'ACTIVE', desiredCount: name === 'api' ? 2 : 1, runningCount: name === 'api' ? 2 : 1, pendingCount: 0, taskDefinition: `${cluster.split(':cluster/')[0]}:task-definition/fss-prod-${name}:16`, deployments: [{ taskDefinition: `${cluster.split(':cluster/')[0]}:task-definition/fss-prod-${name}:16`, rolloutState: 'COMPLETED' }] }]));
  return { source, reader, task, baseline };
}
function harness(fault = '') {
  const f = fixture();
  const state: Json & { readerRecovery?: unknown; off?: unknown; lastTaskExitCode?: number } = {}, calls: { action: string; args: string[]; write: boolean }[] = [];
  const runtimeTasks = ['api', 'worker'].flatMap((name, index) => Array.from({ length: index === 0 ? 2 : 1 }, (_, n) => ({ taskArn: `${cluster.replace(':cluster/', ':task/')}/${String(index * 10 + n + 1).padStart(32, '0')}`, clusterArn: cluster, taskDefinitionArn: f.baseline[name]!.taskDefinition, group: `service:fss-prod-${name}`, lastStatus: 'RUNNING' })));
  let inactive = false, observations = 0, checks = 0;
  const run = { id: 40522197864, path: '.github/workflows/greenfield-deploy.yml', event: 'workflow_dispatch', head_branch: 'main', head_repository: { full_name: 'david-cui-bruno/founding-sales' }, head_sha: commit, status: 'completed', conclusion: 'failure' };
  const options: RecoveryOptions = {
    ...f, custody, cluster, state, network, commit, repository: 'david-cui-bruno/founding-sales', save() {},
    async gh() { return run; },
    async beforeWrite() { checks++; if (fault === 'gate') throw new Error('provenance_changed'); },
    async aws(_service, action, args = [], write = false) {
      calls.push({ action, args, write });
      const argument = (key: string) => args[args.indexOf(key) + 1];
      if (action === 'describe-task-definition') {
        const named = argument('--task-definition');
        if (named === 'fss-prod-operations') return inactive ? (fault === 'after-head' ? { ...f.source, taskDefinition: { ...f.source.definition, taskDefinitionArn: definition(334) } } : { taskDefinition: f.source.definition, tags: f.source.tags }) : (fault === 'before-head' ? { taskDefinition: f.source.definition, tags: f.source.tags } : { taskDefinition: f.reader.definition, tags: f.reader.tags });
        if (named === definition(335)) return { taskDefinition: f.source.definition, tags: f.source.tags };
        return { taskDefinition: { ...f.reader.definition, status: inactive ? (fault === 'readback' ? 'ACTIVE' : 'INACTIVE') : f.reader.definition.status }, tags: f.reader.tags };
      }
      if (action === 'describe-services') return { services: Object.values(f.baseline), failures: [] };
      if (action === 'list-tasks') {
        const stopped = args.includes('STOPPED');
        if (stopped) observations++;
        if (fault === 'pagination') return { taskArns: [], nextToken: 'more' };
        if (fault === 'duplicates') return { taskArns: [taskArn, taskArn] };
        return { taskArns: stopped ? [taskArn] : [...runtimeTasks.map(task => task.taskArn), ...(fault === 'active-reference' || fault === 'foreign-active' ? [`${cluster.replace(':cluster/', ':task/')}/${'f'.repeat(32)}`] : [])] };
      }
      if (action === 'describe-tasks') {
        if (fault === 'missing') return { tasks: [], failures: [] };
        if (fault === 'failed-read') return { tasks: [f.task], failures: [{}] };
        if (fault === 'refresh' && observations > 1) return { tasks: [{ ...f.task, lastStatus: 'RUNNING' }], failures: [] };
        const arns = args.slice(args.indexOf('--tasks') + 1);
        const foreign = { taskArn: `${cluster.replace(':cluster/', ':task/')}/${'f'.repeat(32)}`, clusterArn: cluster, taskDefinitionArn: fault === 'active-reference' ? definition(337) : definition(334), lastStatus: 'RUNNING', group: 'foreign-owner' };
        return { tasks: [f.task, ...runtimeTasks, foreign].filter(task => arns.includes(String(task.taskArn))), failures: [] };
      }
      if (action === 'deregister-task-definition') {
        inactive = true;
        if (fault === 'lost-write') throw new Error('command_aws_failed');
        return { taskDefinition: { ...f.reader.definition, status: 'INACTIVE' } };
      }
      throw new Error(`unexpected_${action}`);
    },
  };
  return { ...f, options, run, state, calls, checks: () => checks, execute: () => recoverApplicationReader(options) };
}
const cleanup = (h: ReturnType<typeof harness>) => h.calls.filter(call => call.write);

describe('explicit application reader custody input', () => {
  it('accepts only exact identity, derives prior run, and freezes the result', () => {
    const { failedRunId: _prior, ...input } = custody;
    const parsed = parseFailedReaderCustody(JSON.stringify(input), '99');
    expect(parsed).toEqual(custody); expect(Object.isFrozen(parsed)).toBe(true);
    expect(parseFailedReaderCustody('', '99')).toBeNull();
  });
  it.each(['{}', 'null', '[]', '{', JSON.stringify({ ...custody }), JSON.stringify({ taskArn })])('refuses malformed/partial/extra keys %s', value => {
    expect(() => parseFailedReaderCustody(value, '99')).toThrow('failed_reader_custody_invalid');
  });
});

describe('bounded historical known-prestart reader reconciliation', () => {
  it('deregisters only exact337 after refreshed positive proof, without executing a task', async () => {
    const h = harness(); await h.execute();
    expect(cleanup(h)).toEqual([{ action: 'deregister-task-definition', args: ['--task-definition', definition(337)], write: true }]);
    expect(h.checks()).toBe(1);
    expect(h.state.readerRecovery).toEqual({ ...custody, outcome: 'completed' });
    expect(h.calls.some(call => ['run-task', 'stop-task', 'update-service'].includes(call.action))).toBe(false);
    expect(h.calls.filter(call => call.action === 'list-tasks')).toHaveLength(4);
  });
  it('accepts a present matching imageDigest without claiming exit or OFF success', async () => {
    const h = harness(); h.task.containers[0]!.imageDigest = digest;
    await h.execute(); expect(h.state.off).toBeUndefined(); expect(h.state.lastTaskExitCode).toBeUndefined();
  });
  it('accepts only the observed empty inference accelerator collection alongside generated overrides', async () => {
    const h = harness();
    h.task.overrides = { containerOverrides: [{ name: 'operations', command: [] }], inferenceAcceleratorOverrides: [] };
    await h.execute(); expect(cleanup(h)).toHaveLength(1);
  });
  it.each([
    ['owner', (h: ReturnType<typeof harness>) => { h.task.startedBy = 'foreign'; }],
    ['cluster', h => { h.task.clusterArn = `${cluster}-foreign`; }],
    ['task-arn', h => { h.task.taskArn = `${taskArn}0`; }],
    ['definition', h => { h.task.taskDefinitionArn = definition(336); }],
    ['running', h => { h.task.lastStatus = 'RUNNING'; }],
    ['stopping', h => { h.task.lastStatus = 'STOPPING'; }],
    ['unknown-status', h => { delete h.task.lastStatus; }],
    ['stop-code', h => { h.task.stopCode = 'EssentialContainerExited'; }],
    ['reason', h => { h.task.stoppedReason = 'unknown'; h.task.containers[0]!.reason = 'unknown'; }],
    ['started', h => { h.task.startedAt = '2026-10-27T14:51:00Z'; }],
    ['exit', h => { h.task.containers[0]!.exitCode = 0; }],
    ['digest', h => { h.task.containers[0]!.imageDigest = `sha256:${'b'.repeat(64)}`; }],
    ['task-image', h => { h.task.containers[0]!.image = `${image}-foreign`; }],
    ['overrides', h => { h.task.overrides = { containerOverrides: [{ name: 'operations', command: [], environment: [{ name: 'NODE_OPTIONS', value: 'changed' }] }] }; }],
    ['command-override', h => { h.task.overrides = { containerOverrides: [{ name: 'operations', command: ['foreign'] }] }; }],
    ['role-override', h => { h.task.overrides = { containerOverrides: [{ name: 'operations', command: [] }], taskRoleArn: 'foreign' }; }],
    ['inference-nonempty', h => { h.task.overrides = { containerOverrides: [{ name: 'operations', command: [] }], inferenceAcceleratorOverrides: [{ deviceName: 'foreign' }] }; }],
    ['inference-null', h => { h.task.overrides = { containerOverrides: [{ name: 'operations', command: [] }], inferenceAcceleratorOverrides: null }; }],
    ['inference-plus-unknown', h => { h.task.overrides = { containerOverrides: [{ name: 'operations', command: [] }], inferenceAcceleratorOverrides: [], unknown: [] }; }],
    ['inference-plus-environment', h => { h.task.overrides = { containerOverrides: [{ name: 'operations', command: [], environment: [] }], inferenceAcceleratorOverrides: [] }; }],
    ['second-container', h => { h.task.containers.push({ name: 'foreign', image }); }],
    ['reader-entrypoint', h => { h.reader.definition.containerDefinitions[0]!.entryPoint = ['node', '--eval', 'foreign']; }],
    ['reader-image', h => { h.reader.definition.containerDefinitions[0]!.image = `${image}-foreign`; }],
    ['reader-tags', h => { h.reader.tags.push({ key: 'extra', value: 'changed' }); }],
    ['reader-registeredBy', h => { h.reader.definition.registeredBy = 'foreign'; }],
    ['source-registeredBy', h => { h.source.definition.registeredBy = 'foreign'; }],
    ['inactive-source', h => { h.source.definition.status = 'INACTIVE'; }],
    ['inactive-reader', h => { h.reader.definition.status = 'INACTIVE'; }],
    ['source-drift', h => { h.options.source = structuredClone(h.source); h.source.definition.taskRoleArn = 'changed'; }],
    ['prior-run', h => { h.run.conclusion = 'success'; }],
    ['prior-commit', h => { h.run.head_sha = 'c'.repeat(40); }],
    ['prior-repository', h => { h.run.head_repository.full_name = 'foreign/repository'; }],
    ['prior-workflow', h => { h.run.path = '.github/workflows/foreign.yml'; }],
    ['prior-event', h => { h.run.event = 'push'; }],
    ['prior-status', h => { h.run.status = 'in_progress'; }],
    ['service-reference', h => { h.baseline['api']!.taskDefinition = definition(337); }],
    ['deployment-reference', h => { h.baseline['api']!.deployments = [{ taskDefinition: definition(337), rolloutState: 'COMPLETED' }]; }],
  ] satisfies [string, (h: ReturnType<typeof harness>) => void][])('refuses %s without cleanup', async (_label, mutate) => {
    const h = harness(); mutate(h);
    await expect(h.execute()).rejects.toThrow(); expect(cleanup(h)).toHaveLength(0);
  });
  it.each(['pagination', 'duplicates', 'missing', 'failed-read', 'refresh', 'gate', 'before-head', 'active-reference', 'foreign-active'])('refuses %s without cleanup or replay', async fault => {
    const h = harness(fault); await expect(h.execute()).rejects.toThrow(); expect(cleanup(h)).toHaveLength(0);
  });
  it.each(['lost-write', 'readback', 'after-head'])('retains exact custody after %s, with no second write', async fault => {
    const h = harness(fault); await expect(h.execute()).rejects.toThrow();
    expect(cleanup(h)).toHaveLength(1);
    expect(h.state.readerRecovery).toEqual({ ...custody, outcome: 'deregister-requested' });
  });
  it('keeps supported service scope explicit rather than inventing universal inventory', async () => {
    const h = harness(); await h.execute();
    expect(h.calls.some(call => call.action === 'list-services')).toBe(false);
    expect(h.calls.filter(call => call.action === 'describe-services').every(call => isDeepStrictEqual(call.args, ['--cluster', cluster, '--services', 'fss-prod-api', 'fss-prod-worker']))).toBe(true);
  });
});

describe('protected workflow custody boundary', () => {
  it('uses the same application job, validates before credentials and retains recovery status', () => {
    const workflow = readRepositoryFile('.github/workflows/greenfield-deploy.yml');
    const job = workflow.split('\n  application:\n')[1]!.split('\n  smoke:\n')[0]!;
    expect(workflow).toContain('Failed-reader custody is application-only');
    expect(job).toContain('FSS_FAILED_READER_CUSTODY: ${{ inputs.failed_reader_custody }}');
    expect(job.indexOf('parseFailedReaderCustody')).toBeLessThan(job.indexOf('Assume narrow protected application identity'));
    expect(job).toContain('readerRecovery');
    expect(job).not.toContain('$GITHUB_ENV');
  });
});

describe('exact recovery native command retry boundary', () => {
  it('overrides ambient native retries only for the selected one-reader write', () => {
    const { failedRunId: _prior, ...input } = custody;
    const env = { FSS_FAILED_READER_CUSTODY: JSON.stringify(input), GITHUB_RUN_ID: '99', AWS_MAX_ATTEMPTS: '9' };
    const args = ['ecs', 'deregister-task-definition', '--task-definition', definition(337), '--output', 'json'];
    expect(readerRecoveryCommandEnvironment(env, 'aws', args)).toEqual({ ...env, AWS_MAX_ATTEMPTS: '1' });
    expect(env.AWS_MAX_ATTEMPTS).toBe('9');
    expect(readerRecoveryCommandEnvironment(env, 'aws', args.map(arg => arg === definition(337) ? definition(335) : arg))).toBe(env);
    expect(readerRecoveryCommandEnvironment(env, 'aws', ['ecs', 'describe-tasks'])).toBe(env);
    expect(readerRecoveryCommandEnvironment(env, 'node', args)).toBe(env);
    const ordinary = { GITHUB_RUN_ID: '99', AWS_MAX_ATTEMPTS: '9' };
    expect(readerRecoveryCommandEnvironment(ordinary, 'aws', args)).toBe(ordinary);
  });
});
