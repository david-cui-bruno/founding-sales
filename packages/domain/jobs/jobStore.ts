import type { Queryable } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { isAdminScope } from '../db/workspaceScope.ts';
import { backoffSeconds, DEFAULT_BACKOFF, isExhausted, type BackoffPolicy } from './backoff.ts';
import { isJobKind, type JobKind } from './jobKinds.ts';

/**
 * The PostgreSQL job queue of specification 13.2.
 *
 * Four facts run through this file.
 *
 * **The claim is one statement.** `FOR UPDATE SKIP LOCKED` inside a CTE, then the
 * `UPDATE` that takes the lease, so there is no window in which a row is selected but
 * not yet claimed and no transaction the caller has to remember to open.
 *
 * **The lease is a hint, the fencing token is the fact.** `lease_expires_at` tells
 * other workers that this row is probably being worked on. It proves nothing: a
 * paused worker still believes it holds the lease. Every write a worker makes to its
 * own job row carries the `fencing_token` it was handed at claim time, and the token
 * increments on every claim and never resets, so a worker that wakes after a reclaim
 * affects zero rows (Appendix G scenario 2).
 *
 * **Time is the database's.** `run_at`, `not_before` and every lease deadline are
 * compared with `now()` inside the statement. No worker's clock enters the decision.
 *
 * **The queue crosses workspaces on purpose.** One worker serves every workspace, so
 * `claimJobs` and `reclaimExpiredLeases` take a session rather than a scope; the row
 * carries `workspace_id` and the runner builds the handler's `WorkspaceScope` from
 * it, so everything the handler then touches is scoped. The admin-facing functions at
 * the bottom of this file take a `RepositoryContext` like every other repository
 * function. See docs/decisions/g5-queue-scope.md.
 */

export interface JobSpecification {
  readonly workspaceId: string;
  readonly kind: JobKind | string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Defaults to database `now()`. */
  readonly runAt?: string | undefined;
  /** Defaults to database `now()`. Respected in database time by the claim. */
  readonly notBefore?: string | undefined;
  readonly maxAttempts?: number | undefined;
}

export interface EnqueueOutcome {
  /** False when the idempotency key already existed. That is the normal case, not an error. */
  readonly inserted: boolean;
  readonly jobId: string;
}

export interface ClaimedJob {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Which attempt this is. The first claim is 1. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** A bigint, carried as a string: it outlives `Number.MAX_SAFE_INTEGER` in principle. */
  readonly fencingToken: string;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: string;
}

export class JobStoreError extends Error {
  constructor(readonly code: 'JOB_KIND_UNKNOWN' | 'LEASE_SECONDS_INVALID' | 'NOT_ADMIN', message: string) {
    super(message);
    this.name = 'JobStoreError';
  }
}

// A type alias, not an interface: only an object type gets the implicit index
// signature `QueryResultRowLike` asks for.
type JobRow = {
  readonly id: string;
  readonly workspace_id: string;
  readonly kind: string;
  readonly idempotency_key: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly fencing_token: string;
  readonly lease_owner: string;
  readonly lease_expires_at: Date;
};

function toClaim(row: JobRow): ClaimedJob {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    payload: row.payload,
    attempt: row.attempt_count,
    maxAttempts: row.max_attempts,
    fencingToken: row.fencing_token,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at.toISOString(),
  };
}

/**
 * Insert a job, or find that its idempotency key already materialized it.
 *
 * `ON CONFLICT DO NOTHING` returns no row, so the second statement reads the one that
 * is already there. Two transactions racing on the same key serialize on the unique
 * index: the loser blocks until the winner commits and then takes the second branch.
 * That is Appendix G scenario 1 with or without the scheduler's advisory lock.
 */
