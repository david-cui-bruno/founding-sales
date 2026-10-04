import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext } from '../../db/workspaceScope.ts';
import { lockSendGateForStopFact } from '../../policy/sendGate.ts';
import { lockTodayForFirmChange } from '../../today/build.ts';
import { loadFirmForUpdate } from '../../crm/firms.ts';
import { foldMeetings, type MeetingRow } from '../../meetings/calcom.ts';
import { readMeetingOutcomes } from '../../meetings/outcomes.ts';
import { materializeMeetingAnalysis } from '../../meetings/analysisRequests.ts';
import { meetingAnalysisPort } from '../../meetings/analysisAdapter.ts';
import { updateSetting } from '../../settings/store.ts';
import { beginMeetingAnalysisRequest, dispatchMeetingAnalysisRequest, completeMeetingAnalysisRequest, expireMeetingAnalysisRequest } from '../../meetings/analysisPaid.ts';
import { meetingTasksFixture } from './support/meetingTasksFixture.ts';
const at = '2026-10-04T10:00:00Z';
describe('meeting outcome lifecycle', () => {
  let f: Awaited<ReturnType<typeof meetingTasksFixture>>;
  beforeEach(async () => { f = await meetingTasksFixture(); });
  afterEach(async () => { await f.db.drop(); });
  const deps = { accountId: '123456789012', port: meetingAnalysisPort({ transport: { kind: 'bedrock', countTokens: async () => 100, create: async () => ({}) } }) };
  async function paid() {
    const meetingId = await f.meeting(); await f.save(meetingId, 'Private meeting notes.');
    await withTransaction(f.db.session, () => updateSetting(f.context, { settingKey: 'meeting_analysis', value: { enabled: true, dailyCeilingCents: 100,
      creditCoverage: { accountId: deps.accountId, service: 'bedrock', evidenceRef: 'fixture', status: 'verified', verifiedAt: '2026-01-01T00:00:00Z', validUntil: '2030-01-01T00:00:00Z' } } }));
    const made = await withTransaction(f.db.session, () => materializeMeetingAnalysis(f.context, { meetingId, at }));
    if (!made.ok) throw new Error(made.reason);
    const requestId = made.value.requestIds[0]!;
    const begun = await withTransaction(f.db.session, () => beginMeetingAnalysisRequest(f.context, { requestId, at }, deps));
    if (begun.kind !== 'reserved') throw new Error(begun.kind);
    await withTransaction(f.db.session, () => dispatchMeetingAnalysisRequest(f.context, { requestId, reservationId: begun.reservationId, at }, deps));
    return { meetingId, requestId, attemptId: begun.reservationId };
  }
  it('keeps task IDs, human notes and paid attempt identities when bookings fold during a request', async () => {
    const { reconcileMeetingTasks } = await import('../../meetings/tasks.ts');
    const p = await f.promise('I will send the guide tomorrow.');
    await withTransaction(f.db.session, () => reconcileMeetingTasks(f.context, p));
    const taskId = (await f.tasks(p.meetingId))[0]!['id'];
    const q = await paid();
    const session = await f.db.appRuntimeSession(), context = repositoryContext(f.context.scope, session);
    await withTransaction(session, async () => {
      await lockSendGateForStopFact(context); await lockTodayForFirmChange(context); await loadFirmForUpdate(context, f.firmId);
      const rows = (await session.query<MeetingRow>('SELECT * FROM meetings WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[p.meetingId, q.meetingId]])).rows;
      await foldMeetings(context, rows, p.meetingId);
    });
    expect(await f.tasks(p.meetingId)).toMatchObject([{ id: taskId }]);
    expect((await f.db.session.query('SELECT id,meeting_id,original_meeting_id,paid_attempts FROM meeting_analysis_requests WHERE id=$1', [q.requestId])).rows).toEqual([{ id: q.requestId, meeting_id: p.meetingId, original_meeting_id: q.meetingId, paid_attempts: 1 }]);
    expect((await readMeetingOutcomes(f.context, { meetingId: p.meetingId }))?.notes.debrief).toContain('Private meeting notes.');
    expect(await withTransaction(f.db.session, () => completeMeetingAnalysisRequest(f.context, { ...q, at, result: { outcome: 'accepted', content: { overview: 'Private result', items: [], reviewReasons: [] }, usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 } } }))).toBe('stale');
    expect((await f.db.session.query('SELECT state,settled_cents FROM provider_reservations WHERE id=$1', [q.attemptId])).rows).toEqual([{ state: 'settled', settled_cents: 1 }]);
    expect((await readMeetingOutcomes(f.context, { meetingId: p.meetingId }))?.holds).toContain('merged_notes_review');
  });
  it('keeps a corrected debrief promise linked to its original task after a booking fold and reanalysis', async () => {
    const { meetingNoteItemSchema } = await import('@fss/contracts');
    const { sampleAnswer } = await import('./fixtures/outcomes/sample.ts');
    const { saveMeetingOutcomeCorrections } = await import('../../meetings/outcomeCorrections.ts');
    const { reconcileMeetingTasks } = await import('../../meetings/tasks.ts');
    const source = await f.meeting(), target = await f.meeting(), quote = 'I will send the guide tomorrow.';
    await f.save(source, quote); await f.save(target, 'Earlier context.');
    const item = meetingNoteItemSchema.parse({ ...sampleAnswer().items[0]!, evidence: [{ kind: 'debrief', revision: 1, quote, startOffset: 0, endOffset: quote.length }] });
    const initial = await f.publish(source, [item]);
    await withTransaction(f.db.session, () => saveMeetingOutcomeCorrections(f.context, { meetingId: source, expectedRevision: 1, debrief: quote, sufficient: true, speakerMappings: [],
      itemOverrides: [{ itemId: initial.items[0]!.id, decision: 'confirmed', text: 'Send corrected pricing', owner: 'you', deadline: { precision: 'date', localDate: '2026-10-20', zone: 'America/New_York' } }] }));
    const corrected = await f.publish(source, [{ ...item, evidence: [{ kind: 'debrief', revision: 2, quote, startOffset: 0, endOffset: quote.length }] }]);
    await withTransaction(f.db.session, () => reconcileMeetingTasks(f.context, corrected));
    const taskId = (await f.tasks(source))[0]!['id'];
    await withTransaction(f.db.session, async () => {
      await lockSendGateForStopFact(f.context); await lockTodayForFirmChange(f.context); await loadFirmForUpdate(f.context, f.firmId);
      const rows = (await f.db.session.query<MeetingRow>('SELECT * FROM meetings WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[source, target]])).rows;
      await foldMeetings(f.context, rows, target);
    });
    const merged = (await readMeetingOutcomes(f.context, { meetingId: target }))!.notes;
    expect((await withTransaction(f.db.session, () => saveMeetingOutcomeCorrections(f.context, { meetingId: target, expectedRevision: merged.revision,
      debrief: merged.debrief, speakerMappings: merged.speakerMappings, itemOverrides: merged.itemOverrides, sufficient: true }))).ok).toBe(true);
    const startOffset = merged.debrief.indexOf(quote);
    const next = await f.publish(target, [{ ...item, evidence: [{ kind: 'debrief', revision: merged.revision + 1, quote, startOffset, endOffset: startOffset + quote.length }] }]);
    expect(next.items[0]).toMatchObject({ text: 'Send corrected pricing', deadline: { localDate: '2026-10-20' } });
    await withTransaction(f.db.session, () => reconcileMeetingTasks(f.context, next));
    expect(await f.tasks(target)).toMatchObject([{ id: taskId, label: 'Send corrected pricing', status: 'open' }]);
    expect(await f.tasks(target)).toHaveLength(1);
  });
  it('scrubs content on deletion and accepts late actual usage after timeout without resurrecting notes', async () => {
    const q = await paid();
    await withTransaction(f.db.session, () => expireMeetingAnalysisRequest(f.context, q.requestId, '2026-10-04T13:00:00Z'));
    const other = await f.db.appRuntimeSession();
    await withTransaction(other, async () => { await other.query('DELETE FROM meetings WHERE id=$1', [q.meetingId]); });
    expect(await withTransaction(f.db.session, () => completeMeetingAnalysisRequest(f.context, { ...q, at: '2026-10-04T13:01:00Z', result: { outcome: 'accepted', content: { overview: 'Deleted speech', items: [], reviewReasons: [] }, usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 } } }))).toBe('stale');
    expect((await f.db.session.query('SELECT meeting_id,result FROM meeting_analysis_requests WHERE id=$1', [q.requestId])).rows).toEqual([{ meeting_id: null, result: null }]);
    expect((await f.db.session.query('SELECT state,settled_cents FROM provider_reservations WHERE id=$1', [q.attemptId])).rows).toEqual([{ state: 'settled', settled_cents: 1 }]);
    expect((await f.db.session.query('SELECT id FROM meeting_analyses')).rows).toHaveLength(0);
  });
  it('invalidates analysis dates after a reschedule or workspace time-zone change', async () => {
    const p = await f.promise('I will send the guide tomorrow.');
    expect((await readMeetingOutcomes(f.context, { meetingId: p.meetingId }))?.state).toBe('current');
    await f.db.session.query("UPDATE meetings SET starts_at=starts_at+interval '1 day',ends_at=ends_at+interval '1 day' WHERE id=$1", [p.meetingId]);
    expect((await readMeetingOutcomes(f.context, { meetingId: p.meetingId }))?.state).toBe('stale');
    const changed = await f.publish(p.meetingId, [p.item]);
    await f.db.session.query("UPDATE workspaces SET business_time_zone='America/Los_Angeles' WHERE id=$1", [f.workspace]);
    expect((await readMeetingOutcomes(f.context, { meetingId: p.meetingId }))?.sourceHash).not.toBe(changed.expectedSourceHash);
  });
  it('rejects a task that points at another meeting analysis', async () => {
    const { reconcileMeetingTasks } = await import('../../meetings/tasks.ts');
    const p = await f.promise('I will send the guide tomorrow.');
    await withTransaction(f.db.session, () => reconcileMeetingTasks(f.context, p));
    const other = await f.promise('I will send the guide tomorrow.');
    await expect(f.db.session.query('UPDATE meeting_tasks SET analysis_id=$2 WHERE meeting_id=$1', [p.meetingId, other.analysisId])).rejects.toMatchObject({ code: '23503' });
  });
  it('revalidates a restored reservation against a setting change committed on another session', async () => {
    const q = await paid();
    await f.db.session.query("UPDATE meeting_analysis_requests SET state='reserved',paid_attempts=0 WHERE id=$1", [q.requestId]);
    await f.db.session.query("UPDATE provider_reservations SET state='reserved' WHERE id=$1", [q.attemptId]);
    const other = await f.db.appRuntimeSession(), context = repositoryContext(f.context.scope, other);
    await other.query('BEGIN');
    await updateSetting(context, { settingKey: 'meeting_analysis', value: { enabled: false, dailyCeilingCents: 0, creditCoverage: null } });
    const dispatched = withTransaction(f.db.session, () => dispatchMeetingAnalysisRequest(f.context, { requestId: q.requestId, reservationId: q.attemptId, at }, deps));
    await other.query('COMMIT');
    expect(await dispatched).toMatchObject({ kind: 'held', reason: 'disabled' });
    expect((await f.db.session.query('SELECT state FROM provider_reservations WHERE id=$1', [q.attemptId])).rows).toEqual([{ state: 'released' }]);
  });

  it('preserves a task created while the booking fold waits on its transaction', async () => {
    const { reconcileMeetingTasks } = await import('../../meetings/tasks.ts');
    const p = await f.promise('I will send the guide tomorrow.'), target = await f.meeting();
    const session = await f.db.appRuntimeSession(), context = repositoryContext(f.context.scope, session);
    await f.db.session.query('BEGIN');
    await reconcileMeetingTasks(f.context, p);
    const taskId = (await f.tasks(p.meetingId))[0]!['id'];
    const folded = withTransaction(session, async () => {
      await lockSendGateForStopFact(context); await lockTodayForFirmChange(context); await loadFirmForUpdate(context, f.firmId);
      const rows = (await session.query<MeetingRow>('SELECT * FROM meetings WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[p.meetingId, target]])).rows;
      await foldMeetings(context, rows, target);
    });
    await f.db.session.query('COMMIT');
    await folded;
    expect(await f.tasks(target)).toMatchObject([{ id: taskId, status: 'open' }]);
    expect(await f.tasks(p.meetingId)).toHaveLength(0);
  });

});
