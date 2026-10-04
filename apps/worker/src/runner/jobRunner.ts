import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import type { JobRunOutcome } from '@fss/domain/jobs/atLeastOnce.ts';
import { DEFAULT_BACKOFF, type BackoffPolicy } from '@fss/domain/jobs/backoff.ts';
import {
  isJobChunk,
  scopeForJob,
  JOB_CLASSES,
  type HandlerRegistry,
  type JobChunk,
  type JobClass,
  type JobHandler,
} from '@fss/domain/jobs/handlerRegistry.ts';
import { recordHeartbeat } from '@fss/domain/jobs/heartbeats.ts';
import { TRANSCRIPTION_HEARTBEAT_FLAG } from '@fss/domain/calls/transcription.ts';
import { callTranscribeStartsNewAttempts } from '../handlers/callTranscribe.ts';
import {
  chunkBookkeepingOf,
  claimJobs,
  completeJob,
  databaseNowMs,
  failJob,
  killJob,
  reclaimExpiredLeases,
  requeueForNextChunk,
  writeProgress,
  type ChunkBookkeeping,
  type ClaimedJob,
  type ProgressOutcome,
} from '@fss/domain/jobs/jobStore.ts';

/**
 * The job runner (specification 13.2).
 *
 * The interesting part is how the three declared protections are actually enforced,
 * because "the handler is idempotent" is a promise and this is the mechanism:
 *
 * **`fencing_token`.** The handler runs inside a transaction that first re-reads its
 * own job row `FOR UPDATE` with the token it was handed. A worker whose lease was
 * stolen finds no row and the handler never runs, so there is no effect to be
 * idempotent about. The completion is in the same transaction.
 *
 * **`business_uniqueness`.** The handler runs inside a transaction and the completion
 * commits with it. A worker whose lease was stolen does its work and then finds the
 * completion affects zero rows, so the transaction rolls back and the work with it.
 * The handler's own unique constraint is the backstop for the case where two workers
 * commit against different rows.
 *
 * **`outbound_fence`.** The handler runs *outside* the completion transaction, because
 * what it does — the `prepared → dispatching` transition and the Gmail call after it —
 * cannot be rolled back (Appendix B). Nothing here may undo it; the fence itself is
 * the at-most-once guarantee, and a stolen lease simply means the completion is
 * reported by whoever still holds one.
 *
 * In every case the outcome for a worker that lost its lease is `lease_lost`, and a
 * test runs each registered handler twice under a real stolen lease and counts the
 * business effects (Appendix G scenario 2).
 *
 * **Chunking.** A handler may instead return `{ progress, done: false }` after a
 * bounded unit of work. The runner commits that unit together with a fenced write of
 * the cursor into `payload.progress`, then calls the handler again with the new cursor
 * while the lease has time left, and hands the job back to the queue — cursor kept,
 * attempt not spent — when it does not. A crash anywhere in that loop loses at most the
 * chunk in flight, because every earlier chunk is already committed with its cursor.
 */

/** Internal: the signal that rolls back a handler whose completion lost the race. */
class LeaseLost extends Error {
  constructor() {
    super('lease lost');
    this.name = 'LeaseLost';
  }
}

export interface RunClaimedJobOptions {
  readonly registry: HandlerRegistry;
  readonly job: ClaimedJob;
  readonly backoff?: BackoffPolicy | undefined;
  readonly random?: (() => number) | undefined;
  /** Database time in epoch milliseconds. Only the chunk loop reads it; a test steers it. */
  readonly now?: (() => Promise<number>) | undefined;
  /** Chunks before a chunked job is failed. `CHUNK_COUNT_LIMIT` unless a test lowers it. */
  readonly chunkCountLimit?: number | undefined;
  /** Seconds of chunking before a chunked job is failed. `CHUNK_SECONDS_LIMIT` by default. */
  readonly chunkSecondsLimit?: number | undefined;
}

/** True while this worker still holds the exact lease it was handed. */
async function holdsLease(session: SessionQueryable, job: ClaimedJob): Promise<boolean> {
  const { rows } = await session.query(
    `SELECT 1 FROM jobs
      WHERE workspace_id = $1 AND id = $2 AND state = 'running'
        AND lease_owner = $3 AND fencing_token = $4::bigint
      FOR UPDATE`,
    [job.workspaceId, job.id, job.leaseOwner, job.fencingToken],
  );
  return rows.length === 1;
}

