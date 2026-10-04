import { hasOptOutLink, meetingDraftEditSchema, meetingFollowThroughSettingSchema, meetingFollowThroughViewSchema,
  type MeetingDraftEdit, type MeetingFollowThroughView, type MeetingOutcomesView } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { loadFirmForUpdate } from '../crm/firms.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { readSetting } from '../settings/store.ts';
import { readSequenceVersion } from '../sequences/rows.ts';
import { readTemplateVersion } from '../templates/templates.ts';
import { templateVariablesFor } from '../sequences/variables.ts';
import { renderedHash } from '../outbound/fence.ts';
import { readMeetingOutcomes } from './outcomes.ts';
import { buildMeetingRecapContent } from './recapDrafts.ts';
import type { FollowThroughDraftRow, FollowThroughRow } from './followThroughTypes.ts';
import type { MeetingResult } from './outcomeTypes.ts';

export const RECAP_EDIT_WINDOW_MS = 30 * 60_000;
export async function readMeetingPlan(context: RepositoryContext, planId: string): Promise<FollowThroughRow | null> {
  return (await context.db.query<FollowThroughRow>('SELECT * FROM meeting_follow_through WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, planId])).rows[0] ?? null;
}
export async function currentMeetingDraft(context: RepositoryContext, plan: FollowThroughRow): Promise<FollowThroughDraftRow | null> {
  return (await context.db.query<FollowThroughDraftRow>('SELECT * FROM meeting_follow_through_drafts WHERE workspace_id=$1 AND plan_id=$2 AND version=$3', [context.scope.workspaceId, plan.id, plan.current_draft_version])).rows[0] ?? null;
}
export async function meetingSendingPaused(context: RepositoryContext): Promise<boolean> {
  const setting = (await readSetting(context, 'sending_enabled')).value as { enabled?: boolean };
  if (setting.enabled !== true) return true;
  const row = (await context.db.query<{ enabled: boolean }>("SELECT automated_sending_enabled AS enabled FROM sending_domains WHERE workspace_id=$1 AND domain='usecallie.com'", [context.scope.workspaceId])).rows[0];
  return row?.enabled !== true;
}

/** Same gate → firm → meeting order as notes and attendance. Caller owns the transaction. */
export async function lockMeetingFollowThrough(context: RepositoryContext, meetingId: string): Promise<MeetingResult<MeetingOutcomesView>> {
  await lockSendGateForStopFact(context);
  const located = (await context.db.query<{ firm_id: string | null }>('SELECT firm_id FROM meetings WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, meetingId])).rows[0];
  if (located?.firm_id === undefined || located.firm_id === null) return { ok: false, reason: 'meeting_unknown' };
  const firm = await loadFirmForUpdate(context, located.firm_id);
  if (firm === null) return { ok: false, reason: 'meeting_unknown' };
  const access = decideFirmMutation(context, firm);
  if (!access.permitted) return { ok: false, reason: access.reason };
  const row = (await context.db.query<{ firm_id: string | null }>('SELECT firm_id FROM meetings WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [context.scope.workspaceId, meetingId])).rows[0];
  if (row?.firm_id !== firm.id) return { ok: false, reason: 'meeting_unknown' };
  const view = await readMeetingOutcomes(context, { meetingId });
  return view === null ? { ok: false, reason: 'meeting_unknown' } : { ok: true, value: view };
}

export async function readMeetingFollowThrough(context: RepositoryContext, input: { meetingId: string }): Promise<MeetingFollowThroughView | null> {
  const outcomes = await readMeetingOutcomes(context, input);
  if (outcomes === null) return null;
  const workspace = context.scope.workspaceId;
  const plan = (await context.db.query<FollowThroughRow>('SELECT * FROM meeting_follow_through WHERE workspace_id=$1 AND meeting_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1', [workspace, input.meetingId])).rows[0];
  const draft = plan === undefined ? null : await currentMeetingDraft(context, plan);
  const sendingPaused = await meetingSendingPaused(context);
  const blockers = [...(plan?.blockers ?? [])];
  if (plan !== undefined && plan.source_hash !== outcomes.sourceHash) blockers.push('source_changed');
  if (plan?.editing === true) blockers.push('editing');
  if (sendingPaused) blockers.push('sending_paused');
  const final = await readMeetingOutcomes(context, input);
  if (final === null || final.firmId !== outcomes.firmId || final.sourceHash !== outcomes.sourceHash) return null;
  return meetingFollowThroughViewSchema.parse({ meetingId: input.meetingId, firmId: outcomes.firmId, contactId: plan?.contact_id ?? null,
    planId: plan?.id ?? null, version: plan?.version ?? 0, sourceHash: plan?.source_hash ?? outcomes.sourceHash, notesRevision: plan?.notes_revision ?? outcomes.notes.revision,
    sequenceVersionId: plan?.sequence_version_id ?? null, status: plan?.status === 'cancelled' || plan?.status === 'completed' ? plan.status : blockers.includes('source_changed') ? 'needs_review' : plan?.editing === true ? 'held' : plan?.status ?? 'draft',
    currentDraft: draft === null ? null : { id: draft.id, version: draft.version, ordinal: draft.ordinal, subject: draft.subject, body: draft.body,
      renderedHash: draft.rendered_hash, templateVersionId: draft.template_version_id, sourceHash: draft.source_hash, materialReferences: draft.material_references,
      createdAt: draft.created_at.toISOString(), notBefore: draft.not_before.toISOString(), state: draft.state },
    scope: plan?.scope ?? null, blockers: [...new Set(blockers)].slice(0, 30), sendingPaused, plannedSteps: [], sentMessages: [] });
}

export async function appendMeetingDraft(context: RepositoryContext, plan: FollowThroughRow, content: {
  subject: string; body: string; templateVersionId: string; sourceHash: string; materialReferences: readonly string[]; at: string; ordinal?: number;
}): Promise<void> {
  const at = new Date(content.at).toISOString();
  await context.db.query("UPDATE meeting_follow_through_drafts SET state='superseded' WHERE workspace_id=$1 AND plan_id=$2 AND version=$3 AND state NOT IN ('submitted','sent')", [context.scope.workspaceId, plan.id, plan.current_draft_version]);
  await context.db.query(`INSERT INTO meeting_follow_through_drafts(workspace_id,plan_id,version,ordinal,subject,body,rendered_hash,template_version_id,source_hash,material_references,created_at,not_before,created_by_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)`, [context.scope.workspaceId, plan.id, plan.current_draft_version + 1, content.ordinal ?? 1,
    content.subject, content.body, renderedHash(content.subject, content.body), content.templateVersionId, content.sourceHash, JSON.stringify(content.materialReferences), at,
    new Date(Date.parse(at) + RECAP_EDIT_WINDOW_MS).toISOString(), context.scope.actor.kind === 'user' ? context.scope.actor.userId : null]);
  await context.db.query('UPDATE meeting_follow_through SET current_draft_version=current_draft_version+1,version=version+1,editing=false,updated_at=$3 WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, plan.id, at]);
}

export async function prepareMeetingRecap(context: RepositoryContext, input: { meetingId: string; expectedSourceHash: string; at: string }): Promise<MeetingResult<MeetingFollowThroughView>> {
  const locked = await lockMeetingFollowThrough(context, input.meetingId);
  if (!locked.ok) return locked;
  const outcomes = locked.value, workspace = context.scope.workspaceId;
  if (outcomes.sourceHash !== input.expectedSourceHash) return { ok: false, reason: 'source_changed' };
  let plan = (await context.db.query<FollowThroughRow>('SELECT * FROM meeting_follow_through WHERE workspace_id=$1 AND meeting_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE', [workspace, input.meetingId])).rows[0];
  if (plan !== undefined && (plan.editing || ['cancelled', 'completed', 'awaiting_reply'].includes(plan.status))) {
    return { ok: true, value: (await readMeetingFollowThrough(context, input))! };
  }
  const setting = meetingFollowThroughSettingSchema.parse((await readSetting(context, 'meeting_follow_through')).value);
  const sequenceId = plan?.sequence_version_id ?? setting.sequenceVersionId;
  const version = sequenceId === null ? null : await readSequenceVersion(context, sequenceId);
  const first = version?.steps[0];
  const template = first?.templateVersionId === undefined || first.templateVersionId === null ? null : await readTemplateVersion(context, first.templateVersionId);
  const contactId = (await context.db.query<{ contact_id: string | null }>('SELECT contact_id FROM meetings WHERE workspace_id=$1 AND id=$2', [workspace, input.meetingId])).rows[0]?.contact_id ?? null;
  const content = template === null ? { ok: false as const, reasons: ['recap_template_required'] }
    : buildMeetingRecapContent({ outcomes, template, variables: contactId === null ? {} : await templateVariablesFor(context, { firmId: outcomes.firmId, contactId }) });
  const blockers = content.ok ? [] : [...content.reasons];
  if (contactId === null) blockers.push('recipient_unresolved');
  if (version?.state !== 'published' || version.steps.length > 3 || version.steps.some(step => step.channel !== 'email')) blockers.push('recap_sequence_required');
  if (outcomes.attendance !== 'attended') blockers.push('attendance_unconfirmed');
  if (plan === undefined) {
    plan = (await context.db.query<FollowThroughRow>(`INSERT INTO meeting_follow_through(workspace_id,meeting_id,firm_id,contact_id,owner_user_id,source_hash,notes_revision,analysis_id,sequence_version_id,created_at,updated_at)
      SELECT m.workspace_id,m.id,m.firm_id,m.contact_id,f.assigned_user_id,$3,$4,$5,$6,$7,$7 FROM meetings m JOIN firms f ON f.workspace_id=m.workspace_id AND f.id=m.firm_id WHERE m.workspace_id=$1 AND m.id=$2 RETURNING *`,
    [workspace, input.meetingId, outcomes.sourceHash, outcomes.notes.revision, outcomes.analysisId, sequenceId, input.at])).rows[0];
    if (plan === undefined) return { ok: false, reason: 'meeting_unknown' };
  }
  const draft = await currentMeetingDraft(context, plan);
  if (draft?.state === 'submitted' || draft?.state === 'sent') return { ok: false, reason: 'delivery_in_progress' };
  if (content.ok && template !== null && (draft === null || plan.source_hash !== outcomes.sourceHash || draft.template_version_id !== template.id)) {
    await appendMeetingDraft(context, plan, { ...content, templateVersionId: template.id, sourceHash: outcomes.sourceHash, at: input.at });
  }
  const paused = await meetingSendingPaused(context);
  await context.db.query(`UPDATE meeting_follow_through SET source_hash=$3,notes_revision=$4,analysis_id=$5,blockers=$6::jsonb,status=$7,
    pause_observed_at=CASE WHEN $8 THEN COALESCE(pause_observed_at,$9) ELSE pause_observed_at END,updated_at=$9,
    sequence_version_id=COALESCE(sequence_version_id,$10) WHERE workspace_id=$1 AND id=$2`,
  [workspace, plan.id, outcomes.sourceHash, outcomes.notes.revision, outcomes.analysisId, JSON.stringify([...new Set(blockers)]), blockers.length > 0 ? 'needs_review' : 'draft', paused, input.at, sequenceId]);
  await recordCrmAuditEvent(context, { action: 'meeting.recap_prepared', subjectKind: 'meeting', subjectId: input.meetingId, detail: { planId: plan.id } });
  return { ok: true, value: (await readMeetingFollowThrough(context, input))! };
}

export async function editMeetingRecap(context: RepositoryContext, input: MeetingDraftEdit, at?: string): Promise<MeetingResult<MeetingFollowThroughView>> {
  const parsed = meetingDraftEditSchema.safeParse(input);
  if (!parsed.success || context.scope.actor.kind !== 'user') return { ok: false, reason: 'invalid_input' };
  const located = await readMeetingPlan(context, input.planId);
  if (located === null) return { ok: false, reason: 'meeting_unknown' };
  const locked = await lockMeetingFollowThrough(context, located.meeting_id);
  if (!locked.ok) return locked;
  const plan = (await context.db.query<FollowThroughRow>('SELECT * FROM meeting_follow_through WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [context.scope.workspaceId, input.planId])).rows[0];
  if (plan === undefined) return { ok: false, reason: 'meeting_unknown' };
  const draft = await currentMeetingDraft(context, plan);
  if (plan.version !== input.expectedPlanVersion || draft?.version !== input.expectedDraftVersion) return { ok: false, reason: 'draft_changed' };
  if (draft.state === 'submitted' || draft.state === 'sent') return { ok: false, reason: 'delivery_in_progress' };
  if (plan.status === 'cancelled' || plan.status === 'completed') return { ok: false, reason: 'plan_finished' };
  const now = at ?? (await context.db.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.toISOString();
  if (input.action === 'save' && !plan.editing) return { ok: false, reason: 'editing_not_started' };
  if (input.action === 'save' && (hasOptOutLink(input.subject) || hasOptOutLink(input.body) || /<[^>]+>/u.test(input.body))) return { ok: false, reason: 'recap_content_invalid' };
  if (input.action === 'discard' && plan.source_hash !== locked.value.sourceHash) {
    await context.db.query("UPDATE meeting_follow_through_drafts SET state='held' WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, draft.id]);
    await context.db.query("UPDATE meeting_follow_through SET editing=false,status='needs_review',version=version+1,updated_at=$3 WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, plan.id, now]);
    await recordCrmAuditEvent(context, { action: 'meeting.recap_discard', subjectKind: 'meeting', subjectId: plan.meeting_id, detail: { planId: plan.id, draftVersion: draft.version, sourceChanged: true } });
    return { ok: true, value: (await readMeetingFollowThrough(context, { meetingId: plan.meeting_id }))! };
  }
  if (input.action === 'save' || input.action === 'discard') {
    if (plan.source_hash !== locked.value.sourceHash) return { ok: false, reason: 'source_changed' };
    if (input.action === 'save' && (input.subject !== draft.subject || input.body !== draft.body) || Date.parse(draft.not_before.toISOString()) <= Date.parse(now)) {
      await appendMeetingDraft(context, plan, { subject: input.action === 'save' ? input.subject : draft.subject, body: input.action === 'save' ? input.body : draft.body,
        templateVersionId: draft.template_version_id, sourceHash: draft.source_hash, materialReferences: draft.material_references, at: now, ordinal: draft.ordinal });
    } else await context.db.query("UPDATE meeting_follow_through_drafts SET state='ready' WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, draft.id]);
  } else await context.db.query('UPDATE meeting_follow_through_drafts SET state=$3 WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, draft.id, input.action === 'cancel' ? 'cancelled' : 'editing']);
  await context.db.query('UPDATE meeting_follow_through SET version=version+1,editing=$3,status=$4,updated_at=$5 WHERE workspace_id=$1 AND id=$2',
    [context.scope.workspaceId, plan.id, input.action === 'begin_edit', input.action === 'cancel' ? 'cancelled' : input.action === 'begin_edit' ? 'held' : 'draft', now]);
  await recordCrmAuditEvent(context, { action: `meeting.recap_${input.action}`, subjectKind: 'meeting', subjectId: plan.meeting_id, detail: { planId: plan.id, draftVersion: draft.version } });
  return { ok: true, value: (await readMeetingFollowThrough(context, { meetingId: plan.meeting_id }))! };
}
