import type { Queryable } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';

/**
 * Database time (specification 9.2, 10.2, Appendix D).
 *
 * "A salesperson may correct only their own mistaken manual suppression within ten
 * minutes of database time." "Exactly one applicable state posture whose effective
 * range contains database time." Both sentences name the database's clock, and no
 * process's own.
 *
 * Every decision this lane makes reads it once and passes the value down. Reading it
 * again inside each statement would make one decision out of several instants: a
 * posture could expire between the posture check and the window check, and the
 * refusal would name neither the state it was nor the state it became. See
 * `docs/decisions/g4-database-time-is-a-parameter.md`.
 */
export async function databaseNow(context: RepositoryContext | { readonly db: Queryable }): Promise<string> {
  const { rows } = await context.db.query<{ now: Date }>('SELECT now() AS now');
  const now = rows[0]?.now;
  if (now === undefined) throw new Error('the database did not answer with its clock');
  return now.toISOString();
}