/** A short, stable, redacted failure code. `jobs_error_code_shape` refuses anything else. */
function failureCode(error: unknown): string {
  const name = error instanceof Error ? error.name : 'error';
  const normalized = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^[^a-z]+/, '');
  return normalized.length >= 3 ? normalized.slice(0, 64) : 'handler_failed';
}

/** Bounded and redacted: an operator hint, never a body, a path or a credential. */
function failureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : 'the handler threw a value that is not an Error';
  return message.slice(0, 500);
}

/** How close to the lease deadline the runner stops starting another chunk. */
const CHUNK_MARGIN_MILLISECONDS = 2_000;

/**
 * The budget a chunked job is held to, across every claim it ever gets.
 *
 * A yield is not a failed attempt and it resets `run_at`, so a handler that never
 * returns `done` is invisible to `DeadJobOldestAgeSeconds` and to
 * `OldestRunnableJobAgeSeconds` alike: it would chunk for ever, quietly, holding a
 * runner slot. These two limits are what turns that into a dead job an operator sees.
 * Five hundred chunks is far beyond any sweep written for this system, and six hours
 * is longer than a night's retention run.
 */
export const CHUNK_COUNT_LIMIT = 500;
export const CHUNK_SECONDS_LIMIT = 6 * 60 * 60;

/** Which budget a chunked job has spent, or null while it is inside both. */
function budgetOverrun(
  chunking: ChunkBookkeeping,
  nowMs: number,
  limits: { readonly chunks: number; readonly seconds: number },
): string | null {
  if (chunking.chunks >= limits.chunks) {
    return `a chunked job committed ${String(chunking.chunks)} chunks without finishing (limit ${String(limits.chunks)})`;
  }
  const elapsedSeconds = (nowMs - chunking.firstChunkMs) / 1000;
  if (elapsedSeconds >= limits.seconds) {
    return `a chunked job has been chunking for ${String(Math.round(elapsedSeconds))} seconds without finishing (limit ${String(limits.seconds)})`;
  }
  return null;
}

type AttemptResult =
  | { readonly outcome: JobRunOutcome; readonly chunk?: undefined; readonly progress?: undefined }
  | { readonly outcome: 'chunk'; readonly chunk: JobChunk; readonly progress: ProgressOutcome; readonly writtenHostMs: number };

interface AttemptOptions {
  readonly handler: JobHandler;
  readonly job: ClaimedJob;
  readonly failure: { readonly backoff: BackoffPolicy; readonly random: (() => number) | undefined };
}

/** One call of the handler, with the transaction shape its protection asks for. */
async function runAttempt(session: SessionQueryable, options: AttemptOptions): Promise<AttemptResult> {
  const { handler, job, failure } = options;
  const input = { session, scope: scopeForJob(job), job };
  const progressOf = (chunk: JobChunk): Promise<ProgressOutcome> =>
    writeProgress(session, {
      jobId: job.id,
      workspaceId: job.workspaceId,
      fencingToken: job.fencingToken,
      progress: chunk.progress,
    });

  if (handler.protection === 'outbound_fence') {
    let result: void | JobChunk;
    try {
      result = await handler.handle(input);
    } catch (error) {
      return { outcome: await failJob(session, job, { code: failureCode(error), detail: failureDetail(error), ...failure }) };
    }
    if (isJobChunk(result) && !result.done) {
      // An irreversible effect cannot be re-entered. There is no transaction to commit
      // the chunk and its cursor together, so "the cursor is where the work got to" is
      // not a fact this path can state; a second claim would re-send. The registry
      // refuses a handler that declares `chunked` with this protection, and this is the
      // same refusal for one that returns a chunk without declaring it.
      //
      // Terminal, not retryable: the handler will return a chunk on the next attempt
      // too, and every one of those attempts is a real send. The job goes straight to
      // `dead`, where an operator sees it and an audited requeue is the way back.
      const buried = await killJob(session, job, {
        code: 'chunking_unsupported',
        detail: `${job.kind} is protected by the outbound fence, which cannot be chunked`,
      });
      return { outcome: buried === 'dead' ? 'dead' : 'lease_lost' };
    }
    return { outcome: await completeJob(session, job) };
  }

  let outcome: JobRunOutcome = 'lease_lost';
  let chunk: JobChunk | null = null;
  let progress: ProgressOutcome | null = null;
  let writtenHostMs = 0;
  let thrown: unknown = null;
  try {
    await withTransaction(session, async () => {
      if (handler.protection === 'fencing_token' && !(await holdsLease(session, job))) {
        outcome = 'lease_lost';
        return;
      }
      const result = await handler.handle(input);
      if (isJobChunk(result) && !result.done) {
        // The chunk and its cursor commit together, or neither does.
        const written = await progressOf(result);
        if (written.outcome === 'lease_lost') throw new LeaseLost();
        chunk = result;
        progress = written;
        writtenHostMs = Date.now();
        return;
      }
      outcome = await completeJob(session, job);
      if (outcome === 'lease_lost') {
        // Undo the handler's work: it was done by a worker that no longer owns the job.
        throw new LeaseLost();
      }
    });
  } catch (error) {
    if (error instanceof LeaseLost) return { outcome: 'lease_lost' };
    thrown = error;
  }
  if (thrown !== null) {
    return { outcome: await failJob(session, job, { code: failureCode(thrown), detail: failureDetail(thrown), ...failure }) };
  }
  if (chunk !== null && progress !== null) return { outcome: 'chunk', chunk, progress, writtenHostMs };
  return { outcome };
}

