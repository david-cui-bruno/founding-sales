import { meetingDeliveryHistory } from './followThroughHistory.ts';
import { meetingPlanInterruption } from './followThroughLifecycle.ts';
import { recapIsStale, nextMeetingFollowThroughAction } from './followThroughSchedule.ts';
import { meetingScheduleContext } from './followThroughJobs.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { verifyFollowUpPermission, type FollowUpPermissionRow, type FollowUpSubject } from '../sequences/followUpPermissions.ts';
import { enrollContact } from '../sequences/enrollments.ts';
import { readSequenceVersion } from '../sequences/rows.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { currentMeetingDraft, lockMeetingFollowThrough, readMeetingPlan } from './followThrough.ts';
import { resolveMeetingFollowThroughScope } from './followThroughScope.ts';
import type { FollowThroughRow } from './followThroughTypes.ts';
import type { MeetingResult } from './outcomeTypes.ts';
export { resolveMeetingFollowThroughScope } from './followThroughScope.ts';

async function planAuthority(context: RepositoryContext, plan: FollowThroughRow, at: string): Promise<MeetingResult<{ planId: string; planVersion: number }>> {
  if (plan.contact_id === null || plan.owner_user_id === null || plan.sequence_version_id === null) return { ok: false, reason: 'recipient_unresolved' };
  if (['cancelled', 'completed', 'needs_review'].includes(plan.status) || plan.blockers.length > 0) return { ok: false, reason: 'plan_held' };
  if (plan.editing) return { ok: false, reason: 'editing' };
  const interruption = await meetingPlanInterruption(context, plan);
  if (interruption !== null) return { ok: false, reason: interruption };
  const resolved = await resolveMeetingFollowThroughScope(context, { meetingId: plan.meeting_id, contactId: plan.contact_id, sourceHash: plan.source_hash });
  if (!resolved.ok) return resolved;
  if (Date.parse(resolved.value.expiresAt) <= Date.parse(at)) return { ok: false, reason: 'follow_up_expired' };
  if (plan.scope !== null && (plan.scope.contactId !== resolved.value.contactId || plan.scope.meetingId !== resolved.value.meetingId
    || plan.scope.maxMessages > resolved.value.maxMessages || JSON.stringify(plan.scope.agreedReminder) !== JSON.stringify(resolved.value.agreedReminder))) return { ok: false, reason: 'scope_changed' };
  const current = (await context.db.query<{ assigned_user_id: string | null; status: string; opportunity_id: string | null; control_mode: string | null; control_mode_origin: string | null; opportunity_status: string | null; ends_at: Date }>(
    `SELECT f.assigned_user_id,f.status,m.opportunity_id,m.ends_at,o.control_mode,o.control_mode_origin,o.status AS opportunity_status
     FROM meetings m JOIN firms f ON f.workspace_id=m.workspace_id AND f.id=m.firm_id
     LEFT JOIN opportunities o ON o.workspace_id=m.workspace_id AND o.id=m.opportunity_id
     WHERE m.workspace_id=$1 AND m.id=$2`, [context.scope.workspaceId, plan.meeting_id])).rows[0];
  if (current === undefined || current.status !== 'active' || current.assigned_user_id !== plan.owner_user_id) return { ok: false, reason: 'not_assigned' };
  if (current.ends_at.getTime() > Date.parse(at)) return { ok: false, reason: 'meeting_not_finished' };
  if (current.opportunity_id === null || current.opportunity_status !== 'open') return { ok: false, reason: 'opportunity_required' };
  if (current.control_mode !== 'automated' && !['human_reply', 'engaged_call', 'direct_send_keep_automation'].includes(current.control_mode_origin ?? '')) return { ok: false, reason: 'opportunity_manual' };
  const other = (await context.db.query(`SELECT id FROM sequence_enrollments WHERE workspace_id=$1 AND firm_id=$2 AND ended_at IS NULL
    AND id IS DISTINCT FROM $3::uuid AND NOT(origin_kind='cold_legacy' AND contact_id=$4) LIMIT 1`, [context.scope.workspaceId, plan.firm_id, plan.enrollment_id, plan.contact_id])).rows[0];
  if (other !== undefined) return { ok: false, reason: 'firm_already_enrolled' };
  return { ok: true, value: { planId: plan.id, planVersion: plan.version } };
}

