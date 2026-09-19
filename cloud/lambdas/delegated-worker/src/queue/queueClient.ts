import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { JOB_GROUP_OF, jobDedupId, queueMessage, SQS_ID_MAX_LENGTH, type JobKind } from './jobs';

/**
 * The one way a job reaches the FIFO queue (slice S3). The scheduler holds this; the runner never enqueues,
 * except for the follow-up an approval asks for, which goes through the same call. Sending a message is not
 * doing the work: nothing here reads a mailbox, sends mail or advances a sequence.
 *
 * The message group is the job's lane (`mail`, `research`, `day`) so one slow lane never blocks another, and
 * the deduplication id is the sha256 of the job id, which keeps every id inside SQS's 128-character limit and
 * its restricted alphabet whatever the firm id or page token behind it looked like.
 */

export type EnqueuedJob = { jobId: string; kind: JobKind };
export interface QueueClient {
  /** Puts one job on the queue. Idempotent by construction: the same job id always produces the same deduplication id. */
  enqueue(job: EnqueuedJob): Promise<void>;
}

/** The SQS-backed client. Never constructed by a test: the scenarios pass their own `QueueClient`. */
export function createSqsQueueClient(input: { sqs: Pick<SQSClient, 'send'>; queueUrl: string }): QueueClient {
  if (!/^https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\/\d{12}\/[A-Za-z0-9_-]{1,80}\.fifo$/.test(input.queueUrl)) throw new Error('queue_url_invalid');
  return { async enqueue(job: EnqueuedJob): Promise<void> {
    const dedup = jobDedupId(job.jobId);
    const group = JOB_GROUP_OF[job.kind];
    if (dedup.length > SQS_ID_MAX_LENGTH || group.length > SQS_ID_MAX_LENGTH) throw new Error('queue_id_too_long');
    await input.sqs.send(new SendMessageCommand({ QueueUrl: input.queueUrl, MessageBody: JSON.stringify(queueMessage(job.jobId, job.kind)),
      MessageGroupId: group, MessageDeduplicationId: dedup }));
  } };
}

/** Records what would have been enqueued without an SQS client configured. Honest: the caller sees `unavailable`, never success. */
export function createUnavailableQueueClient(): QueueClient {
  return { async enqueue(): Promise<void> { throw new Error('queue_unconfigured'); } };
}
