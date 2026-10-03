import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolveMeetingRecording } from '../../meetings/recordingIdentity.ts';
import { withTransaction } from '../../db/queryable.ts';
import { moveRecordingsToSurvivor } from '../../meetings/recordings.ts';
import { readMeetingTranscript, MeetingTranscriptChangedError } from '../../meetings/transcripts.ts';
import { meetingTranscriptionFixture } from './support/meetingTranscriptionFixture.ts';
describe('meeting transcript identity and paging', () => {
    let f: Awaited<ReturnType<typeof meetingTranscriptionFixture>>;
    beforeAll(async () => { f = await meetingTranscriptionFixture(); });
    afterAll(async () => { await f.db.drop(); });
    it('preserves a duplicate recording transcript when meetings fold', async () => {
        const a = await f.meeting(), b = await f.meeting();
        const canonical = await f.recording(a), old = await f.recording(b);
        const transcript = await f.transcript(old);
        await withTransaction(f.db.session, async () => await moveRecordingsToSurvivor(f.context, b, a));
        const page = await readMeetingTranscript(f.context, { meetingId: a });
        expect(page?.utterances[0]?.transcriptId).toBe(transcript);
        expect(page?.utterances[0]?.recordingId).toBe(canonical);
        expect((await f.db.session.query<{
            recording_id: string;
        }>('SELECT recording_id FROM meeting_recording_aliases WHERE workspace_id=$1 AND alias_id=$2', [f.workspace, old])).rows[0]?.recording_id).toBe(canonical);
        await f.db.session.query('DELETE FROM meetings WHERE id=$1', [b]);
        expect((await readMeetingTranscript(f.context, { meetingId: a }))?.coverage.ready).toBe(1);
    });
    it('keeps in-flight accounting across a fold and clears only subject linkage on deletion', async () => {
        const a = await f.meeting(), b = await f.meeting();
        const canonical = await f.recording(a), old = await f.recording(b);
        const reservation = randomUUID(), attempt = randomUUID();
        await f.db.session.query(`INSERT INTO provider_reservations (id,workspace_id,provider_key,subject_kind,subject_id,attempt,business_date,business_time_zone,cents,model_name,max_input_tokens,max_output_tokens,priced_unit,max_units,unit_price_micros)
      VALUES ($1,$2,'aws_transcribe.standard','meeting_transcription',$3,1,current_date,'America/New_York',12,NULL,NULL,NULL,'minute',20,6000)`, [reservation, f.workspace, old]);
        await f.db.session.query(`INSERT INTO meeting_transcription_attempts (id,workspace_id,recording_id,original_recording_id,reservation_id,job_name,input_key,output_key,duration_ms,source_kind,deadline_at)
      VALUES ($1,$2,$3,$3,$4,$5,$6,$7,1200000,'participant',now()+interval '120 minutes')`, [attempt, f.workspace, old, reservation, `m5-${attempt}`, `meetings-processing/${old}/${attempt}.flac`, `meetings-processing/${old}/${attempt}.json`]);
        await withTransaction(f.db.session, async () => await moveRecordingsToSurvivor(f.context, b, a));
        expect(await resolveMeetingRecording(f.context, old)).toEqual({ recordingId: canonical, meetingId: a, aliasIds: [old] });
        expect((await f.db.session.query<{
            recording_id: string;
        }>('SELECT recording_id FROM meeting_transcription_attempts WHERE id=$1', [attempt])).rows[0]?.recording_id).toBe(canonical);
        await f.db.session.query('DELETE FROM meetings WHERE id=$1', [a]);
        expect((await f.db.session.query<{
            recording_id: string | null;
        }>('SELECT recording_id FROM meeting_transcription_attempts WHERE id=$1', [attempt])).rows[0]?.recording_id).toBeNull();
        expect((await f.db.session.query<{
            cents: number;
        }>('SELECT cents FROM provider_reservations WHERE id=$1', [reservation])).rows[0]?.cents).toBe(12);
    });
    it('invalidates a cursor when a late participant arrives instead of skipping their speech', async () => {
        const meeting = await f.meeting();
        await f.transcript(await f.recording(meeting), 201);
        const first = await readMeetingTranscript(f.context, { meetingId: meeting });
        expect(first?.utterances).toHaveLength(200);
        expect(first?.nextCursor).toBeTypeOf('string');
        const cursor = first?.nextCursor ?? '';
        expect((await readMeetingTranscript(f.context, { meetingId: meeting, cursor }))?.utterances).toHaveLength(1);
        await f.recording(meeting, 'b'.repeat(64));
        await expect(readMeetingTranscript(f.context, { meetingId: meeting, cursor })).rejects.toBeInstanceOf(MeetingTranscriptChangedError);
    });
});
