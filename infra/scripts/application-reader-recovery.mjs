import { isDeepStrictEqual } from 'node:util';
import { normalizeTaskDefinition, readerTaskDocument } from './release-safety.mjs';
import { parseFailedReaderCustody } from './application-reader-custody.mjs';
import { proveReaderHistory } from './application-reader-history.mjs';

const requireThat = (condition, reason) => { if (!condition) throw new Error(reason); };
const knownStatuses = ['PROVISIONING', 'PENDING', 'ACTIVATING', 'RUNNING', 'DEACTIVATING', 'STOPPING', 'DEPROVISIONING', 'STOPPED'];

// One application call must also mean one native CLI attempt, even when an
// ambient retry setting would otherwise replay an ambiguous provider write.
export function readerRecoveryCommandEnvironment(environment, program, args) {
  if (!environment.FSS_FAILED_READER_CUSTODY || program !== 'aws' || args[0] !== 'ecs' || args[1] !== 'deregister-task-definition') return environment;
  const custody = parseFailedReaderCustody(environment.FSS_FAILED_READER_CUSTODY, environment.GITHUB_RUN_ID);
  if (!isDeepStrictEqual(args, ['ecs', 'deregister-task-definition', '--task-definition', custody.readerDefinitionArn, '--output', 'json'])) return environment;
  return { ...environment, AWS_MAX_ATTEMPTS: '1' };
}

