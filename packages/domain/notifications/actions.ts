import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { TodayAction } from '@fss/contracts';
import { readTodayActions } from '../today/actions.ts';

export interface NotificationCandidate extends TodayAction {
  eventKey: string;
  phase: 'attention' | 'reply_overdue' | 'pre_call';
}

export async function readNotificationCandidates(context: RepositoryContext, input: { now: string }): Promise<NotificationCandidate[]> {
  if (context.scope.actor.kind !== 'user') return [];
  return notificationCandidatesFromToday((await readTodayActions(context, input)).actions, input.now);
}

export function notificationCandidatesFromToday(actions: readonly TodayAction[], now: string): NotificationCandidate[] {
  return actions.filter(action => action.kind === 'reply' || action.kind === 'problem' ||
    action.kind === 'call' && Date.parse(action.dueAt) - Date.parse(now) <= 15 * 60_000).map(action => {
    const phase = action.kind === 'call' ? 'pre_call' : action.reason === 'substantive_reply' && action.state === 'overdue' ? 'reply_overdue' : 'attention';
    return { ...action, phase, eventKey: `${action.actionId}:${phase}${action.kind === 'call' ? `:${action.dueAt}` : ''}` };
  });
}
