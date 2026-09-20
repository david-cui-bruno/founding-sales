import type { RepositoryContext } from '../db/workspaceScope.ts';
import { localDate } from '../src/rules/localClock.ts';

/**
 * Daily counters (specification 13.3: "Daily counters are keyed by workspace,
 * owner/mailbox, kind, and explicit workspace business date"; Appendix D).
 *
 * Two things make this harder than `count = count + 1`.
 *
 * The date is a *business* date in the workspace's configurable zone, not a UTC date
 * and not the host's. It is computed here and stored beside the zone that produced it,
 * so changing the workspace zone later cannot silently re-date yesterday's sends.
 *
 * The ceiling has to be enforced in the same statement as the increment. A read of
 * "are we under the cap?" followed by a write is the classic way to send the
 * fifty-first message of a fifty-message day, and the mailbox ramp of 12.7 is exactly
 * the thing that must not be approximate.
 */

export const COUNTER_SUBJECT_KINDS = ['workspace', 'owner', 'mailbox', 'domain'] as const;
export type CounterSubjectKind = (typeof COUNTER_SUBJECT_KINDS)[number];

export interface CounterKey {
  readonly subjectKind: CounterSubjectKind;
  /** The owner's user id, the mailbox address, the domain, or the workspace slug. */
  readonly subjectKey: string;
  /** Lower snake case, e.g. `automated_sends`. `daily_counters_counter_kind_shape` refuses the rest. */
  readonly counterKind: string;
  /** The workspace's business zone. Appendix D: caps count in this zone. */
  readonly businessTimeZone: string;
  /** The instant to date. The business date is derived, never passed in. */
  readonly at: string;
}

export type CounterOutcome =
  | { readonly allowed: true; readonly count: number; readonly businessDate: string }
  | { readonly allowed: false; readonly count: number; readonly businessDate: string; readonly reason: 'ceiling_reached' };

/**
 * Increment by one if, and only if, the result stays at or under `ceiling`.
 *
 * One statement. `ON CONFLICT … DO UPDATE … WHERE` returns no row when the `WHERE`
 * is false, which is how "the cap refused it" is distinguished from "it worked"
 * without a second read. The insert branch is guarded separately, because a ceiling
 * of zero must refuse the very first increment too.
 */
export async function incrementDailyCounter(
  context: RepositoryContext,
  key: CounterKey,
  ceiling: number,
): Promise<CounterOutcome> {
  const businessDate = localDate(key.at, key.businessTimeZone);
  if (!Number.isFinite(ceiling) || ceiling < 1) {
    return { allowed: false, count: await readDailyCounter(context, key), businessDate, reason: 'ceiling_reached' };
  }

  const { rows } = await context.db.query<{ count: number }>(
    `INSERT INTO daily_counters
       (workspace_id, subject_kind, subject_key, counter_kind, business_date, business_time_zone, count, updated_at)
     VALUES ($1, $2, $3, $4, $5::date, $6, 1, now())
     ON CONFLICT (workspace_id, subject_kind, subject_key, counter_kind, business_date)
     DO UPDATE SET count = daily_counters.count + 1, updated_at = now()
              WHERE daily_counters.count < $7::integer
     RETURNING count`,
    [
      context.scope.workspaceId,
      key.subjectKind,
      key.subjectKey,
      key.counterKind,
      businessDate,
      key.businessTimeZone,
      Math.trunc(ceiling),
    ],
  );
  const count = rows[0]?.count;
  if (count === undefined) {
    return { allowed: false, count: await readDailyCounter(context, key), businessDate, reason: 'ceiling_reached' };
  }
  return { allowed: true, count, businessDate };
}

/** The counter as it stands. Zero when no row exists; a missing row is not an error. */
export async function readDailyCounter(context: RepositoryContext, key: CounterKey): Promise<number> {
  const businessDate = localDate(key.at, key.businessTimeZone);
  const { rows } = await context.db.query<{ count: number }>(
    `SELECT count FROM daily_counters
      WHERE workspace_id = $1 AND subject_kind = $2 AND subject_key = $3
        AND counter_kind = $4 AND business_date = $5::date`,
    [context.scope.workspaceId, key.subjectKind, key.subjectKey, key.counterKind, businessDate],
  );
  return rows[0]?.count ?? 0;
}
