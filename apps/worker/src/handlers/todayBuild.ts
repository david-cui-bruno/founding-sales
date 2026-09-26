import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import type { JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';
import { jobIdempotencyKey } from '@fss/domain/jobs/jobKinds.ts';
import type { JobSpecification } from '@fss/domain/jobs/jobStore.ts';
import { buildTodaySnapshot, type TodaySource } from '@fss/domain/today/build.ts';
import { TODAY_ALGORITHM_VERSION } from '@fss/domain/today/types.ts';
import type { DueWorkSource } from '../scheduler/schedulerPass.ts';

/**
 * The `today.build` job and the source that materializes it (specification 8.2,
 * 13.1, 13.3, Appendix C).
 *
 * Appendix C: "Today list | `today:{workspace}:{business_date}:{algorithm}` | Snapshot
 * uniqueness". All three parts of the key matter. The workspace, because the list is
 * per workspace. The business date, because a pass at 05:00 and a pass at 05:01 are
 * the same work and must produce one job. The algorithm version, because changing the
 * ordering rules makes it *different* work rather than a second attempt at the old
 * work — a job whose key did not name the algorithm would be deduplicated against the
 * morning's run and the new rules would not be applied until tomorrow.
 *
 * The protection is `business_uniqueness`, which is Appendix C's third column and what
 * the registry enforces. It is real rather than nominal: the build is an upsert over
 * `UNIQUE(workspace_id, snapshot_date, firm_id, item_key)`, so a second run writes the
 * same rows, and the stolen-lease probe in `apps/worker/test/todayBuild.test.ts`
 * proves it against a real theft rather than by calling the handler twice.
 */

/** 05:00 in the workspace business zone (8.2), as minutes past local midnight. */
export const TODAY_BUILD_LOCAL_MINUTE = 5 * 60;

export function todayBuildJobKey(workspaceSlug: string, businessDate: string): string {
  return jobIdempotencyKey.todayList(workspaceSlug, businessDate, TODAY_ALGORITHM_VERSION);
}

export interface TodayBuildHandlerOptions {
  readonly maxAttempts?: number;
  readonly leaseSeconds?: number;
  /** The reply and sequence lanes pass theirs. Absent means the default two. */
  readonly sources?: readonly TodaySource[] | undefined;
}

export function todayBuildJobHandler(options: TodayBuildHandlerOptions = {}): JobHandler {
  return {
    kind: 'today.build',
    protection: 'business_uniqueness',
    // Four attempts and sixty seconds, the defaults from
    // docs/decisions/g5-retry-ladder.md. The build is a handful of indexed reads and
    // an upsert per task; nothing in it is slow.
    maxAttempts: options.maxAttempts ?? 4,
    leaseSeconds: options.leaseSeconds ?? 60,
    handle: async input => {
      const businessDate = input.job.payload['businessDate'];
      const algorithmVersion = input.job.payload['algorithmVersion'];
      if (typeof businessDate !== 'string') {
        throw new Error('a today.build payload names the business date it builds');
      }
      // The algorithm version is in the key, so a payload naming another one is a job
      // materialized by a binary this one does not agree with. Refusing is the same
      // decision the schema range makes at startup: do not write rows under a
      // contract you cannot honour.
      if (algorithmVersion !== undefined && algorithmVersion !== TODAY_ALGORITHM_VERSION) {
        throw new Error(
          `this binary builds ${TODAY_ALGORITHM_VERSION}, not ${String(algorithmVersion)}`,
        );
      }

      const { rows } = await input.session.query<{ now: Date }>('SELECT now() AS now');
      const now = (rows[0]?.now ?? new Date()).toISOString();
      await buildTodaySnapshot(
        repositoryContext(workspaceScope(input.scope.workspaceId, { kind: 'system', component: 'worker' }), input.session),
        {
          businessDate,
          now,
          ...(options.sources === undefined ? {} : { sources: options.sources }),
        },
      );
    },
  };
}

/**
 * The due-work source (13.1).
 *
 * One job per workspace per business date, from the first pass at or after 05:00 local
 * — and one for the whole of the rest of the day, because the idempotency key is the
 * business date and `UNIQUE(workspace_id, kind, idempotency_key)` refuses the second.
 * A workspace whose scheduler was down at 05:00 gets its list on the first pass after
 * it comes back rather than not at all, which is also what makes 13.3's "Today
 * snapshot absent at 05:10 workspace time" an alarm about a real outage.
 *
 * The date and the local minute are computed by PostgreSQL from the workspace's own
 * `business_time_zone`, so a worker running in another region materializes the same
 * job as one running beside the database.
 */
export function todayBuildSource(): DueWorkSource {
  return {
    name: 'today-build',
    find: async (session: SessionQueryable, now: string): Promise<readonly JobSpecification[]> => {
      const { rows } = await session.query<{ id: string; slug: string; business_date: string }>(
        `SELECT w.id, w.slug, (local.at)::date::text AS business_date
           FROM workspaces w
           CROSS JOIN LATERAL (SELECT ($1::timestamptz AT TIME ZONE w.business_time_zone) AS at) local
          WHERE extract(hour FROM local.at) * 60 + extract(minute FROM local.at) >= $2
          ORDER BY w.id`,
        [now, TODAY_BUILD_LOCAL_MINUTE],
      );
      return rows.map(row => ({
        workspaceId: row.id,
        kind: 'today.build' as const,
        idempotencyKey: todayBuildJobKey(row.slug, row.business_date),
        payload: { businessDate: row.business_date, algorithmVersion: TODAY_ALGORITHM_VERSION },
        maxAttempts: 4,
      }));
    },
  };
}
