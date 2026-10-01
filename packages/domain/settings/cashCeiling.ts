import { monthlyCashCeilingSettingSchema } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { lockMonthlySpend, readSpend, workspaceBusinessZone } from '../research/ledger.ts';
import { databaseNow } from '../policy/clock.ts';
import { readSetting } from './store.ts';

/**
 * The month-to-date cash ceiling (slice P1, invariant I2; migration 0031).
 *
 * Daily ceilings are not a monthly guarantee: $1.25 of calling and $0.50 of transcription
 * a day already allow $38.50 across twenty-two weekdays. So every telephony,
 * transcription, research and reply-classification reservation is also cleared against
 * one workspace number,
 * `monthly_cash_ceiling_cents` ($25 by default, at most $50), **at reservation time and
 * atomically with its own daily ceiling**: the caller holds its daily budget lock, then
 * this function takes the workspace's monthly lock, and the reservation row is inserted
 * before either is released (both are transaction locks). Two reservations at the edge —
 * a call and a transcription, or two calls — therefore cannot both read the same headroom.
 *
 * Lock order: the caller's own daily budget lock first, then this one, then ledger rows
 * (every ledger write takes this lock before its row: `lockMonthlySpend`). The whole
 * order is in `docs/greenfield/calling.md`.
 *
 * ## What month-to-date spend is
 *
 * `research/ledger.ts`'s `readSpend`: every provider's settled cost (`provider_ledger`)
 * plus every open (`reserved` or `calling`) reservation, whose business date falls in the
 * calendar month of the workspace business time zone, up to today. The research ceilings
 * already read the same sum, so "what this month cost" has one definition. Research keeps
 * its own monthly ceiling as well.
 *
 * A stored value that does not parse is a ceiling of 0, so nothing new is reserved: a
 * configuration bug in something that spends money behaves as though it said no.
 */

/** The workspace's month-to-date cash ceiling, in cents. */
export async function readMonthlyCashCeiling(context: RepositoryContext): Promise<number> {
  const parsed = monthlyCashCeilingSettingSchema.safeParse((await readSetting(context, 'monthly_cash_ceiling_cents')).value);
  return parsed.success ? parsed.data.cents : 0;
}

/**
 * Take the workspace's monthly lock for the rest of the transaction, for a write that
 * changes what the month has spent outside a clearance (a settlement correction).
 */
export async function lockMonthlyCash(context: RepositoryContext): Promise<void> {
  await lockMonthlySpend(context);
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
  await lockMonthlySpend(context);
  const ceiling = await readMonthlyCashCeiling(context);
  const spend = await readSpend(context, { businessTimeZone: input.zone, at: input.at });
  return spend.monthToDateCents + Math.max(0, Math.trunc(input.cents)) <= ceiling;
}

/**
 * Whether the month's spend, open reservations included, is still within the ceiling now —
 * for a reservation already made that is about to be marked `calling` (the classifier's
 * chunk 2), so a ceiling lowered between the chunks stops the request. Takes the monthly
 * lock for the rest of the transaction.
 */
export async function monthWithinCeiling(
  context: RepositoryContext,
  input: { readonly at: string; readonly zone: string },
): Promise<boolean> {
  await lockMonthlySpend(context);
  const ceiling = await readMonthlyCashCeiling(context);
  const spend = await readSpend(context, { businessTimeZone: input.zone, at: input.at });
  return spend.monthToDateCents <= ceiling;
}

/** What Settings → Calling & calendar shows: "this month: $x of $y". */
export async function monthlyCashStatus(
  context: RepositoryContext,
): Promise<{ readonly ceilingCents: number; readonly spentMonthCents: number }> {
  const zone = await workspaceBusinessZone(context);
  const spend = await readSpend(context, { businessTimeZone: zone, at: await databaseNow(context) });
  return { ceilingCents: await readMonthlyCashCeiling(context), spentMonthCents: spend.monthToDateCents };
}
