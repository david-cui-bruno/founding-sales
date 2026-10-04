import { saveMeetingNotesSchema, type SaveMeetingNotes, type MeetingNotesRevision } from '@fss/contracts';
import { enqueueMeetingAnalysis } from './analysisJobs.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { loadFirmForUpdate } from '../crm/firms.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { lockTodayForFirmChange } from '../today/build.ts';
import { readCurrentMeetingNotes } from './outcomes.ts';
import type { MeetingResult } from './outcomeTypes.ts';
/** Caller owns the transaction; authorization and CAS happen under the firm/meeting locks. */
export async function saveMeetingNotes(context: RepositoryContext, input: SaveMeetingNotes): Promise<MeetingResult<MeetingNotesRevision>> {
  const parsed = saveMeetingNotesSchema.safeParse(input);
  if (!parsed.success || context.scope.actor.kind !== 'user') return { ok: false, reason: 'invalid_input' };
  const value = parsed.data;
  const workspace = context.scope.workspaceId;
  await lockSendGateForStopFact(context);
  await lockTodayForFirmChange(context);
  const located = (await context.db.query<{ firm_id: string | null }>('SELECT firm_id FROM meetings WHERE workspace_id=$1 AND id=$2', [workspace, value.meetingId])).rows[0];
  if (located === undefined) return { ok: false, reason: 'meeting_unknown' };
  if (located.firm_id === null) return { ok: false, reason: 'meeting_unmatched' };
  const firm = await loadFirmForUpdate(context, located.firm_id);
  if (firm === null) return { ok: false, reason: 'firm_unknown' };
  const authorized = decideFirmMutation(context, firm);
  if (!authorized.permitted) return { ok: false, reason: authorized.reason };
  const meeting = (await context.db.query<{ firm_id: string | null; notes_revision: number }>('SELECT firm_id,notes_revision FROM meetings WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspace, value.meetingId])).rows[0];
  if (meeting?.firm_id !== firm.id) return { ok: false, reason: 'meeting_unknown' };
  if (meeting.notes_revision !== value.expectedRevision) return { ok: false, reason: 'notes_changed' };
  if (value.speakerMappings.length > 0) {
    const ids = [...new Set(value.speakerMappings.map(m => m.recordingId))];
    const found = await context.db.query('SELECT id FROM meeting_recordings WHERE workspace_id=$1 AND meeting_id=$2 AND id=ANY($3::uuid[])', [workspace, value.meetingId, ids]);
    if (found.rows.length !== ids.length) return { ok: false, reason: 'source_invalid' };
  }
  if (value.itemOverrides.length > 0) {
    const items = (await context.db.query<{ id: string }>(`SELECT DISTINCT i->>'id' AS id FROM meeting_analyses a CROSS JOIN LATERAL jsonb_array_elements(a.items) i WHERE a.workspace_id=$1 AND a.meeting_id=$2`, [workspace, value.meetingId])).rows;
    if (value.itemOverrides.some(o => !items.some(i => i.id === o.itemId))) return { ok: false, reason: 'source_invalid' };
  }
  await context.db.query(`INSERT INTO meeting_note_revisions(workspace_id,meeting_id,firm_id,revision,debrief,speaker_mappings,item_overrides,sufficient,created_by_user_id)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)`, [workspace, value.meetingId, firm.id, value.expectedRevision + 1, value.debrief,
    JSON.stringify(value.speakerMappings), JSON.stringify(value.itemOverrides), value.sufficient, context.scope.actor.userId]);
  await context.db.query('UPDATE meetings SET notes_revision=notes_revision+1 WHERE workspace_id=$1 AND id=$2', [workspace, value.meetingId]);
  await context.db.query("UPDATE meeting_analyses SET state='stale' WHERE workspace_id=$1 AND meeting_id=$2 AND state IN ('pending','ready','held')", [workspace, value.meetingId]);
  await recordCrmAuditEvent(context, { action: 'meeting.notes_saved', subjectKind: 'meeting', subjectId: value.meetingId, detail: { revision: value.expectedRevision + 1 } });
  await enqueueMeetingAnalysis(context, value.meetingId);
  return { ok: true, value: await readCurrentMeetingNotes(context, value.meetingId) };
}
