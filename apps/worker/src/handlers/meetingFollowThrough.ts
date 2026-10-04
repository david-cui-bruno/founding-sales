import { repositoryContext } from '@fss/domain/db/workspaceScope.ts';
import type { JobHandler, JobChunk } from '@fss/domain/jobs/handlerRegistry.ts';
import { runMeetingFollowThrough, finalizeMeetingFollowThrough, scheduleMeetingFollowThrough } from '@fss/domain/meetings/followThroughJobs.ts';
import type { DueWorkSource } from '../scheduler/schedulerPass.ts';
export function meetingFollowThroughJobHandler(): JobHandler {
  return { kind: 'meeting.follow_through', protection: 'business_uniqueness', maxAttempts: 3, leaseSeconds: 60, chunked: true,
    async handle(input): Promise<JobChunk> {
      const meetingId = input.job.payload['meetingId']; if (typeof meetingId !== 'string') return { done: true, progress: { step: 'done' } };
      const context = repositoryContext(input.scope, input.session), at = (await input.session.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]!.at.toISOString();
      const progress = input.job.payload['progress'] as Record<string, unknown> | undefined;
      if (progress?.['step'] === 'finalize') { await finalizeMeetingFollowThrough(context, { meetingId, at }); return { done: true, progress: { step: 'done' } }; }
      await runMeetingFollowThrough(context, { meetingId, at });
      return { done: false, progress: { step: 'finalize' } };
    },
  };
}
export function meetingFollowThroughSource(): DueWorkSource { return { name: 'meeting-follow-through', find: scheduleMeetingFollowThrough }; }
