import type { SessionQueryable } from '../db/queryable.ts';
import { repositoryContext, workspaceScope } from '../db/workspaceScope.ts';
import type { JobSpecification } from '../jobs/jobStore.ts';
import { jobIdempotencyKey } from '../jobs/jobKinds.ts';
import { completeMeetingTranscription } from './transcription.ts';
/** One stable, persisted ordering across passes; overdue accounting precedes new work. */
export async function scheduleMeetingTranscriptions(session: SessionQueryable, at: string): Promise<readonly JobSpecification[]> {
  const candidates = (await session.query<{ workspace_id: string; id: string; recording_id: string | null; type: 'attempt' | 'source'; due: Date; deadline_at: Date | null }>(`
    SELECT * FROM (
      SELECT a.workspace_id,a.id,a.recording_id,'attempt'::text AS type,LEAST(a.next_check_at,a.deadline_at) AS due,a.deadline_at
      FROM meeting_transcription_attempts a WHERE a.state IN ('reserved','submitting','started') AND LEAST(a.next_check_at,a.deadline_at)<=$1
      UNION ALL
      SELECT r.workspace_id,r.id,r.id AS recording_id,'source'::text AS type,r.next_wake_at AS due,NULL::timestamptz AS deadline_at
      FROM meeting_recordings r JOIN workspace_settings s ON s.workspace_id=r.workspace_id AND s.setting_key='meeting_transcription' AND s.superseded_at IS NULL
      WHERE r.processing_status IN ('queued','preparing','disabled','budget_held','funding_unverified')
        AND (r.next_wake_at<=$1 OR s.version>r.processing_settings_version)
        AND s.value->'enabled'='true'::jsonb AND s.value->'dailyCeilingCents'>'0'::jsonb
        AND NOT EXISTS (SELECT 1 FROM meeting_transcription_attempts a WHERE a.workspace_id=r.workspace_id AND a.recording_id=r.id AND a.state IN ('reserved','submitting','started'))
        AND NOT EXISTS (SELECT 1 FROM meeting_transcripts t WHERE t.workspace_id=r.workspace_id AND t.recording_id=r.id)
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.workspace_id=r.workspace_id AND j.kind='meeting.transcribe' AND j.payload->>'recordingId'=r.id::text AND j.state IN ('queued','running','retryable'))
    ) candidates ORDER BY due,workspace_id,id LIMIT 50`, [at])).rows;
  const jobs: JobSpecification[] = [];
  for (const row of candidates) {
    if (row.type === 'attempt') {
      if (row.deadline_at !== null && row.deadline_at.getTime() <= Date.parse(at)) {
        const context = repositoryContext(workspaceScope(row.workspace_id, { kind: 'system', component: 'scheduler' }), session);
        await completeMeetingTranscription(context, { attemptId: row.id, at, result: { kind: 'pending' } });
        continue;
      }
      const look = (await session.query<{ looks: number }>(`UPDATE meeting_transcription_attempts SET looks=looks+1,next_check_at=$3::timestamptz+interval '5 minutes'
        WHERE workspace_id=$1 AND id=$2 AND state IN ('reserved','submitting','started') RETURNING looks`, [row.workspace_id, row.id, at])).rows[0];
      if (look !== undefined) jobs.push({ workspaceId: row.workspace_id, kind: 'meeting.transcribe', idempotencyKey: jobIdempotencyKey.meetingCollect(row.id, look.looks), payload: { attemptId: row.id }, maxAttempts: 3 });
    } else {
      const source = (await session.query<{ wake_revision: number }>(`UPDATE meeting_recordings SET wake_revision=wake_revision+1,next_wake_at=$3::timestamptz+interval '5 minutes'
        WHERE workspace_id=$1 AND id=$2 RETURNING wake_revision`, [row.workspace_id, row.id, at])).rows[0];
      if (source !== undefined) jobs.push({ workspaceId: row.workspace_id, kind: 'meeting.transcribe', idempotencyKey: jobIdempotencyKey.meetingTranscribe(row.id, source.wake_revision), payload: { recordingId: row.id }, maxAttempts: 3 });
    }
  }
  return jobs;
}
