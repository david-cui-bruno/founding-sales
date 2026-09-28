import type { RepositoryContext } from '../db/workspaceScope.ts';
import { localDate } from '../src/rules/localClock.ts';

/**
 * What a paid provider cost, per workspace business date (`provider_ledger`).
 *
 * Deliberately generic rather than `research_provider_ledger`: lane C (Twilio) and
 * lane D need the same three numbers, and three tables with the same columns would be
 * three places to get the business date wrong. Both functions take the zone as an
 * argument for the same reason `daily_counters` stores it — the date is derived here
 * and never passed in, so changing the workspace zone later cannot re-date yesterday.
 *
 * ## Why this is not `daily_counters`
 *
 * A counter answers "how many more may I start today" in one atomic statement, and it
 * has to, because the alternative is the fifty-first call of a fifty-call day. A
 * ledger answers "what did it cost and what failed", which is only knowable *after*
 * the call. One table doing both would mean either a ceiling that is not atomic or an
 * accounting row written in the same statement as a decision that has to be made
 * before the thing it is accounting for happened.
 */

/** The workspace's business zone. Read here rather than imported from `today`, to keep
 * `packages/domain/research` free of a cycle with a module that reads the brief. */
export async function workspaceBusinessZone(context: RepositoryContext): Promise<string> {
  const { rows } = await context.db.query<{ business_time_zone: string }>(
    'SELECT business_time_zone FROM workspaces WHERE id = $1',
    [context.scope.workspaceId],
  );
  return rows[0]?.business_time_zone ?? 'America/New_York';
}

export interface RecordProviderCallInput {
  readonly providerKey: string;
  /** Database time. One run dates every write it makes identically. */
  readonly at: string;
  readonly businessTimeZone: string;
  readonly costCents: number;
  /** A short lower-snake code. `provider_ledger_failure_code_shape` refuses the rest. */
  readonly failureCode?: string | undefined;
}

/**
 * Record one call. One statement: the row is created on the first call of the day and
 * incremented after that, so two workers finishing at once cannot lose a cent.
 */
export async function recordProviderCall(
  context: RepositoryContext,
  input: RecordProviderCallInput,
): Promise<void> {
  const businessDate = localDate(input.at, input.businessTimeZone);
  const failed = input.failureCode !== undefined;
  const cents = Math.max(0, Math.trunc(input.costCents));
  await context.db.query(
    `INSERT INTO provider_ledger
       (workspace_id, provider_key, business_date, business_time_zone, calls, failures, cost_cents,
        last_failure_code, last_failure_at, updated_at)
     VALUES ($1, $2, $3::date, $4, 1, $5::integer, $6::integer, $7, $8, now())
     ON CONFLICT (workspace_id, provider_key, business_date) DO UPDATE
        SET calls = provider_ledger.calls + 1,
            failures = provider_ledger.failures + $5::integer,
            cost_cents = provider_ledger.cost_cents + $6::integer,
            -- The *last* failure, so a day that recovered still says what went wrong.
            last_failure_code = COALESCE($7, provider_ledger.last_failure_code),
            last_failure_at = COALESCE($8, provider_ledger.last_failure_at),
            updated_at = now()`,
    [
      context.scope.workspaceId,
      input.providerKey,
      businessDate,
      input.businessTimeZone,
      failed ? 1 : 0,
      cents,
      input.failureCode ?? null,
      failed ? input.at : null,
    ],
  );
}

export interface Spend {
  readonly todayCents: number;
  readonly monthToDateCents: number;
}

/**
 * Everything every provider has cost today and this month, in the workspace's zone.
 *
 * Across providers on purpose. The ceilings are the workspace's budget, not research's
 * — when lane C starts writing call minutes here, a day that spent its budget on calls
 * should stop researching, because David's answer 8 puts calls ahead of everything
 * else.
 */
export async function readSpend(
  context: RepositoryContext,
  input: { readonly businessTimeZone: string; readonly at: string },
): Promise<Spend> {
  const businessDate = localDate(input.at, input.businessTimeZone);
  const monthStart = `${businessDate.slice(0, 7)}-01`;
  const { rows } = await context.db.query<{ today: string | null; month: string | null }>(
    `SELECT sum(cost_cents) FILTER (WHERE business_date = $2::date) AS today,
            sum(cost_cents) FILTER (WHERE business_date >= $3::date AND business_date <= $2::date) AS month
       FROM provider_ledger
      WHERE workspace_id = $1`,
    [context.scope.workspaceId, businessDate, monthStart],
  );
  const row = rows[0];
  return { todayCents: Number(row?.today ?? 0), monthToDateCents: Number(row?.month ?? 0) };
}
