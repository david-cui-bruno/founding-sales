import { SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { accountInstantSchema } from '../../../../src/shared/contracts/accountContract';
import { attemptReasonSchema } from '../../../../src/shared/contracts/v1Contract';
import { withDynamoReadErrors, type DynamoAdapter, type DynamoStore } from './dynamoStore';
import { WorkerAuth } from './workerAuth';
import { createSqsQueueClient, type QueueClient } from './queue/queueClient';
import { dayBuildJobId, jobEnqueueable, jobRef, markQueued, pollJobId, readJobs, reconcileJobId, sendFollowupJobId, sendStepJobId,
  type JobKind, type JobRecord } from './queue/jobs';
import { recordAttempt } from './v1/attempts';
import { backfillDuePointers, dayKey, LIST_BUILD_START_MINUTE, readDuePointers } from './v1/dayBuild';
import { createAccountFirmSource, type FirmCard, type FirmSource } from './v1/firms';
import { EASTERN, localParts } from './v1/localClock';
import { readDrafts, readMailboxCursor } from './v1/mail';
import { enqueueResearch, type ResearchEnqueueReport } from './v1/research';
import { createSequencePort, currentStepOf, dueEmailSteps, listSequenceRecords, type SequencePort } from './v1/sequence';
import { remainingSendsToday } from './v1/templates';

/**
 * The scheduler Lambda (FSS target design sections 1 and 4; slice S3). It runs on the five-minute rule, decides
 * what is due, and enqueues it. It finishes in seconds and it does no work of its own: it never reads a mailbox,
 * never sends and never advances a sequence.
 *
 * Four decisions per tick, in this order:
 *
 *   day.build      the first tick at or after 05:00 Eastern with no DAY# for the Eastern date
 *   mail.poll      once a tick, identified by the scheduler's own tick sequence rather than a clock bucket, so
 *                  schedule jitter can never drop or duplicate a poll
 *   mail.reconcile once an hour, `reconcile:<date>T<HH>` on the Eastern clock
 *   mail.send_step every DUE# pointer standing on a template step, up to the remaining daily cap and no further
 *
 * A job already queued, running under a live lease, or failed inside its backoff window (one hour doubling to a
 * day) is not enqueued again; when that job is a send, the hold is written on the step so Today says why.
 */

export const SCHEDULER_STATE_KEY = 'SCHEDULER#state';
export const schedulerStateSchema = z.strictObject({
  version: z.literal(1),
  tickSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  lastRunAt: accountInstantSchema,
  enqueued: z.record(z.string().max(40), z.number().int().nonnegative()),
  skipped: z.record(attemptReasonSchema, z.number().int().nonnegative()),
  durationMs: z.number().int().nonnegative(),
});
export type SchedulerState = z.infer<typeof schedulerStateSchema>;

export type SchedulerDependencies = { store: DynamoStore; queue: QueueClient; firms?: FirmSource; sequence?: SequencePort };
export type SchedulerReport = { tickSeq: number; enqueued: { jobId: string; kind: JobKind }[];
  skipped: { jobId: string; reason: string }[]; remainingCap: number; failed: string[];
  /** What research this tick offered and why it offered no more (S4). */
  research?: ResearchEnqueueReport };

/** The user-facing code a job's own failure is held under. A closed code the record carries, or a generic refusal. */
function holdCodeOf(record: JobRecord | null): string {
  const code = record?.lastError ?? null;
  return code !== null && attemptReasonSchema.safeParse(code).success ? code : 'provider_error';
}

export async function readSchedulerState(store: DynamoStore): Promise<{ state: SchedulerState; rev: number } | null> {
  const row = await store.get<unknown>(SCHEDULER_STATE_KEY);
  if (!row) return null;
  const parsed = schedulerStateSchema.safeParse(row.data);
  return parsed.success ? { state: parsed.data, rev: row.rev } : null;
}

/** One five-minute tick. Pure decision plus enqueues; every refusal is counted and named, never silent. */
export async function runScheduler(deps: SchedulerDependencies, signal: AbortSignal): Promise<SchedulerReport> {
  const store = deps.store;
  const started = Date.now();
  const now = store.now();
  const eastern = localParts(now, EASTERN);
  const held = await readSchedulerState(store);
  const tickSeq = (held?.state.tickSeq ?? 0) + 1;
  const jobs = await readJobs(store);
  const report: SchedulerReport = { tickSeq, enqueued: [], skipped: [], remainingCap: 0, failed: [] };

  const offer = async (jobId: string, kind: JobKind, onSkip?: (reason: string) => Promise<void>): Promise<boolean> => {
    const decision = jobEnqueueable(jobs.get(jobId) ?? null, now);
    if (!decision.enqueue) {
      report.skipped.push({ jobId, reason: decision.reason });
      if (decision.reason === 'backoff') await onSkip?.(holdCodeOf(jobs.get(jobId) ?? null));
      return false;
    }
    try { await deps.queue.enqueue({ jobId, kind }); }
    catch { report.failed.push(jobId); return false; }
    await markQueued(store, { jobId, kind });
    report.enqueued.push({ jobId, kind });
    return true;
  };

  // The morning list, once per Eastern day, at or after 05:00.
  if (eastern.minuteOfDay >= LIST_BUILD_START_MINUTE && !(await store.get<unknown>(dayKey(eastern.date)))) {
    await offer(dayBuildJobId(eastern.date), 'day.build');
  }
  signal.throwIfAborted();
  // One mailbox read a tick. The cursor is read so a workspace that has never polled still gets its first scan.
  await readMailboxCursor(store);
  await offer(pollJobId(tickSeq), 'mail.poll');
  // The hourly settlement of anything unsettled.
  await offer(reconcileJobId(eastern.date, eastern.hour), 'mail.reconcile');
  signal.throwIfAborted();

  const { remaining } = await remainingSendsToday(store, now);
  report.remainingCap = remaining;
  if (remaining > 0) {
    const firms = await (deps.firms ?? createAccountFirmSource(store)).listFirms();
    // The pointers are a hint the range read checks against where the firm stands now, `SEQ#` first. The backfill
    // only writes the ones no `SEQ#` record covers: the sequence module writes its own beside the step it moves.
    await backfillDuePointers(store, firms);
    const byFirm = new Map(firms.map(firm => [firm.firmId, firm]));
    const sequence = deps.sequence ?? createSequencePort(store);
    let enqueued = 0;
    // One jobId is offered at most once a tick, whichever of the two reads below found the step due.
    const offered = new Set<string>();
    for (const pointer of await readDuePointers(store, firms, now)) {
      if (enqueued >= remaining) { report.skipped.push({ jobId: sendStepJobId(pointer.firmId, pointer.stepId), reason: 'cap_reached' }); continue; }
      const firm = byFirm.get(pointer.firmId) as FirmCard | undefined;
      if (!firm || firm.suppressed) continue;
      // Which step the firm stands on, and whether it is an email one, comes from the `SEQ#` record first: a firm
      // whose sequence began at a logged call has no old enrollment to read a channel off.
      const step = currentStepOf(await sequence.read(firm.firmId), firm);
      if (step?.channel !== 'email' || step.stepId !== pointer.stepId) continue;
      const jobId = sendStepJobId(pointer.firmId, pointer.stepId);
      if (offered.has(jobId)) continue;
      offered.add(jobId);
      const taken = await offer(jobId, 'mail.send_step', async code => {
        await sequence.holdStep({ firmId: firm.firmId, enrollmentId: pointer.enrollmentId, startedAt: firm.enrollment?.startedAt ?? pointer.nextDueAt,
          currentStepId: pointer.stepId, nextDueAt: pointer.nextDueAt, stepId: pointer.stepId, code });
      });
      if (taken) enqueued++;
    }
    // The email steps the call cadence walked past and held, now past their own start-anchored instant. This is how
    // a firm whose mornings are calls gets its day-7 and day-21 emails: the cadence never stands on an email step.
    for (const [firmId, record] of await listSequenceRecords(store)) {
      const firm = byFirm.get(firmId);
      if (!firm || firm.suppressed) continue;
      for (const step of dueEmailSteps(record, now)) {
        const jobId = sendStepJobId(firmId, step.stepId);
        if (offered.has(jobId)) continue;
        offered.add(jobId);
        if (enqueued >= remaining) { report.skipped.push({ jobId, reason: 'cap_reached' }); continue; }
        const taken = await offer(jobId, 'mail.send_step', async code => {
          await sequence.holdStep({ firmId, enrollmentId: record.enrollmentId, startedAt: record.startedAt,
            currentStepId: record.currentStepId, nextDueAt: record.nextDueAt, stepId: step.stepId, code });
        });
        if (taken) enqueued++;
      }
    }
    // The drafts David approved. Approving is never sending: the approval writes the record, this puts it on the
    // queue, and the runner takes it through the same fence, under the same cap, as a sequence step.
    for (const draft of await readDrafts(store)) {
      if (draft.status !== 'approved' || draft.text === null) continue;
      const jobId = sendFollowupJobId(draft.firmId, draft.draftId);
      if (enqueued >= remaining) { report.skipped.push({ jobId, reason: 'cap_reached' }); continue; }
      if (await offer(jobId, 'mail.send_followup')) enqueued++;
    }
  }

  // S4: the research pages and per-firm jobs this tick should carry. It decides on counters and cursors alone.
  report.research = await enqueueResearch(store, deps.queue, now);
  for (const job of report.research.enqueued) report.enqueued.push(job);
  for (const entry of report.research.skipped) report.skipped.push(entry);
  signal.throwIfAborted();

  const state = schedulerStateSchema.parse({ version: 1, tickSeq, lastRunAt: now,
    enqueued: countBy(report.enqueued.map(job => job.kind)), skipped: countBy(report.skipped.map(entry => entry.reason)),
    durationMs: Date.now() - started });
  try { await store.transact([store.put(SCHEDULER_STATE_KEY, state, held?.rev ?? null)]); }
  catch { /* Another scheduler wrote this tick first; its enqueues and ours are the same deterministic ids. */ }
  await recordAttempt(store, { kind: 'tick', outcome: report.failed.length ? 'failed' : 'ok',
    reason: report.failed.length ? 'queue_unavailable' : null,
    detail: { code: 'scheduler_tick', count: report.enqueued.length, jobId: jobRef(pollJobId(tickSeq)) },
    durationMs: Date.now() - started, ref: `tick:${tickSeq}` });
  return report;
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

export type SchedulerBoundaries = { dynamo?: DynamoAdapter; sqs?: Pick<SQSClient, 'send'> };

/**
 * The production scheduler: the table and the queue, and nothing else. It holds no Google client secret and no
 * SSM parameter, which is what its own IAM role is for.
 */
export function createSchedulerHandler(env: NodeJS.ProcessEnv, boundaries: SchedulerBoundaries = {}) {
  return async (): Promise<SchedulerReport | { status: 'disabled' }> => {
    if (env.DELEGATED_WORKER_ENABLED !== 'true') return { status: 'disabled' };
    const config = z.object({ DELEGATED_WORKER_TABLE: z.string().min(1), DELEGATED_WORKSPACE_ID: z.string().min(1),
      DELEGATED_WORKER_QUEUE_URL: z.string().min(1), AWS_REGION: z.string().min(1) }).parse(env);
    const dynamo = withDynamoReadErrors(boundaries.dynamo ?? new DynamoDBClient({ region: config.AWS_REGION, maxAttempts: 1 }));
    const auth = new WorkerAuth({ dynamo, tableName: config.DELEGATED_WORKER_TABLE, workspaceId: config.DELEGATED_WORKSPACE_ID,
      clock: { now: () => new Date().toISOString() } });
    const queue = createSqsQueueClient({ sqs: boundaries.sqs ?? new SQSClient({ region: config.AWS_REGION, maxAttempts: 2 }), queueUrl: config.DELEGATED_WORKER_QUEUE_URL });
    return runScheduler({ store: auth.store, queue }, AbortSignal.timeout(30000));
  };
}

export const handler = async (): Promise<SchedulerReport | { status: 'disabled' }> => createSchedulerHandler(process.env)();
