import type { MeetingDeadline } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { lockSendGateForDispatch } from '../policy/sendGate.ts';
import { lockTodayForFirmChange, refreshTodayForFirm } from '../today/build.ts';
import { lockAnalysisMeeting } from './analysisRequests.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { meetingDeadlineDueAt } from './taskDeadlines.ts';
/** Own transaction, after provider settlement: gate shared → Today shared → firm → meeting. */
export async function ensureUnresolvedMeetingTask(context: RepositoryContext, input: {
  meetingId: string; planId: string; ownerUserId: string; dueAt: string; deadline: MeetingDeadline;
}): Promise<{ taskId: string; created: boolean }> {
  await lockSendGateForDispatch(context); await lockTodayForFirmChange(context);
  const firmId = await lockAnalysisMeeting(context, input.meetingId);
  if (firmId === null) throw new Error('meeting_unknown');
  const existing = (await context.db.query<{ id: string }>('SELECT id FROM meeting_tasks WHERE workspace_id=$1 AND follow_through_plan_id=$2', [context.scope.workspaceId, input.planId])).rows[0];
  if (existing !== undefined) return { taskId: existing.id, created: false };
  const row = (await context.db.query<{ id: string }>(`INSERT INTO meeting_tasks(workspace_id,meeting_id,firm_id,follow_through_plan_id,label,owner_user_id,deadline,due_at,evidence)
    VALUES($1,$2,$3,$4,'Review unanswered demo follow-up',$5,$6::jsonb,$7,'[]') RETURNING id`, [context.scope.workspaceId, input.meetingId, firmId, input.planId, input.ownerUserId, JSON.stringify(input.deadline), meetingDeadlineDueAt(input.deadline)])).rows[0]!;
  await recordCrmAuditEvent(context, { action: 'meeting.unanswered_task_created', subjectKind: 'meeting_task', subjectId: row.id, detail: { planId: input.planId } });
  await refreshTodayForFirm(context, { firmId });
  return { taskId: row.id, created: true };
}
export async function fulfillDeliveredMeetingMaterials(context: RepositoryContext, planId: string): Promise<void> {
  const changed = await context.db.query<{ id: string; firm_id: string }>(`UPDATE meeting_tasks t SET status='done',completed_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
    WHERE t.workspace_id=$1 AND t.meeting_id=(SELECT meeting_id FROM meeting_follow_through WHERE workspace_id=$1 AND id=$2) AND t.status='open' AND NOT t.user_edited AND t.commitment_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM meeting_follow_through p JOIN meeting_follow_through_drafts d ON d.workspace_id=p.workspace_id AND d.plan_id=p.id
      LEFT JOIN outbound_messages m ON m.workspace_id=d.workspace_id AND m.id=d.outbound_message_id
      LEFT JOIN mail_messages manual ON manual.workspace_id=d.workspace_id AND manual.id=d.manual_message_id
      WHERE p.workspace_id=t.workspace_id AND p.id=$2 AND p.meeting_id=t.meeting_id AND d.source_hash=p.source_hash AND d.state='sent' AND ((m.state='sent' AND m.rendered_hash=d.rendered_hash
      AND NOT EXISTS(SELECT 1 FROM outbound_message_events ev WHERE ev.workspace_id=m.workspace_id AND ev.outbound_message_id=m.id AND ev.detail->>'sentBytes'='unverified')) OR manual.direction='outgoing') AND d.material_task_ids ? t.id::text AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(d.material_references) u(url)
        WHERE position(u.url IN CASE WHEN manual.id IS NOT NULL THEN d.body ELSE m.body END)>0 AND position(u.url IN t.label)>0 AND EXISTS(SELECT 1 FROM jsonb_array_elements(t.evidence) e WHERE position(u.url IN e->>'quote')>0))) RETURNING t.id,t.firm_id`, [context.scope.workspaceId, planId]);
  for (const row of changed.rows) await recordCrmAuditEvent(context, { action: 'meeting.material_delivered', subjectKind: 'meeting_task', subjectId: row.id });
}