export async function runClaimedJob(session: SessionQueryable, options: RunClaimedJobOptions): Promise<JobRunOutcome> {
  const { registry } = options;
  const handler: JobHandler | undefined = registry.get(options.job.kind);
  if (handler === undefined) {
    // Never claimed in the first place unless the registry changed under us; still,
    // report it rather than burning an attempt silently.
    await failJob(session, options.job, { code: 'handler_unregistered', detail: `no handler for ${options.job.kind}` });
    return 'no_handler';
  }

  const failure = { backoff: options.backoff ?? DEFAULT_BACKOFF, random: options.random };
  // Database time throughout. The lease deadline came from the database at claim time,
  // so comparing it with a host clock compares two clocks; a worker whose clock had
  // drifted forward would give itself a shorter lease and one drifted back a longer.
  const overrideNow = options.now;
  const now = overrideNow ?? ((): Promise<number> => databaseNowMs(session));
  const limits = { chunks: options.chunkCountLimit ?? CHUNK_COUNT_LIMIT, seconds: options.chunkSecondsLimit ?? CHUNK_SECONDS_LIMIT };
  const deadline = Date.parse(options.job.leaseExpiresAt);
  let job = options.job;
  // The worst chunk so far is the estimate for the next one: a chunk is a bounded unit
  // of work, so the bound the handler already demonstrated is the honest guess.
  let longestChunk = 0;
  let clock: number | null = null;

  for (;;) {
    // The budget is checked before the work, from the row's own bookkeeping, so a job
    // that arrived over its limit spends nothing more on it.
    const carried = chunkBookkeepingOf(job.payload);
    if (carried !== null) {
      clock ??= await now();
      const overrun = budgetOverrun(carried, clock, limits);
      if (overrun !== null) {
        return await failJob(session, job, { code: 'chunk_budget_exhausted', detail: overrun, ...failure });
      }
    }
    const startedAt = clock ?? (await now());
    const attempt = await runAttempt(session, { handler, job, failure });
    if (attempt.outcome !== 'chunk') return attempt.outcome;

    const written = attempt.progress;
    job = {
      ...job,
      payload: {
        ...job.payload,
        progress: attempt.chunk.progress,
        ...(written.chunking === null ? {} : { chunking: written.chunking }),
      },
    };
    // A fresh reading, after the commit, of the database clock — without a query (slice P1,
    // final round): the progress write's own database time, plus the host time since it.
    // A chunk that marks a paid attempt `calling` is followed by its provider request, and
    // nothing but the next chunk's BEGIN may come between that commit and the request.
    // A test that steers the clock still asks its own function.
    clock =
      overrideNow === undefined && written.chunking !== null
        ? written.chunking.lastChunkMs + Math.max(0, Date.now() - attempt.writtenHostMs)
        : await now();
    longestChunk = Math.max(longestChunk, clock - startedAt);
    if (!Number.isFinite(deadline) || clock + longestChunk + CHUNK_MARGIN_MILLISECONDS >= deadline) {
      // Out of lease with work left: back to the queue, cursor kept, runnable now.
      return (await requeueForNextChunk(session, job)) === 'requeued' ? 'requeued' : 'lease_lost';
    }
  }
}

