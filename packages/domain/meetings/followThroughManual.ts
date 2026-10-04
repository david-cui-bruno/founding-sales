import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { MailMessageRow } from '../mail/types.ts';
import { readMessageBody } from '../mail/messages.ts';
import { completeStepExecution } from '../sequences/executions.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { readFence, renderedHash } from '../outbound/fence.ts';
import { currentMeetingDraft, lockMeetingFollowThrough } from './followThrough.ts';
import { holdPreparedMeetingFence } from './followThroughDelivery.ts';
import { invalidateMeetingFollowThrough, meetingPlanInterruption, requiresExplicitMeetingReview } from './followThroughLifecycle.ts';
import type { FollowThroughRow } from './followThroughTypes.ts';
/** Existing mail matching has already proved the firm and each recipient association. */
export async function applyManualMeetingSend(context: RepositoryContext, input: {
  firmId: string; contactIds: readonly string[]; message: MailMessageRow; at: string;
}): Promise<void> {
  const plans = (await context.db.query<FollowThroughRow>("SELECT * FROM meeting_follow_through WHERE workspace_id=$1 AND firm_id=$2 AND created_at<=$3 AND status NOT IN ('cancelled','completed') ORDER BY meeting_id", [context.scope.workspaceId,input.firmId,input.at])).rows;
  for (const plan of plans) {
    if (input.contactIds.length > 0 && (plan.contact_id === null || !input.contactIds.includes(plan.contact_id))) continue;
    const locked = await lockMeetingFollowThrough(context,plan.meeting_id); if (!locked.ok) continue;
    const draft = await currentMeetingDraft(context,plan), body = await readMessageBody(context,input.message.id);
    const mailbox = (await context.db.query<{ owner_user_id: string }>('SELECT owner_user_id FROM mailboxes WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,input.message.mailboxId])).rows[0];
    const fence = draft?.outbound_message_id == null ? null : await readFence(context,draft.outbound_message_id);
    const exact = !requiresExplicitMeetingReview(plan.blockers) && draft !== null && ['ready','held','editing'].includes(draft.state) && draft.created_at.getTime() <= Date.parse(input.at)
      && body !== null && !body.truncated && input.message.subject !== null && renderedHash(input.message.subject,body.text) === draft.rendered_hash
      && input.message.direction === 'outgoing' && input.message.headerTo.length + input.message.headerCc.length === 1
      && input.contactIds.length === 1 && input.contactIds[0] === plan.contact_id && mailbox?.owner_user_id === plan.owner_user_id
      && locked.value.sourceHash === draft.source_hash && draft.source_hash === plan.source_hash
      && (fence === null || (['prepared','held'].includes(fence.state) && fence.attemptToken === null))
      && await meetingPlanInterruption(context,plan) === null;
    if (!exact || draft === null) {
      await invalidateMeetingFollowThrough(context,{meetingId:plan.meeting_id,reason:'manual_email_review',eventId:input.message.id}); continue;
    }
    await holdPreparedMeetingFence(context,plan);
    await context.db.query("UPDATE meeting_follow_through_drafts SET state='sent',manual_message_id=$3 WHERE workspace_id=$1 AND id=$2",[context.scope.workspaceId,draft.id,input.message.id]);
    await context.db.query("UPDATE meeting_follow_through SET status='awaiting_reply',editing=false,blockers='[]',version=version+1,next_wake_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[context.scope.workspaceId,plan.id]);
    const execution = (await context.db.query<{ id: string }>('SELECT id FROM step_executions WHERE workspace_id=$1 AND enrollment_id=$2 AND ordinal=$3',[context.scope.workspaceId,plan.enrollment_id,draft.ordinal])).rows[0];
    if (execution !== undefined) await completeStepExecution(context,{stepExecutionId:execution.id,completionSource:'system',result:'sent',completedAt:input.at});
    await recordCrmAuditEvent(context,{action:'meeting.manual_recap_fulfilled',subjectKind:'meeting',subjectId:plan.meeting_id,detail:{planId:plan.id,draftId:draft.id,messageId:input.message.id}});
  }
}
