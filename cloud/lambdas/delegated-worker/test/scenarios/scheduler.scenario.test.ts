import { describe, expect, it } from 'vitest';
import { dayBuildJobId, jobBackoffUntil, jobDedupId, jobKey, jobRecordSchema, JOB_GROUP_OF, JOB_GROUPS, JOB_KINDS, parseJobId, pollJobId,
  queueMessage, reconcileJobId, sendStepJobId, SQS_ID_MAX_LENGTH, type JobKind } from '../../src/queue/jobs';
import { runQueuedJob } from '../../src/runner';
import { runScheduler, readSchedulerState, type SchedulerDependencies } from '../../src/scheduler';
import { readSend } from '../../src/v1/send';
import { seqKey, sequenceRecordSchema } from '../../src/v1/sequenceBridge';
import { setSendingLimit } from '../../src/v1/templates';
import { enrollOnEmailStep, gmailFetch, mailboxAccess, sendWorkspace } from './sendFixtures';
import { putTerritoryPolicy, setPosture, putDay } from './firmFixtures';
import { v1Fixture } from './v1Fixture';
import type { QueueClient } from '../../src/queue/queueClient';

/**
 * The scheduler on the real store adapter (FSS target design sections 1 and 4; slice S3). It decides what is due
 * and enqueues it; the queue itself is a recording stand-in here, which is exactly the seam SQS occupies in
 * production. Nothing in this file sends, reads a mailbox or advances a sequence.
 */

const START = '2026-09-18T12:00:00.000Z';

function recordingQueue(): QueueClient & { sent: { jobId: string; kind: JobKind }[]; fail?: boolean } {
  const sent: { jobId: string; kind: JobKind }[] = [];
  const client = { sent, fail: false, async enqueue(job: { jobId: string; kind: JobKind }) {
    if (client.fail) throw new Error('fictional queue outage');
    sent.push(job);
  } };
  return client;
}

const deps = (f: ReturnType<typeof v1Fixture>, queue: QueueClient): SchedulerDependencies => ({ store: f.store, queue });

