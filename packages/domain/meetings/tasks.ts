import { changeMeetingTaskSchema, meetingDeadlineSchema, meetingNoteItemSchema, meetingTaskViewSchema, type ChangeMeetingTask, type MeetingNoteItem, type MeetingTaskView } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { loadFirmForUpdate } from '../crm/firms.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { lockSendGateForDispatch, lockSendGateForStopFact } from '../policy/sendGate.ts';
import { lockTodayForFirmChange, refreshTodayForFirm } from '../today/build.ts';
import { databaseNow } from '../policy/clock.ts';
import { assembleMeetingAnalysisInput, type MeetingAnalysisInput } from './analysisInput.ts';
import { lockAnalysisMeeting } from './analysisRequests.ts';
import { validateMeetingAnalysisAnswer } from './analysisModel.ts';
import { readMeetingOutcomes } from './outcomes.ts';
import { meetingDeadlineDueAt, resolveMeetingDeadline } from './taskDeadlines.ts';
import type { MeetingResult } from './outcomeTypes.ts';
interface TaskRow { [key: string]: unknown; id: string; commitment_id: string; label: string; status: string; user_edited: boolean; version: number; owner_user_id: string; deadline: MeetingTaskView['deadline']; evidence: MeetingTaskView['evidence']; }
function similar(left: string, right: string): boolean {
  const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]+/gu)?.filter(w => !['i', 'will', 'the', 'a', 'to', 'my', 'you', 'your'].includes(w)) ?? []);
  const a = words(left), b = words(right);
  return a.size > 0 && b.size > 0 && [...a].filter(w => b.has(w)).length / Math.min(a.size, b.size) >= 0.8;
}
function checkedPromise(item: MeetingNoteItem, input: MeetingAnalysisInput): MeetingNoteItem {
  const reasons = new Set(item.reviewReasons), override = input.notes.itemOverrides.find(o => o.itemId === item.id && o.decision === 'confirmed');
  if (item.owner !== 'you') reasons.add('owner_unknown');
  if (item.provenance !== 'stated' && override === undefined) reasons.add('inferred');
  // The model's semantic commitment classification is necessary but not sufficient.
  // A lexical backstop blocks common negations/conditions even if the model misclassifies them.
  const quotes = item.evidence.map(e => e.quote).join(' ');
  if (override === undefined && /\b(?:not|never|might|maybe|could|would|if|unless|possibly|consider|won't|cannot)\b/iu.test(quotes)) reasons.add('commitment_uncertain');
  let deadline = item.deadline;
  if (deadline === null && item.deadlineText !== null && item.evidence.length === 1 && quotes.includes(item.deadlineText)) {
    const source = item.evidence[0]!;
    const speaker = source.kind === 'transcript' ? input.utterances.find(u => u.id === source.utteranceId)?.speaker : undefined;
    const zone = source.kind === 'debrief' ? input.businessZone : input.notes.speakerMappings.find(m => m.recordingId === source.recordingId && m.speaker === speaker)?.zone ?? null;
    const anchorAt = source.kind === 'transcript' ? input.startsAt : input.notes.savedAt;
    if (anchorAt !== null) {
      const resolved = resolveMeetingDeadline({ text: item.deadlineText, anchorAt, zone, sourceKind: source.kind });
      if (resolved.ok) deadline = resolved.value;
    }
  }
  if (deadline === null) reasons.add('deadline_unclear');
  return { ...item, deadline, reviewReasons: [...reasons] };
}
/** Separate from paid settlement: send gate → Today → firm → meeting → analysis/tasks. */
export async function reconcileMeetingTasks(context: RepositoryContext, input: { meetingId: string; analysisId: string; expectedSourceHash: string }): Promise<MeetingResult<{ created: number; changed: number; review: number }>> {
  await lockSendGateForDispatch(context); await lockTodayForFirmChange(context);
  const firmId = await lockAnalysisMeeting(context, input.meetingId);
  if (firmId === null) return { ok: false, reason: 'meeting_unknown' };
  const source = await assembleMeetingAnalysisInput(context, input);
  if (!source.ok || source.value.sourceHash !== input.expectedSourceHash) return { ok: false, reason: 'source_changed' };
  const analysis = (await context.db.query<{ state: string; source_hash: string; items: MeetingNoteItem[]; source_complete: boolean; review_reasons: string[] }>('SELECT * FROM meeting_analyses WHERE workspace_id=$1 AND meeting_id=$2 AND id=$3 FOR UPDATE', [context.scope.workspaceId, input.meetingId, input.analysisId])).rows[0];
  if (analysis === undefined) return { ok: false, reason: 'analysis_unknown' };
  if (analysis.state !== 'ready' || analysis.source_hash !== input.expectedSourceHash) return { ok: false, reason: 'source_changed' };
  const validated = validateMeetingAnalysisAnswer(JSON.stringify({ overview: '', items: analysis.items, reviewReasons: analysis.review_reasons }), source.value);
  if (!validated.ok) return { ok: false, reason: 'source_invalid' };
  const firm = await loadFirmForUpdate(context, firmId);
  const owner = firm?.assigned_user_id;
  const existing = (await context.db.query<TaskRow>('SELECT * FROM meeting_tasks WHERE workspace_id=$1 AND meeting_id=$2 ORDER BY id FOR UPDATE', [context.scope.workspaceId, input.meetingId])).rows;
  let created = 0, changed = 0, review = 0;
  const output: MeetingNoteItem[] = [], accepted: MeetingNoteItem[] = [];
  const sufficient = (source.value.complete && source.value.utterances.length > 0) || source.value.notes.sufficient;
  for (const raw of validated.value.items) {
    if (raw.kind !== 'commitment') { output.push(raw); continue; }
    let item = checkedPromise(raw, source.value);
    const held = existing.find(t => t.commitment_id === item.id);
    const duplicate = held === undefined && (existing.some(t => similar(t.label, item.text)) || accepted.some(i => similar(i.text, item.text)));
    if (duplicate) item = { ...item, reviewReasons: [...new Set([...item.reviewReasons, 'possible_duplicate'])] };
    if (!sufficient) item = { ...item, reviewReasons: [...new Set([...item.reviewReasons, 'notes_incomplete'])] };
    if (owner === null || owner === undefined) item = { ...item, reviewReasons: [...new Set([...item.reviewReasons, 'owner_unknown'])] };
    if (item.reviewReasons.length > 0 || item.deadline === null || owner === null || owner === undefined) { review++; output.push(item); continue; }
    accepted.push(item); output.push(item);
    if (held !== undefined && (held.status !== 'open' || held.user_edited)) continue;
    const dueAt = meetingDeadlineDueAt(item.deadline);
    if (held === undefined) {
      await context.db.query(`INSERT INTO meeting_tasks(workspace_id,meeting_id,firm_id,commitment_id,analysis_id,label,owner_user_id,deadline,due_at,evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb)`, [context.scope.workspaceId, input.meetingId, firmId, item.id, input.analysisId, item.text, owner, JSON.stringify(item.deadline), dueAt, JSON.stringify(item.evidence)]);
      created++;
    } else if (held.label !== item.text || held.owner_user_id !== owner || JSON.stringify(meetingDeadlineSchema.parse(held.deadline)) !== JSON.stringify(item.deadline)) {
      await context.db.query('UPDATE meeting_tasks SET label=$3,owner_user_id=$4,deadline=$5::jsonb,due_at=$6,analysis_id=$7,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, held.id, item.text, owner, JSON.stringify(item.deadline), dueAt, input.analysisId]); changed++;
    }
  }
  await context.db.query('UPDATE meeting_analyses SET items=$3::jsonb,tasks_pending=false WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, input.analysisId, JSON.stringify(output.map(i => meetingNoteItemSchema.parse(i)))]);
  if (created + changed > 0) await recordCrmAuditEvent(context, { action: 'meeting.tasks_reconciled', subjectKind: 'meeting', subjectId: input.meetingId, detail: { created, changed, review, analysisId: input.analysisId } });
  await refreshTodayForFirm(context, { firmId });
  return { ok: true, value: { created, changed, review } };
}
export async function changeMeetingTask(context: RepositoryContext, input: ChangeMeetingTask): Promise<MeetingResult<MeetingTaskView>> {
  const parsed = changeMeetingTaskSchema.safeParse(input);
  if (!parsed.success || context.scope.actor.kind !== 'user') return { ok: false, reason: 'invalid_input' };
  await lockSendGateForStopFact(context); await lockTodayForFirmChange(context);
  const located = (await context.db.query<{ meeting_id: string }>('SELECT meeting_id FROM meeting_tasks WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, input.taskId])).rows[0];
  if (located === undefined || await lockAnalysisMeeting(context, located.meeting_id) === null) return { ok: false, reason: 'task_unknown' };
  const row = (await context.db.query<TaskRow>('SELECT * FROM meeting_tasks WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [context.scope.workspaceId, input.taskId])).rows[0];
  if (row === undefined) return { ok: false, reason: 'task_unknown' };
  if (row.version !== input.expectedVersion) return { ok: false, reason: 'task_changed' };
  if (input.action === 'edit') {
    await context.db.query('UPDATE meeting_tasks SET label=$3,deadline=$4::jsonb,due_at=$5,user_edited=true,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, row.id, input.label, JSON.stringify(input.deadline), meetingDeadlineDueAt(input.deadline)]);
  } else {
    await context.db.query("UPDATE meeting_tasks SET status=$3,completed_at=CASE WHEN $3='done' THEN $4::timestamptz END,user_edited=true,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, row.id, input.action === 'complete' ? 'done' : 'cancelled', await databaseNow(context)]);
  }
  await recordCrmAuditEvent(context, { action: `meeting.task_${input.action}`, subjectKind: 'meeting_task', subjectId: row.id });
  const view = await readMeetingOutcomes(context, { meetingId: located.meeting_id });
  const task = view?.tasks.find(t => t.id === row.id);
  if (task === undefined || view === null) throw new Error('changed_meeting_task_not_readable');
  await refreshTodayForFirm(context, { firmId: view.firmId });
  return { ok: true, value: meetingTaskViewSchema.parse(task) };
}
