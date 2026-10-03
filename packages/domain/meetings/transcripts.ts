import { meetingTranscriptPageSchema, type MeetingTranscriptPage, type RecordingProcessingView, type MeetingSpeech } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readFirm } from '../crm/firms.ts';
import { decideFirmRead } from '../crm/authorization.ts';
import { readMeetingTranscription } from './transcriptionSettings.ts';
export class MeetingTranscriptChangedError extends Error {
    constructor() { super('transcript_changed'); this.name = 'MeetingTranscriptChangedError'; }
}
export class MeetingTranscriptCursorError extends Error {
    constructor() { super('invalid_cursor'); this.name = 'MeetingTranscriptCursorError'; }
}
type Cursor = {
    meetingId: string;
    revision: number;
    offset: number;
};
function parseCursor(value: string, meetingId: string): Cursor {
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<Cursor>;
        if (parsed.meetingId !== meetingId || !Number.isSafeInteger(parsed.revision) || !Number.isSafeInteger(parsed.offset)
            || (parsed.offset ?? -1) < 0 || (parsed.offset ?? 0) > 20000000)
            throw new Error('invalid');
        return parsed as Cursor;
    }
    catch {
        throw new MeetingTranscriptCursorError();
    }
}
interface SourceRow {
    readonly [key: string]: unknown;
    id: string;
    meeting_id: string;
    participant_label: string;
    segment: number;
    source_kind: RecordingProcessingView['sourceKind'];
    processing_status: RecordingProcessingView['status'];
    processing_reason: string | null;
    duration_ms: number | null;
    transcript_id: string | null;
    version: number | null;
}
const chosen = `LEFT JOIN LATERAL (SELECT id,version,utterances FROM meeting_transcripts t
  WHERE t.workspace_id=r.workspace_id AND t.recording_id=r.id ORDER BY t.created_at,t.id LIMIT 1) t ON true`;
/** Current authority is checked before decoding a cursor or revealing any content. */
export async function readMeetingTranscript(context: RepositoryContext, input: {
    meetingId: string;
    cursor?: string;
}): Promise<MeetingTranscriptPage | null> {
    const workspace = context.scope.workspaceId;
    const meeting = (await context.db.query<{
        firm_id: string | null;
        transcript_source_revision: number;
    }>('SELECT firm_id,transcript_source_revision FROM meetings WHERE workspace_id=$1 AND id=$2', [workspace, input.meetingId])).rows[0];
    if (meeting?.firm_id === undefined || meeting.firm_id === null)
        return null;
    const firm = await readFirm(context, meeting.firm_id);
    if (firm === null || decideFirmRead(context, firm) !== 'assigned_or_admin')
        return null;
    const revision = meeting.transcript_source_revision;
    const cursor = input.cursor === undefined ? { offset: 0, revision, meetingId: input.meetingId } : parseCursor(input.cursor, input.meetingId);
    if (cursor.revision !== revision)
        throw new MeetingTranscriptChangedError();
    const settings = await readMeetingTranscription(context);
    const sourceSql = `SELECT r.id,r.meeting_id,r.participant_label,r.segment,r.source_kind,r.processing_status,
    r.processing_reason,r.duration_ms,t.id AS transcript_id,t.version FROM meeting_recordings r ${chosen}
    WHERE r.workspace_id=$1 AND r.meeting_id=$2`;
    const sourceRows = (await context.db.query<SourceRow>(`${sourceSql} ORDER BY r.id LIMIT 201`, [workspace, input.meetingId])).rows;
    const speechRows = (await context.db.query<{
        recording_id: string;
        transcript_id: string;
        version: number;
        ordinal: string;
        speech: MeetingSpeech;
    }>(`SELECT r.id AS recording_id,t.id AS transcript_id,t.version,u.ordinal::text,u.speech
     FROM meeting_recordings r ${chosen}
     CROSS JOIN LATERAL jsonb_array_elements(t.utterances) WITH ORDINALITY u(speech,ordinal)
     WHERE r.workspace_id=$1 AND r.meeting_id=$2 ORDER BY r.id,u.ordinal LIMIT 201 OFFSET $3`, [workspace, input.meetingId, cursor.offset])).rows;
    const page = speechRows.slice(0, 200);
    const absent = [...new Set(page.map(row => row.recording_id))].filter(id => !sourceRows.slice(0, 200).some(row => row.id === id));
    const extras = absent.length === 0 ? [] : (await context.db.query<SourceRow>(`${sourceSql} AND r.id=ANY($3::uuid[]) ORDER BY r.id`, [workspace, input.meetingId, absent])).rows;
    const sources = [...extras, ...sourceRows].slice(0, 200).map(row => ({
        recordingId: row.id, meetingId: row.meeting_id, participantLabel: row.participant_label, segment: row.segment, sourceKind: row.source_kind,
        status: row.transcript_id !== null ? 'ready' as const : (!settings.enabled || settings.dailyCeilingCents === 0) && row.processing_status === 'queued' ? 'disabled' as const : row.processing_status,
        reason: row.processing_reason, transcriptId: row.transcript_id, transcriptVersion: row.version, durationMs: row.duration_ms,
    }));
    const counts = (await context.db.query<{
        total: string;
        ready: string;
        held: string;
        failed: string;
        unavailable: string;
    }>(`SELECT count(*)::text AS total,count(*) FILTER (WHERE t.id IS NOT NULL)::text AS ready,
     count(*) FILTER (WHERE t.id IS NULL AND (r.processing_status IN ('disabled','budget_held','funding_unverified') OR ($3::boolean AND r.processing_status='queued')))::text AS held,
     count(*) FILTER (WHERE t.id IS NULL AND r.processing_status='failed')::text AS failed,
     count(*) FILTER (WHERE t.id IS NULL AND r.processing_status='needs_reupload')::text AS unavailable
     FROM meeting_recordings r ${chosen} WHERE r.workspace_id=$1 AND r.meeting_id=$2`, [workspace, input.meetingId, !settings.enabled || settings.dailyCeilingCents === 0])).rows[0];
    const total = Number(counts?.total ?? 0), ready = Number(counts?.ready ?? 0), held = Number(counts?.held ?? 0), failed = Number(counts?.failed ?? 0), unavailable = Number(counts?.unavailable ?? 0);
    // A new source or selected transcript arriving between queries invalidates this page.
    const current = (await context.db.query<{
        transcript_source_revision: number;
    }>('SELECT transcript_source_revision FROM meetings WHERE workspace_id=$1 AND id=$2', [workspace, input.meetingId])).rows[0];
    if (current === undefined)
        return null;
    if (current.transcript_source_revision !== revision)
        throw new MeetingTranscriptChangedError();
    return meetingTranscriptPageSchema.parse({
        meetingId: input.meetingId, coverage: { sourceRevision: revision, total, ready, held, failed, unavailable, pending: total - ready - held - failed - unavailable },
        recordings: sources, recordingsTruncated: sourceRows.length > 200, utterances: page.map(row => ({
            ...row.speech, id: `${row.transcript_id}:${row.ordinal}`, recordingId: row.recording_id, transcriptId: row.transcript_id, transcriptVersion: row.version,
        })), nextCursor: speechRows.length > 200 ? Buffer.from(JSON.stringify({ meetingId: input.meetingId, revision, offset: cursor.offset + 200 })).toString('base64url') : null,
        timing: 'file_relative',
    });
}
