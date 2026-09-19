import type { DiagnosticsView } from '../../../../../src/shared/contracts/v1Contract';
import type { DynamoStore } from '../dynamoStore';
import { JOB_MAX_ATTEMPTS, readJobs } from '../queue/jobs';
import { readSchedulerState } from '../scheduler';

/**
 * The queue as Diagnostics shows it (FSS target design section 3; slice S3). The API role holds no queue
 * permission by design, so this counts `JOB#` records rather than asking SQS: jobs waiting or running, jobs that
 * failed their last attempt, and jobs that exhausted their three attempts and are therefore on the dead-letter
 * queue. That last number is what the worker knows; the DLQ-depth alarm is what AWS knows, and they are allowed
 * to disagree for as long as it takes a message to arrive. Reading this decides nothing and enqueues nothing.
 */
export async function readQueueSummary(store: DynamoStore): Promise<NonNullable<DiagnosticsView['queue']>> {
  const [jobs, scheduler] = await Promise.all([readJobs(store), readSchedulerState(store)]);
  let queued = 0, running = 0, failed = 0, deadLettered = 0;
  for (const job of jobs.values()) {
    if (job.state === 'queued') queued++;
    else if (job.state === 'running') running++;
    else if (job.state === 'failed') { failed++; if (job.attempt >= JOB_MAX_ATTEMPTS) deadLettered++; }
  }
  const state = scheduler?.state ?? null;
  return { queued, running, failed, deadLettered,
    lastSchedulerRun: state === null ? null : { at: state.lastRunAt, tickSeq: state.tickSeq,
      enqueued: Object.values(state.enqueued).reduce((total, value) => total + value, 0), durationMs: state.durationMs } };
}
