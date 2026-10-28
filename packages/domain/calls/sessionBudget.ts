import type { RepositoryContext } from '../db/workspaceScope.ts';
import { workspaceBusinessZone } from '../research/ledger.ts';
import { localDate } from '../src/rules/localClock.ts';
import { databaseNow } from '../policy/clock.ts';
import { readTelephonyBudget } from '../settings/integrations.ts';
import { clearMonthlyCash } from '../settings/cashCeiling.ts';
import type { CallSessionResult } from './sessionTypes.ts';

export const TELEPHONY_PROVIDER_KEY = 'twilio.voice';

/** Cents for the worst case (the per-call limit); the bill is by started minute. */
export function telephonyReservationCents(minutes: number, unitPriceMicros: number): number {
  return Math.ceil((Math.trunc(minutes) * Math.trunc(unitPriceMicros)) / 10_000);
}

export interface TelephonyReservationClearance {
  readonly cents: number;
  readonly maxMinutes: number;
  readonly unitPriceMicros: number;
  readonly businessDate: string;
  readonly zone: string;
}

/** One shared daily/monthly check; the caller inserts the reservation in this transaction. */
export async function clearTelephonyReservation(
  context: RepositoryContext,
  at: string,
  maxMinutes?: number,
): Promise<CallSessionResult<TelephonyReservationClearance>> {
  const budget = await readTelephonyBudget(context);
  if (budget.dailyCeilingCents <= 0) return { ok: false, reason: 'telephony_budget_disabled' };
  await lockTelephonyBudget(context);
  const zone = await workspaceBusinessZone(context);
  const businessDate = localDate(at, zone);
  const minutes = maxMinutes ?? budget.maxMinutesPerCall;
  const cents = telephonyReservationCents(minutes, budget.unitPriceMicros);
  if (await telephonySpentCents(context, businessDate) + cents > budget.dailyCeilingCents) {
    return { ok: false, reason: 'telephony_budget_exhausted' };
  }
  if (!await clearMonthlyCash(context, { at, zone, cents })) return { ok: false, reason: 'monthly_cash_ceiling' };
  return { ok: true, value: { cents, maxMinutes: minutes, unitPriceMicros: budget.unitPriceMicros, businessDate, zone } };
}

export async function lockTelephonyBudget(context: RepositoryContext): Promise<void> {
  await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${context.scope.workspaceId}:telephony_budget`,
  ]);
}

export async function reserveTelephonyCall(
  context: RepositoryContext,
  sessionId: string,
  clearance: TelephonyReservationClearance,
): Promise<string> {
  const { rows } = await context.db.query<{ id: string }>(
    `INSERT INTO provider_reservations
       (workspace_id, provider_key, subject_kind, subject_id, attempt, business_date, business_time_zone,
        cents, priced_unit, max_units, unit_price_micros, state)
     VALUES ($1, $2, 'call_session', $3, 1, $4::date, $5, $6, 'minute', $7, $8, 'reserved') RETURNING id`,
    [context.scope.workspaceId, TELEPHONY_PROVIDER_KEY, sessionId, clearance.businessDate, clearance.zone,
      clearance.cents, clearance.maxMinutes, clearance.unitPriceMicros],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('the telephony reservation insert returned no row');
  return id;
}

/** Recheck a held reservation against current settings; its own cents are counted once. */
export async function clearExistingTelephonyReservation(
  context: RepositoryContext,
  reservationId: string,
  at: string,
): Promise<CallSessionResult<null>> {
  const budget = await readTelephonyBudget(context);
  if (budget.dailyCeilingCents <= 0) return { ok: false, reason: 'telephony_budget_disabled' };
  await lockTelephonyBudget(context);
  const reservation = (await context.db.query<{ business_date: string; cents: number; state: string }>(
    `SELECT business_date::text, cents, state FROM provider_reservations
      WHERE workspace_id=$1 AND id=$2 AND provider_key=$3 AND subject_kind='call_session'`,
    [context.scope.workspaceId, reservationId, TELEPHONY_PROVIDER_KEY],
  )).rows[0];
  if (!reservation || !['reserved', 'calling'].includes(reservation.state)) return { ok: false, reason: 'ticket_expired' };
  const zone = await workspaceBusinessZone(context);
  const date = localDate(at, zone);
  const extra = reservation.business_date === date ? 0 : Number(reservation.cents);
  if (await telephonySpentCents(context, date) + extra > budget.dailyCeilingCents) {
    return { ok: false, reason: 'telephony_budget_exhausted' };
  }
  const monthlyExtra = reservation.business_date.slice(0, 7) === date.slice(0, 7) ? 0 : Number(reservation.cents);
  if (!await clearMonthlyCash(context, { at, zone, cents: monthlyExtra })) return { ok: false, reason: 'monthly_cash_ceiling' };
  return { ok: true, value: null };
}

/**
 * Cents of Twilio minutes spent on one business date: settled ledger cost plus live
 * (reserved or calling) reservations. The budget check and Settings' "spent today" both
 * ask this, so they cannot disagree about the day boundary or what counts.
 */
export async function telephonySpentCents(context: RepositoryContext, businessDate: string): Promise<number> {
  const { rows } = await context.db.query<{ cents: string | null }>(
    `SELECT sum(cents)::text AS cents FROM (
       SELECT cost_cents AS cents FROM provider_ledger
        WHERE workspace_id = $1 AND provider_key = $2 AND business_date = $3::date
       UNION ALL
       SELECT cents FROM provider_reservations
        WHERE workspace_id = $1 AND provider_key = $2 AND business_date = $3::date AND state IN ('reserved', 'calling')
     ) AS spend`,
    [context.scope.workspaceId, TELEPHONY_PROVIDER_KEY, businessDate],
  );
  return Number(rows[0]?.cents ?? 0);
}

/** Today's telephony spend, on the workspace's business day. */
export async function telephonySpentToday(context: RepositoryContext): Promise<number> {
  const zone = await workspaceBusinessZone(context);
  return await telephonySpentCents(context, localDate(await databaseNow(context), zone));
}
