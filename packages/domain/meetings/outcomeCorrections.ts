import {foldMeetingQualification} from './qualification.ts';
import { foldMeetingFollowThrough } from './followThroughLifecycle.ts';
import type { MeetingNoteItem, SaveMeetingNotes } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { refreshTodayForFirm } from '../today/build.ts';
import { readCurrentMeetingNotes } from './outcomes.ts';
import { saveMeetingNotes } from './notes.ts';
import { meetingItemIdentity } from './analysisModel.ts';
/** saveMeetingNotes owns the gate → Today → firm → meeting lock order for this transaction. */
export async function saveMeetingOutcomeCorrections(context: RepositoryContext, input: SaveMeetingNotes) {
  const saved = await saveMeetingNotes(context, input);
  if (!saved.ok) return saved;
  const invalidated = input.itemOverrides.filter(o => o.decision === 'dismissed' || o.owner === 'prospect').map(o => o.itemId);
  const previous = (await context.db.query<{ speaker_mappings: SaveMeetingNotes['speakerMappings'] }>(
    'SELECT speaker_mappings FROM meeting_note_revisions WHERE workspace_id=$1 AND meeting_id=$2 AND revision=$3',
    [context.scope.workspaceId, input.meetingId, input.expectedRevision])).rows[0]?.speaker_mappings ?? [];
  const changedSpeakers = previous.filter(old => old.owner === 'you' && !input.speakerMappings.some(next =>
    next.recordingId === old.recordingId && next.speaker === old.speaker && next.owner === 'you'));
  const changed = await context.db.query<{ id: string; firm_id: string }>(`UPDATE meeting_tasks SET status='cancelled',version=version+1,updated_at=now()
    WHERE workspace_id=$1 AND meeting_id=$2 AND status='open' AND NOT user_edited AND (
      commitment_id=ANY($3::text[]) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(meeting_tasks.evidence) e
        JOIN meeting_transcripts t ON t.workspace_id=meeting_tasks.workspace_id AND t.id::text=e->>'transcriptId'
        CROSS JOIN LATERAL jsonb_array_elements(t.utterances) WITH ORDINALITY u(speech,ordinal)
        CROSS JOIN jsonb_array_elements($4::jsonb) m
        WHERE e->>'kind'='transcript' AND e->>'recordingId'=m->>'recordingId'
          AND e->>'utteranceId'=t.id::text || ':' || u.ordinal::text
          AND (u.speech->>'speaker') IS NOT DISTINCT FROM (m->>'speaker')
      )) RETURNING id,firm_id`, [context.scope.workspaceId, input.meetingId, invalidated, JSON.stringify(changedSpeakers)]);
  for (const task of changed.rows) await recordCrmAuditEvent(context, { action: 'meeting.task_invalidated', subjectKind: 'meeting_task', subjectId: task.id, detail: { notesRevision: saved.value.revision } });
  const firmId = changed.rows[0]?.firm_id;
  if (firmId !== undefined) await refreshTodayForFirm(context, { firmId });
  return saved;
}

