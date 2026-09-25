import type { Queryable } from '../db/queryable.ts';
import { jobIdempotencyKey } from '../jobs/jobKinds.ts';
import type { MetricDatum } from '../jobs/metrics.ts';
import { TODAY_ALGORITHM_VERSION } from './types.ts';

/**
 * The Today lane's gauge, `TodaySnapshotMissing` (specification 8.2, 13.3; lane g67).
 *
 * 13.3 alarms on "Today snapshot absent at 05:10 workspace time". The alarm in
 * `infra/modules/alerts/main.tf` is `Maximum >= 1` over one five-minute period with
 * missing data ignored, so this gauge is published on every metric pass, with no
 * dimensions: 1 when any workspace is past 05:10 on its business date without that
 * day's list, 0 otherwise. Until g67 nothing published it and the alarm sat in
 * INSUFFICIENT_DATA before and after the first 05:00 build alike.
 *
 * **The signal is the job, not the rows.** A workspace with no firms, no callbacks
 * and no due work produces no `today_snapshots` rows at all when its build runs
 * (`docs/greenfield/today.md`), and production on 25 September 2026 is one workspace
 * with zero firms. "Rows exist" would page every morning over a list that was built
 * and is honestly empty. What 8.2 promises is that the 05:00 build ran, and the
 * evidence of that is the `today.build` job under Appendix C's key
 * `today:{workspace}:{business_date}:{algorithm}` in state `done`. Queued, running,
 * retryable and dead are all "not built": each is a morning without its list, and a
 * dead one is also what `dead_job_unresolved` reads, with its error code.
 *
 * **"Today" is the scheduler's today.** The business date and the local minute come
 * from `workspaces.business_time_zone`, computed by PostgreSQL with the same
 * expression `todayBuildSource` uses to materialize the job, and the key is built by
 * the same `jobIdempotencyKey.todayList` with the same `TODAY_ALGORITHM_VERSION`. So
 * the job this looks for is exactly the job the scheduler inserts, a job completed
 * for yesterday's date never counts for today's, and a zone changed in Settings moves
 * the deadline with the build.
 *
 * Two events read 1 on a healthy system, briefly: a release that changes
 * `TODAY_ALGORITHM_VERSION` after 05:10, and a workspace created after 05:10. Each
 * key has no `done` row until the next scheduler pass materializes it and a runner
 * completes it, usually within a minute, and one such datapoint is enough for the
 * alarm. Both are rare in a single-user deployment and both are in the runbook.
 */

export const TODAY_METRIC_NAMES: readonly string[] = Object.freeze(['TodaySnapshotMissing']);

/** 05:10 in the workspace business zone (13.3), as minutes past local midnight. */
export const TODAY_SNAPSHOT_DEADLINE_LOCAL_MINUTE = 5 * 60 + 10;

export interface TodaySnapshotReading {
  readonly workspaceId: string;
  /** The workspace business date `now` falls on, in its own zone. */
  readonly businessDate: string;
  /** At or past 05:10 local on that date: the list is owed. */
  readonly due: boolean;
  /** That date's `today.build` job, under the current algorithm version, is `done`. */
  readonly built: boolean;
  /** `due && !built`, which is what the gauge reports. */
  readonly missing: boolean;
}

/**
 * Every workspace's Today status at `now` (database `now()` when absent), in
 * workspace order.
 *
 * Two reads: the workspaces with their local date and minute, then the `today.build`
 * rows for their keys, looked up by `(workspace_id, kind, idempotency_key)` as
 * `enqueueJob` does. The key is built here in TypeScript, never concatenated in SQL,
 * so it cannot drift from the one the scheduler materializes.
 */
export async function readTodaySnapshotStatus(
  db: Queryable,
  now?: string | undefined,
): Promise<TodaySnapshotReading[]> {
  const { rows } = await db.query<{ id: string; slug: string; business_date: string; due: boolean }>(
    `SELECT w.id, w.slug, (local.at)::date::text AS business_date,
            extract(hour FROM local.at) * 60 + extract(minute FROM local.at) >= $2 AS due
       FROM workspaces w
       CROSS JOIN LATERAL (
         SELECT (coalesce($1::timestamptz, now()) AT TIME ZONE w.business_time_zone) AS at
       ) local
      ORDER BY w.id`,
    [now ?? null, TODAY_SNAPSHOT_DEADLINE_LOCAL_MINUTE],
  );
  if (rows.length === 0) return [];

  const keys = rows.map(row => jobIdempotencyKey.todayList(row.slug, row.business_date, TODAY_ALGORITHM_VERSION));
  const done = await db.query<{ workspace_id: string }>(
    `SELECT j.workspace_id
       FROM unnest($1::uuid[], $2::text[]) AS wanted(workspace_id, idempotency_key)
       JOIN jobs j
         ON j.workspace_id = wanted.workspace_id
        AND j.kind = 'today.build'
        AND j.idempotency_key = wanted.idempotency_key
      WHERE j.state = 'done'`,
    [rows.map(row => row.id), keys],
  );
  const built = new Set(done.rows.map(row => row.workspace_id));

  return rows.map(row => {
    const isBuilt = built.has(row.id);
    return {
      workspaceId: row.id,
      businessDate: row.business_date,
      due: row.due,
      built: isBuilt,
      missing: row.due && !isBuilt,
    };
  });
}

/**
 * Everything the Today lane publishes on one metric pass: one `TodaySnapshotMissing`
 * datum, the maximum over workspaces, which is the statistic the alarm reads.
 *
 * Always published, including as 0 with no workspace at all, so the alarm is OK
 * rather than INSUFFICIENT_DATA whenever the worker is publishing. No dimension:
 * the alarm has none, and 13.3's metrics are aggregate. Which workspace is short is
 * `readTodaySnapshotStatus`'s answer, and the runbook's first check.
 */
export async function collectTodayMetrics(
  db: Queryable,
  options: { readonly now?: string | undefined } = {},
): Promise<readonly MetricDatum[]> {
  const readings = await readTodaySnapshotStatus(db, options.now);
  const missing = readings.some(reading => reading.missing);
  return [{ name: 'TodaySnapshotMissing', value: missing ? 1 : 0, unit: 'Count' }];
}
