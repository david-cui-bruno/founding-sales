import { randomUUID } from 'node:crypto';
import { repositoryContext } from '@fss/domain/db/workspaceScope.ts';
import type { JobHandler, JobChunk } from '@fss/domain/jobs/handlerRegistry.ts';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
async function meetingClock(session: SessionQueryable): Promise<string> {
  return (await session.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]!.at.toISOString();
}
import { beginMeetingTranscription, completeMeetingTranscription, dispatchMeetingTranscription, holdMeetingSource, meetingSource, readMeetingAttempt, submitMeetingTranscription, type MeetingAttempt } from '@fss/domain/meetings/transcription.ts';
import { meetingFunding } from '@fss/domain/meetings/transcriptionBudget.ts';
import { resolveMeetingRecording } from '@fss/domain/meetings/recordingIdentity.ts';
import { scheduleMeetingTranscriptions } from '@fss/domain/meetings/transcriptionJobs.ts';
import type { MeetingMediaPreparer, MeetingTranscriptionProvider } from '@fss/domain/meetings/transcriptionTypes.ts';
import type { DueWorkSource } from '../scheduler/schedulerPass.ts';
import { MeetingMediaError } from '../transcription/prepareMeetingAudio.ts';
export interface MeetingTranscribeOptions {
  preparer: MeetingMediaPreparer; provider: MeetingTranscriptionProvider; accountId: string; jobPrefix: string;
  signal?: AbortSignal | undefined;
}
/**
 * Short committed chunks: prepare marker → bounded media/reservation → paid marker → submission.
 * A resumed claim without its own paid-marker cursor only collects the persisted job.
 * Media runs with no subject/budget locks. Its maximum 240 seconds fits the 300-second
 * handler lease and the existing 300-second idle-in-transaction timeout; no global limits change.
 */
export function meetingTranscribeJobHandler(options: MeetingTranscribeOptions): JobHandler {
  return { kind: 'meeting.transcribe', protection: 'business_uniqueness', maxAttempts: 3, leaseSeconds: 300, chunked: true,
    async handle(input): Promise<JobChunk> {
      const context = repositoryContext(input.scope, input.session), at = await meetingClock(input.session);
      const progress = input.job.payload['progress'] as Record<string, unknown> | undefined;
      const fencing = String(input.job.fencingToken);
      const done = (): JobChunk => ({ done: true, progress: { step: 'done' } });
      const attemptId = typeof input.job.payload['attemptId'] === 'string' ? input.job.payload['attemptId'] : typeof progress?.['attemptId'] === 'string' ? progress['attemptId'] : null;
      let attempt = attemptId === null ? null : await readMeetingAttempt(context, attemptId);
      const rawRecording = input.job.payload['recordingId'];
      const recordingId = typeof rawRecording === 'string' ? rawRecording : null;
      const identity = recordingId === null ? null : await resolveMeetingRecording(context, recordingId);
      if (attempt === null && identity !== null) attempt = (await input.session.query<MeetingAttempt>(`SELECT * FROM meeting_transcription_attempts
        WHERE workspace_id=$1 AND recording_id=$2 AND state IN ('reserved','submitting','started') ORDER BY created_at,id LIMIT 1`, [input.scope.workspaceId, identity.recordingId])).rows[0] ?? null;
      if (attempt !== null) {
        if (attempt.state === 'submitting' && progress?.['step'] === 'dispatch' && progress['fencing'] === fencing && progress['attemptId'] === attempt.id) {
          await submitMeetingTranscription(context, { attemptId: attempt.id, at, accountId: options.accountId, provider: options.provider }); return done();
        }
        if (attempt.state === 'reserved') {
          const dispatch = await dispatchMeetingTranscription(context, { attemptId: attempt.id, at, accountId: options.accountId });
          return dispatch.kind === 'dispatch' ? { done: false, progress: { attemptId: attempt.id, step: 'dispatch', fencing } } : done();
        }
        if (attempt.state === 'submitting' || attempt.state === 'started') {
          const result = await options.provider.collect({ jobName: attempt.job_name, outputKey: attempt.output_key });
          await completeMeetingTranscription(context, { attemptId: attempt.id, result, at: await meetingClock(input.session) });
        }
        return done();
      }
      if (identity === null || attemptId !== null) return done();
      const funding = await meetingFunding(context, at, options.accountId);
      const source = await meetingSource(context, identity.recordingId);
      if (source === null || source.firm_id === null || source.meeting_state === 'cancelled' || funding.reason !== null) {
        await holdMeetingSource(context, identity.recordingId, funding.reason ?? 'not_eligible', at, funding.version); return done();
      }
      if ((await input.session.query('SELECT id FROM meeting_transcripts WHERE workspace_id=$1 AND recording_id=$2 LIMIT 1', [input.scope.workspaceId, source.id])).rows.length > 0) return done();
      if (progress?.['step'] !== 'prepare') {
        await input.session.query("UPDATE meeting_recordings SET processing_status='preparing',processing_reason=NULL,processing_settings_version=$3 WHERE workspace_id=$1 AND id=$2", [input.scope.workspaceId, source.id, funding.version]);
        return { done: false, progress: { step: 'prepare', preparedKey: `meetings-processing/${source.id}/${randomUUID()}.flac` } };
      }
      const signal = options.signal ?? new AbortController().signal;
      try {
        const preparedKey = progress['preparedKey']; if (typeof preparedKey !== 'string') throw new Error('invalid_meeting_progress');
        const prepared = await options.preparer.prepare({ sourceKey: source.s3_key, expectedSha256: source.sha256, expectedSizeBytes: Number(source.size_bytes), preparedKey }, signal);
        signal.throwIfAborted();
        const begun = await beginMeetingTranscription(context, { recordingId: source.id, prepared, at: await meetingClock(input.session), accountId: options.accountId, jobPrefix: options.jobPrefix });
        return begun.kind === 'reserved' ? { done: false, progress: { step: 'reserved', attemptId: begun.attemptId } } : done();
      } catch (error) {
        if (signal.aborted) throw new Error('meeting_media_aborted');
        if (!(error instanceof MeetingMediaError)) throw new Error('meeting_preparation_failed');
        await holdMeetingSource(context, source.id, error.code, await meetingClock(input.session), funding.version); return done();
      }
    },
  };
}
export function meetingTranscriptionsSource(enabled: boolean): DueWorkSource {
  return { name: 'meeting-transcription', find: async (session, at) => enabled ? scheduleMeetingTranscriptions(session, at) : [] };
}