/** Both meetings and their firms are already locked by the owning booking transaction. */
export async function foldMeetingOutcomes(context: RepositoryContext, input: { sourceMeetingId: string; targetMeetingId: string }): Promise<void> {
  if (input.sourceMeetingId === input.targetMeetingId) return;
  const workspace = context.scope.workspaceId;
  await context.db.query('SET CONSTRAINTS meeting_tasks_workspace_id_analysis_id_fkey,meeting_follow_through_workspace_id_analysis_id_meeting_id_fkey,meeting_tasks_plan_source DEFERRED');
  const rows = (await context.db.query<{ id: string; firm_id: string | null; notes_revision: number }>('SELECT id,firm_id,notes_revision FROM meetings WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE', [workspace, [input.sourceMeetingId, input.targetMeetingId]])).rows;
  const source = rows.find(r => r.id === input.sourceMeetingId), target = rows.find(r => r.id === input.targetMeetingId);
  if (source === undefined || target === undefined || source.firm_id === null) return;
  if (target.firm_id !== source.firm_id) throw new Error('meeting_outcome_fold_firm_conflict');
  await foldMeetingFollowThrough(context, source.id, target.id);
  await foldMeetingQualification(context,source.id,target.id);
  const sourceNotes = await readCurrentMeetingNotes(context, source.id), targetNotes = await readCurrentMeetingNotes(context, target.id);
  const offset = target.notes_revision;
  const debrief = [targetNotes.debrief, sourceNotes.debrief].filter(t => t.trim() !== '').join('\n\n');
  const sourceTextOffset = targetNotes.debrief.trim() === '' ? 0 : [...targetNotes.debrief].length + 2;
  const identities = new Map<string, string>();
  const remap = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(remap);
    if (value !== null && typeof value === 'object') {
      const row = value as Record<string, unknown>;
      if (row['kind'] === 'debrief' && typeof row['revision'] === 'number') return { ...row, revision: row['revision'] + offset };
      return Object.fromEntries(Object.entries(row).map(([key, child]) => [key, remap(child)]));
    }
    return value;
  };
  // Historical revisions remain individually readable and retain their original identity.
  await context.db.query(`UPDATE meeting_note_revisions SET original_meeting_id=COALESCE(original_meeting_id,meeting_id),original_revision=COALESCE(original_revision,revision),
    meeting_id=$3,firm_id=$4,revision=revision+$5 WHERE workspace_id=$1 AND meeting_id=$2`, [workspace, source.id, target.id, target.firm_id, offset]);
  const analyses = (await context.db.query<{ id: string; meeting_id: string; items: MeetingNoteItem[] }>('SELECT id,meeting_id,items FROM meeting_analyses WHERE workspace_id=$1 AND meeting_id=ANY($2::uuid[]) ORDER BY created_at,id', [workspace, [source.id, target.id]])).rows;
  for (const row of analyses) {
    const moved = row.meeting_id === source.id;
    const items = row.items.map(item => {
      // Evidence continues to cite its immutable historical revision. Only the
      // matching key is rebased to the combined document's future interpretation.
      const evidence = item.evidence.map(e => e.kind === 'debrief' && moved ? { ...e, startOffset: e.startOffset + sourceTextOffset, endOffset: e.endOffset + sourceTextOffset } : e);
      const id = meetingItemIdentity(target.id, { ...item, evidence }, debrief);
      identities.set(item.id, id);
      return { ...item, id };
    });
    await context.db.query("UPDATE meeting_analyses SET meeting_id=$3,firm_id=$4,notes_revision=notes_revision+$5,items=$6::jsonb,state='stale',tasks_pending=false WHERE workspace_id=$1 AND id=$2", [workspace, row.id, target.id, target.firm_id, moved ? offset : 0, JSON.stringify(moved ? remap(items) : items)]);
  }
  const tasks = (await context.db.query<{ id: string; meeting_id: string; commitment_id: string; evidence: unknown }>('SELECT id,meeting_id,commitment_id,evidence FROM meeting_tasks WHERE workspace_id=$1 AND meeting_id=ANY($2::uuid[]) ORDER BY id', [workspace, [source.id, target.id]])).rows;
  for (const row of tasks) await context.db.query('UPDATE meeting_tasks SET meeting_id=$3,firm_id=$4,evidence=$5::jsonb,commitment_id=$6,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2', [workspace, row.id, target.id, target.firm_id, JSON.stringify(row.meeting_id === source.id ? remap(row.evidence) : row.evidence), identities.get(row.commitment_id) ?? row.commitment_id]);
  await context.db.query('UPDATE meeting_analysis_requests SET meeting_id=$3 WHERE workspace_id=$1 AND meeting_id=$2', [workspace, source.id, target.id]);
  const hasContent = sourceNotes.revision > 0 || targetNotes.revision > 0 || analyses.length > 0 || tasks.length > 0;
  if (!hasContent) return;
  const mappings = [...targetNotes.speakerMappings];
  for (const incoming of sourceNotes.speakerMappings) {
    const held = mappings.find(m => m.recordingId === incoming.recordingId && m.speaker === incoming.speaker);
    if (held === undefined) mappings.push(incoming);
    else if (held.owner !== incoming.owner || held.zone !== incoming.zone) { held.owner = 'unknown'; held.zone = null; }
  }
  const overrides = [...new Map([...targetNotes.itemOverrides, ...sourceNotes.itemOverrides].map(o => {
    const itemId = identities.get(o.itemId) ?? o.itemId; return [itemId, { ...o, itemId }];
  })).values()];
  if (Buffer.byteLength(debrief) > 32768 || mappings.length > 200 || overrides.length > 100) throw new Error('meeting_notes_merge_requires_shorter_notes');
  const revision = offset + source.notes_revision + 1;
  const author = (await context.db.query<{ created_by_user_id: string }>('SELECT created_by_user_id FROM meeting_note_revisions WHERE workspace_id=$1 AND meeting_id=$2 ORDER BY revision DESC LIMIT 1', [workspace, target.id])).rows[0]?.created_by_user_id;
  if (author !== undefined) {
    await context.db.query(`INSERT INTO meeting_note_revisions(workspace_id,meeting_id,firm_id,revision,debrief,speaker_mappings,item_overrides,sufficient,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,false,$8)`, [workspace, target.id, target.firm_id, revision, debrief, JSON.stringify(mappings), JSON.stringify(overrides), author]);
    await context.db.query('UPDATE meetings SET notes_revision=$3 WHERE workspace_id=$1 AND id=$2', [workspace, target.id, revision]);
  }
  await context.db.query('UPDATE meetings SET outcomes_review_required=true WHERE workspace_id=$1 AND id=$2', [workspace, target.id]);
  await context.db.query("UPDATE meeting_analyses SET state='stale',tasks_pending=false WHERE workspace_id=$1 AND meeting_id=$2", [workspace, target.id]);
  // Deadline cleanup uses the normal budget-before-firm order in a separate scheduler transaction.
  await context.db.query("UPDATE meeting_analysis_requests SET deadline_at=now(),next_wake_at='9999-01-01' WHERE workspace_id=$1 AND meeting_id=$2 AND state IN ('queued','held','reserved','calling')", [workspace, target.id]);
  await context.db.query('SET CONSTRAINTS meeting_tasks_workspace_id_analysis_id_fkey,meeting_follow_through_workspace_id_analysis_id_meeting_id_fkey,meeting_tasks_plan_source IMMEDIATE');
  await recordCrmAuditEvent(context, { action: 'meeting.outcomes_folded', subjectKind: 'meeting', subjectId: target.id, detail: { sourceMeetingId: source.id, preservedTasks: tasks.length } });
}

/** Scrub immediately; reservation settlement follows under its normal lock order. */
export async function deleteMeetingOutcomeContent(context: RepositoryContext, input: { meetingIds: readonly string[] }): Promise<void> {
  if (input.meetingIds.length === 0) return;
  await context.db.query('UPDATE meeting_analysis_requests SET result=NULL,deadline_at=now() WHERE workspace_id=$1 AND meeting_id=ANY($2::uuid[])', [context.scope.workspaceId, [...input.meetingIds]]);
  await context.db.query("DELETE FROM today_items WHERE workspace_id=$1 AND ((source_kind='meeting_task' AND source_id IN (SELECT id FROM meeting_tasks WHERE workspace_id=$1 AND meeting_id=ANY($2::uuid[]))) OR (source_kind='meeting_review' AND source_id=ANY($2::uuid[])))", [context.scope.workspaceId, [...input.meetingIds]]);
  for (const table of ['meeting_tasks', 'meeting_follow_through', 'meeting_analyses', 'meeting_note_revisions']) await context.db.query(`DELETE FROM ${table} WHERE workspace_id=$1 AND meeting_id=ANY($2::uuid[])`, [context.scope.workspaceId, [...input.meetingIds]]);
}
