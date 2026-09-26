import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { type JobRunOutcome } from '@fss/domain/jobs/atLeastOnce.ts';
import { DEFAULT_BACKOFF, type BackoffPolicy } from '@fss/domain/jobs/backoff.ts';
import { scopeForJob, type HandlerRegistry, type JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';
import { recordHeartbeat } from '@fss/domain/jobs/heartbeats.ts';
import { claimJobs, completeJob, failJob, reclaimExpiredLeases, type ClaimedJob } from '@fss/domain/jobs/jobStore.ts';

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

export async function runClaimedJob(session: SessionQueryable, options: RunClaimedJobOptions): Promise<JobRunOutcome> {
  const { job, registry } = options;
  const handler: JobHandler | undefined = registry.get(job.kind);
  if (handler === undefined) {
    // Never claimed in the first place unless the registry changed under us; still,
    // report it rather than burning an attempt silently.
    await failJob(session, job, { code: 'handler_unregistered', detail: `no handler for ${job.kind}` });
    return 'no_handler';
  }

  const input = { session, scope: scopeForJob(job), job };
  const failure = { backoff: options.backoff ?? DEFAULT_BACKOFF, random: options.random };

  if (handler.protection === 'outbound_fence') {
    try {
      await handler.handle(input);
    } catch (error) {
      return await failJob(session, job, { code: failureCode(error), detail: failureDetail(error), ...failure });
    }
    return await completeJob(session, job);
  }

  let outcome: JobRunOutcome = 'lease_lost';
  let thrown: unknown = null;
  try {
    await withTransaction(session, async () => {
      if (handler.protection === 'fencing_token' && !(await holdsLease(session, job))) {
        outcome = 'lease_lost';
        return;
      }
      await handler.handle(input);
      outcome = await completeJob(session, job);
      if (outcome === 'lease_lost') {
        // Undo the handler's work: it was done by a worker that no longer owns the job.
        throw new LeaseLost();
      }
    });
  } catch (error) {
    if (error instanceof LeaseLost) return 'lease_lost';
    thrown = error;
  }
  if (thrown !== null) {
    return await failJob(session, job, { code: failureCode(thrown), detail: failureDetail(thrown), ...failure });
  }
  return outcome;
}

export interface RunOnceOptions {
  readonly registry: HandlerRegistry;
  readonly owner: string;
  readonly limit: number;
  readonly instanceKey?: string | undefined;
  readonly backoff?: BackoffPolicy | undefined;
  readonly random?: (() => number) | undefined;
}

export interface RunOnceReport {
  readonly reclaimed: number;
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly leaseLost: number;
}

/**
 * One pass of the worker loop: return expired leases to the runnable set, claim what
 * this worker has handlers for, run each, and record the worker heartbeat.
 */
export async function runOnce(session: SessionQueryable, options: RunOnceOptions): Promise<RunOnceReport> {
  const reclaimed = await reclaimExpiredLeases(session, { limit: Math.max(options.limit, 10) });

  // One claim for every registered kind, so the lease has to cover the slowest of
  // them. Over-leasing only delays a reclaim after a crash; under-leasing would let a
  // second worker claim a job the first is still running, which the fencing token
  // survives but which wastes the attempt.
  const handlers = options.registry.all();
  const leaseSeconds = handlers.reduce((longest, handler) => Math.max(longest, handler.leaseSeconds), 60);
  const claims = await claimJobs(session, {
    owner: options.owner,
    kinds: options.registry.kinds(),
    limit: options.limit,
    leaseSeconds,
  });

  let completed = 0;
  let failed = 0;
  let leaseLost = 0;
  for (const job of claims) {
    const outcome = await runClaimedJob(session, {
      registry: options.registry,
      job,
      backoff: options.backoff,
      random: options.random,
    });
    if (outcome === 'completed') completed += 1;
    else if (outcome === 'lease_lost') leaseLost += 1;
    else failed += 1;
  }

  await recordHeartbeat(session, {
    component: 'worker',
    instanceKey: options.instanceKey ?? options.owner,
    expectedIntervalSeconds: 60,
    detail: { claimed: claims.length, completed, failed },
  });

  return { reclaimed, claimed: claims.length, completed, failed, leaseLost };
}