export async function enqueueJob(db: Queryable, specification: JobSpecification): Promise<EnqueueOutcome> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, run_at, not_before, max_attempts)
     VALUES ($1, $2, $3::jsonb, $4, coalesce($5::timestamptz, now()), coalesce($6::timestamptz, now()), coalesce($7::integer, 4))
     ON CONFLICT (workspace_id, kind, idempotency_key) DO NOTHING
     RETURNING id`,
    [
      specification.workspaceId,
      specification.kind,
      JSON.stringify(specification.payload),
      specification.idempotencyKey,
      specification.runAt ?? null,
      specification.notBefore ?? null,
      specification.maxAttempts ?? null,
    ],
  );
  const first = inserted.rows[0];
  if (first !== undefined) return { inserted: true, jobId: first.id };

  const existing = await db.query<{ id: string }>(
    'SELECT id FROM jobs WHERE workspace_id = $1 AND kind = $2 AND idempotency_key = $3',
    [specification.workspaceId, specification.kind, specification.idempotencyKey],
  );
  return { inserted: false, jobId: existing.rows[0]?.id ?? '' };
}

export interface ClaimOptions {
  /** Who is claiming. A task identifier, never a credential. */
  readonly owner: string;
  /** Only kinds this worker has a registered handler for. */
  readonly kinds: readonly string[];
  readonly limit: number;
  readonly leaseSeconds: number;
}

/**
 * Claim up to `limit` runnable jobs. `SELECT … FOR UPDATE SKIP LOCKED` over the
 * runnable partial index, so a second worker running the same statement at the same
 * instant takes different rows rather than waiting.
 */
export async function claimJobs(db: Queryable, options: ClaimOptions): Promise<ClaimedJob[]> {
  if (!Number.isFinite(options.leaseSeconds) || options.leaseSeconds <= 0) {
    throw new JobStoreError('LEASE_SECONDS_INVALID', 'a lease lasts a positive number of seconds');
  }
  if (options.kinds.length === 0) return [];
  const { rows } = await db.query<JobRow>(
    `WITH candidate AS (
       SELECT workspace_id, id
         FROM jobs
        WHERE state IN ('queued', 'retryable')
          AND kind = ANY($1::text[])
          AND run_at <= now()
          AND not_before <= now()
          AND attempt_count < max_attempts
        ORDER BY run_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT $2
     )
     UPDATE jobs AS j
        SET state = 'running',
            lease_owner = $3,
            lease_expires_at = now() + make_interval(secs => $4::double precision),
            claimed_at = now(),
            attempt_count = j.attempt_count + 1,
            fencing_token = j.fencing_token + 1,
            updated_at = now()
       FROM candidate AS c
      WHERE j.workspace_id = c.workspace_id AND j.id = c.id
    RETURNING j.id, j.workspace_id, j.kind, j.idempotency_key, j.payload,
              j.attempt_count, j.max_attempts, j.fencing_token::text AS fencing_token,
              j.lease_owner, j.lease_expires_at`,
    [[...options.kinds], Math.trunc(options.limit), options.owner, options.leaseSeconds],
  );
  return rows.map(toClaim);
}

/** `completed` when this worker still held the lease it was handed; `lease_lost` otherwise. */
export async function completeJob(db: Queryable, claim: ClaimedJob): Promise<'completed' | 'lease_lost'> {
  const { rowCount } = await db.query(
    `UPDATE jobs
        SET state = 'done',
            completed_at = now(),
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_code = NULL,
            error_detail = NULL,
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND state = 'running'
        AND lease_owner = $3 AND fencing_token = $4::bigint`,
    [claim.workspaceId, claim.id, claim.leaseOwner, claim.fencingToken],
  );
  return (rowCount ?? 0) === 1 ? 'completed' : 'lease_lost';
}

export interface JobFailure {
  /** A short stable code. `jobs_error_code_shape` refuses a sentence. */
  readonly code: string;
  /** Bounded and redacted: an operator hint, never a body or a credential. */
  readonly detail?: string | undefined;
  readonly backoff?: BackoffPolicy | undefined;
  readonly random?: (() => number) | undefined;
}

export type FailOutcome = 'retryable' | 'dead' | 'lease_lost';

/**
 * Record a failed attempt. The job becomes `retryable` with a bounded exponential
 * delay, or `dead` once its attempts are exhausted — visible to admins and
 * requeueable only by the audited command below (13.2).
 */
export async function failJob(db: Queryable, claim: ClaimedJob, failure: JobFailure): Promise<FailOutcome> {
  const exhausted = isExhausted(claim.attempt, claim.maxAttempts);
  const delay = exhausted ? 0 : backoffSeconds(claim.attempt, failure.backoff ?? DEFAULT_BACKOFF, failure.random ?? (() => 0));
  const { rows } = await db.query<{ state: string }>(
    `UPDATE jobs
        SET state = CASE WHEN $5::boolean THEN 'dead' ELSE 'retryable' END,
            dead_at = CASE WHEN $5::boolean THEN now() ELSE NULL END,
            run_at = CASE WHEN $5::boolean THEN run_at ELSE now() + make_interval(secs => $6::double precision) END,
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_code = $7,
            error_detail = $8,
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND state = 'running'
        AND lease_owner = $3 AND fencing_token = $4::bigint
    RETURNING state`,
    [
      claim.workspaceId,
      claim.id,
      claim.leaseOwner,
      claim.fencingToken,
      exhausted,
      delay,
      failure.code,
      failure.detail ?? null,
    ],
  );
  const state = rows[0]?.state;
  if (state === 'dead' || state === 'retryable') return state;
  return 'lease_lost';
}

/** Extend a lease this worker still holds. A long handler renews rather than gambling. */
export async function renewLease(db: Queryable, claim: ClaimedJob, leaseSeconds: number): Promise<'renewed' | 'lease_lost'> {
  const { rowCount } = await db.query(
    `UPDATE jobs
        SET lease_expires_at = now() + make_interval(secs => $5::double precision), updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND state = 'running'
        AND lease_owner = $3 AND fencing_token = $4::bigint`,
    [claim.workspaceId, claim.id, claim.leaseOwner, claim.fencingToken, leaseSeconds],
  );
  return (rowCount ?? 0) === 1 ? 'renewed' : 'lease_lost';
}

/**
 * Return expired running leases to the runnable set, through the second partial index
 * (13.2: "Expired running leases are indexed separately"). The fencing token is not
 * touched here: the next claim increments it, which is what makes the old owner's
 * token stale rather than merely old.
 */
export async function reclaimExpiredLeases(db: Queryable, options: { readonly limit: number }): Promise<number> {
  const { rowCount } = await db.query(
    `WITH expired AS (
       SELECT workspace_id, id
         FROM jobs
        WHERE state = 'running' AND lease_expires_at < now()
        ORDER BY lease_expires_at
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     )
     UPDATE jobs AS j
        SET state = CASE WHEN j.attempt_count >= j.max_attempts THEN 'dead' ELSE 'retryable' END,
            dead_at = CASE WHEN j.attempt_count >= j.max_attempts THEN now() ELSE NULL END,
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_code = 'lease_expired',
            error_detail = 'The lease expired before the worker reported an outcome.',
            updated_at = now()
       FROM expired AS e
      WHERE j.workspace_id = e.workspace_id AND j.id = e.id`,
    [Math.trunc(options.limit)],
  );
  return rowCount ?? 0;
}

/**
 * Archive completed payloads after the operational window (13.2: "Completed payloads
 * are archived after the operational window; durable business dedupe remains for its
 * required horizon"). The row and its `(workspace_id, kind, idempotency_key)` survive,
 * so the dedupe the queue promises is unaffected; only the payload and the error hint
 * go, because a payload may name a prospect and the operational reason to keep it has
 * passed. See docs/decisions/g5-payload-archival.md.
 */
export async function archiveCompletedPayloads(
  db: Queryable,
  options: { readonly olderThanSeconds: number; readonly limit: number },
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE jobs
        SET payload = '{}'::jsonb, error_detail = NULL, payload_archived_at = now(), updated_at = now()
      WHERE (workspace_id, id) IN (
        SELECT workspace_id, id
          FROM jobs
         WHERE state = 'done'
           AND payload_archived_at IS NULL
           AND completed_at < now() - make_interval(secs => $1::double precision)
         ORDER BY completed_at
         LIMIT $2
      )`,
    [options.olderThanSeconds, Math.trunc(options.limit)],
  );
  return rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Admin-facing reads and commands. These are scoped like every other repository
