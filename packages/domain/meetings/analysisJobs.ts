import type { SessionQueryable } from '../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../db/workspaceScope.ts';
import { enqueueJob, type JobSpecification } from '../jobs/jobStore.ts';
import { jobIdempotencyKey } from '../jobs/jobKinds.ts';
import { expireMeetingAnalysisRequest } from './analysisPaid.ts';
export { materializeMeetingAnalysis } from './analysisRequests.ts';
export async function enqueueMeetingAnalysis(context: RepositoryContext, meetingId: string): Promise<void> {
  const row = (await context.db.query<{ notes_revision: number; transcript_source_revision: number }>('SELECT notes_revision,transcript_source_revision FROM meetings WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, meetingId])).rows[0];
  if (row === undefined) return;
  await enqueueJob(context.db, { workspaceId: context.scope.workspaceId, kind: 'meeting.analyze',
    idempotencyKey: jobIdempotencyKey.meetingAnalyze(meetingId, row.notes_revision, row.transcript_source_revision), payload: { meetingId }, maxAttempts: 3 });
}
export async function scheduleMeetingAnalyses(session: SessionQueryable, at: string): Promise<readonly JobSpecification[]> {
  const expired = (await session.query<{ workspace_id: string; id: string }>(`SELECT workspace_id,id FROM meeting_analysis_requests
    WHERE state IN ('queued','held','reserved','calling') AND deadline_at<=$1 ORDER BY deadline_at,id LIMIT 50`, [at])).rows;
  for (const row of expired) await expireMeetingAnalysisRequest(repositoryContext(workspaceScope(row.workspace_id, { kind: 'system', component: 'scheduler' }), session), row.id, at);
  const jobs: JobSpecification[] = [];
  const pendingTasks = (await session.query<{ workspace_id: string; id: string; meeting_id: string; source_hash: string }>(
    "SELECT workspace_id,id,meeting_id,source_hash FROM meeting_analyses WHERE state='ready' AND tasks_pending ORDER BY completed_at,id LIMIT 25")).rows;
  for (const row of pendingTasks) jobs.push({ workspaceId: row.workspace_id, kind: 'meeting.analyze', idempotencyKey: `meeting-tasks:${row.id}`,
    payload: { meetingId: row.meeting_id, analysisId: row.id, sourceHash: row.source_hash }, maxAttempts: 3 });
  const missing = (await session.query<{ workspace_id: string; id: string; notes_revision: number; transcript_source_revision: number }>(`SELECT m.workspace_id,m.id,m.notes_revision,m.transcript_source_revision
    FROM meetings m WHERE m.firm_id IS NOT NULL AND (m.notes_revision>0 OR m.transcript_source_revision>0)
    AND NOT EXISTS (SELECT 1 FROM meeting_analyses a WHERE a.workspace_id=m.workspace_id AND a.meeting_id=m.id AND a.notes_revision=m.notes_revision AND a.transcript_revision=m.transcript_source_revision)
    ORDER BY m.updated_at,m.id LIMIT 25`)).rows;
  for (const row of missing) jobs.push({ workspaceId: row.workspace_id, kind: 'meeting.analyze',
    idempotencyKey: jobIdempotencyKey.meetingAnalyze(row.id, row.notes_revision, row.transcript_source_revision), payload: { meetingId: row.id }, maxAttempts: 3 });
  const due = (await session.query<{ workspace_id: string; id: string; version: number }>(`SELECT r.workspace_id,r.id,s.version FROM meeting_analysis_requests r
    JOIN workspace_settings s ON s.workspace_id=r.workspace_id AND s.setting_key='meeting_analysis' AND s.superseded_at IS NULL
    WHERE r.meeting_id IS NOT NULL AND r.state IN ('queued','reserved','held') AND (r.next_wake_at<=$1 OR s.version>r.settings_version)
      AND s.value->'enabled'='true'::jsonb AND s.value->'dailyCeilingCents'>'0'::jsonb
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.workspace_id=r.workspace_id AND j.kind='meeting.analyze' AND j.payload->>'requestId'=r.id::text AND j.state IN ('queued','running','retryable'))
    ORDER BY r.next_wake_at,r.id LIMIT 25`, [at])).rows;
  for (const row of due) {
    const updated = (await session.query<{ wake_revision: number }>(`UPDATE meeting_analysis_requests SET wake_revision=wake_revision+1,settings_version=$4,
      next_wake_at=$3::timestamptz+interval '5 minutes',deadline_at=COALESCE(deadline_at,$3::timestamptz+interval '120 minutes') WHERE workspace_id=$1 AND id=$2 RETURNING wake_revision`, [row.workspace_id, row.id, at, row.version])).rows[0];
    if (updated !== undefined) jobs.push({ workspaceId: row.workspace_id, kind: 'meeting.analyze', idempotencyKey: jobIdempotencyKey.meetingAnalysisRequest(row.id, updated.wake_revision), payload: { requestId: row.id }, maxAttempts: 3 });
  }
  return jobs;
}
