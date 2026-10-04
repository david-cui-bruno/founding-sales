import { firstSuppressed } from '../suppression/effective.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { lockMeetingFollowThrough } from './followThrough.ts';
import { holdPreparedMeetingFence } from './followThroughDelivery.ts';
import type { FollowThroughRow } from './followThroughTypes.ts';
import { stopEnrollments } from '../sequences/enrollments.ts';
/** Read again at the final claim; a delayed lifecycle job is never permission to send. */
export async function meetingPlanInterruption(context: RepositoryContext, plan: FollowThroughRow): Promise<string | null> {
  const current = (await context.db.query<{ assigned_user_id: string | null; status: string; opportunity_id: string | null; opportunity_status: string | null; control_mode: string | null; control_mode_origin: string | null; end_reason: string | null }>(`SELECT f.assigned_user_id,f.status,m.opportunity_id,o.status AS opportunity_status,o.control_mode,o.control_mode_origin,e.end_reason
    FROM meetings m JOIN firms f ON f.workspace_id=m.workspace_id AND f.id=m.firm_id
    LEFT JOIN opportunities o ON o.workspace_id=m.workspace_id AND o.id=m.opportunity_id
    LEFT JOIN sequence_enrollments e ON e.workspace_id=m.workspace_id AND e.id=$3
    WHERE m.workspace_id=$1 AND m.id=$2`, [context.scope.workspaceId,plan.meeting_id,plan.enrollment_id])).rows[0];
  if (current === undefined || current.status !== 'active' || current.assigned_user_id !== plan.owner_user_id) return 'not_assigned';
  if (current.opportunity_id === null || current.opportunity_status !== 'open') return 'opportunity_required';
  if (current.control_mode !== 'automated' && !['human_reply','engaged_call','direct_send_keep_automation'].includes(current.control_mode_origin ?? '')) return 'opportunity_manual';
  if (current.end_reason !== null && current.end_reason !== 'sequence_complete') return 'enrollment_stopped';
  const addresses = (await context.db.query<{ address: string }>('SELECT address FROM email_addresses WHERE workspace_id=$1 AND firm_id=$2 AND contact_id=$3', [context.scope.workspaceId,plan.firm_id,plan.contact_id])).rows;
  if (await firstSuppressed(context, [{ scope: 'firm', canonicalKey: plan.firm_id }, ...addresses.map(a => ({ scope: 'handle' as const, canonicalKey: a.address }))], 'email') !== null) return 'suppressed';
  const row = (await context.db.query<{ newer: boolean; direct: boolean; reply: boolean }>(`SELECT
    EXISTS(SELECT 1 FROM meetings n JOIN meetings m ON m.workspace_id=n.workspace_id AND m.id=$3
      WHERE n.workspace_id=$1 AND n.firm_id=$2 AND n.id<>m.id AND n.state NOT IN ('cancelled','no_show') AND n.starts_at>m.ends_at) AS newer,
    EXISTS(SELECT 1 FROM mail_message_effects e JOIN mail_messages msg ON msg.workspace_id=e.workspace_id AND msg.id=e.mail_message_id
      WHERE e.workspace_id=$1 AND e.detail->>'firmId'=$2::text AND e.effect_kind IN ('direct_send_conversation','direct_send_manual') AND msg.internal_date>=$4
      AND (COALESCE(jsonb_array_length(e.detail->'recipientContactIds'),0)=0 OR e.detail->'recipientContactIds' ? $5::text)
      AND NOT EXISTS(SELECT 1 FROM meeting_follow_through_drafts d WHERE d.workspace_id=e.workspace_id AND d.plan_id=$6 AND d.manual_message_id=msg.id)) AS direct,
    EXISTS(SELECT 1 FROM active_holds h JOIN meetings m ON m.workspace_id=h.workspace_id AND m.id=$3
      WHERE h.workspace_id=$1 AND h.released_at IS NULL AND h.reason_code='uncertain_reply' AND
      ((h.scope_kind='firm' AND h.scope_key=$2::text) OR (h.scope_kind='opportunity' AND h.scope_key=m.opportunity_id::text))) AS reply`, [context.scope.workspaceId, plan.firm_id, plan.meeting_id, plan.created_at,plan.contact_id,plan.id])).rows[0]!;
  return row.newer ? 'new_meeting' : row.direct ? 'manual_email_review' : row.reply ? 'reply_received' : null;
}
export async function invalidateMeetingFollowThrough(context: RepositoryContext, input: { meetingId: string; reason: string; eventId: string }): Promise<void> {
  const locked = await lockMeetingFollowThrough(context, input.meetingId); if (!locked.ok) return;
  const rows = (await context.db.query<FollowThroughRow>("SELECT * FROM meeting_follow_through WHERE workspace_id=$1 AND meeting_id=$2 AND status NOT IN ('cancelled','completed') ORDER BY id FOR UPDATE", [context.scope.workspaceId, input.meetingId])).rows;
  for (const plan of rows) {
    await holdPreparedMeetingFence(context, plan);
    const cancelled = input.reason === 'new_meeting';
    if (cancelled && plan.enrollment_id !== null) await stopEnrollments(context, { enrollmentId: plan.enrollment_id, reason: 'admin_stop', cancelReason: 'terminal_stop' });
    if (plan.blockers.includes(input.reason) && (cancelled ? plan.status === 'cancelled' : plan.status === 'needs_review')) continue;
    await context.db.query("UPDATE meeting_follow_through SET status=$3,blockers=$4::jsonb,version=version+1,next_wake_at='9999-01-01',updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, plan.id, cancelled ? 'cancelled' : 'needs_review', JSON.stringify([...new Set([...plan.blockers, input.reason])])]);
    await recordCrmAuditEvent(context, { action: 'meeting.follow_through_interrupted', subjectKind: 'meeting', subjectId: input.meetingId, detail: { planId: plan.id, reason: input.reason, eventId: input.eventId } });
  }
}
/** Called only after the existing mail matcher has attributed the message. */
export async function interruptMeetingPlansForFirm(context: RepositoryContext, input: { firmId: string; reason: string; messageId: string; at: string }): Promise<void> {
  const rows = (await context.db.query<{ meeting_id: string }>("SELECT meeting_id FROM meeting_follow_through WHERE workspace_id=$1 AND firm_id=$2 AND created_at<=$3 AND status NOT IN ('cancelled','completed') ORDER BY meeting_id", [context.scope.workspaceId, input.firmId, input.at])).rows;
  for (const row of rows) await invalidateMeetingFollowThrough(context, { meetingId: row.meeting_id, reason: input.reason, eventId: input.messageId });
}
/** Booking folds keep identifiers and delivered history, but cancel ambiguous old automation. */
export async function foldMeetingFollowThrough(context: RepositoryContext, source: string, target: string): Promise<void> {
  const rows = (await context.db.query<FollowThroughRow>('SELECT * FROM meeting_follow_through WHERE workspace_id=$1 AND meeting_id=ANY($2::uuid[]) ORDER BY id FOR UPDATE', [context.scope.workspaceId, [source,target]])).rows;
  for (const plan of rows) {
    await holdPreparedMeetingFence(context, plan);
    if (plan.enrollment_id !== null) await stopEnrollments(context, { enrollmentId: plan.enrollment_id, reason: 'admin_stop', cancelReason: 'terminal_stop' });
  }
  await context.db.query("UPDATE meeting_follow_through SET status='cancelled',blockers='[\"meeting_fold_review\"]',version=version+1 WHERE workspace_id=$1 AND meeting_id=ANY($2::uuid[])", [context.scope.workspaceId,[source,target]]);
  await context.db.query('UPDATE meeting_follow_through SET meeting_id=$3 WHERE workspace_id=$1 AND meeting_id=$2', [context.scope.workspaceId,source,target]);
}
