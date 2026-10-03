import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext } from '../../db/workspaceScope.ts';
import { meetingTranscriptionCents } from '../../meetings/transcriptionBudget.ts';
import { beginMeetingTranscription, dispatchMeetingTranscription, completeMeetingTranscription, submitMeetingTranscription } from '../../meetings/transcription.ts';
import { moveRecordingsToSurvivor } from '../../meetings/recordings.ts';
import { accountId, at, coverage, jobPrefix, meetingProcessingFixture, prepared } from './support/meetingProcessingFixture.ts';
describe('meeting spend boundary', () => {
  let f: Awaited<ReturnType<typeof meetingProcessingFixture>>;
  beforeEach(async () => { f = await meetingProcessingFixture(); });
  afterEach(async () => { await f.db.drop(); });
  const reserve = async (recordingId: string, durationMs = 1200000) => withTransaction(f.db.session, () => beginMeetingTranscription(f.context, { recordingId, prepared: prepared(recordingId, durationMs), accountId, jobPrefix, at }));
  it('two 20-minute sources reserve 12 cents each, at the business date including silence', async () => {
    expect(meetingTranscriptionCents(1200000)).toBe(12); expect(meetingTranscriptionCents(1)).toBe(1);
    const meeting = await f.meeting();
    for (const digest of ['a', 'b']) expect((await reserve(await f.recording(meeting, digest.repeat(64)))).kind).toBe('reserved');
    const rows = (await f.db.session.query('SELECT cents,business_date::text AS day FROM provider_reservations WHERE workspace_id=$1', [f.workspace])).rows;
    expect(rows).toEqual([{ cents: 12, day: '2026-10-02' }, { cents: 12, day: '2026-10-02' }]);
  });
  it('concurrent 30-cent requests cannot both fit in 50 cents', async () => {
    const a = await f.recording(await f.meeting()), b = await f.recording(await f.meeting());
    const second = await f.db.appRuntimeSession(); const context = repositoryContext(f.context.scope, second);
    const results = await Promise.all([reserve(a, 3000000), withTransaction(second, () => beginMeetingTranscription(context, { recordingId: b, prepared: prepared(b, 3000000), accountId, jobPrefix, at }))]);
    expect(results.map(x => x.kind).sort()).toEqual(['held', 'reserved']);
    expect(results.find(x => x.kind === 'held')).toMatchObject({ reason: 'daily_limit' });
  });
  it.each([
    { enabled: false }, { dailyCeilingCents: 0 }, { creditCoverage: null },
    { creditCoverage: { ...coverage, status: 'revoked' as const } },
    { creditCoverage: { ...coverage, accountId: '000000000000' } },
    { creditCoverage: { ...coverage, validUntil: '2026-10-02T00:00:00.000Z' } },
  ])('no reservation with invalid configuration %j', async patch => {
    await f.configure(patch); expect((await reserve(await f.recording(await f.meeting()))).kind).toBe('held');
    expect((await f.db.session.query('SELECT id FROM provider_reservations')).rows).toHaveLength(0);
  });
  it('disablement at dispatch releases a reserved attempt without spending', async () => {
    const first = await reserve(await f.recording(await f.meeting())); if (first.kind !== 'reserved') throw new Error('not reserved');
    await f.configure({ enabled: false });
    expect((await withTransaction(f.db.session, () => dispatchMeetingTranscription(f.context, { attemptId: first.attemptId, at, accountId }))).kind).toBe('held');
    expect((await f.db.session.query('SELECT state,settled_cents FROM provider_reservations')).rows).toEqual([{ state: 'released', settled_cents: 0 }]);
  });
  it('bounds released-before-dispatch rows and never resets them on settings changes', async () => {
    const recordingId = await f.recording(await f.meeting());
    for (let i = 0; i < 6; i++) {
      const a = await reserve(recordingId); if (a.kind !== 'reserved') throw new Error('not reserved');
      await f.configure({ enabled: false });
      await withTransaction(f.db.session, () => dispatchMeetingTranscription(f.context, { attemptId: a.attemptId, at, accountId }));
      await f.configure();
    }
    expect(await reserve(recordingId)).toMatchObject({ kind: 'held', reason: 'reservation_limit' });
    expect((await f.db.session.query('SELECT id FROM provider_reservations')).rows).toHaveLength(6);
  });
  it('an old-day reservation cannot buy work on a new business date', async () => {
    const a = await reserve(await f.recording(await f.meeting())); if (a.kind !== 'reserved') throw new Error('not reserved');
    expect(await withTransaction(f.db.session, () => dispatchMeetingTranscription(f.context, { attemptId: a.attemptId, at: '2026-10-03T05:00:00.000Z', accountId }))).toMatchObject({ kind: 'held', reason: 'budget_expired' });
  });
  it('the actual paid call rereads database time instead of trusting a stale dispatch timestamp', async () => {
    const now = (await f.db.session.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]!.at.getTime();
    const stale = new Date(now - 86400000).toISOString();
    await f.configure({ creditCoverage: { ...coverage, verifiedAt: new Date(now - 172800000).toISOString(), validUntil: new Date(now - 1000).toISOString() } });
    const recordingId = await f.recording(await f.meeting());
    const a = await withTransaction(f.db.session, () => beginMeetingTranscription(f.context, { recordingId, prepared: prepared(recordingId), accountId, jobPrefix, at: stale }));
    if (a.kind !== 'reserved') throw new Error('not reserved');
    await withTransaction(f.db.session, () => dispatchMeetingTranscription(f.context, { attemptId: a.attemptId, accountId, at: stale }));
    let starts = 0;
    await withTransaction(f.db.session, () => submitMeetingTranscription(f.context, { attemptId: a.attemptId, accountId, at: stale, provider: {
      async start() { starts++; return 'started'; }, async collect() { return { kind: 'pending' }; },
    } }));
    expect(starts).toBe(0);
  });
  it('folded identities retain the paid-attempt ceiling', async () => {
    const a = await f.meeting(), b = await f.meeting(); const canonical = await f.recording(a), old = await f.recording(b);
    for (const recordingId of [canonical, old]) {
      const first = await reserve(recordingId); if (first.kind !== 'reserved') throw new Error('not reserved');
      await withTransaction(f.db.session, () => dispatchMeetingTranscription(f.context, { attemptId: first.attemptId, at, accountId }));
      await withTransaction(f.db.session, () => completeMeetingTranscription(f.context, { attemptId: first.attemptId, at, result: { kind: 'failed', code: 'output_missing' } }));
    }
    await withTransaction(f.db.session, () => moveRecordingsToSurvivor(f.context, b, a));
    expect(await reserve(old)).toMatchObject({ kind: 'held', reason: 'attempt_limit' });
  });
});