// Historical custody only. This never executes/stops a task, retries a write, or
// changes safety.off's fail-closed handling of unknown current-run outcomes.
export async function recoverApplicationReader({ custody, cluster, source, baseline, state, save, beforeWrite, aws, gh, ghText, commit, repository }) {
  state.readerRecovery = { ...custody, outcome: 'observing' }; save();
  const historical = custody.evidenceBasis === 'historical-readonly-retirement';
  if (historical) {
    Object.assign(state.readerRecovery, { historicalExecution: 'UNKNOWN', historicalEffects: 'UNKNOWN' }); save();
  }
  const readDefinition = async arn => aws('ecs', 'describe-task-definition', ['--task-definition', arn, '--include', 'TAGS']);
  const readTasks = async arns => {
    const result = await aws('ecs', 'describe-tasks', ['--cluster', cluster, '--tasks', ...arns]);
    requireThat(Array.isArray(result.failures) && result.failures.length === 0 && Array.isArray(result.tasks) && result.tasks.length === arns.length && new Set(result.tasks.map(t => t?.taskArn)).size === arns.length && result.tasks.every(t => t && arns.includes(t.taskArn) && t.clusterArn === cluster && knownStatuses.includes(t.lastStatus)), 'reader_recovery_tasks_unknown');
    return result.tasks;
  };
  async function proveIdentity() {
    const run = await gh(`actions/runs/${custody.failedRunId}`);
    requireThat(String(run?.id) === custody.failedRunId && run.path?.split('@')[0] === '.github/workflows/greenfield-deploy.yml' && run.event === 'workflow_dispatch' && run.head_branch === 'main' && run.head_repository?.full_name === repository && run.head_sha === commit && run.status === 'completed' && run.conclusion === 'failure', 'reader_recovery_run_changed');
    const actualSource = await readDefinition(custody.sourceOperationsDefinitionArn);
    const reader = await readDefinition(custody.readerDefinitionArn);
    const head = await readDefinition('fss-prod-operations');
    const owner = `arn:aws:sts::326255650484:assumed-role/fss-prod-ci-application/fss-prod-application-${custody.failedRunId}`;
    requireThat(actualSource.taskDefinition?.taskDefinitionArn === custody.sourceOperationsDefinitionArn && actualSource.taskDefinition.status === 'ACTIVE' && actualSource.taskDefinition.registeredBy === owner && isDeepStrictEqual(actualSource.taskDefinition, source.definition) && isDeepStrictEqual(actualSource.tags, source.tags), 'reader_recovery_source_changed');
    const expected = readerTaskDocument(source);
    requireThat(reader.taskDefinition?.taskDefinitionArn === custody.readerDefinitionArn && reader.taskDefinition.status === 'ACTIVE' && reader.taskDefinition.registeredBy === owner && head.taskDefinition?.taskDefinitionArn === custody.readerDefinitionArn && isDeepStrictEqual(head, reader) && isDeepStrictEqual(normalizeTaskDefinition(reader.taskDefinition), normalizeTaskDefinition(expected)) && isDeepStrictEqual(reader.tags, expected.tags), 'reader_recovery_definition_changed');
    if (historical) {
      requireThat(state.fromSchema === 142 && state.targetSchema === 142 && state.observedSchema === 142 && isDeepStrictEqual(reader.taskDefinition.containerDefinitions[0]?.entryPoint, expected.containerDefinitions[0].entryPoint) && isDeepStrictEqual(reader.taskDefinition.containerDefinitions[0]?.command, []), 'reader_recovery_history_scope_changed');
      const history = await proveReaderHistory({ custody, run, commit, repository, gh, ghText });
      const missing = await aws('ecs', 'describe-tasks', ['--cluster', cluster, '--tasks', custody.taskArn]);
      requireThat(isDeepStrictEqual(missing.tasks, []) && isDeepStrictEqual(missing.failures, [{ arn: custody.taskArn, reason: 'MISSING' }]), 'reader_recovery_history_not_missing');
      Object.assign(state.readerRecovery, history); save();
      return;
    }
    const [task] = await readTasks([custody.taskArn]);
    const container = task.containers?.[0];
    const image = source.definition.containerDefinitions[0].image;
    const generated = { containerOverrides: [{ name: 'operations', command: [] }] };
    // ECS may echo this one empty collection. No other field is normalized away.
    const safeOverrides = isDeepStrictEqual(task.overrides, generated) || isDeepStrictEqual(task.overrides, { ...generated, inferenceAcceleratorOverrides: [] });
    // No pulled digest is fabricated for a never-started container. Its declared
    // pinned URI must match, and any actual digest returned must match as well.
    requireThat(task.startedBy === custody.startedBy && task.taskDefinitionArn === custody.readerDefinitionArn && task.lastStatus === 'STOPPED' && task.stopCode === 'TaskFailedToStart' && task.startedAt === undefined && task.containers?.length === 1 && container?.name === 'operations' && container.image === image && container.exitCode === undefined && (container.imageDigest === undefined || container.imageDigest === image.split('@')[1]) && /^CannotPullContainerError(?::|$)/u.test(task.stoppedReason || '') && (container.reason === undefined || /^CannotPullContainerError(?::|$)/u.test(container.reason)) && safeOverrides, 'reader_recovery_not_known_prestart');
  }
  async function proveReferences() {
    // The protected writer owns these two services. This is deliberately not a
    // claim about dormant third-party services outside the supported inventory.
    const result = await aws('ecs', 'describe-services', ['--cluster', cluster, '--services', 'fss-prod-api', 'fss-prod-worker']);
    requireThat(Array.isArray(result.failures) && result.failures.length === 0 && Array.isArray(result.services) && result.services.length === 2 && new Set(result.services.map(s => s?.serviceName)).size === 2, 'reader_recovery_services_unknown');
    for (const name of ['api', 'worker']) {
      const service = result.services.find(s => s?.serviceName === `fss-prod-${name}`);
      const previous = baseline[name];
      requireThat(service?.status === 'ACTIVE' && service.taskDefinition === previous.taskDefinition && service.taskDefinition !== custody.readerDefinitionArn && service.desiredCount === previous.desiredCount && service.runningCount === previous.desiredCount && service.pendingCount === 0 && service.deployments?.length === 1 && service.deployments[0].taskDefinition === previous.taskDefinition && service.deployments[0].taskDefinition !== custody.readerDefinitionArn && service.deployments[0].rolloutState === 'COMPLETED', 'reader_recovery_service_reference');
    }
    const all = [];
    for (const desired of ['RUNNING', 'STOPPED']) {
      const listed = await aws('ecs', 'list-tasks', ['--cluster', cluster, '--desired-status', desired, '--max-results', '100', '--no-paginate']);
      requireThat(Array.isArray(listed.taskArns) && listed.taskArns.length <= 100 && !listed.nextToken && listed.taskArns.every(arn => typeof arn === 'string' && new RegExp(`^${cluster.replace(':cluster/', ':task/')}/[0-9a-f]{32}$`, 'u').test(arn)) && new Set(listed.taskArns).size === listed.taskArns.length, 'reader_recovery_inventory_unknown');
      all.push(...listed.taskArns);
    }
    requireThat(new Set(all).size === all.length, 'reader_recovery_inventory_unknown');
    requireThat(!historical || !all.includes(custody.taskArn), 'reader_recovery_missing_task_listed');
    // ECS DescribeTasks accepts at most100. Each complete list above is bounded.
    const tasks = [];
    for (let offset = 0; offset < all.length; offset += 100) tasks.push(...await readTasks(all.slice(offset, offset + 100)));
    requireThat(tasks.every(task => task.taskDefinitionArn !== custody.readerDefinitionArn || task.lastStatus === 'STOPPED'), 'reader_recovery_task_reference');
    for (const task of tasks.filter(task => task.lastStatus !== 'STOPPED')) {
      requireThat(['api', 'worker'].some(name => task.lastStatus === 'RUNNING' && task.taskDefinitionArn === baseline[name].taskDefinition && task.group === `service:fss-prod-${name}`), 'reader_recovery_foreign_active_task');
    }
    for (const name of ['api', 'worker']) requireThat(tasks.filter(task => task.lastStatus === 'RUNNING' && task.group === `service:fss-prod-${name}`).length === baseline[name].desiredCount, 'reader_recovery_inventory_incomplete');
  }
  await proveIdentity(); await proveReferences();
  // The caller refreshes full candidate health/runtime bindings and gates. Then
  // refresh all custody/reference proofs immediately before the single write.
  await beforeWrite();
  await proveIdentity(); await proveReferences();
  state.readerRecovery.outcome = 'deregister-requested'; save();
  await aws('ecs', 'deregister-task-definition', ['--task-definition', custody.readerDefinitionArn], true);
  const inactive = await readDefinition(custody.readerDefinitionArn);
  requireThat(inactive.taskDefinition?.taskDefinitionArn === custody.readerDefinitionArn && inactive.taskDefinition.status === 'INACTIVE' && isDeepStrictEqual(normalizeTaskDefinition(inactive.taskDefinition), normalizeTaskDefinition(readerTaskDocument(source))) && isDeepStrictEqual(inactive.tags, source.tags), 'reader_recovery_deregistration_unknown');
  const head = await readDefinition('fss-prod-operations');
  requireThat(isDeepStrictEqual(head.taskDefinition, source.definition) && isDeepStrictEqual(head.tags, source.tags), 'reader_recovery_family_changed');
  state.readerRecovery.outcome = 'completed'; save();
}