export interface RunOnceOptions {
  readonly registry: HandlerRegistry;
  readonly owner: string;
  readonly limit: number;
  readonly instanceKey?: string | undefined;
  readonly backoff?: BackoffPolicy | undefined;
  readonly random?: (() => number) | undefined;
  /**
   * The lanes this slot claims, in order; with the worker's limit of one, the first
   * lane with a runnable job wins the pass. Defaults to every lane, urgent first,
   * which is what a single-slot worker does.
   * `slots.ts` computes it from the slot's index.
   */
  readonly classes?: readonly JobClass[] | undefined;
}

export interface RunOnceReport {
  readonly reclaimed: number;
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly leaseLost: number;
  /** Chunked jobs handed back to the queue with their cursor. Neither done nor failed. */
  readonly requeued: number;
  /** The first lane the pass claimed from, or null when it claimed nothing. */
  readonly claimedClass: JobClass | null;
}

/**
 * One pass of the worker loop: return expired leases to the runnable set, claim what
 * this slot's lanes have handlers for, run each, and record the worker heartbeat.
 */
export async function runOnce(session: SessionQueryable, options: RunOnceOptions): Promise<RunOnceReport> {
  const reclaimed = await reclaimExpiredLeases(session, { limit: Math.max(options.limit, 10) });

  // One claim per lane, in the slot's order, until the pass's limit is spent. A slot
  // polls with a limit of one, so in the worker this is "urgent first, then bulk, in
  // the same poll"; a test that drains with a large limit still drains both lanes.
  // The lease has to cover the slowest handler *of the kinds this claim names* — not of
  // every registered kind, which would lease a mail sync for as long as a retention
  // sweep. Over-leasing only delays a reclaim after a crash; under-leasing would let a
  // second worker claim a job the first is still running, which the fencing token
  // survives but which wastes the attempt.
  const claims: ClaimedJob[] = [];
  let claimedClass: JobClass | null = null;
  for (const jobClass of options.classes ?? JOB_CLASSES) {
    const remaining = options.limit - claims.length;
    if (remaining <= 0) break;
    const kinds = options.registry.kindsOfClass(jobClass);
    if (kinds.length === 0) continue;
    const leaseSeconds = kinds.reduce(
      (longest, kind) => Math.max(longest, options.registry.get(kind)?.leaseSeconds ?? 0),
      60,
    );
    const lane = await claimJobs(session, { owner: options.owner, kinds, limit: remaining, leaseSeconds });
    if (lane.length > 0) claimedClass ??= jobClass;
    claims.push(...lane);
  }

  let completed = 0;
  let failed = 0;
  let leaseLost = 0;
  let requeued = 0;
  for (const job of claims) {
    const outcome = await runClaimedJob(session, {
      registry: options.registry,
      job,
      backoff: options.backoff,
      random: options.random,
    });
    if (outcome === 'completed') completed += 1;
    else if (outcome === 'lease_lost') leaseLost += 1;
    else if (outcome === 'requeued') requeued += 1;
    else failed += 1;
  }

  await recordHeartbeat(session, {
    component: 'worker',
    instanceKey: options.instanceKey ?? options.owner,
    expectedIntervalSeconds: 60,
    // Slice C2: whether this runner can transcribe, for the API, which is not given the
    // transcription key and reads this instead (`transcriptionWorkerAvailable`). A
    // collect-only handler (review C3-N) is registered but cannot start one: false.
    detail: { meeting_recording_setup: options.registry.get('meeting.recording_setup')!==undefined, claimed: claims.length, completed, failed, [TRANSCRIPTION_HEARTBEAT_FLAG]: callTranscribeStartsNewAttempts(options.registry.get('call.transcribe')) },
  });

  return { reclaimed, claimed: claims.length, completed, failed, leaseLost, requeued, claimedClass };
}
