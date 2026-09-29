import type { SessionQueryable } from '@fss/domain/db/queryable.ts';

/**
 * Was the routine this migration replaced actually called?
 *
 * A `replaces-routine` migration releases without a rehearsal, so the claim that its
 * new body works has to rest on something. `pg_stat_user_functions` counts calls, and
 * `track_functions = 'all'` is turned on for the test database before the workflows
 * run, so the question "did anything exercise the replaced function" is answered by the
 * server rather than by a list somebody maintained.
 *
 * `track_functions` is a superuser setting applied to the database, which is why it is
 * set on the owner connection and why the workflow child has to connect afterwards.
 */

export const TRACK_FUNCTIONS_SETTING = 'all';

export interface RoutineCalls {
  readonly routine: string;
  readonly calls: number;
}

/** Turn function call counting on for `database`. New connections pick it up. */
export async function enableRoutineTracking(owner: SessionQueryable, database: string): Promise<void> {
  await owner.query(`ALTER DATABASE "${database}" SET track_functions = '${TRACK_FUNCTIONS_SETTING}'`);
}

/** How many times each of `routines` has been called, by bare name. */
export async function routineCalls(
  session: SessionQueryable,
  routines: readonly string[],
): Promise<readonly RoutineCalls[]> {
  if (routines.length === 0) return [];
  const { rows } = await session.query<{ routine: string; calls: string }>(
    `SELECT p.proname AS routine, coalesce(sum(s.calls), 0)::text AS calls
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       LEFT JOIN pg_stat_user_functions s ON s.funcid = p.oid
      WHERE n.nspname = 'public' AND p.proname = ANY($1)
      GROUP BY p.proname`,
    [routines],
  );
  const seen = new Map(rows.map(row => [row.routine, Number(row.calls)]));
  return routines.map(routine => ({ routine, calls: seen.get(routine) ?? 0 }));
}
