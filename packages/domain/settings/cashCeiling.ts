import { monthlyCashCeilingSettingSchema } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readSpend, workspaceBusinessZone } from '../research/ledger.ts';
import { databaseNow } from '../policy/clock.ts';
import { readSetting } from './store.ts';

/**
 * The month-to-date cash ceiling (slice P1, invariant I2; migration 0031).
 *
 * Daily ceilings are not a monthly guarantee: $1.25 of calling and $0.50 of transcription
 * a day already allow $38.50 across twenty-two weekdays. So every telephony and
 * transcription reservation is also cleared against one workspace number,
 * `monthly_cash_ceiling_cents` ($25 by default, at most $50), **at reservation time and
 * atomically with its own daily ceiling**: the caller holds its daily budget lock, then
 * this function takes the workspace's monthly lock, and the reservation row is inserted
 * before either is released (both are transaction locks). Two reservations at the edge —
 * a call and a transcription, or two calls — therefore cannot both read the same headroom.
 *
 * Lock order: the caller's own daily budget lock first, then this one. Nothing takes this
 * lock first, so there is no cycle.
 *
 * ## What month-to-date spend is
 *
 * `research/ledger.ts`'s `readSpend`: every provider's settled cost (`provider_ledger`)
 * plus every open (`reserved` or `calling`) reservation, whose business date falls in the
 * calendar month of the workspace business time zone, up to today. The research ceilings
 * already read the same sum, so "what this month cost" has one definition. Research
 * reservations are not refused by this ceiling (research has its own monthly ceiling),
 * but they count towards it.
 *
 * A stored value that does not parse is a ceiling of 0, so nothing new is reserved: a
 * configuration bug in something that spends money behaves as though it said no.
 */

/** The workspace's month-to-date cash ceiling, in cents. */
export async function readMonthlyCashCeiling(context: RepositoryContext): Promise<number> {
  const parsed = monthlyCashCeilingSettingSchema.safeParse((await readSetting(context, 'monthly_cash_ceiling_cents')).value);
  return parsed.success ? parsed.data.cents : 0;
}

/** The transaction lock every monthly clearance of one workspace takes. */
function monthlyCashLockName(workspaceId: string): string {
  return `${workspaceId}:monthly_cash_ceiling`;
}

/**
 * Whether one more reservation of `cents`, dated `at` on the `zone` business calendar, fits
 * this month's ceiling. Takes the workspace's monthly lock, which is held until the
 * caller's transaction ends — so the caller must insert its reservation in the same
 * transaction, as both callers do.
 */
export async function clearMonthlyCash(
  context: RepositoryContext,
  input: { readonly at: string; readonly zone: string; readonly cents: number },
): Promise<boolean> {
  await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    monthlyCashLockName(context.scope.workspaceId),
  ]);
  const ceiling = await readMonthlyCashCeiling(context);
  const spend = await readSpend(context, { businessTimeZone: input.zone, at: input.at });
  return spend.monthToDateCents + Math.max(0, Math.trunc(input.cents)) <= ceiling;
}

/**
 * Whether a request of at most `cents`, made outside any reservation, fits this month —
 * for the reply classifier, which has no reservation row.
 *
 * The same monthly lock serialises the check with every reservation, but it is a
 * **session** lock released before the call: the classifier runs inside its job's
 * transaction, and an xact lock would be held across the provider request, blocking every
 * call and transcription reservation for as long as the model takes. The cost is a bounded
 * overshoot: between this check and the ledger write after the call, a reservation may
 * spend the headroom too, so the month can pass its ceiling by at most the cost of the
 * classifier calls in flight — one per classifier job slot, each at most `cents`.
 */
export async function monthFitsUnreserved(
  context: RepositoryContext,
  input: { readonly at: string; readonly zone: string; readonly cents: number },
): Promise<boolean> {
  const key = monthlyCashLockName(context.scope.workspaceId);
  await context.db.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
  try {
    const ceiling = await readMonthlyCashCeiling(context);
    const spend = await readSpend(context, { businessTimeZone: input.zone, at: input.at });
    return spend.monthToDateCents + Math.max(0, Math.trunc(input.cents)) <= ceiling;
  } finally {
    await context.db.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
  }
}

/** What Settings → Calling & calendar shows: "this month: $x of $y". */
export async function monthlyCashStatus(
  context: RepositoryContext,
): Promise<{ readonly ceilingCents: number; readonly spentMonthCents: number }> {
  const zone = await workspaceBusinessZone(context);
  const spend = await readSpend(context, { businessTimeZone: zone, at: await databaseNow(context) });
  return { ceilingCents: await readMonthlyCashCeiling(context), spentMonthCents: spend.monthToDateCents };
}