// function: the workspace comes from the scope, never from the request.
// ---------------------------------------------------------------------------

export interface DeadJob {
  readonly id: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly requeuedCount: number;
  readonly errorCode: string | null;
  readonly errorDetail: string | null;
  readonly deadAt: string;
}

export async function listDeadJobs(
  context: RepositoryContext,
  options: { readonly limit?: number | undefined } = {},
): Promise<DeadJob[]> {
  const { rows } = await context.db.query<{
    id: string;
    kind: string;
    idempotency_key: string;
    attempt_count: number;
    max_attempts: number;
    requeued_count: number;
    error_code: string | null;
    error_detail: string | null;
    dead_at: Date;
  }>(
    `SELECT id, kind, idempotency_key, attempt_count, max_attempts, requeued_count, error_code, error_detail, dead_at
       FROM jobs
      WHERE workspace_id = $1 AND state = 'dead'
      ORDER BY dead_at
      LIMIT $2`,
    [context.scope.workspaceId, Math.trunc(options.limit ?? 100)],
  );
  return rows.map(row => ({
    id: row.id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    attempts: row.attempt_count,
    maxAttempts: row.max_attempts,
    requeuedCount: row.requeued_count,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    deadAt: row.dead_at.toISOString(),
  }));
}

export type RequeueOutcome =
  | { readonly requeued: true; readonly jobId: string; readonly kind: string }
  | { readonly requeued: false; readonly reason: 'not_admin' | 'not_dead' };