/** Used by both the evidence and scope checks. A booking string alone never passes. */
export async function verifyMeetingBookingPermission(context: RepositoryContext, permission: FollowUpPermissionRow, subject: FollowUpSubject): Promise<string | null> {
  if (permission.kind !== 'booking' || permission.scope !== 'booking_communications' || permission.bookingReference === null) return 'booking_scope_unbound';
  const plan = (await context.db.query<FollowThroughRow>('SELECT * FROM meeting_follow_through WHERE workspace_id=$1 AND permission_id=$2', [context.scope.workspaceId, permission.id])).rows[0];
  if (plan === undefined || plan.scope === null || plan.sequence_version_id === null) return 'booking_scope_unbound';
  if (plan.firm_id !== permission.firmId || plan.contact_id !== permission.contactId || plan.enrollment_id !== permission.enrollmentId) return 'booking_scope_mismatch';
  const alias = (await context.db.query(`SELECT m.id FROM meetings m WHERE m.workspace_id=$1 AND m.id=$2 AND (m.booking_uid=$3 OR m.current_booking_uid=$3
    OR EXISTS(SELECT 1 FROM meeting_booking_uids a WHERE a.workspace_id=m.workspace_id AND a.meeting_id=m.id AND a.booking_uid=$3))`, [context.scope.workspaceId, plan.meeting_id, permission.bookingReference])).rows[0];
  if (alias === undefined) return 'booking_missing';
  if (Date.parse(permission.expiresAt) > Date.parse(plan.scope.expiresAt)) return 'booking_scope_extended';
  if (subject.sequenceVersionId != null && subject.sequenceVersionId !== plan.sequence_version_id) return 'another_version';
  if ((subject.stepCount ?? 1) > 3 || (subject.stepOrdinal ?? 1) > plan.scope.maxMessages) return 'booking_scope_exhausted';
  if (subject.nextStep !== undefined && subject.nextStep?.channel !== 'email') return 'not_an_email';
  const version = await readSequenceVersion(context, plan.sequence_version_id);
  if (version === null || version.state !== 'published' || version.steps.length === 0 || version.steps.length > 3 || version.steps.some(s => s.channel !== 'email')) return 'recap_sequence_required';
  const result = await planAuthority(context, plan, subject.now);
  return result.ok ? null : result.reason;
}

