import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readFence, readFenceByStepExecution, renderedHash, rewritePreparedBody, holdFence } from '../outbound/fence.ts';
import { composeBodyForWorkspace } from '../outbound/footer.ts';
import { readTemplateVersion } from '../templates/templates.ts';
import { currentMeetingDraft } from './followThrough.ts';
import { verifyMeetingFollowThrough } from './followThroughEligibility.ts';
import type { FollowThroughRow } from './followThroughTypes.ts';
import type { MeetingResult } from './outcomeTypes.ts';

export async function meetingPlanForExecution(context: RepositoryContext, executionId: string): Promise<FollowThroughRow | null> {
  return (await context.db.query<FollowThroughRow>(`SELECT p.* FROM meeting_follow_through p JOIN step_executions e ON e.workspace_id=p.workspace_id AND e.enrollment_id=p.enrollment_id
    WHERE e.workspace_id=$1 AND e.id=$2`, [context.scope.workspaceId, executionId])).rows[0] ?? null;
}
/** Runs only under the exclusive preparation gate, never during a provider call. */
export async function meetingDraftForExecution(context: RepositoryContext, input: { executionId: string; at: string }): Promise<MeetingResult<{
  draftId: string; draftVersion: number; subject: string; body: string; renderedHash: string; notBefore: string;
}>> {
  const plan = await meetingPlanForExecution(context, input.executionId);
  if (plan === null) return { ok: false, reason: 'not_meeting_execution' };
  const draft = await currentMeetingDraft(context, plan);
  if (draft === null) return { ok: false, reason: 'draft_not_ready' };
  const eligible = await verifyMeetingFollowThrough(context, { planId: plan.id, executionId: input.executionId, draftVersion: draft.version, at: input.at });
  if (!eligible.ok) return eligible;
  const template = await readTemplateVersion(context, draft.template_version_id);
  if (template === null || template.approvedAt === null || template.retiredAt !== null || template.contentHash !== draft.template_content_hash) return { ok: false, reason: 'template_changed' };
  const composed = await composeBodyForWorkspace(context, { body: draft.body, signOff: template.footerSignOff });
  if (!composed.composed || composed.body !== draft.body) return { ok: false, reason: 'presentation_changed' };
  const fence = await readFenceByStepExecution(context, input.executionId);
  if (fence !== null) {
    if (!['prepared', 'held'].includes(fence.state) || fence.attemptToken !== null) return { ok: false, reason: 'delivery_in_progress' };
    if (fence.templateVersionId !== draft.template_version_id) return { ok: false, reason: 'template_changed' };
    if (fence.renderedHash !== draft.rendered_hash) {
      const rewritten = await rewritePreparedBody(context, { outboundMessageId: fence.id, body: draft.body, subject: draft.subject, reason: 'meeting_draft_revision' });
      if (!rewritten.ok) return { ok: false, reason: 'delivery_in_progress' };
    }
    await attachMeetingFence(context, { executionId: input.executionId, fenceId: fence.id });
  }
  return { ok: true, value: { draftId: draft.id, draftVersion: draft.version, subject: draft.subject, body: draft.body, renderedHash: draft.rendered_hash, notBefore: draft.not_before.toISOString() } };
}
export async function attachMeetingFence(context: RepositoryContext, input: { executionId: string; fenceId: string }): Promise<void> {
  await context.db.query(`UPDATE meeting_follow_through_drafts d SET outbound_message_id=$3 FROM meeting_follow_through p,step_executions e,outbound_messages m
    WHERE d.workspace_id=$1 AND p.workspace_id=d.workspace_id AND p.id=d.plan_id AND p.current_draft_version=d.version
    AND e.workspace_id=p.workspace_id AND e.enrollment_id=p.enrollment_id AND e.id=$2 AND e.ordinal=d.ordinal
    AND m.workspace_id=e.workspace_id AND m.id=$3 AND m.step_execution_id=e.id AND m.rendered_hash=d.rendered_hash
    AND d.state='ready' AND (d.outbound_message_id IS NULL OR d.outbound_message_id=$3)`, [context.scope.workspaceId, input.executionId, input.fenceId]);
}
/** A normal fence remains the provider authority; this adds current meeting/content identity. */
export async function verifyMeetingFence(context: RepositoryContext, input: { fenceId: string; at: string }): Promise<MeetingResult<{ planId: string | null }>> {
  const fence = await readFence(context, input.fenceId);
  if (fence?.stepExecutionId == null) return { ok: true, value: { planId: null } };
  const plan = await meetingPlanForExecution(context, fence.stepExecutionId);
  if (plan === null) return { ok: true, value: { planId: null } };
  const draft = await currentMeetingDraft(context, plan);
  if (draft === null || draft.outbound_message_id !== fence.id || draft.rendered_hash !== fence.renderedHash || renderedHash(fence.subject, fence.body) !== draft.rendered_hash) return { ok: false, reason: 'draft_changed' };
  const eligible = await verifyMeetingFollowThrough(context, { planId: plan.id, executionId: fence.stepExecutionId, draftVersion: draft.version, at: input.at });
  if (!eligible.ok) return eligible;
  const template = await readTemplateVersion(context, draft.template_version_id);
  if (template === null || template.approvedAt === null || template.retiredAt !== null || template.contentHash !== draft.template_content_hash || fence.templateVersionId !== template.id) return { ok: false, reason: 'template_changed' };
  const composed = await composeBodyForWorkspace(context, { body: draft.body, signOff: template.footerSignOff });
  if (!composed.composed || composed.body !== draft.body) return { ok: false, reason: 'presentation_changed' };
  return { ok: true, value: { planId: plan.id } };
}
/** Same transaction as the provider claim. Any failure rolls that claim back. */
export async function markMeetingDraftSubmitted(context: RepositoryContext, fenceId: string): Promise<boolean> {
  const fence = await readFence(context, fenceId);
  if (fence?.stepExecutionId == null) return true;
  const plan = await meetingPlanForExecution(context, fence.stepExecutionId);
  if (plan === null) return true;
  const result = await context.db.query(`UPDATE meeting_follow_through_drafts SET state='submitted' WHERE workspace_id=$1 AND plan_id=$2 AND version=$3
    AND outbound_message_id=$4 AND rendered_hash=$5 AND state='ready'`, [context.scope.workspaceId, plan.id, plan.current_draft_version, fenceId, fence.renderedHash]);
  return result.rowCount === 1;
}
/** After the delivery commit. The worker later finalizes tasks in its own Today transaction. */
export async function recordMeetingDelivery(context: RepositoryContext, input: { executionId: string; messageId: string; sentAt: string }): Promise<void> {
  await context.db.query(`WITH delivered AS (
    UPDATE meeting_follow_through_drafts d SET state='sent' FROM outbound_messages m
    WHERE d.workspace_id=$1 AND d.outbound_message_id=m.id AND m.workspace_id=d.workspace_id AND m.id=$2 AND m.step_execution_id=$3
      AND m.state='sent' AND m.rendered_hash=d.rendered_hash AND d.state IN ('submitted','sent') RETURNING d.plan_id
    ) UPDATE meeting_follow_through p SET status=CASE WHEN p.status IN ('cancelled','completed') THEN p.status ELSE 'awaiting_reply' END,
      next_wake_at=LEAST(next_wake_at,clock_timestamp()),updated_at=clock_timestamp()
      WHERE p.workspace_id=$1 AND p.id IN (SELECT plan_id FROM delivered)`, [context.scope.workspaceId, input.messageId, input.executionId]);
}
export async function holdPreparedMeetingFence(context: RepositoryContext, plan: FollowThroughRow): Promise<void> {
  const draft = await currentMeetingDraft(context, plan);
  if (draft?.outbound_message_id == null) return;
  const fence = await readFence(context, draft.outbound_message_id);
  if (fence?.state === 'prepared') await holdFence(context, { outboundMessageId: fence.id, reason: 'meeting_draft_changed' });
}
