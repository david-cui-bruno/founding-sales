import { meetingDeliveryHistory } from './followThroughHistory.ts';
export { meetingDeliveryHistory } from './followThroughHistory.ts';
import { composeBodyForWorkspace } from '../outbound/footer.ts';
import { readMeetingOutcomes } from './outcomes.ts';
import { resolveMeetingFollowThroughScope } from './followThroughScope.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { SessionQueryable } from '../db/queryable.ts';
import type { JobSpecification } from '../jobs/jobStore.ts';
import { lockSendGateForDispatch } from '../policy/sendGate.ts';
import { lockTodayForFirmChange, refreshTodayForFirm } from '../today/build.ts';
import { lockAnalysisMeeting } from './analysisRequests.ts';
import { currentHolidayCalendar } from '../sequences/calendars.ts';
import { dispatchHolidayCalendar } from '../outbound/stepPermission.ts';
import { readEnrollment, readSequenceVersion } from '../sequences/rows.ts';
import { readTemplateVersion, renderTemplateVersion } from '../templates/templates.ts';
import { templateVariablesFor } from '../sequences/variables.ts';
import { recordMeetingDelivery } from './followThroughDelivery.ts';
import { prepareMeetingRecap, readMeetingPlan, currentMeetingDraft, appendMeetingDraft, lockMeetingFollowThrough, meetingSendingPaused } from './followThrough.ts';
import { enrollMeetingFollowThrough } from './followThroughEligibility.ts';
import { nextMeetingFollowThroughAction, recapIsStale } from './followThroughSchedule.ts';
import { ensureUnresolvedMeetingTask, fulfillDeliveredMeetingMaterials } from './followThroughTasks.ts';
import type { FollowThroughRow } from './followThroughTypes.ts';
import { invalidateMeetingFollowThrough, meetingPlanInterruption, requiresExplicitMeetingReview } from './followThroughLifecycle.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
export { invalidateMeetingFollowThrough } from './followThroughLifecycle.ts';
export async function meetingScheduleContext(context: RepositoryContext, plan: FollowThroughRow) {
  const row = (await context.db.query<{ ends_at: Date; time_zone: string | null }>(`SELECT m.ends_at,f.time_zone FROM meetings m JOIN firms f ON f.workspace_id=m.workspace_id AND f.id=m.firm_id WHERE m.workspace_id=$1 AND m.id=$2`, [context.scope.workspaceId, plan.meeting_id])).rows[0];
  const enrollment = plan.enrollment_id === null ? null : await readEnrollment(context, { enrollmentId: plan.enrollment_id });
  const calendar = enrollment === null ? await currentHolidayCalendar(context) : await dispatchHolidayCalendar(context, enrollment);
  const version = plan.sequence_version_id === null ? null : await readSequenceVersion(context, plan.sequence_version_id);
  return { row, calendar, enrollment, version };
}
async function hold(context: RepositoryContext, plan: FollowThroughRow, reason: string) {
  await context.db.query("UPDATE meeting_follow_through SET status='needs_review',blockers=$3::jsonb,version=version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, plan.id, JSON.stringify([reason])]);
}
/** Preparation only; delivery stays in sequence.action. No Today lock is acquired here. */
export async function runMeetingFollowThrough(context: RepositoryContext, input: { meetingId: string; at: string }): Promise<void> {
  const locked = await lockMeetingFollowThrough(context, input.meetingId); if (!locked.ok) return;
  let plan = (await context.db.query<FollowThroughRow>('SELECT * FROM meeting_follow_through WHERE workspace_id=$1 AND meeting_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE', [context.scope.workspaceId, input.meetingId])).rows[0];
  if (plan === undefined) {
    const prepared = await prepareMeetingRecap(context, { ...input, expectedSourceHash: locked.value.sourceHash });
    if (!prepared.ok || prepared.value.planId === null) return;
    plan = (await readMeetingPlan(context, prepared.value.planId))!;
  }
  if (['cancelled','completed'].includes(plan.status)) return;
  const interruption = await meetingPlanInterruption(context, plan);
  if (interruption !== null) { await invalidateMeetingFollowThrough(context, { meetingId: plan.meeting_id, reason: interruption, eventId: plan.id }); return; }
  if (requiresExplicitMeetingReview(plan.blockers)) return;
  if (plan.blockers.includes('opportunity_required')) {
    // The current prerequisite was rechecked above; clear only this recoverable fact.
    await context.db.query("UPDATE meeting_follow_through SET blockers=$3::jsonb,status='draft',pause_observed_at=COALESCE(pause_observed_at,$4),version=version+1,next_wake_at=$4,updated_at=$4 WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, plan.id, JSON.stringify(plan.blockers.filter(r => r !== 'opportunity_required')), input.at]);
    plan = (await readMeetingPlan(context, plan.id))!;
  }
  let schedule = await meetingScheduleContext(context, plan);
  const zone = schedule.row?.time_zone;
  if (zone == null) { await hold(context, plan, 'time_zone_unresolved'); return; }
  const unverified = (await context.db.query(`SELECT m.id FROM meeting_follow_through_drafts d JOIN outbound_messages m ON m.workspace_id=d.workspace_id AND m.id=d.outbound_message_id
    WHERE d.workspace_id=$1 AND d.plan_id=$2 AND m.state='sent' AND (m.rendered_hash<>d.rendered_hash OR EXISTS(SELECT 1 FROM outbound_message_events ev WHERE ev.workspace_id=m.workspace_id AND ev.outbound_message_id=m.id AND ev.detail->>'sentBytes'='unverified')) LIMIT 1`, [context.scope.workspaceId,plan.id])).rows[0];
  if (unverified !== undefined) { await hold(context, plan, 'delivery_bytes_unverified'); return; }
  const deliveries = await meetingDeliveryHistory(context, plan.id);
  // Restore or a process death may leave a sent fence beside a submitted draft.
  for (const sent of deliveries) if (sent.messageId !== undefined && plan.enrollment_id !== null) {
    const execution = (await context.db.query<{ id: string }>('SELECT id FROM step_executions WHERE workspace_id=$1 AND enrollment_id=$2 AND ordinal=$3', [context.scope.workspaceId, plan.enrollment_id, sent.ordinal])).rows[0];
    if (execution !== undefined) await recordMeetingDelivery(context, { executionId: execution.id, messageId: sent.messageId, sentAt: sent.sentAt });
  }
  let draft = await currentMeetingDraft(context, plan);
  if (plan.editing || draft?.state === 'submitted') return;
  const paused = await meetingSendingPaused(context, plan.owner_user_id);
  if (paused) {
    await context.db.query('UPDATE meeting_follow_through SET pause_observed_at=COALESCE(pause_observed_at,$3) WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, plan.id, input.at]);
    return;
  }
  if (deliveries.length === 0) {
    // An explicit Save after the stale hold records review; a timer cannot clear it.
    const reviewed = plan.reviewed_at !== null && plan.reviewed_draft_version === plan.current_draft_version && !recapIsStale(plan.reviewed_at.toISOString(), input.at, zone, schedule.calendar);
    const scope = plan.contact_id === null ? null : await resolveMeetingFollowThroughScope(context, { meetingId: plan.meeting_id, contactId: plan.contact_id, sourceHash: plan.source_hash });
    const agreed = scope?.ok === true && scope.value.agreedReminder !== null;
    if (!agreed && recapIsStale(schedule.row!.ends_at.toISOString(), input.at, zone, schedule.calendar) && !reviewed) { await hold(context, plan, 'recap_stale'); return; }
    const prepared = await prepareMeetingRecap(context, { ...input, expectedSourceHash: locked.value.sourceHash });
    if (!prepared.ok) return;
    plan = (await readMeetingPlan(context, plan.id))!; draft = await currentMeetingDraft(context, plan);
    if (plan.blockers.length > 0 || draft === null) return;
    if (plan.pause_observed_at !== null && draft.not_before.getTime() <= Date.parse(input.at)) {
      const appended = await appendMeetingDraft(context, plan, { subject: draft.subject, body: draft.body, templateVersionId: draft.template_version_id, sourceHash: draft.source_hash, materialReferences: draft.material_references, at: input.at, ordinal: draft.ordinal });
      if (!appended.ok) { await hold(context, plan, appended.reason); return; }
      plan = (await readMeetingPlan(context, plan.id))!; draft = await currentMeetingDraft(context, plan);
    }
    await context.db.query('UPDATE meeting_follow_through SET pause_observed_at=NULL WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, plan.id]);
    const enrolled = await enrollMeetingFollowThrough(context, { planId: plan.id, expectedVersion: plan.version, at: input.at });
    if (!enrolled.ok) { await hold(context, plan, enrolled.reason); return; }
    plan = (await readMeetingPlan(context, plan.id))!;
    const action = nextMeetingFollowThroughAction({ plan: { scope: plan.scope, maxMessages: schedule.version?.steps.length ?? 0 }, deliveryHistory: [], at: input.at, calendar: schedule.calendar, zone });
    if (action.kind === 'review') { await hold(context, plan, action.reason); return; }
    if (draft !== null) await context.db.query('UPDATE step_executions SET due_at=GREATEST(due_at,$3::timestamptz),not_before=GREATEST(not_before,$3::timestamptz) WHERE workspace_id=$1 AND enrollment_id=$2 AND ordinal=1', [context.scope.workspaceId, plan.enrollment_id, action.kind === 'nudge' ? new Date(Math.max(Date.parse(action.dueAt), draft.not_before.getTime())).toISOString() : draft.not_before.toISOString()]);
    return;
  }
  if (plan.enrollment_id === null && plan.blockers.length === 0 && plan.source_hash === locked.value.sourceHash) {
    const enrolled = await enrollMeetingFollowThrough(context, { planId: plan.id, expectedVersion: plan.version, at: input.at });
    if (!enrolled.ok) { await hold(context, plan, enrolled.reason); return; }
    plan = (await readMeetingPlan(context, plan.id))!;
    schedule = await meetingScheduleContext(context, plan);
  }
  if (plan.source_hash !== locked.value.sourceHash || plan.blockers.length > 0) { await hold(context, plan, 'source_changed'); return; }
  const action = nextMeetingFollowThroughAction({ plan: { scope: plan.scope, maxMessages: schedule.version?.steps.length ?? 0 }, deliveryHistory: deliveries, at: input.at, calendar: schedule.calendar, zone });
  if (action.kind === 'review') { await hold(context, plan, action.reason); return; }
  if (action.kind !== 'nudge') return;
  // Prepare a nudge only once its day arrives; every nudge has the same edit window.
  if (Date.parse(action.dueAt) > Date.parse(input.at) + 30 * 60_000) return;
  const step = schedule.version?.steps.find(s => s.ordinal === action.ordinal), template = step?.templateVersionId == null ? null : await readTemplateVersion(context, step.templateVersionId);
  if (template === null || template.approvedAt === null || template.retiredAt !== null || plan.contact_id === null) { await hold(context, plan, 'template_unapproved'); return; }
  if (draft?.ordinal === action.ordinal && draft.state !== 'sent') {
    const composed = await composeBodyForWorkspace(context, { body: draft.body, signOff: template.footerSignOff });
    if (!composed.composed) { await hold(context, plan, 'presentation_changed'); return; }
    if (template.id !== draft.template_version_id || template.contentHash !== draft.template_content_hash) { await hold(context, plan, 'template_changed'); return; }
    if ((plan.pause_observed_at !== null && draft.not_before.getTime() <= Date.parse(input.at)) || composed.body !== draft.body) {
      const appended = await appendMeetingDraft(context, plan, { subject: draft.subject, body: composed.body, templateVersionId: draft.template_version_id, sourceHash: draft.source_hash, materialReferences: draft.material_references, at: input.at, ordinal: draft.ordinal });
      if (!appended.ok) { await hold(context, plan, appended.reason); return; }
    }
    await context.db.query("UPDATE meeting_follow_through SET status='scheduled',pause_observed_at=NULL WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId,plan.id]);
    return;
  }
  // Later messages use approved nudge copy, not a repeat of the original recap.
  const rendered = renderTemplateVersion(template, await templateVariablesFor(context, { firmId: plan.firm_id, contactId: plan.contact_id }));
  if (!rendered.rendered || template.requiredVariables.includes('meeting_recap')) { await hold(context, plan, 'nudge_template_required'); return; }
  const appended = await appendMeetingDraft(context, plan, { subject: rendered.subject, body: rendered.body, templateVersionId: template.id, sourceHash: plan.source_hash, materialReferences: [], ordinal: action.ordinal, at: input.at });
  if (!appended.ok) { await hold(context, plan, appended.reason); return; }
  await context.db.query("UPDATE meeting_follow_through SET status='scheduled',pause_observed_at=NULL WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, plan.id]);
}
/** Separate post-commit chunk: gate shared → Today shared → firm → meeting. */
export async function finalizeMeetingFollowThrough(context: RepositoryContext, input: { meetingId: string; at: string }): Promise<void> {
  await lockSendGateForDispatch(context); await lockTodayForFirmChange(context);
  const firmId = await lockAnalysisMeeting(context, input.meetingId); if (firmId === null) return;
  const plans = (await context.db.query<FollowThroughRow>('SELECT * FROM meeting_follow_through WHERE workspace_id=$1 AND meeting_id=$2 ORDER BY id FOR UPDATE', [context.scope.workspaceId, input.meetingId])).rows;
  const outcomes = await readMeetingOutcomes(context, input);
  for (const plan of plans) {
    if (['cancelled','completed','needs_review'].includes(plan.status) || plan.blockers.length > 0 || outcomes?.sourceHash !== plan.source_hash || await meetingPlanInterruption(context, plan) !== null) continue;
    await fulfillDeliveredMeetingMaterials(context, plan.id);
    const schedule = await meetingScheduleContext(context, plan), zone = schedule.row?.time_zone;
    if (zone == null) continue;
    const action = nextMeetingFollowThroughAction({ plan: { scope: plan.scope, maxMessages: schedule.version?.steps.length ?? 0 }, deliveryHistory: await meetingDeliveryHistory(context, plan.id), at: input.at, calendar: schedule.calendar, zone });
    if (action.kind === 'task' && Date.parse(action.dueAt) <= Date.parse(input.at) && plan.owner_user_id !== null) {
      await ensureUnresolvedMeetingTask(context, { ...input, planId: plan.id, ownerUserId: plan.owner_user_id, dueAt: action.dueAt, deadline: action.deadline });
    } else if (action.kind !== 'complete') continue;
    await context.db.query("UPDATE meeting_follow_through SET status='completed',version=version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, plan.id]);
    await recordCrmAuditEvent(context, { action: 'meeting.follow_through_completed', subjectKind: 'meeting', subjectId: plan.meeting_id, detail: { planId: plan.id } });
  }
  await refreshTodayForFirm(context, { firmId });
}
export async function scheduleMeetingFollowThrough(session: SessionQueryable, at: string): Promise<readonly JobSpecification[]> {
  const rows = (await session.query<{ workspace_id: string; id: string; plan_id: string | null; revision: number }>(`SELECT m.workspace_id,m.id,p.id AS plan_id,COALESCE(p.wake_revision,0) AS revision FROM meetings m
    JOIN workspace_settings s ON s.workspace_id=m.workspace_id AND s.setting_key='meeting_follow_through' AND s.superseded_at IS NULL AND s.value->>'sequenceVersionId' IS NOT NULL
    LEFT JOIN meeting_follow_through p ON p.workspace_id=m.workspace_id AND p.meeting_id=m.id
    WHERE m.firm_id IS NOT NULL AND m.state='held' AND m.ends_at<=$1 AND ((p.id IS NULL AND EXISTS(SELECT 1 FROM meeting_analyses a WHERE a.workspace_id=m.workspace_id AND a.meeting_id=m.id AND a.state='ready')) OR (p.status NOT IN ('cancelled','completed') AND p.next_wake_at<=$1))
    AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.workspace_id=m.workspace_id AND j.kind='meeting.follow_through' AND j.payload->>'meetingId'=m.id::text AND j.state IN ('queued','running','retryable'))
    ORDER BY m.updated_at,m.id LIMIT 25`, [at])).rows;
  const jobs: JobSpecification[] = [];
  for (const row of rows) {
    if (row.plan_id !== null) await session.query("UPDATE meeting_follow_through SET next_wake_at=$3::timestamptz+interval '5 minutes',wake_revision=wake_revision+1 WHERE workspace_id=$1 AND id=$2", [row.workspace_id,row.plan_id,at]);
    jobs.push({ workspaceId: row.workspace_id, kind: 'meeting.follow_through', idempotencyKey: `meeting-follow-through:${row.id}:${row.plan_id ?? 'initial'}:${String(row.revision)}`, payload: { meetingId: row.id }, maxAttempts: 3 });
  }
  return jobs;
}
