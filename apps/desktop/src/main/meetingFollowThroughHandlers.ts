import { meetingFollowThroughViewV2Schema } from '@fss/contracts';
import type { OperationInput } from '../shared/operations.ts';
import type { OperationHostDeps } from './operationHost.ts';

/** Business drafts never enter the cache. Drop answers after an identity change. */
export function meetingFollowThroughHandlers(deps: Pick<OperationHostDeps, 'api' | 'recordings'>) {
  const command = async (path: string, input: OperationInput<'meetings.editRecap'> | OperationInput<'meetings.saveUnpublishedPlan'>) => {
    const generation = deps.recordings.identity.current(), { commandId, ...body } = input;
    const answer = await deps.api.command(path, body, value => meetingFollowThroughViewV2Schema.parse(value), { commandId });
    if (generation !== deps.recordings.identity.current()) return { view: null, reason: 'not_found' };
    return answer.ok ? { view: answer.value, reason: null } : { view: null, reason: answer.reason.slice(0, 80) };
  };
  return {
    'meetings.followThrough': async (input: OperationInput<'meetings.followThrough'>) => {
      const generation = deps.recordings.identity.current();
      const answer = await deps.api.read(`/meetings/follow-through?meetingId=${encodeURIComponent(input.meetingId)}&version=2`, value => meetingFollowThroughViewV2Schema.parse(value));
      if (generation !== deps.recordings.identity.current()) return { view: null, reason: 'not_found' };
      return answer.ok ? { view: answer.value, reason: null } : { view: null, reason: answer.reason.slice(0, 80) };
    },
    'meetings.editRecap': async (input: OperationInput<'meetings.editRecap'>) => await command('/meetings/recap/edit?version=2', input),
    'meetings.saveUnpublishedPlan': async (input: OperationInput<'meetings.saveUnpublishedPlan'>) => await command('/meetings/unpublished-plan', input),
  };
}
