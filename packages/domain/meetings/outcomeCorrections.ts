import type { SaveMeetingNotes } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { refreshTodayForFirm } from '../today/build.ts';
import { saveMeetingNotes } from './notes.ts';
/** saveMeetingNotes owns the gate → Today → firm → meeting lock order for this transaction. */
export async function saveMeetingOutcomeCorrections(context: RepositoryContext, input: SaveMeetingNotes) {
  const saved = await saveMeetingNotes(context, input);
  if (!saved.ok) return saved;
  const invalidated = input.itemOverrides.filter(o => o.decision === 'dismissed' || o.owner === 'prospect').map(o => o.itemId);
  const changed = await context.db.query<{ id: string; firm_id: string }>(`UPDATE meeting_tasks SET status='cancelled',version=version+1,updated_at=now()
    WHERE workspace_id=$1 AND meeting_id=$2 AND commitment_id=ANY($3::text[]) AND status='open' AND NOT user_edited RETURNING id,firm_id`, [context.scope.workspaceId, input.meetingId, invalidated]);
  for (const task of changed.rows) await recordCrmAuditEvent(context, { action: 'meeting.task_invalidated', subjectKind: 'meeting_task', subjectId: task.id, detail: { notesRevision: saved.value.revision } });
  const firmId = changed.rows[0]?.firm_id;
  if (firmId !== undefined) await refreshTodayForFirm(context, { firmId });
  return saved;
}