/**
 * Requeue a dead job. Admin only, and audited in the same transaction as the state
 * transition (Appendix A: "Requeue dead job … State transition and audit").
 *
 * The idempotency key is deliberately unchanged, so a requeue can never materialize a
 * second copy of work that already exists.
 */
export async function requeueDeadJob(
  context: RepositoryContext,
  options: { readonly jobId: string; readonly reason: string },
): Promise<RequeueOutcome> {
  if (!isAdminScope(context.scope)) return { requeued: false, reason: 'not_admin' };
  const actor = context.scope.actor;
  const actorUserId = actor.kind === 'user' ? actor.userId : null;

  const { rows } = await context.db.query<{ kind: string }>(
    `UPDATE jobs
        SET state = 'queued',
            dead_at = NULL,
            attempt_count = 0,
            requeued_count = requeued_count + 1,
            run_at = now(),
            not_before = now(),
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_code = NULL,
            error_detail = NULL,
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND state = 'dead'
    RETURNING kind`,
    [context.scope.workspaceId, options.jobId],
  );
  const kind = rows[0]?.kind;
  if (kind === undefined) return { requeued: false, reason: 'not_dead' };

  await context.db.query(
    `INSERT INTO audit_events (workspace_id, actor_kind, actor_user_id, action, subject_kind, subject_id, detail)
     VALUES ($1, 'admin', $2, 'job.requeue', 'job', $3, $4::jsonb)`,
    [context.scope.workspaceId, actorUserId, options.jobId, JSON.stringify({ kind, reason: options.reason })],
  );
  return { requeued: true, jobId: options.jobId, kind };
}

/** A guard the runner uses so an unregistered kind is never claimed by accident. */
export function assertKnownKind(kind: string): JobKind {
  if (!isJobKind(kind)) throw new JobStoreError('JOB_KIND_UNKNOWN', `${kind} is not a job kind of Appendix C`);
  return kind;
}
