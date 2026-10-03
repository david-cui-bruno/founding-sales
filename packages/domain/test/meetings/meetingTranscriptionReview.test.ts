import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction, type SessionQueryable, type QueryResultRowLike } from '../../db/queryable.ts';
import { repositoryContext } from '../../db/workspaceScope.ts';
import { beginMeetingTranscription, dispatchMeetingTranscription, completeMeetingTranscription, submitMeetingTranscription } from '../../meetings/transcription.ts';
import { moveRecordingsToSurvivor } from '../../meetings/recordings.ts';
import { accountId, jobPrefix, meetingProcessingFixture, prepared } from './support/meetingProcessingFixture.ts';

describe('meeting transcription review regressions', () => {
  let f: Awaited<ReturnType<typeof meetingProcessingFixture>>, at: string;
  beforeEach(async () => {
    f = await meetingProcessingFixture();
    at = (await f.db.session.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]!.at.toISOString();
  });
  afterEach(async () => { await f.db.drop(); });
  const reserve = async (recordingId: string) => {
    const result = await withTransaction(f.db.session, () => beginMeetingTranscription(f.context, { recordingId, prepared: prepared(recordingId), accountId, jobPrefix, at }));
    if (result.kind !== 'reserved') throw new Error(`not reserved: ${result.reason}`);
    return result;
  };
  const dispatch = async (attemptId: string) => withTransaction(f.db.session, () => dispatchMeetingTranscription(f.context, { attemptId, at, accountId }));
  const complete = { kind: 'complete' as const, language: 'en-US', utterances: [{ startMs: 0, endMs: 100, text: 'Preserve this speech.', speaker: null, attribution: 'unknown' as const }] };

  it.each([true, false])('a fold during completion retries without losing content (duplicate=%s)', async duplicate => {
    const survivor = await f.meeting(), oldMeeting = await f.meeting();
    const canonical = await f.recording(survivor, 'a'.repeat(64));
    const original = await f.recording(oldMeeting, (duplicate ? 'a' : 'b').repeat(64));
    const attempt = await reserve(original); await dispatch(attempt.attemptId);
    const other = await f.db.appRuntimeSession();
    const otherContext = repositoryContext(f.context.scope, other);
    let folded = false;
    const interleaved: SessionQueryable = {
      async query<Row extends QueryResultRowLike>(sql: string, values?: readonly unknown[]) {
        if (!folded && sql.includes(' FROM firms ') && sql.endsWith('FOR UPDATE')) {
          folded = true;
          await withTransaction(other, async () => {
            await other.query('SELECT id FROM firms WHERE id=$1 FOR UPDATE', [f.firmId]);
            await other.query('SELECT id FROM meetings WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[oldMeeting, survivor]]);
            await moveRecordingsToSurvivor(otherContext, oldMeeting, survivor);
          });
        }
        return await f.db.session.query<Row>(sql, values);
      },
    };
    const context = repositoryContext(f.context.scope, interleaved);
    await expect(withTransaction(interleaved, () => completeMeetingTranscription(context, { attemptId: attempt.attemptId, result: complete, at }))).rejects.toThrow('meeting_recording_changed');
    expect(folded).toBe(true);
    expect((await f.db.session.query('SELECT state FROM meeting_transcription_attempts WHERE id=$1', [attempt.attemptId])).rows).toEqual([{ state: 'submitting' }]);
    expect((await f.db.session.query('SELECT state,settled_cents FROM provider_reservations WHERE id=$1', [attempt.reservationId])).rows).toEqual([{ state: 'calling', settled_cents: 0 }]);
    expect(await withTransaction(f.db.session, () => completeMeetingTranscription(f.context, { attemptId: attempt.attemptId, result: complete, at }))).toBe('complete');
    expect((await f.db.session.query('SELECT recording_id,original_recording_id,utterances FROM meeting_transcripts')).rows).toEqual([{ recording_id: duplicate ? canonical : original, original_recording_id: original, utterances: complete.utterances }]);
  });

  it.each(['before_dispatch', 'before_submission'] as const)('a fold %s cannot spend a third paid attempt', async when => {
    const survivor = await f.meeting(), oldMeeting = await f.meeting();
    const canonical = await f.recording(survivor), original = await f.recording(oldMeeting);
    const waiting = await reserve(original);
    if (when === 'before_submission') expect((await dispatch(waiting.attemptId)).kind).toBe('dispatch');
    for (let i = 0; i < 2; i++) {
      const previous = await reserve(canonical); await dispatch(previous.attemptId);
      await withTransaction(f.db.session, () => completeMeetingTranscription(f.context, { attemptId: previous.attemptId, at, result: { kind: 'failed', code: 'output_missing' } }));
    }
    await withTransaction(f.db.session, () => moveRecordingsToSurvivor(f.context, oldMeeting, survivor));
    if (when === 'before_dispatch') expect(await dispatch(waiting.attemptId)).toMatchObject({ kind: 'held', reason: 'attempt_limit' });
    let starts = 0;
    await withTransaction(f.db.session, () => submitMeetingTranscription(f.context, { attemptId: waiting.attemptId, at, accountId, provider: {
      async start() { starts++; return 'started'; }, async collect() { return { kind: 'pending' }; },
    } }));
    expect(starts).toBe(0);
    expect((await f.db.session.query('SELECT state,settled_cents FROM provider_reservations WHERE id=$1', [waiting.reservationId])).rows).toEqual([{ state: 'released', settled_cents: 0 }]);
    expect((await f.db.session.query('SELECT count(*)::integer AS n FROM provider_reservations WHERE state=\'estimated\'')).rows).toEqual([{ n: 2 }]);
  });

  it.each(['before_dispatch', 'before_submission'] as const)('a completed survivor prevents redundant work after fold %s', async when => {
    const survivor = await f.meeting(), oldMeeting = await f.meeting();
    const canonical = await f.recording(survivor), original = await f.recording(oldMeeting);
    const waiting = await reserve(original);
    if (when === 'before_submission') await dispatch(waiting.attemptId);
    const existingTranscript = await f.transcript(canonical);
    await withTransaction(f.db.session, () => moveRecordingsToSurvivor(f.context, oldMeeting, survivor));
    if (when === 'before_dispatch') expect(await dispatch(waiting.attemptId)).toMatchObject({ kind: 'held', reason: 'already_ready' });
    let starts = 0;
    await withTransaction(f.db.session, () => submitMeetingTranscription(f.context, { attemptId: waiting.attemptId, at, accountId, provider: {
      async start() { starts++; return 'started'; }, async collect() { return { kind: 'pending' }; },
    } }));
    expect(starts).toBe(0);
    expect((await f.db.session.query('SELECT id FROM meeting_transcripts')).rows).toEqual([{ id: existingTranscript }]);
    expect((await f.db.session.query('SELECT state,settled_cents FROM provider_reservations WHERE id=$1', [waiting.reservationId])).rows).toEqual([{ state: 'released', settled_cents: 0 }]);
  });
});
