import type { RepositoryContext } from '../db/workspaceScope.ts';

/**
 * How many calls were placed today (specification 8.2; David, 29 September 2026).
 *
 * The seven-day figures on Today already say how many calls were placed in the window
 * they cover, which is the number that tells somebody whether the week went well. It is
 * not the number that tells them whether *this morning* has gone anywhere, and that is
 * the one a person working a call list wants in front of them. So this is a read of its
 * own rather than a narrower dashboard window: the count is for one business date, and
 * the business date is not a seven-day window with a different end.
 *
 * **"Today" is the workspace's today.** The date is `now` in `business_time_zone`, and a
 * call counts when `occurred_at` falls on that same local date — computed by PostgreSQL
 * in the workspace's zone, the same way `businessDateOf` and the 05:00 build compute it
 * (Appendix D). A call placed at 23:50 in the workspace's evening is on that day and not
 * the next, whatever UTC says about it, and a zone changed in Settings moves the boundary
 * for the next read rather than reinterpreting the calls already recorded.
 *
 * **`occurred_at`, not `recorded_at`.** A call can be recorded a little after it was
 * placed, and one placed late last night and recorded after midnight belongs to the night
 * it happened. `recorded_at` is the server's clock on the insert; `occurred_at` is the
 * fact being counted.
 *
 * **Who it counts for is 8.2's rule, not a parameter.** "Admins see all entries;
 * salespeople see their own": an administrator is told the workspace's calls, a
 * salesperson the calls at the firms assigned to them. The scope's own actor decides, as
 * it does for the Today list itself, so a route cannot widen it.
 *
 * Read-only. Nothing here writes, locks or enqueues.
 */

export interface CallsPlacedTodayDto {
  /** The workspace business date `now` falls on, in the workspace's own zone. */
  readonly businessDate: string;
  readonly businessTimeZone: string;
  /** Calls whose `occurred_at` falls on that local date, for this caller's audience. */
  readonly calls: number;
}

/** The workspace's calls on its own business date: null for nobody, 0 for none. */
export async function readCallsPlacedToday(
  context: RepositoryContext,
  options: { readonly now?: string | undefined } = {},
): Promise<CallsPlacedTodayDto> {
  const actor = context.scope.actor;
  // 8.2: a salesperson is counted their own firms' calls, an admin the workspace's. The
  // scheduler and the worker read as the workspace, as they do everywhere else.
  const assignedUserId = actor.kind === 'user' && actor.role !== 'admin' ? actor.userId : null;
  const { rows } = await context.db.query<{ business_date: string; zone: string; calls: string }>(
    `SELECT (local.at)::date::text AS business_date,
            w.business_time_zone AS zone,
            (SELECT count(*)
               FROM call_logs c
               JOIN firms f ON f.workspace_id = c.workspace_id AND f.id = c.firm_id
              WHERE c.workspace_id = w.id
                AND (c.occurred_at AT TIME ZONE w.business_time_zone)::date = (local.at)::date
                AND ($3::uuid IS NULL OR f.assigned_user_id = $3::uuid))::text AS calls
       FROM workspaces w
       CROSS JOIN LATERAL (
         SELECT (coalesce($2::timestamptz, now()) AT TIME ZONE w.business_time_zone) AS at
       ) local
      WHERE w.id = $1`,
    [context.scope.workspaceId, options.now ?? null, assignedUserId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('the workspace has no business time zone');
  return { businessDate: row.business_date, businessTimeZone: row.zone, calls: Number(row.calls) };
}
