import { randomUUID } from 'node:crypto';
import { meeting, type CallToBookingFixture } from './callToBookingCases.ts';
import { recording } from './meetingRecordingsCases.ts';
type F = CallToBookingFixture;
type Row = Record<string, unknown>;
type Case = {
    constraint: string;
    run: (f: F) => Promise<unknown>;
};
const absent = '00000000-0000-4000-8000-000000004299';
async function insert(f: F, table: string, row: Row) {
    const keys = Object.keys(row);
    return await f.session.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${String(i + 1)}`).join(',')})`, Object.values(row));
}
async function base(f: F) {
    const meetingId = await meeting(f), id = randomUUID(), reservation = randomUUID(), workspace = f.seeded.alpha.workspaceId;
    await recording(f, meetingId, { id });
    await f.session.query(`INSERT INTO provider_reservations
    (id,workspace_id,provider_key,subject_kind,subject_id,attempt,business_date,business_time_zone,cents,model_name,max_input_tokens,max_output_tokens,priced_unit,max_units,unit_price_micros)
    VALUES ($1,$2,'aws_transcribe.standard','meeting_transcription',$3,1,current_date,'America/New_York',1,NULL,NULL,NULL,'minute',1,6000)`, [reservation, workspace, id]);
    return { meetingId, id, reservation, workspace };
}
async function alias(f: F): Promise<Row> { const b = await base(f); return { workspace_id: b.workspace, alias_id: randomUUID(), recording_id: b.id }; }
async function transcript(f: F): Promise<Row> { const b = await base(f); return { workspace_id: b.workspace, id: randomUUID(), recording_id: b.id, original_recording_id: b.id, version: 1, duration_ms: 1000, language: 'en-US', utterances: '[]' }; }
async function attempt(f: F): Promise<Row> { const b = await base(f); const id = randomUUID(); return { workspace_id: b.workspace, id, recording_id: b.id, original_recording_id: b.id, reservation_id: b.reservation, job_name: `m5-${id}`, input_key: `meetings-processing/${b.id}/${id}.flac`, output_key: `meetings-processing/${b.id}/${id}.json`, duration_ms: 1000, source_kind: 'participant', deadline_at: '2030-01-01T00:00:00Z', created_at: '2026-10-03T00:00:00Z' }; }
const bad = (table: string, constraint: string, make: (f: F) => Promise<Row>, overrides: Row): Case => ({ constraint, run: async (f) => await insert(f, table, { ...await make(f), ...overrides }) });
export const MEETING_TRANSCRIPTION_CONSTRAINT_CASES: readonly Case[] = [
    { constraint: 'meetings_transcript_source_revision_check', run: async (f) => await f.session.query('UPDATE meetings SET transcript_source_revision=-1 WHERE id=$1', [await meeting(f)]) },
    ...[
        ['source_kind', 'other'], ['processing_status', 'other'], ['processing_reason', 'Not a code'], ['duration_ms', 14400001], ['wake_revision', -1],
    ].map(([column, value]): Case => ({ constraint: `meeting_recordings_${String(column)}_check`, run: async (f) => { const b = await base(f); return await f.session.query(`UPDATE meeting_recordings SET ${String(column)}=$2 WHERE id=$1`, [b.id, value]); } })),
    { constraint: 'meeting_recording_aliases_check', run: async (f) => { const row = await alias(f); return await insert(f, 'meeting_recording_aliases', { ...row, alias_id: row['recording_id'] }); } },
    bad('meeting_recording_aliases', 'meeting_recording_aliases_workspace_id_recording_id_fkey', alias, { recording_id: absent }),
    { constraint: 'meeting_recording_aliases_pkey', run: async (f) => { const row = await alias(f); await insert(f, 'meeting_recording_aliases', row); return await insert(f, 'meeting_recording_aliases', row); } },
    ...[
        ['duration_ms', -1], ['version', 0], ['language', 'bad language'], ['utterances', '{}'],
    ].map(([column, value]) => bad('meeting_transcripts', `meeting_transcripts_${String(column)}_check`, transcript, { [String(column)]: value })),
    bad('meeting_transcripts', 'meeting_transcripts_workspace_id_recording_id_fkey', transcript, { recording_id: absent }),
    { constraint: 'meeting_transcripts_pkey', run: async (f) => { const row = await transcript(f); await insert(f, 'meeting_transcripts', row); return await insert(f, 'meeting_transcripts', { ...row, version: 2 }); } },
    { constraint: 'meeting_transcripts_workspace_id_original_recording_id_vers_key', run: async (f) => { const row = await transcript(f); await insert(f, 'meeting_transcripts', row); return await insert(f, 'meeting_transcripts', { ...row, id: randomUUID() }); } },
    ...[
        ['duration_ms', 0], ['source_kind', 'bad'], ['job_name', 'bad job'], ['input_key', 'calls/not-allowed.flac'], ['output_key', 'other/out.json'], ['looks', -1], ['reason', 'Bad code'], ['state', 'bad'],
    ].map(([column, value]) => bad('meeting_transcription_attempts', `meeting_transcription_attempts_${String(column)}_check`, attempt, { [String(column)]: value })),
    bad('meeting_transcription_attempts', 'meeting_transcription_attempts_check', attempt, { state: 'complete' }),
    bad('meeting_transcription_attempts', 'meeting_transcription_attempts_check1', attempt, { deadline_at: '2020-01-01T00:00:00Z' }),
    bad('meeting_transcription_attempts', 'meeting_transcription_attempts_workspace_id_fkey', attempt, { workspace_id: absent, recording_id: null }),
    bad('meeting_transcription_attempts', 'meeting_transcription_attempts_workspace_id_recording_id_fkey', attempt, { recording_id: absent }),
    bad('meeting_transcription_attempts', 'meeting_transcription_attempts_workspace_id_reservation_id_fkey', attempt, { reservation_id: absent }),
    { constraint: 'meeting_transcription_attempts_pkey', run: async (f) => { const a = await attempt(f), b = await attempt(f); await insert(f, 'meeting_transcription_attempts', a); return await insert(f, 'meeting_transcription_attempts', { ...b, id: a['id'] }); } },
    { constraint: 'meeting_transcription_attempts_job_name_key', run: async (f) => { const a = await attempt(f), b = await attempt(f); await insert(f, 'meeting_transcription_attempts', a); return await insert(f, 'meeting_transcription_attempts', { ...b, job_name: a['job_name'] }); } },
    { constraint: 'meeting_transcription_attempts_workspace_id_reservation_id_key', run: async (f) => { const a = await attempt(f), b = await attempt(f); await insert(f, 'meeting_transcription_attempts', a); return await insert(f, 'meeting_transcription_attempts', { ...b, reservation_id: a['reservation_id'] }); } },
];
