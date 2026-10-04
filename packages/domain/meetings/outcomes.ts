import { meetingNotesRevisionSchema, meetingOutcomesViewSchema, meetingTaskViewSchema, type MeetingNotesRevision, type MeetingOutcomesView, type MeetingTaskView } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readFirm } from '../crm/firms.ts';
import { decideFirmRead, firmReadIsAudited } from '../crm/authorization.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { emptyMeetingNotes, meetingSourceHash } from './outcomeTypes.ts';
import { readMeetingAnalysisSetting } from './analysisSettings.ts';
export async function readCurrentMeetingNotes(context: RepositoryContext, meetingId: string): Promise<MeetingNotesRevision> {
  const row = (await context.db.query<{ revision: number; debrief: string; speaker_mappings: unknown; item_overrides: unknown; sufficient: boolean; created_at: Date }>(
    `SELECT n.* FROM meeting_note_revisions n JOIN meetings m ON m.workspace_id=n.workspace_id AND m.id=n.meeting_id AND m.notes_revision=n.revision
     WHERE m.workspace_id=$1 AND m.id=$2`, [context.scope.workspaceId, meetingId])).rows[0];
  return row === undefined ? emptyMeetingNotes(meetingId) : meetingNotesRevisionSchema.parse({ meetingId, revision: row.revision, debrief: row.debrief,
    speakerMappings: row.speaker_mappings, itemOverrides: row.item_overrides, sufficient: row.sufficient, savedAt: row.created_at.toISOString() });
}
export async function readMeetingOutcomes(context: RepositoryContext, input: { meetingId: string }): Promise<MeetingOutcomesView | null> {
  const workspace = context.scope.workspaceId;
  const locate = async () => (await context.db.query<{ firm_id: string | null; notes_revision: number; transcript_source_revision: number; state: string; outcomes_review_required: boolean }>(
    'SELECT firm_id,notes_revision,transcript_source_revision,state,outcomes_review_required FROM meetings WHERE workspace_id=$1 AND id=$2', [workspace, input.meetingId])).rows[0];
  const meeting = await locate();
  if (meeting?.firm_id === undefined || meeting.firm_id === null) return null;
  const firm = await readFirm(context, meeting.firm_id);
  if (firm === null || firm.status === 'merged' || decideFirmRead(context, firm) !== 'assigned_or_admin') return null;
  const notes = await readCurrentMeetingNotes(context, input.meetingId);
  const sourceHash = meetingSourceHash(input.meetingId, meeting.notes_revision, meeting.transcript_source_revision);
  const analysis = (await context.db.query<{ id: string; source_hash: string; state: string; overview: string; items: unknown[]; review_reasons: string[]; source_complete: boolean }>(
    'SELECT id,source_hash,state,overview,items,review_reasons,source_complete FROM meeting_analyses WHERE workspace_id=$1 AND meeting_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1', [workspace, input.meetingId])).rows[0];
  const tasks = (await context.db.query<{ id: string; commitment_id: string | null; follow_through_plan_id: string | null; label: string; owner_user_id: string; deadline: unknown; status: string; version: number; user_edited: boolean; evidence: unknown }>(
    'SELECT * FROM meeting_tasks WHERE workspace_id=$1 AND meeting_id=$2 ORDER BY due_at,id LIMIT 200', [workspace, input.meetingId])).rows.map(row => meetingTaskViewSchema.parse({
      id: row.id, meetingId: input.meetingId, firmId: firm.id, source: row.follow_through_plan_id === null ? { kind: 'promise', commitmentId: row.commitment_id } : { kind: 'follow_through', planId: row.follow_through_plan_id }, label: row.label,
      ownerUserId: row.owner_user_id, deadline: row.deadline, status: row.status, version: row.version, userEdited: row.user_edited, evidence: row.evidence,
    }));
  // Reads consist of several queries; do not return a prior assignee's content after a move or source edit.
  const final = await locate();
  const currentFirm = await readFirm(context, firm.id);
  if (currentFirm === null || currentFirm.status === 'merged' || decideFirmRead(context, currentFirm) !== 'assigned_or_admin' || final?.firm_id !== firm.id
    || final.notes_revision !== meeting.notes_revision || final.transcript_source_revision !== meeting.transcript_source_revision) return null;
  const setting = await readMeetingAnalysisSetting(context);
  const holds = [...(analysis?.review_reasons ?? [])];
  if (final.outcomes_review_required) holds.push('merged_notes_review');
  if (!setting.enabled || setting.dailyCeilingCents === 0) holds.push('analysis_disabled');
  const stale = analysis !== undefined && (analysis.source_hash !== sourceHash || analysis.state === 'stale');
  const state = stale ? 'stale' : analysis?.state === 'ready' ? analysis.source_complete || notes.sufficient ? 'current' : 'partial' : analysis === undefined ? 'empty' : analysis.state === 'failed' || analysis.state === 'held' ? 'partial' : 'pending';
  if (firmReadIsAudited(context, currentFirm)) await recordCrmAuditEvent(context, { action: 'meeting.outcomes_read', subjectKind: 'meeting', subjectId: input.meetingId });
  return meetingOutcomesViewSchema.parse({ meetingId: input.meetingId, firmId: firm.id, notes, analysisId: analysis?.id ?? null, sourceHash, state,
    attendance: final.state === 'held' ? 'attended' : final.state === 'no_show' ? 'no_show' : final.state === 'cancelled' ? 'cancelled' : 'unconfirmed',
    overview: analysis?.overview ?? '', items: analysis?.items ?? [], tasks, holds: [...new Set(holds)].slice(0, 30) });
}

/** Direct lookup, independent of the bounded meeting panel. Caller may hold meeting locks. */
export async function readMeetingTask(context: RepositoryContext, taskId: string): Promise<MeetingTaskView | null> {
  const row = (await context.db.query<{ id: string; meeting_id: string; firm_id: string; commitment_id: string | null; follow_through_plan_id: string | null; label: string; owner_user_id: string; deadline: unknown; status: string; version: number; user_edited: boolean; evidence: unknown }>(
    'SELECT * FROM meeting_tasks WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, taskId])).rows[0];
  if (row === undefined) return null;
  const firm = await readFirm(context, row.firm_id);
  if (firm === null || firm.status === 'merged' || decideFirmRead(context, firm) !== 'assigned_or_admin') return null;
  return meetingTaskViewSchema.parse({ id: row.id, meetingId: row.meeting_id, firmId: row.firm_id, source: row.follow_through_plan_id === null ? { kind: 'promise', commitmentId: row.commitment_id } : { kind: 'follow_through', planId: row.follow_through_plan_id },
    label: row.label, ownerUserId: row.owner_user_id, deadline: row.deadline, status: row.status, version: row.version, userEdited: row.user_edited, evidence: row.evidence });
}
