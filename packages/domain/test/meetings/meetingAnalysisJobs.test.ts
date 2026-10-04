import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { meetingOutcomesFixture } from './support/meetingOutcomesFixture.ts';
import { withTransaction } from '../../db/queryable.ts';
import { updateSetting } from '../../settings/store.ts';
const at = '2026-10-04T12:00:00Z';
describe('durable meeting analysis jobs', () => {
  let f: Awaited<ReturnType<typeof meetingOutcomesFixture>>;
  beforeAll(async () => { f = await meetingOutcomesFixture(); });
  afterAll(async () => { await f.db.drop(); });
  it('reuses unchanged transcript requests after a debrief edit and creates no paid work while disabled', async () => {
    const { materializeMeetingAnalysis, scheduleMeetingAnalyses } = await import('../../meetings/analysisJobs.ts');
    const meetingId = await f.meeting(); await f.speech(meetingId, 'We handle maintenance.');
    const first = await withTransaction(f.db.session, () => materializeMeetingAnalysis(f.context, { meetingId, at }));
    expect(first.ok).toBe(true); if (!first.ok) return;
    await f.save(meetingId, 'Additional context.');
    const second = await withTransaction(f.db.session, () => materializeMeetingAnalysis(f.context, { meetingId, at }));
    expect(second.ok).toBe(true); if (!second.ok) return;
    expect(second.value.requestIds[0]).toBe(first.value.requestIds[0]);
    expect(second.value.requestIds).toHaveLength(2);
    expect((await scheduleMeetingAnalyses(f.db.session, at)).filter(j => j.payload?.['requestId'] !== undefined)).toHaveLength(0);
  });
  it('expires poison work from the scheduler even when its handler never runs', async () => {
    const { materializeMeetingAnalysis, scheduleMeetingAnalyses } = await import('../../meetings/analysisJobs.ts');
    const meetingId = await f.meeting(); await f.save(meetingId, 'A new debrief.');
    await withTransaction(f.db.session, () => updateSetting(f.context, { settingKey: 'meeting_analysis', value: { enabled: true, dailyCeilingCents: 100, creditCoverage: null } }));
    const result = await withTransaction(f.db.session, () => materializeMeetingAnalysis(f.context, { meetingId, at }));
    if (!result.ok) throw new Error(result.reason);
    const id = result.value.requestIds[0]!;
    await f.db.session.query("UPDATE meeting_analysis_requests SET deadline_at='2026-10-04T10:00:00Z',next_wake_at='2026-10-04T10:00:00Z' WHERE id=$1", [id]);
    await scheduleMeetingAnalyses(f.db.session, at);
    expect((await f.db.session.query('SELECT state,reason FROM meeting_analysis_requests WHERE id=$1', [id])).rows).toEqual([{ state: 'failed', reason: 'deadline_exceeded' }]);
  });
});