describe('scheduler: what is due, once, inside the cap', () => {
  it('enqueues the poll and the hourly reconcile every tick, with the tick sequence and the Eastern hour', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    await sendWorkspace(f, bearer);
    const queue = recordingQueue();

    const first = await runScheduler(deps(f, queue), AbortSignal.timeout(5000));
    expect(first.tickSeq).toBe(1);
    expect(queue.sent.map(job => job.jobId)).toContain(pollJobId(1));
    // 12:00 UTC is 08:00 Eastern on 18 September 2026 (daylight time).
    expect(queue.sent.map(job => job.jobId)).toContain(reconcileJobId('2026-09-18', 8));
    expect((await readSchedulerState(f.store))?.state.tickSeq).toBe(1);

    // Five minutes later: a new poll id from the tick sequence, and the same reconcile id, which is not enqueued twice.
    f.advance('2026-09-18T12:05:00.000Z');
    queue.sent.length = 0;
    const second = await runScheduler(deps(f, queue), AbortSignal.timeout(5000));
    expect(second.tickSeq).toBe(2);
    expect(queue.sent.map(job => job.jobId)).toContain(pollJobId(2));
    expect(queue.sent.map(job => job.jobId)).not.toContain(reconcileJobId('2026-09-18', 8));
    expect(second.skipped.map(entry => entry.jobId)).toContain(reconcileJobId('2026-09-18', 8));

    // The next Eastern hour gets its own reconcile.
    f.advance('2026-09-18T13:01:00.000Z');
    queue.sent.length = 0;
    await runScheduler(deps(f, queue), AbortSignal.timeout(5000));
    expect(queue.sent.map(job => job.jobId)).toContain(reconcileJobId('2026-09-18', 9));
  });

  it('enqueues the morning list once, at or after 05:00 Eastern, and never when the day record exists', async () => {
    const f = v1Fixture('2026-09-18T07:00:00.000Z'); // 03:00 Eastern
    const { bearer } = await f.pairDevice();
    await sendWorkspace(f, bearer);
    const queue = recordingQueue();
    await runScheduler(deps(f, queue), AbortSignal.timeout(5000));
    expect(queue.sent.map(job => job.jobId)).not.toContain(dayBuildJobId('2026-09-18'));

    f.advance('2026-09-18T09:05:00.000Z'); // 05:05 Eastern
    queue.sent.length = 0;
    await runScheduler(deps(f, queue), AbortSignal.timeout(5000));
    expect(queue.sent.map(job => job.jobId)).toContain(dayBuildJobId('2026-09-18'));

    // The day record now exists: nothing offers the list again.
    await putDay(f.store, { date: '2026-09-18', builtAt: '2026-09-18T09:06:00.000Z', newFirmIds: [] });
    f.advance('2026-09-18T09:10:00.000Z');
    queue.sent.length = 0;
    await runScheduler(deps(f, queue), AbortSignal.timeout(5000));
    expect(queue.sent.map(job => job.jobId)).not.toContain(dayBuildJobId('2026-09-18'));
  });

  it('enqueues only due template steps, and only up to the remaining cap', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    await setPosture(f, bearer, 'RI', 'calling');
    const policy = await putTerritoryPolicy(f.store, '2026-09-01T12:00:00.000Z');
    // David narrows the day to three sends.
    await setSendingLimit(f.store, { postalAddress: '12 Fictional Way, Suite 3, Providence, RI 02903', dailyLimit: 3, ramp: { startPerDay: 3, stepPerDay: 0, maxPerDay: 3 } });
    // Five firms are due (started seven days ago) and one is not due until next week.
    for (let n = 1; n <= 5; n++) await enrollOnEmailStep(f.store, policy, { n, startedAt: '2026-09-11T12:00:00.000Z' });
    const notDue = await enrollOnEmailStep(f.store, policy, { n: 9, startedAt: '2026-09-17T12:00:00.000Z' });

    const queue = recordingQueue();
    const report = await runScheduler(deps(f, queue), AbortSignal.timeout(5000));
    const sends = queue.sent.filter(job => job.kind === 'mail.send_step');
    expect(sends).toHaveLength(3);
    expect(report.remainingCap).toBe(3);
    expect(sends.map(job => job.jobId)).not.toContain(sendStepJobId(notDue.firmId, notDue.stepId));
    expect(report.skipped.filter(entry => entry.reason === 'cap_reached')).toHaveLength(2);
  });

  it('does not offer a job that is queued, running under a live lease, or failed inside its backoff window', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const firm = await sendWorkspace(f, bearer);
    const jobId = sendStepJobId(firm.firmId, firm.stepId);
    const queue = recordingQueue();

    const first = await runScheduler(deps(f, queue), AbortSignal.timeout(5000));
    expect(first.enqueued.map(job => job.jobId)).toContain(jobId);
    // The record the scheduler wrote says `queued`: the next tick leaves it alone.
    f.advance('2026-09-18T12:05:00.000Z');
    queue.sent.length = 0;
    const second = await runScheduler(deps(f, queue), AbortSignal.timeout(5000));
    expect(second.enqueued.map(job => job.jobId)).not.toContain(jobId);

    // The job failed. Inside the backoff window it is skipped, and the hold is written on the step.
    const row = f.db.inspect(jobKey(jobId));
    const record = jobRecordSchema.parse(row);
    await f.store.transact([f.store.put(jobKey(jobId), jobRecordSchema.parse({ ...record, state: 'failed', attempt: 1,
      leaseUntil: null, lastError: 'provider_error', lastAttemptAt: '2026-09-18T12:06:00.000Z' }),
    Number((f.db.dump().find(item => item.sk?.S === jobKey(jobId)))!.rev!.N))]);
    f.advance('2026-09-18T12:40:00.000Z');
    queue.sent.length = 0;
    const third = await runScheduler(deps(f, queue), AbortSignal.timeout(5000));
    expect(third.skipped.find(entry => entry.jobId === jobId)).toEqual({ jobId, reason: 'backoff' });
    expect(sequenceRecordSchema.parse(f.db.inspect(seqKey(firm.firmId))).heldSteps.map(step => step.code)).toEqual(['provider_error']);
    expect(jobBackoffUntil({ attempt: 1, lastAttemptAt: '2026-09-18T12:06:00.000Z' })).toBe('2026-09-18T13:06:00.000Z');

    // Past the window it is offered again.
    f.advance('2026-09-18T13:10:00.000Z');
    queue.sent.length = 0;
    const fourth = await runScheduler(deps(f, queue), AbortSignal.timeout(5000));
    expect(fourth.enqueued.map(job => job.jobId)).toContain(jobId);
  });

  it('a queue outage is reported, not hidden, and nothing is recorded as queued', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    await sendWorkspace(f, bearer);
    const queue = recordingQueue();
    queue.fail = true;
    const report = await runScheduler(deps(f, queue), AbortSignal.timeout(5000));
    expect(report.enqueued).toEqual([]);
    expect(report.failed.length).toBeGreaterThan(0);
    expect(f.db.dump().some(item => item.sk?.S?.startsWith('JOB#'))).toBe(false);
  });

  it('every job id, deduplication id and message group fits inside the SQS limits', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const firm = await sendWorkspace(f, bearer);
    const queue = recordingQueue();
    await runScheduler(deps(f, queue), AbortSignal.timeout(5000));
    expect(queue.sent.length).toBeGreaterThan(0);
    for (const job of queue.sent) {
      const dedup = jobDedupId(job.jobId);
      expect(dedup).toMatch(/^[a-f0-9]{64}$/);
      expect(dedup.length).toBeLessThanOrEqual(SQS_ID_MAX_LENGTH);
      expect(JOB_GROUP_OF[job.kind].length).toBeLessThanOrEqual(SQS_ID_MAX_LENGTH);
      expect(JOB_GROUPS).toContain(JOB_GROUP_OF[job.kind]);
      // The id itself is long (a firm id alone is 72 characters), which is why the deduplication id is its hash.
      expect(parseJobId(job.jobId)?.kind).toBe(job.kind);
    }
    // A real firm id makes the raw job id longer than SQS would accept as a deduplication id.
    const realistic = sendStepJobId(`account-${'a'.repeat(64)}`, `territory-version-${'b'.repeat(64)}-step-2`);
    expect(realistic.length).toBeGreaterThan(SQS_ID_MAX_LENGTH);
    expect(jobDedupId(realistic).length).toBe(64);
    expect(parseJobId(sendStepJobId(firm.firmId, firm.stepId))).toEqual({ kind: 'mail.send_step', firmId: firm.firmId, stepId: firm.stepId });
  });

  it('every job kind has a group, and a message names the group its kind belongs to', () => {
    for (const kind of JOB_KINDS) {
      expect(JOB_GROUPS).toContain(JOB_GROUP_OF[kind]);
      expect(queueMessage('day:2026-09-18', kind).group).toBe(JOB_GROUP_OF[kind]);
    }
    expect(JOB_KINDS.length).toBe(Object.keys(JOB_GROUP_OF).length);
  });

  it('a message the scheduler enqueued runs once through the runner, and its duplicate is skipped', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const firm = await sendWorkspace(f, bearer);
    const queue = recordingQueue();
    await runScheduler(deps(f, queue), AbortSignal.timeout(5000));
    const job = queue.sent.find(entry => entry.kind === 'mail.send_step');
    expect(job).toBeDefined();
    const body = JSON.stringify(queueMessage(job!.jobId, job!.kind));
    const gmail = gmailFetch({ send: ['accepted'] });
    const runner = { store: f.store, mailbox: mailboxAccess(), fetch: gmail.fetch, budgetMs: 5000 };

    const first = await runQueuedJob(runner, body);
    expect(first).toMatchObject({ jobId: job!.jobId, state: 'done' });
    expect((await readSend(f.store, firm.firmId, firm.stepId))?.record.state).toBe('accepted');
    expect(gmail.calls.filter(call => call.url.includes('/messages/send'))).toHaveLength(1);

    // The same message delivered again: the claim refuses it because the job is done.
    const second = await runQueuedJob(runner, body);
    expect(second).toEqual({ jobId: job!.jobId, state: 'skipped', reason: 'already_done' });
    expect(gmail.calls.filter(call => call.url.includes('/messages/send'))).toHaveLength(1);
  });
});
