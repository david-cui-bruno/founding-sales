import { isDeepStrictEqual } from 'node:util';
import { createReleaseSafety, normalizeTaskDefinition, readerTaskDocument } from './release-safety.mjs';

const requireThat = (condition, reason) => { if (!condition) throw new Error(reason); };

export function readerObservationRequested(value, custody) {
  if (value === undefined || value === '') return false;
  requireThat(value === 'true' && custody?.evidenceBasis === 'historical-readonly-retirement', 'reader_observation_input_invalid');
  return true;
}

// This is only the existing fixed OFF reader. The caller has just proved historical
// custody/current inventories twice. It returns before any retirement or release.
export async function observeReaderOff({ aws, waitFor, now, state, save, cluster, network, owner, source, custody }) {
  const document = readerTaskDocument(source);
  const readDefinition = arn => aws('ecs', 'describe-task-definition', ['--task-definition', arn, '--include', 'TAGS']);
  const prior = await readDefinition(custody.readerDefinitionArn);
  requireThat(prior.taskDefinition?.taskDefinitionArn === custody.readerDefinitionArn && prior.taskDefinition.status === 'ACTIVE' && isDeepStrictEqual(normalizeTaskDefinition(prior.taskDefinition), normalizeTaskDefinition(document)) && isDeepStrictEqual(prior.tags, document.tags), 'reader_observation_family_changed');
  let registered, launched = false, cleanupRequested = false;
  state.offObservation = { outcome: 'observing', readerDefinitionArn: null }; save();
  async function transport(service, action, args = [], write = false) {
    if (!write) return aws(service, action, args);
    requireThat(service === 'ecs', 'reader_observation_write_refused');
    if (action === 'register-task-definition') {
      requireThat(!registered && isDeepStrictEqual(args, ['--cli-input-json', JSON.stringify(document)]), 'reader_observation_write_refused');
      state.offObservation.outcome = 'registration-requested'; save();
      const result = await aws(service, action, args, true);
      registered = result.taskDefinition?.taskDefinitionArn;
      state.offObservation.readerDefinitionArn = registered ?? null; save();
      const prefix = `${cluster.split(':cluster/')[0]}:task-definition/fss-prod-operations:`;
      requireThat(typeof registered === 'string' && registered.startsWith(prefix) && /^[1-9][0-9]*$/u.test(registered.slice(prefix.length)) && Number(registered.slice(prefix.length)) > Number(custody.readerDefinitionArn.split(':').at(-1)), 'reader_observation_registration_unknown');
      return result;
    }
    requireThat(registered && args[args.indexOf('--task-definition') + 1] === registered, 'reader_observation_write_refused');
    if (action === 'run-task') {
      requireThat(!launched && !cleanupRequested, 'reader_observation_write_refused');
      launched = true; state.offObservation.outcome = 'task-requested'; save();
      return aws(service, action, args, true);
    }
    requireThat(action === 'deregister-task-definition' && launched && !cleanupRequested && state.currentTaskArn === null && state.lastStoppedTaskArn, 'reader_observation_write_refused');
    cleanupRequested = true; state.offObservation.outcome = 'cleanup-requested'; save();
    const result = await aws(service, action, args, true);
    const inactive = await readDefinition(registered);
    requireThat(inactive.taskDefinition?.taskDefinitionArn === registered && inactive.taskDefinition.status === 'INACTIVE' && isDeepStrictEqual(normalizeTaskDefinition(inactive.taskDefinition), normalizeTaskDefinition(document)) && isDeepStrictEqual(inactive.tags, document.tags), 'reader_observation_cleanup_unknown');
    requireThat(isDeepStrictEqual(await readDefinition('fss-prod-operations'), prior) && isDeepStrictEqual(await readDefinition(custody.readerDefinitionArn), prior) && isDeepStrictEqual(await readDefinition(custody.sourceOperationsDefinitionArn), { taskDefinition: source.definition, tags: source.tags }), 'reader_observation_family_changed');
    state.offObservation.outcome = 'cleaned'; save();
    return result;
  }
  const safety = createReleaseSafety({ aws: transport, waitFor, now, state, save, cluster, network, owner });
  await safety.off(source, state.fromSchema);
  state.offObservation.outcome = 'completed';
  state.phase = 'off-observation-completed'; state.outcome = 'observation-completed'; save();
}
