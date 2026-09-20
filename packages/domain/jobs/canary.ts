import type { Queryable } from '../db/queryable.ts';
import type { JobHandler } from './handlerRegistry.ts';
import { jobIdempotencyKey, quarterHourOf } from './jobKinds.ts';

/**
 * The canary (specification 13.3: "A canary is inserted every 15 minutes and proves
 * scheduler-to-worker completion").
 *
 * Neither heartbeat can prove this on its own. A scheduler that inserts jobs nobody
 * claims is alive; a worker with an empty queue is alive; the system between them is
 * dead, and only a row that one writes and the other completes notices.
 *
 * The quarter hour is the identity, so a second insert for the same quarter hour is
 * refused by the primary key rather than by a check the caller has to remember, and
 * the completion is written once — a replayed canary job finds `completed_at` already
 * set and leaves it alone, so the age the alarm reads is the age of the real
 * completion.
 */

export interface CanaryInsertion {
  readonly quarterHour: string;
  readonly inserted: boolean;
}

/** Insert the row for the quarter hour containing `at`. Idempotent by primary key. */
export async function insertCanaryRun(db: Queryable, workspaceId: string, at: string): Promise<CanaryInsertion> {
  const quarterHour = quarterHourOf(at);
  const { rowCount } = await db.query(
    `INSERT INTO canary_runs (workspace_id, quarter_hour) VALUES ($1, $2::timestamptz)
     ON CONFLICT (workspace_id, quarter_hour) DO NOTHING`,
    [workspaceId, quarterHour],
  );
  return { quarterHour, inserted: (rowCount ?? 0) === 1 };
}

/** The idempotency key Appendix C gives the canary job for the quarter hour of `at`. */
export function canaryJobKey(at: string): string {
  return jobIdempotencyKey.canary(quarterHourOf(at));
}

/**
 * Complete the canary run. Written once: the `completed_at IS NULL` predicate is the
 * business uniqueness that makes this handler safe to run twice.
 */
export async function completeCanaryRun(
  db: Queryable,
  workspaceId: string,
  quarterHour: string,
  completedBy: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE canary_runs
        SET completed_at = now(), completed_by = $3
      WHERE workspace_id = $1 AND quarter_hour = $2::timestamptz AND completed_at IS NULL`,
    [workspaceId, quarterHour, completedBy],
  );
  return (rowCount ?? 0) === 1;
}

/** Seconds since the newest canary completion, or null when none has ever completed. */
export async function canaryCompletionAgeSeconds(db: Queryable): Promise<number | null> {
  const { rows } = await db.query<{ age_seconds: string | null }>(
    'SELECT extract(epoch FROM now() - max(completed_at))::text AS age_seconds FROM canary_runs',
  );
  const value = rows[0]?.age_seconds;
  return value === null || value === undefined ? null : Number(value);
}

/**
 * The canary handler. Its payload names the quarter hour, so a replay completes the
 * same run rather than whichever one happens to be current when it is retried.
 */
export function canaryHandler(options: { readonly maxAttempts?: number; readonly leaseSeconds?: number } = {}): JobHandler {
  return {
    kind: 'canary',
    protection: 'business_uniqueness',
    maxAttempts: options.maxAttempts ?? 4,
    leaseSeconds: options.leaseSeconds ?? 60,
    handle: async input => {
      const quarterHour = input.job.payload['quarterHour'];
      if (typeof quarterHour !== 'string') {
        throw new Error('a canary payload names the quarter hour it proves');
      }
      await completeCanaryRun(input.session, input.scope.workspaceId, quarterHour, input.job.leaseOwner);
    },
  };
}
