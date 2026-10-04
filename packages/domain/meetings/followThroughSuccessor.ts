import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { EnrollmentRow } from '../sequences/types.ts';
import type { FollowThroughRow } from './followThroughTypes.ts';
import { meetingDeliveryHistory } from './followThroughJobs.ts';
import { nextMeetingFollowThroughAction } from './followThroughSchedule.ts';
import { dispatchHolidayCalendar } from '../outbound/stepPermission.ts';
/** undefined = ordinary sequence; null = this meeting plan has no next email. */
export async function meetingSuccessorDue(context: RepositoryContext, enrollment: EnrollmentRow, ordinal: number, at: string): Promise<{ dueAt: string; sourceZone: string; ruleVersion: string } | null | undefined> {
  const plan = (await context.db.query<FollowThroughRow>('SELECT * FROM meeting_follow_through WHERE workspace_id=$1 AND enrollment_id=$2', [context.scope.workspaceId, enrollment.id])).rows[0];
  if (plan === undefined) return undefined;
  const calendar = await dispatchHolidayCalendar(context, enrollment);
  const action = nextMeetingFollowThroughAction({ plan: { scope: plan.scope, maxMessages: 3 }, deliveryHistory: await meetingDeliveryHistory(context, plan.id), at, calendar, zone: enrollment.firmTimeZone });
  if (action.kind === 'review') await context.db.query("UPDATE meeting_follow_through SET status='needs_review',blockers=$3::jsonb WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, plan.id, JSON.stringify([action.reason])]);
  if (action.kind !== 'nudge' || action.ordinal !== ordinal) return null;
  return { dueAt: action.dueAt, sourceZone: enrollment.firmTimeZone, ruleVersion: 'meeting-follow-through.1' };
}
