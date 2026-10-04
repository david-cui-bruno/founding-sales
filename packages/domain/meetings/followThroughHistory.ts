import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { MeetingDelivery } from './followThroughSchedule.ts';
/** Proven delivery only. Restored envelopes with unverified bytes never fulfill work. */
export async function meetingDeliveryHistory(context: RepositoryContext, planId: string): Promise<MeetingDelivery[]> {
  const rows = (await context.db.query<{ ordinal: number; id: string; sent_at: Date }>(`SELECT DISTINCT d.ordinal,m.id,m.sent_at FROM meeting_follow_through_drafts d
    JOIN outbound_messages m ON m.workspace_id=d.workspace_id AND m.id=d.outbound_message_id
    WHERE d.workspace_id=$1 AND d.plan_id=$2 AND m.state='sent' AND m.rendered_hash=d.rendered_hash AND m.sent_at IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM outbound_message_events ev WHERE ev.workspace_id=m.workspace_id AND ev.outbound_message_id=m.id AND ev.detail->>'sentBytes'='unverified')
    UNION SELECT d.ordinal,m.id,m.internal_date AS sent_at FROM meeting_follow_through_drafts d JOIN mail_messages m ON m.workspace_id=d.workspace_id AND m.id=d.manual_message_id
    WHERE d.workspace_id=$1 AND d.plan_id=$2 AND d.state='sent' AND m.direction='outgoing' ORDER BY ordinal`, [context.scope.workspaceId,planId])).rows;
  return rows.map(r => ({ ordinal:r.ordinal,messageId:r.id,sentAt:r.sent_at.toISOString() }));
}
