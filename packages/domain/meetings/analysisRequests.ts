import type { RepositoryContext } from '../db/workspaceScope.ts';
import { loadFirmForUpdate } from '../crm/firms.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { assembleMeetingAnalysisInput, buildMeetingAnalysisBlocks, analysisHash, MEETING_ANALYSIS_LIMITS } from './analysisInput.ts';
import { MEETING_ANALYSIS_MODEL, MEETING_ANALYSIS_PROMPT_VERSION, validateMeetingAnalysisAnswer, type ValidatedMeetingAnalysis } from './analysisModel.ts';
import type { MeetingAnalysisCall } from './analysisAdapter.ts';
import type { MeetingResult } from './outcomeTypes.ts';
export interface AnalysisRequestRow {
  [key: string]: unknown;
  id: string; meeting_id: string | null; original_meeting_id: string; request_hash: string; model_name: string; prompt_version: number;
  purpose: 'extract' | 'merge'; state: 'queued' | 'reserved' | 'calling' | 'ready' | 'held' | 'failed' | 'estimated';
  paid_attempts: number; reservation_count: number; reservation_id: string | null; prepared_hash: string | null;
  result: ValidatedMeetingAnalysis | null; reason: string | null; deadline_at: Date | null; settings_version: number;
}
export async function readAnalysisRequest(context: RepositoryContext, id: string, lock = false): Promise<AnalysisRequestRow | null> {
  return (await context.db.query<AnalysisRequestRow>(`SELECT * FROM meeting_analysis_requests WHERE workspace_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [context.scope.workspaceId, id])).rows[0] ?? null;
}
/** Owning transactions acquire budget (if needed) before this firm → meeting lock pair. */
export async function lockAnalysisMeeting(context: RepositoryContext, meetingId: string): Promise<string | null> {
  const located = (await context.db.query<{ firm_id: string | null }>('SELECT firm_id FROM meetings WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, meetingId])).rows[0];
  if (located?.firm_id === undefined || located.firm_id === null) return null;
  const firm = await loadFirmForUpdate(context, located.firm_id);
  if (firm === null || !decideFirmMutation(context, firm).permitted) return null;
  const row = (await context.db.query<{ firm_id: string | null }>('SELECT firm_id FROM meetings WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [context.scope.workspaceId, meetingId])).rows[0];
  return row?.firm_id === firm.id ? firm.id : null;
}
async function ensureRequest(context: RepositoryContext, meetingId: string, hash: string, purpose: 'extract' | 'merge', at: string): Promise<string> {
  const inserted = await context.db.query<{ id: string }>(`INSERT INTO meeting_analysis_requests(workspace_id,meeting_id,original_meeting_id,request_hash,prompt_version,model_name,purpose,next_wake_at)
    VALUES($1,$2,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,original_meeting_id,request_hash,prompt_version,model_name) DO UPDATE SET meeting_id=EXCLUDED.meeting_id RETURNING id`,
    [context.scope.workspaceId, meetingId, hash, MEETING_ANALYSIS_PROMPT_VERSION, MEETING_ANALYSIS_MODEL, purpose, at]);
  return inserted.rows[0]!.id;
}
export async function materializeMeetingAnalysis(context: RepositoryContext, input: { meetingId: string; at: string }): Promise<MeetingResult<{ analysisId: string; requestIds: string[] }>> {
  if (await lockAnalysisMeeting(context, input.meetingId) === null) return { ok: false, reason: 'meeting_unknown' };
  const assembled = await assembleMeetingAnalysisInput(context, input);
  if (!assembled.ok) return assembled;
  const source = assembled.value, blocks = buildMeetingAnalysisBlocks(source);
  if (!blocks.ok) return blocks;
  // A prompt upgrade alone never schedules a previously analyzed source snapshot.
  const existing = (await context.db.query<{ id: string; request_ids: string[] }>('SELECT id,request_ids FROM meeting_analyses WHERE workspace_id=$1 AND meeting_id=$2 AND source_hash=$3 ORDER BY created_at,id LIMIT 1', [context.scope.workspaceId, input.meetingId, source.sourceHash])).rows[0];
  if (existing !== undefined) return { ok: true, value: { analysisId: existing.id, requestIds: existing.request_ids } };
  const requestIds: string[] = [];
  for (const block of blocks.value) requestIds.push(await ensureRequest(context, input.meetingId, block.hash, 'extract', input.at));
  const id = (await context.db.query<{ id: string }>(`INSERT INTO meeting_analyses(workspace_id,meeting_id,firm_id,source_hash,notes_revision,transcript_revision,prompt_version,source_complete,request_ids)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING id`, [context.scope.workspaceId, input.meetingId, source.firmId, source.sourceHash,
    source.notes.revision, source.transcriptRevision, MEETING_ANALYSIS_PROMPT_VERSION, source.complete, JSON.stringify(requestIds)])).rows[0]!.id;
  await progressMeetingAnalysis(context, input.meetingId, input.at);
  return { ok: true, value: { analysisId: id, requestIds } };
}
export async function readAnalysisCall(context: RepositoryContext, row: AnalysisRequestRow): Promise<MeetingResult<MeetingAnalysisCall>> {
  if (row.meeting_id === null || row.prompt_version !== MEETING_ANALYSIS_PROMPT_VERSION) return { ok: false, reason: 'source_changed' };
  const assembled = await assembleMeetingAnalysisInput(context, { meetingId: row.meeting_id });
  if (!assembled.ok) return assembled;
  const input = assembled.value;
  const blocks = buildMeetingAnalysisBlocks(input);
  if (!blocks.ok) return blocks;
  if (row.purpose === 'extract') {
    const block = blocks.value.find(b => b.hash === row.request_hash);
    return block === undefined ? { ok: false, reason: 'source_changed' } : { ok: true, value: { model: row.model_name, purpose: 'extract', maxOutputTokens: MEETING_ANALYSIS_LIMITS.extractOutput, input: block.input } };
  }
  const analysis = (await context.db.query<{ request_ids: string[] }>('SELECT request_ids FROM meeting_analyses WHERE workspace_id=$1 AND meeting_id=$2 AND source_hash=$3 AND merge_request_id=$4', [context.scope.workspaceId, row.meeting_id, input.sourceHash, row.id])).rows[0];
  if (analysis === undefined) return { ok: false, reason: 'source_changed' };
  const prior: ValidatedMeetingAnalysis[] = [];
  for (const id of analysis.request_ids) {
    const block = await readAnalysisRequest(context, id);
    if (block?.state !== 'ready' || block.result === null) return { ok: false, reason: 'blocks_pending' };
    const validated = validateMeetingAnalysisAnswer(JSON.stringify(block.result), input);
    if (!validated.ok) return validated;
    prior.push(validated.value);
  }
  return { ok: true, value: { model: row.model_name, purpose: 'merge', maxOutputTokens: MEETING_ANALYSIS_LIMITS.mergeOutput, input, prior } };
}
/** No Today lock here: tasks_pending is the durable request for a separate reconciliation transaction. */
export async function progressMeetingAnalysis(context: RepositoryContext, meetingId: string, at: string): Promise<void> {
  const assembled = await assembleMeetingAnalysisInput(context, { meetingId });
  if (!assembled.ok) return;
  const input = assembled.value;
  const analysis = (await context.db.query<{ id: string; request_ids: string[]; merge_request_id: string | null; state: string }>(
    'SELECT id,request_ids,merge_request_id,state FROM meeting_analyses WHERE workspace_id=$1 AND meeting_id=$2 AND source_hash=$3 ORDER BY created_at,id LIMIT 1 FOR UPDATE', [context.scope.workspaceId, meetingId, input.sourceHash])).rows[0];
  if (analysis === undefined || analysis.state === 'ready') return;
  const requests: AnalysisRequestRow[] = [];
  for (const id of analysis.request_ids) { const row = await readAnalysisRequest(context, id); if (row !== null) requests.push(row); }
  if (requests.some(r => r.state === 'failed' || r.state === 'estimated')) {
    await context.db.query("UPDATE meeting_analyses SET state='failed',review_reasons='[\"analysis_failed\"]' WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, analysis.id]); return;
  }
  if (requests.length !== analysis.request_ids.length || requests.some(r => r.state !== 'ready' || r.result === null)) return;
  let content = requests[0]?.result;
  if (requests.length > 1) {
    const hash = analysisHash({ sourceHash: input.sourceHash, results: requests.map(r => ({ id: r.id, result: r.result })) });
    const mergeId = analysis.merge_request_id ?? await ensureRequest(context, meetingId, hash, 'merge', at);
    await context.db.query('UPDATE meeting_analyses SET merge_request_id=$3 WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, analysis.id, mergeId]);
    const merged = await readAnalysisRequest(context, mergeId);
    if (merged?.state === 'failed' || merged?.state === 'estimated') {
      await context.db.query("UPDATE meeting_analyses SET state='failed',review_reasons='[\"analysis_failed\"]' WHERE workspace_id=$1 AND id=$2", [context.scope.workspaceId, analysis.id]); return;
    }
    if (merged?.state !== 'ready') return;
    content = merged.result;
  }
  if (content === null || content === undefined) return;
  const validated = validateMeetingAnalysisAnswer(JSON.stringify(content), input);
  if (!validated.ok) return;
  await context.db.query(`UPDATE meeting_analyses SET state='ready',overview=$3,items=$4::jsonb,review_reasons=$5::jsonb,completed_at=$6,tasks_pending=true WHERE workspace_id=$1 AND id=$2`,
    [context.scope.workspaceId, analysis.id, validated.value.overview, JSON.stringify(validated.value.items), JSON.stringify(validated.value.reviewReasons), at]);
}
