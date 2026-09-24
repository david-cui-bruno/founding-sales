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
 * set and leaves it alone, so the latency the alarm reads is the latency of the real
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

/**
 * The newest canary run's scheduler-to-worker latency, in seconds. Null when no run
 * exists at all — a database with no `canary_runs` row has nothing to say, and the
 * alarm's `treat_missing_data = "breaching"` is what says it (g39).
 *
 * **This is a latency, not an age since the last completion**, and the difference is
 * the whole of `docs/decisions/g41-the-canary-age-is-the-newest-runs-latency.md`. A
 * canary is inserted once per workspace per *quarter hour*, so "seconds since the
 * newest completion" — which this was until g41 — is a sawtooth that climbs to 900
 * between canaries and spends about ten minutes in every fifteen above the five-minute
 * threshold 13.3 names. The first production smoke read 359 s off a perfectly healthy
 * system and failed, and `fss-prod-canary-stale` flapped OK→ALARM→OK three times in
 * the first hour (release.md 8.0r).
 *
 * What 13.3's sentence actually describes is the gap between a run being inserted and
 * the same run being completed: `completed_at - inserted_at` once the worker has
 * written it, and `now() - inserted_at` while it has not. On a healthy system that is
 * a few seconds whatever the moment; when the worker is dead the newest run never
 * completes and the value passes 300 within five minutes, which is exactly the alarm
 * and exactly the smoke check.
 *
 * **The worst of the newest runs, not the newest run.** The canary is per workspace,
 * so `DISTINCT ON (workspace_id) … ORDER BY workspace_id, inserted_at DESC` takes each
 * workspace's newest run and `max` takes the worst latency among them. A single
 * `ORDER BY inserted_at DESC LIMIT 1` would let one workspace whose canary completes
 * normally hide another whose canary never completes at all, which is the failure this
 * metric exists to notice.
 */
export async function canaryCompletionAgeSeconds(db: Queryable): Promise<number | null> {
  const { rows } = await db.query<{ age_seconds: string | null }>(
    `WITH newest_per_workspace AS (
       SELECT DISTINCT ON (workspace_id) inserted_at, completed_at
         FROM canary_runs
        ORDER BY workspace_id, inserted_at DESC
     )
     SELECT max(extract(epoch FROM coalesce(completed_at, now()) - inserted_at))::text AS age_seconds
       FROM newest_per_workspace`,
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
