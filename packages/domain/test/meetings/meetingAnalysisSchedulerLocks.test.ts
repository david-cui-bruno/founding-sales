import { expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { meetingTasksFixture } from './support/meetingTasksFixture.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext } from '../../db/workspaceScope.ts';
import { materializeMeetingAnalysis, scheduleMeetingAnalyses } from '../../meetings/analysisJobs.ts';
import { scheduleMeetingTranscriptions } from '../../meetings/transcriptionJobs.ts';
import { beginMeetingTranscription, meetingSource } from '../../meetings/transcription.ts';
import { lockMeetingBudget } from '../../meetings/transcriptionBudget.ts';
import { updateSetting } from '../../settings/store.ts';

it('expires analysis and transcription in one scheduler pass without reversing a worker budget/firm lock', async () => {
  const f = await meetingTasksFixture();
  try {
    const meetingId = await f.meeting(); await f.save(meetingId, 'I will send the guide tomorrow.');
    const recordingId = await f.recording(meetingId);
    const made = await withTransaction(f.db.session, () => materializeMeetingAnalysis(f.context, { meetingId, at: '2026-10-03T12:00:00Z' }));
    if (!made.ok) throw new Error(made.reason);
    await f.db.session.query("UPDATE meeting_analysis_requests SET deadline_at='2026-10-03T13:00:00Z' WHERE id=$1", [made.value.requestIds[0]]);
    await withTransaction(f.db.session, () => updateSetting(f.context, { settingKey: 'meeting_transcription', value: { enabled: true, dailyCeilingCents: 50,
      creditCoverage: { accountId: '123456789012', service: 'transcribe', evidenceRef: 'fixture', verifiedAt: '2026-01-01T00:00:00Z', validUntil: '2030-01-01T00:00:00Z', status: 'verified' } } }));
    expect((await withTransaction(f.db.session, () => beginMeetingTranscription(f.context, { recordingId,
      prepared: { durationMs: 1000, sizeBytes: 100, sha256: 'a'.repeat(64), mediaFormat: 'flac', inputKey: `meetings-processing/${f.workspace}/${recordingId}.flac` }, at: '2026-10-03T12:00:00Z', accountId: '123456789012', jobPrefix: 'fixture' }))).kind).toBe('reserved');
    const other = await f.db.appRuntimeSession(), observer = await f.db.appRuntimeSession(), context = repositoryContext(f.context.scope, other);
    const pid = (await f.db.session.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await other.query('BEGIN'); await lockMeetingBudget(context);
    const scheduler = withTransaction(f.db.session, async () => {
      await scheduleMeetingAnalyses(f.db.session, '2026-10-03T16:00:00Z');
      await scheduleMeetingTranscriptions(f.db.session, '2026-10-03T16:00:00Z');
    });
    // Wait for a real blocked lock, not an assumed timing window.
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      waiting = (await observer.query<{ waiting: boolean }>('SELECT cardinality(pg_blocking_pids($1)) > 0 AS waiting', [pid])).rows[0]!.waiting;
      if (!waiting) await delay(10);
    }
    const worker = meetingSource(context, recordingId, true).finally(() => other.query('COMMIT'));
    const results = await Promise.allSettled([worker, scheduler]);
    expect(waiting).toBe(true);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect((await f.db.session.query('SELECT state FROM meeting_analysis_requests WHERE id=$1', [made.value.requestIds[0]])).rows).toEqual([{ state: 'failed' }]);
  } finally { await f.db.drop(); }
});
