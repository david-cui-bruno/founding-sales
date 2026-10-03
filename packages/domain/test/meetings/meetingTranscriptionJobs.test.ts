import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enqueueJob } from '../../jobs/jobStore.ts';
import { withTransaction } from '../../db/queryable.ts';
import { beginMeetingTranscription, dispatchMeetingTranscription, completeMeetingTranscription } from '../../meetings/transcription.ts';
import { scheduleMeetingTranscriptions } from '../../meetings/transcriptionJobs.ts';
import { readMeetingTranscript } from '../../meetings/transcripts.ts';
import { accountId, at, jobPrefix, meetingProcessingFixture, prepared } from './support/meetingProcessingFixture.ts';
describe('durable meeting attempts', () => {
  let f: Awaited<ReturnType<typeof meetingProcessingFixture>>;
  beforeEach(async () => { f = await meetingProcessingFixture(); }); afterEach(async () => { await f.db.drop(); });
  async function begun() {
    const meetingId = await f.meeting(), recordingId = await f.recording(meetingId);
    const attempt = await withTransaction(f.db.session, () => beginMeetingTranscription(f.context, { recordingId, prepared: prepared(recordingId), at, accountId, jobPrefix }));
    if (attempt.kind !== 'reserved') throw new Error('not reserved'); return { meetingId, recordingId, ...attempt };
  }
  const completed = { kind: 'complete' as const, language: 'en-US', utterances: [{ startMs: 0, endMs: 100, text: 'Example only.', speaker: null, attribution: 'unknown' as const }] };
  it('replay and a lost dispatch response keep one job and one reservation', async () => {
    const a = await begun();
    const replay = await withTransaction(f.db.session, () => beginMeetingTranscription(f.context, { recordingId: a.recordingId, prepared: prepared(a.recordingId), at, accountId, jobPrefix }));
    expect(replay).toMatchObject({ attemptId: a.attemptId, jobName: a.jobName });
    expect((await withTransaction(f.db.session, () => dispatchMeetingTranscription(f.context, { attemptId: a.attemptId, at, accountId }))).kind).toBe('dispatch');
    expect((await withTransaction(f.db.session, () => dispatchMeetingTranscription(f.context, { attemptId: a.attemptId, at, accountId }))).kind).toBe('held');
    expect((await f.db.session.query('SELECT id FROM provider_reservations')).rows).toHaveLength(1);
  });
  it('collects after disablement, prices decoded duration and stores once', async () => {
    const a = await begun(); await withTransaction(f.db.session, () => dispatchMeetingTranscription(f.context, { attemptId: a.attemptId, at, accountId }));
    await f.configure({ enabled: false });
    for (let i = 0; i < 2; i++) await withTransaction(f.db.session, () => completeMeetingTranscription(f.context, { attemptId: a.attemptId, result: completed, at }));
    expect((await f.db.session.query('SELECT id FROM meeting_transcripts')).rows).toHaveLength(1);
    expect((await f.db.session.query('SELECT settled_cents FROM provider_reservations')).rows).toEqual([{ settled_cents: 12 }]);
    const page = await readMeetingTranscript(f.context, { meetingId: a.meetingId }); expect(page?.coverage.ready).toBe(1); expect(page?.recordings[0]?.durationMs).toBe(1200000);
  });
  it('late completion after deletion settles but never recreates speech', async () => {
    const a = await begun(); await withTransaction(f.db.session, () => dispatchMeetingTranscription(f.context, { attemptId: a.attemptId, at, accountId }));
    await f.db.session.query('DELETE FROM meetings WHERE id=$1', [a.meetingId]);
    expect(await withTransaction(f.db.session, () => completeMeetingTranscription(f.context, { attemptId: a.attemptId, result: completed, at }))).toBe('gone');
    expect((await f.db.session.query('SELECT id FROM meeting_transcripts')).rows).toHaveLength(0);
    expect((await f.db.session.query('SELECT settled_cents FROM provider_reservations')).rows).toEqual([{ settled_cents: 12 }]);
  });
  it('an unmatched meeting settles without leaving its recording stuck as processing', async () => {
    const a = await begun(); await withTransaction(f.db.session, () => dispatchMeetingTranscription(f.context, { attemptId: a.attemptId, at, accountId }));
    await f.db.session.query('UPDATE meetings SET firm_id=NULL WHERE id=$1', [a.meetingId]);
    expect(await withTransaction(f.db.session, () => completeMeetingTranscription(f.context, { attemptId: a.attemptId, result: completed, at }))).toBe('gone');
    expect((await f.db.session.query('SELECT processing_status,processing_reason FROM meeting_recordings WHERE id=$1', [a.recordingId])).rows).toEqual([{ processing_status: 'disabled', processing_reason: 'not_eligible' }]);
    expect((await f.db.session.query('SELECT id FROM meeting_transcripts')).rows).toHaveLength(0);
  });
  it('stores a valid transcript close to the byte limit instead of imposing an arbitrary smaller limit', async () => {
    const a = await begun(); await withTransaction(f.db.session, () => dispatchMeetingTranscription(f.context, { attemptId: a.attemptId, at, accountId }));
    let length = 100; let utterances = [] as typeof completed.utterances;
    for (; length < 300; length++) {
      utterances = Array.from({ length: 15000 }, () => ({ startMs: 0, endMs: 1, text: 'a'.repeat(length), speaker: null, attribution: 'unknown' as const }));
      if (Buffer.byteLength(JSON.stringify(utterances)) > 4000000) break;
    }
    const sqlSize = Number((await f.db.session.query<{ size: number }>('SELECT octet_length($1::jsonb::text) AS size', [JSON.stringify(utterances)])).rows[0]!.size);
    expect(sqlSize).toBeLessThanOrEqual(4194304);
    expect(await withTransaction(f.db.session, () => completeMeetingTranscription(f.context, { attemptId: a.attemptId, at, result: { ...completed, utterances } }))).toBe('complete');
  });
  it('scans at most 50 legacy sources and advances without starving later sources', async () => {
    for (let i = 0; i < 55; i++) await f.recording(await f.meeting());
    await f.db.session.query("DELETE FROM jobs WHERE kind='meeting.transcribe'");
    await f.db.session.query("UPDATE meeting_recordings SET next_wake_at=$1,processing_settings_version=1", [at]);
    const sizes: number[] = [];
    for (let i = 0; i < 3; i++) await withTransaction(f.db.session, async () => {
      const jobs = await scheduleMeetingTranscriptions(f.db.session, at); sizes.push(jobs.length);
      for (const job of jobs) await enqueueJob(f.db.session, job);
    });
    expect(sizes).toEqual([50, 5, 0]);
  });
  it('an always-crashing check-up still reaches the independent 120-minute deadline', async () => {
    const a = await begun(); await withTransaction(f.db.session, () => dispatchMeetingTranscription(f.context, { attemptId: a.attemptId, at, accountId }));
    await withTransaction(f.db.session, () => scheduleMeetingTranscriptions(f.db.session, '2026-10-03T05:01:00.000Z'));
    expect((await f.db.session.query('SELECT state,reason FROM meeting_transcription_attempts')).rows).toEqual([{ state: 'estimated', reason: 'collection_timeout' }]);
    expect((await f.db.session.query('SELECT settled_cents FROM provider_reservations')).rows).toEqual([{ settled_cents: 12 }]);
  });
});
