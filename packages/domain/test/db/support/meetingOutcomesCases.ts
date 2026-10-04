import { randomUUID } from 'node:crypto';
import { meeting, type CallToBookingFixture } from './callToBookingCases.ts';
type F = CallToBookingFixture;
type Row = Record<string, unknown>;
type Case = { constraint: string; run: (f: F) => Promise<unknown> };
const absent = '00000000-0000-4000-8000-000000004399';
async function insert(f: F, table: string, row: Row) {
  const keys = Object.keys(row);
  return await f.session.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${String(i + 1)}`).join(',')})`, Object.values(row));
}
async function base(f: F): Promise<Row> {
  const id = await meeting(f);
  const firm = (await f.session.query<{ firm_id: string }>('SELECT firm_id FROM meetings WHERE id=$1', [id])).rows[0]?.firm_id;
  return { workspace_id: f.seeded.alpha.workspaceId, meeting_id: id, firm_id: firm };
}
async function notes(f: F): Promise<Row> { return { ...await base(f), revision: 1, debrief: 'Private fixture', created_by_user_id: f.seeded.alpha.admin.userId }; }
async function analysis(f: F): Promise<Row> { return { ...await base(f), id: randomUUID(), source_hash: 'a'.repeat(64), notes_revision: 0, transcript_revision: 0, prompt_version: 1 }; }
async function request(f: F): Promise<Row> { const b = await base(f); return { workspace_id: b['workspace_id'], meeting_id: b['meeting_id'], original_meeting_id: b['meeting_id'], id: randomUUID(), request_hash: 'b'.repeat(64), prompt_version: 1, model_name: 'claude-haiku-4-5', purpose: 'extract' }; }
async function task(f: F): Promise<Row> { return { ...await base(f), id: randomUUID(), commitment_id: 'promise:fixture', label: 'Send guide', owner_user_id: f.seeded.alpha.admin.userId,
  deadline: JSON.stringify({ precision: 'date', localDate: '2026-10-06', zone: 'America/New_York' }), due_at: '2026-10-07T04:00:00Z', evidence: JSON.stringify([{ kind: 'debrief', revision: 1, quote: 'Send guide', startOffset: 0, endOffset: 10 }]) }; }
const bad = (table: string, constraint: string, make: (f: F) => Promise<Row>, overrides: Row): Case => ({ constraint, run: async f => await insert(f, table, { ...await make(f), ...overrides }) });
const duplicate = (table: string, constraint: string, make: (f: F) => Promise<Row>, overrides: () => Row = () => ({})): Case => ({ constraint, run: async f => { const r = await make(f); await insert(f, table, r); return await insert(f, table, { ...r, ...overrides() }); } });
export const MEETING_OUTCOMES_CONSTRAINT_CASES: readonly Case[] = [
  { constraint: 'meetings_notes_revision_check', run: async f => await f.session.query('UPDATE meetings SET notes_revision=-1 WHERE id=$1', [await meeting(f)]) },
  { constraint: 'meetings_firm_identity', run: async f => {
    const id = await meeting(f);
    // The PK is stronger than this semantic FK target; isolate this key inside the rolled-back fixture.
    await f.session.query('ALTER TABLE meetings DROP CONSTRAINT meetings_pkey CASCADE');
    return await f.session.query("INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) SELECT workspace_id,id,firm_id,'duplicate43','duplicate43',state,starts_at,ends_at,last_event_at FROM meetings WHERE id=$1", [id]);
  } },
  ...[['revision', 0], ['debrief', 'x'.repeat(32769)], ['speaker_mappings', '{}'], ['item_overrides', '{}']].map(([column, value]) => bad('meeting_note_revisions', `meeting_note_revisions_${String(column)}_check`, notes, { [String(column)]: value })),
  duplicate('meeting_note_revisions', 'meeting_note_revisions_pkey', notes),
  bad('meeting_note_revisions', 'meeting_note_revisions_workspace_id_created_by_user_id_fkey', notes, { created_by_user_id: absent }),
  bad('meeting_note_revisions', 'meeting_note_revisions_workspace_id_meeting_id_firm_id_fkey', notes, { firm_id: absent }),
  bad('meeting_analyses', 'meeting_analyses_merge_request', analysis, { merge_request_id: absent }),
  ...[['notes_revision', -1], ['transcript_revision', -1], ['prompt_version', 0], ['source_hash', 'bad'], ['state', 'bad'], ['overview', 'x'.repeat(6001)], ['items', '{}'], ['review_reasons', '{}']].map(([column, value]) => bad('meeting_analyses', `meeting_analyses_${String(column)}_check`, analysis, { [String(column)]: value })),
  duplicate('meeting_analyses', 'meeting_analyses_pkey', analysis, () => ({ source_hash: 'c'.repeat(64) })),
  duplicate('meeting_analyses', 'meeting_analyses_workspace_id_meeting_id_source_hash_prompt_key', analysis, () => ({ id: randomUUID() })),
  bad('meeting_analyses', 'meeting_analyses_workspace_id_meeting_id_firm_id_fkey', analysis, { firm_id: absent }),
  ...[['prompt_version', 0], ['request_hash', 'bad'], ['purpose', 'bad'], ['state', 'bad'], ['paid_attempts', 3], ['reservation_count', 7], ['reason', 'Bad code']].map(([column, value]) => bad('meeting_analysis_requests', `meeting_analysis_requests_${String(column)}_check`, request, { [String(column)]: value })),
  duplicate('meeting_analysis_requests', 'meeting_analysis_requests_pkey', request, () => ({ request_hash: 'c'.repeat(64) })),
  duplicate('meeting_analysis_requests', 'meeting_analysis_requests_workspace_id_original_meeting_id__key', request, () => ({ id: randomUUID() })),
  bad('meeting_analysis_requests', 'meeting_analysis_requests_workspace_id_fkey', request, { workspace_id: absent, meeting_id: null }),
  bad('meeting_analysis_requests', 'meeting_analysis_requests_workspace_id_meeting_id_fkey', request, { meeting_id: absent }),
  bad('meeting_analysis_requests', 'meeting_analysis_requests_workspace_id_reservation_id_fkey', request, { reservation_id: absent }),
  ...[['commitment_id', ''], ['label', ' '], ['evidence', '[]'], ['status', 'bad'], ['version', 0], ['creator_kind', 'user']].map(([column, value]) => bad('meeting_tasks', `meeting_tasks_${String(column)}_check`, task, { [String(column)]: value })),
  bad('meeting_tasks', 'meeting_tasks_deadline_shape', task, { deadline: '{}' }),
  bad('meeting_tasks', 'meeting_tasks_check', task, { status: 'done' }),
  duplicate('meeting_tasks', 'meeting_tasks_pkey', task, () => ({ commitment_id: 'different' })),
  duplicate('meeting_tasks', 'meeting_tasks_workspace_id_meeting_id_commitment_id_key', task, () => ({ id: randomUUID() })),
  bad('meeting_tasks', 'meeting_tasks_workspace_id_meeting_id_firm_id_fkey', task, { firm_id: absent }),
  bad('meeting_tasks', 'meeting_tasks_workspace_id_owner_user_id_fkey', task, { owner_user_id: absent }),
  bad('meeting_tasks', 'meeting_tasks_workspace_id_analysis_id_fkey', task, { analysis_id: absent }),
];
