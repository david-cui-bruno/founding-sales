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
 *
 * ## Why the total is still taken by bare name
 *
 * A migration's `-- replaces-routine:` header names a function the way a person does:
 * `claim_due_jobs`, with no argument list. Summing by that name is what makes "the
 * replaced routine was called" answerable at all, and a GPT-6 review round asked only
 * that the evidence stop being silent about *what* was counted — not that the total be
 * split. So the total stays name-level and each overload's own signature and count is
 * carried alongside it, which is enough for a reader of the report to see that two
 * functions share a name and that one of them was never touched.
 *
 * Attributing an overload back to the migration that replaced it is deliberately not
 * attempted: the header does not carry an argument list, so any mapping would be a
 * guess. The documentation says so in a sentence.
 */

export const TRACK_FUNCTIONS_SETTING = 'all';

/** One function in the catalogue that answers to a replaced routine's bare name. */
export interface RoutineOverload {
  /**
   * How the server identifies it: `public.claim_due_jobs(limit integer, kind text)`,
   * built from the schema, the name and `pg_get_function_identity_arguments` — the
   * argument list in the form `ALTER FUNCTION` needs, so parameter names are in and
   * default values are out. Two overloads differ in their argument *types* by
   * definition, so no two of them can render the same string.
   */
  readonly signature: string;
  /** The identity arguments alone, `limit integer, kind text`; empty for a no-argument function. */
  readonly arguments: string;
  /** Calls `pg_stat_user_functions` attributes to this `funcid`. */
  readonly calls: number;
}

export interface RoutineCalls {
  /** The bare name, exactly as asked for and as the migration header spells it. */
  readonly routine: string;
  /**
   * The sum over every overload of that name. Zero means nothing called any of them,
   * which is the failure the caller checks for.
   */
  readonly calls: number;
  /**
   * Every function of that name found in the catalogue, in signature order. Empty when
   * no function of that name exists at all, which itself leaves `calls` at zero.
   */
  readonly overloads: readonly RoutineOverload[];
}

/** Turn function call counting on for `database`. New connections pick it up. */
export async function enableRoutineTracking(owner: SessionQueryable, database: string): Promise<void> {
  await owner.query(`ALTER DATABASE "${database}" SET track_functions = '${TRACK_FUNCTIONS_SETTING}'`);
}

/**
 * How many times each of `routines` has been called, totalled by bare name, with every
 * overload's own signature and count recorded beside the total.
 *
 * Only `public` is searched, as before: every routine the migrations create lives there.
 * A routine elsewhere is simply not found, which leaves its total at zero and reads in
 * the report as "no workflow called it" — the fail-closed direction.
 */
export async function routineCalls(
  session: SessionQueryable,
  routines: readonly string[],
): Promise<readonly RoutineCalls[]> {
  if (routines.length === 0) return [];
  // Grouped by `funcid`, not by name: one row per overload, so the signature printed
  // beside a count is the signature that count belongs to. The name-level total is the
  // sum taken below, in this process, where it is visibly a sum.
  const { rows } = await session.query<{
    routine: string;
    signature: string;
    identity_arguments: string;
    calls: string;
  }>(
    `SELECT p.proname AS routine,
            n.nspname || '.' || p.proname
              || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature,
            pg_get_function_identity_arguments(p.oid) AS identity_arguments,
            coalesce(sum(s.calls), 0)::text AS calls
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       LEFT JOIN pg_stat_user_functions s ON s.funcid = p.oid
      WHERE n.nspname = 'public' AND p.proname = ANY($1)
      GROUP BY p.oid, n.nspname, p.proname
      ORDER BY p.proname, signature`,
    [routines],
  );

  const byName = new Map<string, RoutineOverload[]>();
  for (const row of rows) {
    const overload: RoutineOverload = {
      signature: row.signature,
      arguments: row.identity_arguments,
      calls: Number(row.calls),
    };
    const list = byName.get(row.routine);
    if (list === undefined) byName.set(row.routine, [overload]);
    else list.push(overload);
  }

  return routines.map(routine => {
    const overloads = byName.get(routine) ?? [];
    return {
      routine,
      calls: overloads.reduce((total, overload) => total + overload.calls, 0),
      overloads,
    };
  });
}