export async function enrollMeetingFollowThrough(context: RepositoryContext, input: { planId: string; expectedVersion: number; at: string }): Promise<MeetingResult<{ enrollmentId: string }>> {
  const located = await readMeetingPlan(context, input.planId);
  if (located === null) return { ok: false, reason: 'meeting_unknown' };
  const locked = await lockMeetingFollowThrough(context, located.meeting_id);
  if (!locked.ok) return locked;
  const plan = (await context.db.query<FollowThroughRow>('SELECT * FROM meeting_follow_through WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [context.scope.workspaceId, input.planId])).rows[0]!;
  if (plan.enrollment_id !== null) return { ok: true, value: { enrollmentId: plan.enrollment_id } };
  if (plan.version !== input.expectedVersion) return { ok: false, reason: 'draft_changed' };
  const eligible = await planAuthority(context, plan, input.at);
  if (!eligible.ok) return eligible;
  const draft = await currentMeetingDraft(context, plan);
  const manualRecap = draft?.state === 'sent' && draft.ordinal === 1 && draft.manual_message_id !== null
    ? (await meetingDeliveryHistory(context, plan.id)).find(d => d.ordinal === 1 && d.messageId === draft.manual_message_id) : undefined;
  if (draft === null || draft.source_hash !== plan.source_hash || (draft.state !== 'ready' && manualRecap === undefined)) return { ok: false, reason: 'draft_not_ready' };
  const resolved = await resolveMeetingFollowThroughScope(context, { meetingId: plan.meeting_id, contactId: plan.contact_id!, sourceHash: plan.source_hash });
  if (!resolved.ok) return resolved;
  const version = await readSequenceVersion(context, plan.sequence_version_id!);
  if (version === null || version.state !== 'published' || version.steps.length === 0 || version.steps.length > 3 || version.steps.some(s => s.channel !== 'email')) return { ok: false, reason: 'recap_sequence_required' };
  const opportunity = (await context.db.query<{ opportunity_id: string }>('SELECT opportunity_id FROM meetings WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, plan.meeting_id])).rows[0]!;
  // Columns reserved by 0025 stay NULL; the plan supplies the checked immutable version and count.
  const permissionId = (await context.db.query<{ id: string }>(`INSERT INTO follow_up_permissions(workspace_id,firm_id,contact_id,kind,scope,booking_reference,granted_at,expires_at,granted_by_rule)
    VALUES($1,$2,$3,'booking','booking_communications',$4,$5,$6,'meeting.completed_demo') RETURNING id`,
    [context.scope.workspaceId, plan.firm_id, plan.contact_id, resolved.value.bookingReference, input.at, resolved.value.expiresAt])).rows[0]!.id;
  await context.db.query('UPDATE meeting_follow_through SET permission_id=$3,scope=$4::jsonb WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, plan.id, permissionId, JSON.stringify(resolved.value)]);
  const enrolled = await enrollContact(context, { originKind: 'follow_up', permissionId, sequenceVersionId: plan.sequence_version_id!, opportunityId: opportunity.opportunity_id, firmId: plan.firm_id, contactId: plan.contact_id!, assignedUserId: plan.owner_user_id! });
  if (!enrolled.ok) {
    await context.db.query('UPDATE meeting_follow_through SET permission_id=NULL,scope=NULL WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, plan.id]);
    await context.db.query('DELETE FROM follow_up_permissions WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, permissionId]);
    return enrolled;
  }
  await context.db.query("UPDATE meeting_follow_through SET enrollment_id=$3,status='scheduled',version=version+1,updated_at=$4 WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, plan.id, enrolled.value.enrollmentId, input.at]);
  await context.db.query('UPDATE step_executions SET due_at=GREATEST(due_at,$3::timestamptz) WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, enrolled.value.firstExecutionId, draft.not_before.toISOString()]);
  if (manualRecap !== undefined) {
    // The same transaction records ordinal 1 as already delivered before any worker can claim it.
    // Enrollment/permission initialization precedes the execution module's channel tables.
    const { completeStepExecution } = await import('../sequences/executions.ts');
    const completed = await completeStepExecution(context, { stepExecutionId: enrolled.value.firstExecutionId, completionSource: 'system', result: 'sent', completedAt: manualRecap.sentAt });
    if (!completed.ok) throw new Error('manual_recap_completion_failed');
    await context.db.query("UPDATE meeting_follow_through SET status='awaiting_reply' WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, plan.id]);
  }
  await recordCrmAuditEvent(context, { action: 'meeting.follow_through_enrolled', subjectKind: 'meeting', subjectId: plan.meeting_id, detail: { planId: plan.id, enrollmentId: enrolled.value.enrollmentId } });
  return { ok: true, value: { enrollmentId: enrolled.value.enrollmentId } };
}

export async function verifyMeetingFollowThrough(context: RepositoryContext, input: { planId: string; executionId: string; draftVersion: number; at: string }): Promise<MeetingResult<{ planId: string; planVersion: number }>> {
  const plan = await readMeetingPlan(context, input.planId);
  if (plan === null) return { ok: false, reason: 'meeting_unknown' };
  const eligible = await planAuthority(context, plan, input.at);
  if (!eligible.ok) return eligible;
  const draft = await currentMeetingDraft(context, plan);
  if (draft === null || draft.version !== input.draftVersion) return { ok: false, reason: 'draft_changed' };
  if (draft.source_hash !== plan.source_hash) return { ok: false, reason: 'source_changed' };
  if (draft.state !== 'ready' || draft.not_before.getTime() > Date.parse(input.at)) return { ok: false, reason: 'draft_not_ready' };
  if (plan.pause_observed_at !== null) return { ok: false, reason: 'resume_window_required' };
  const schedule = await meetingScheduleContext(context, plan), zone = schedule.row?.time_zone;
  if (zone == null) return { ok: false, reason: 'time_zone_unresolved' };
  if (draft.ordinal === 1 && plan.scope?.agreedReminder == null && recapIsStale(schedule.row!.ends_at.toISOString(), input.at, zone, schedule.calendar)
    && !(plan.reviewed_at !== null && plan.reviewed_draft_version === draft.version && !recapIsStale(plan.reviewed_at.toISOString(), input.at, zone, schedule.calendar))) return { ok: false, reason: 'recap_stale' };
  if (draft.ordinal === 1 && plan.scope?.agreedReminder != null) {
    const agreed = nextMeetingFollowThroughAction({ plan: { scope: plan.scope, maxMessages: 1 }, deliveryHistory: [], at: input.at, calendar: schedule.calendar, zone });
    if (agreed.kind !== 'nudge' || Date.parse(agreed.dueAt) > Date.parse(input.at)) return { ok: false, reason: 'reminder_not_due' };
  }
  if (draft.ordinal > 1) {
    const action = nextMeetingFollowThroughAction({ plan: { scope: plan.scope, maxMessages: schedule.version?.steps.length ?? 0 }, deliveryHistory: await meetingDeliveryHistory(context, plan.id), at: input.at, calendar: schedule.calendar, zone });
    if (action.kind === 'review') return { ok: false, reason: action.reason };
    if (action.kind !== 'nudge' || action.ordinal !== draft.ordinal || Date.parse(action.dueAt) > Date.parse(input.at)) return { ok: false, reason: 'nudge_not_due' };
  }
  const execution = (await context.db.query<{ ordinal: number; template_version_id: string | null }>(`SELECT s.ordinal,s.template_version_id FROM step_executions e JOIN sequence_steps s ON s.workspace_id=e.workspace_id AND s.id=e.step_id
    JOIN sequence_enrollments n ON n.workspace_id=e.workspace_id AND n.id=e.enrollment_id AND n.ended_at IS NULL
    WHERE e.workspace_id=$1 AND e.id=$2 AND e.enrollment_id=$3`, [context.scope.workspaceId, input.executionId, plan.enrollment_id])).rows[0];
  if (execution === undefined || plan.scope === null || execution.ordinal > plan.scope.maxMessages || execution.ordinal !== draft.ordinal || execution.template_version_id !== draft.template_version_id) return { ok: false, reason: 'scope_changed' };
  if (plan.permission_id === null) return { ok: false, reason: 'permission_missing' };
  const permission = await verifyFollowUpPermission(context, plan.permission_id, { firmId: plan.firm_id, contactId: plan.contact_id!, now: input.at, sequenceVersionId: plan.sequence_version_id, enrollmentId: plan.enrollment_id, stepOrdinal: execution.ordinal, templateVersionId: draft.template_version_id });
  if (!permission.ok) return { ok: false, reason: permission.detail };
  return eligible;
}
