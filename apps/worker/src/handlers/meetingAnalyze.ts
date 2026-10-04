import { reconcileMeetingTasks } from '@fss/domain/meetings/tasks.ts';
import { repositoryContext } from '@fss/domain/db/workspaceScope.ts';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import type { JobHandler, JobChunk } from '@fss/domain/jobs/handlerRegistry.ts';
import { scheduleMeetingAnalyses } from '@fss/domain/meetings/analysisJobs.ts';
import { materializeMeetingAnalysis, readAnalysisCall, readAnalysisRequest } from '@fss/domain/meetings/analysisRequests.ts';
import { beginMeetingAnalysisRequest, dispatchMeetingAnalysisRequest, completeMeetingAnalysisRequest, abandonMeetingAnalysisDispatch, meetingAnalysisFunding, type MeetingAnalysisDeps } from '@fss/domain/meetings/analysisPaid.ts';
import { analysisHash } from '@fss/domain/meetings/analysisInput.ts';
import { buildMeetingAnalysisRequest } from '@fss/domain/meetings/analysisModel.ts';
import { meetingAnalysisPort, type MeetingAnalysisAttempt } from '@fss/domain/meetings/analysisAdapter.ts';
import type { DueWorkSource } from '../scheduler/schedulerPass.ts';
import type { ClassifyWorkerOptions } from './classify.ts';
export type MeetingAnalyzeOptions = MeetingAnalysisDeps;
async function clock(session: SessionQueryable): Promise<string> { return (await session.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]!.at.toISOString(); }
export function meetingAnalyzeJobHandler(options: MeetingAnalyzeOptions): JobHandler {
  return { kind: 'meeting.analyze', protection: 'business_uniqueness', maxAttempts: 3, leaseSeconds: 120, chunked: true,
    async handle(input): Promise<JobChunk> {
      const context = repositoryContext(input.scope, input.session), at = await clock(input.session);
      const done = (): JobChunk => ({ done: true, progress: { step: 'done' } });
      const requestId = input.job.payload['requestId'], meetingId = input.job.payload['meetingId'];
      const analysisId = input.job.payload['analysisId'], sourceHash = input.job.payload['sourceHash'];
      if (typeof analysisId === 'string' && typeof meetingId === 'string' && typeof sourceHash === 'string') {
        const reconciled = await reconcileMeetingTasks(context, { meetingId, analysisId, expectedSourceHash: sourceHash });
        if (!reconciled.ok) await context.db.query("UPDATE meeting_analyses SET tasks_pending=false,review_reasons=review_reasons || $3::jsonb WHERE workspace_id=$1 AND id=$2", [input.scope.workspaceId, analysisId, JSON.stringify([reconciled.reason])]);
        return done();
      }
      if (typeof requestId !== 'string') {
        if (typeof meetingId === 'string') await materializeMeetingAnalysis(context, { meetingId, at });
        return done();
      }
      const row = await readAnalysisRequest(context, requestId);
      if (row === null) return done();
      const progress = input.job.payload['progress'] as Record<string, unknown> | undefined;
      if (row.state === 'calling') {
        // A restarted/reclaimed job must never repeat an ambiguous submission.
        if (progress?.['step'] !== 'dispatch' || progress['fencing'] !== String(input.job.fencingToken) || progress['reservationId'] !== row.reservation_id || row.reservation_id === null) return done();
        const funding = await meetingAnalysisFunding(context, at, options), call = await readAnalysisCall(context, row);
        const request = call.ok ? buildMeetingAnalysisRequest(call.value) : null;
        if (funding.reason !== null || request === null || analysisHash(request) !== row.prepared_hash || !call.ok) {
          await abandonMeetingAnalysisDispatch(context, { requestId, reservationId: row.reservation_id, at, reason: funding.reason ?? 'source_changed' }); return done();
        }
        // No send gate, Today, firm or meeting lock is held over the provider request.
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<MeetingAnalysisAttempt>(resolve => { timeout = setTimeout(() => resolve({ outcome: 'provider_error', content: null, usage: null }), 60_000); timeout.unref(); });
        let result: MeetingAnalysisAttempt;
        try { result = await Promise.race([options.port.run(call.value, { request, inputTokens: 0 }), expired]); }
        finally { if (timeout !== undefined) clearTimeout(timeout); }
        await completeMeetingAnalysisRequest(context, { requestId, attemptId: row.reservation_id, at: await clock(input.session), result });
        return done();
      }
      const begun = await beginMeetingAnalysisRequest(context, { requestId, at }, options);
      if (begun.kind !== 'reserved') return done();
      // reserve and mark-calling must be different commits, each with a durable cursor.
      if (progress?.['step'] !== 'reserved' || progress['reservationId'] !== begun.reservationId) return { done: false, progress: { step: 'reserved', reservationId: begun.reservationId } };
      const dispatched = await dispatchMeetingAnalysisRequest(context, { requestId, reservationId: begun.reservationId, at }, options);
      return dispatched.kind === 'dispatch' ? { done: false, progress: { step: 'dispatch', reservationId: begun.reservationId, fencing: String(input.job.fencingToken) } } : done();
    },
  };
}
export function meetingAnalysesSource(enabled: boolean): DueWorkSource { return { name: 'meeting-analysis', find: async (session, at) => enabled ? scheduleMeetingAnalyses(session, at) : [] }; }
export function readMeetingAnalysisComposition(classifier: ClassifyWorkerOptions | undefined, environment: Readonly<Record<string, string | undefined>>): { options: MeetingAnalyzeOptions | null; problem: string | null } {
  const accountId = environment['FSS_AWS_ACCOUNT_ID'] ?? '';
  if (!/^\d{12}$/u.test(accountId)) return { options: null, problem: 'FSS_AWS_ACCOUNT_ID' };
  if (classifier === undefined) return { options: null, problem: 'meeting_analysis:transport_absent' };
  const port = meetingAnalysisPort({ transport: classifier.transport });
  return port.kind === 'bedrock' ? { options: { accountId, port }, problem: null } : { options: null, problem: 'meeting_analysis:bedrock_required' };
}
