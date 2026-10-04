import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { meetingOutcomesFixture } from './support/meetingOutcomesFixture.ts';
import { withTransaction } from '../../db/queryable.ts';
import { updateSetting } from '../../settings/store.ts';
import { meetingAnalysisPort } from '../../meetings/analysisAdapter.ts';
const accountId = '123456789012', at = '2026-10-04T10:00:00.000Z';
const coverage = { accountId, service: 'bedrock', evidenceRef: 'synthetic-evidence', verifiedAt: '2026-10-01T00:00:00Z', validUntil: '2026-11-01T00:00:00Z', status: 'verified' };
describe('credit-only meeting analysis', () => {
  let f: Awaited<ReturnType<typeof meetingOutcomesFixture>>;
  beforeAll(async () => { f = await meetingOutcomesFixture(); });
  afterAll(async () => { await f.db.drop(); });
  const configure = async (patch: Record<string, unknown> = {}) => await withTransaction(f.db.session, () => updateSetting(f.context, { settingKey: 'meeting_analysis', value: { enabled: true, dailyCeilingCents: 100, creditCoverage: coverage, ...patch } }));
  const seed = async () => {
    const { materializeMeetingAnalysis } = await import('../../meetings/analysisJobs.ts');
    const meetingId = await f.meeting(); await f.save(meetingId, 'I will send the guide tomorrow.');
    const result = await withTransaction(f.db.session, () => materializeMeetingAnalysis(f.context, { meetingId, at }));
    if (!result.ok) throw new Error(result.reason);
    return { meetingId, requestId: result.value.requestIds[0]! };
  };
  const deps = () => {
    let calls = 0;
    const port = meetingAnalysisPort({ transport: { kind: 'bedrock', countTokens: async () => { calls++; return 100; }, create: async () => { calls++; return {}; } } });
    return { accountId, port, calls: () => calls };
  };
  it('never reaches the provider when disabled, zero-budget or coverage is invalid', async () => {
    const { beginMeetingAnalysisRequest } = await import('../../meetings/analysisPaid.ts');
    for (const patch of [{ enabled: false }, { dailyCeilingCents: 0 }, { creditCoverage: null }, { creditCoverage: { ...coverage, accountId: '999999999999' } }, { creditCoverage: { ...coverage, validUntil: '2026-10-02T00:00:00Z' } }]) {
      await configure(patch); const seeded = await seed(), d = deps();
      expect(await withTransaction(f.db.session, () => beginMeetingAnalysisRequest(f.context, { requestId: seeded.requestId, at }, d))).toMatchObject({ kind: 'held' });
      expect(d.calls()).toBe(0);
    }
    expect((await f.db.session.query('SELECT id FROM provider_reservations WHERE subject_kind=$1', ['meeting_analysis'])).rows).toHaveLength(0);
  });
  it('reserves bounded tokens, rechecks the switch at dispatch and settles ambiguous outcomes at the estimate', async () => {
    const { beginMeetingAnalysisRequest, dispatchMeetingAnalysisRequest, completeMeetingAnalysisRequest } = await import('../../meetings/analysisPaid.ts');
    await configure(); const seeded = await seed(), d = deps();
    const begin = await withTransaction(f.db.session, () => beginMeetingAnalysisRequest(f.context, { requestId: seeded.requestId, at }, d));
    expect(begin.kind).toBe('reserved'); if (begin.kind !== 'reserved') return;
    await configure({ enabled: false });
    expect(await withTransaction(f.db.session, () => dispatchMeetingAnalysisRequest(f.context, { requestId: seeded.requestId, reservationId: begin.reservationId, at }, d))).toMatchObject({ kind: 'held' });
    expect((await f.db.session.query('SELECT state,settled_cents FROM provider_reservations WHERE id=$1', [begin.reservationId])).rows).toEqual([{ state: 'released', settled_cents: 0 }]);
    await configure();
    for (let i = 0; i < 2; i++) {
      const reserved = await withTransaction(f.db.session, () => beginMeetingAnalysisRequest(f.context, { requestId: seeded.requestId, at }, d));
      if (reserved.kind !== 'reserved') throw new Error(reserved.kind);
      expect(await withTransaction(f.db.session, () => dispatchMeetingAnalysisRequest(f.context, { requestId: seeded.requestId, reservationId: reserved.reservationId, at }, d))).toMatchObject({ kind: 'dispatch' });
      await withTransaction(f.db.session, () => completeMeetingAnalysisRequest(f.context, { requestId: seeded.requestId, attemptId: reserved.reservationId, at, result: { outcome: 'provider_error', usage: null, content: null } }));
    }
    expect(await withTransaction(f.db.session, () => beginMeetingAnalysisRequest(f.context, { requestId: seeded.requestId, at }, d))).toMatchObject({ kind: 'done' });
    expect((await f.db.session.query('SELECT paid_attempts,state FROM meeting_analysis_requests WHERE id=$1', [seeded.requestId])).rows).toEqual([{ paid_attempts: 2, state: 'failed' }]);
    const rows = (await f.db.session.query<{ state: string; cents: number; settled_cents: number }>('SELECT state,cents,settled_cents FROM provider_reservations WHERE subject_id=$1 ORDER BY attempt', [seeded.requestId])).rows;
    expect(rows).toHaveLength(3); expect(rows[1]).toMatchObject({ state: 'estimated', settled_cents: rows[1]?.cents });
  });
  it('caps reservation churn even when nothing was sent', async () => {
    const { beginMeetingAnalysisRequest, dispatchMeetingAnalysisRequest } = await import('../../meetings/analysisPaid.ts');
    const seeded = await seed(), d = deps();
    for (let i = 0; i < 6; i++) {
      await configure();
      const reserved = await withTransaction(f.db.session, () => beginMeetingAnalysisRequest(f.context, { requestId: seeded.requestId, at }, d));
      if (reserved.kind !== 'reserved') throw new Error(reserved.kind);
      await configure({ enabled: false });
      await withTransaction(f.db.session, () => dispatchMeetingAnalysisRequest(f.context, { requestId: seeded.requestId, reservationId: reserved.reservationId, at }, d));
    }
    await configure();
    expect(await withTransaction(f.db.session, () => beginMeetingAnalysisRequest(f.context, { requestId: seeded.requestId, at }, d))).toEqual({ kind: 'done' });
    expect((await f.db.session.query('SELECT paid_attempts,reservation_count,state FROM meeting_analysis_requests WHERE id=$1', [seeded.requestId])).rows).toEqual([{ paid_attempts: 0, reservation_count: 6, state: 'failed' }]);
  });

  it('releases a reservation if the switch changes before the next worker chunk', async () => {
    const { beginMeetingAnalysisRequest } = await import('../../meetings/analysisPaid.ts');
    await configure(); const seeded = await seed(), d = deps();
    const reserved = await withTransaction(f.db.session, () => beginMeetingAnalysisRequest(f.context, { requestId: seeded.requestId, at }, d));
    if (reserved.kind !== 'reserved') throw new Error(reserved.kind);
    await configure({ enabled: false });
    expect(await withTransaction(f.db.session, () => beginMeetingAnalysisRequest(f.context, { requestId: seeded.requestId, at }, d))).toMatchObject({ kind: 'held' });
    expect((await f.db.session.query('SELECT state FROM provider_reservations WHERE id=$1', [reserved.reservationId])).rows).toEqual([{ state: 'released' }]);
  });

});
