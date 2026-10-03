import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { authorizeRecordingRecovery, completeRecordingRecovery, listRecordingRecoveries } from '../../meetings/recordingRecovery.ts';
import { moveRecordingsToSurvivor, listFirmRecordings } from '../../meetings/recordings.ts';
import { beginMeetingTranscription, dispatchMeetingTranscription, completeMeetingTranscription } from '../../meetings/transcription.ts';
import { accountId, at, jobPrefix, meetingProcessingFixture, prepared } from './support/meetingProcessingFixture.ts';
describe('recording recovery', () => {
  let f: Awaited<ReturnType<typeof meetingProcessingFixture>>;
  beforeEach(async () => { f = await meetingProcessingFixture(); });
  afterEach(async () => { await f.db.drop(); });
  const binding = { issued: async () => true, wrote: async () => true };
  const verify = async () => ({ verdict: 'ok' as const, uploadId: randomUUID() });
  async function missing() {
    const meetingId = await f.meeting(), recordingId = await f.recording(meetingId);
    await f.db.session.query("UPDATE meeting_recordings SET processing_status='needs_reupload',processing_reason='source_missing' WHERE id=$1", [recordingId]);
    return { meetingId, recordingId };
  }
  const complete = (id: string, check = verify, bound = binding) => withTransaction(f.db.session, () => completeRecordingRecovery(f.context, { recordingId: id, commandId: randomUUID() }, check, bound));
  it('expired_source_uses_same_identity and replay enqueues only once', async () => {
    const { recordingId } = await missing();
    const attempt = await withTransaction(f.db.session, () => beginMeetingTranscription(f.context, { recordingId, prepared: prepared(recordingId), at, accountId, jobPrefix }));
    if (attempt.kind !== 'reserved') throw new Error('missing attempt');
    await withTransaction(f.db.session, () => dispatchMeetingTranscription(f.context, { attemptId: attempt.attemptId, at, accountId }));
    await withTransaction(f.db.session, () => completeMeetingTranscription(f.context, { attemptId: attempt.attemptId, at, result: { kind: 'failed', code: 'provider_failed' } }));
    await f.db.session.query("UPDATE meeting_recordings SET processing_status='needs_reupload' WHERE id=$1", [recordingId]);
    expect(await complete(recordingId)).toBe('resumed');
    expect(await complete(recordingId)).toBe('refused');
    expect((await f.db.session.query('SELECT id FROM meeting_recordings')).rows).toEqual([{ id: recordingId }]);
    expect((await f.db.session.query('SELECT id FROM provider_reservations')).rows).toHaveLength(1);
    expect((await f.db.session.query("SELECT id FROM jobs WHERE kind='meeting.transcribe'")).rows).toHaveLength(2);
  });
  it('folded_source_uses_original_object_key', async () => {
    const { recordingId, meetingId } = await missing(), survivor = await f.meeting();
    await withTransaction(f.db.session, () => moveRecordingsToSurvivor(f.context, meetingId, survivor));
    const allowed = await withTransaction(f.db.session, () => authorizeRecordingRecovery(f.context, recordingId));
    expect(allowed).toMatchObject({ recordingId, meetingId: survivor, key: `meetings/${meetingId}/${'a'.repeat(64)}.m4a` });
  });
  it('registered_success_does_not_reupload or HEAD', async () => {
    const { recordingId } = await missing(); await f.transcript(recordingId);
    const head = vi.fn(verify);
    expect(await complete(recordingId, head)).toBe('already_ready'); expect(head).not.toHaveBeenCalled();
  });
  it('refuses another uploader before reading the object, even for an admin', async () => {
    const { recordingId } = await missing(); const head = vi.fn(verify);
    expect(await complete(recordingId, head, { ...binding, issued: async () => false })).toBe('refused');
    expect(head).not.toHaveBeenCalled();
    expect(await complete(recordingId, head, { ...binding, wrote: async () => false })).toBe('refused');
  });
  it('wrong checksum does not resume processing', async () => {
    const { recordingId } = await missing();
    expect(await completeRecordingRecovery(f.context, { recordingId, commandId: randomUUID() }, async () => ({ verdict: 'recording_checksum_mismatch', uploadId: randomUUID() }), binding)).toBe('refused');
    expect((await f.db.session.query('SELECT processing_status FROM meeting_recordings WHERE id=$1', [recordingId])).rows[0]).toEqual({ processing_status: 'needs_reupload' });
  });
  it('Today lists only actionable missing sources, once each, under current ownership', async () => {
    const a = await missing(); await f.recording(await f.meeting(), 'b'.repeat(64));
    expect((await listRecordingRecoveries(f.context)).items.map(row => row.recordingId)).toEqual([a.recordingId]);
    await f.transcript(a.recordingId);
    expect((await listRecordingRecoveries(f.context)).items).toEqual([]);
  });

  it('the older firm recording read reflects completed processing without changing shape', async () => {
    const id = await f.recording(await f.meeting());
    await f.db.session.query("UPDATE meeting_recordings SET processing_status='ready' WHERE id=$1", [id]);
    expect((await listFirmRecordings(f.context, f.firmId))?.recordings[0]?.state).toBe('transcribed');
  });

});
