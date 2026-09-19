import { z } from 'zod';
import { weekViewSchema, type V1CallOutcome, type V1HoldReason, type WeekView } from '../../../../../src/shared/contracts/v1Contract';
import type { DynamoStore } from '../dynamoStore';
import { ATTEMPT_PREFIX } from './attempts';
import { CALL_PREFIX, CALLBACK_PREFIX, callRecordSchema, callbackRecordSchema } from './calls';
import { REPLY_PREFIX, replyRecordSchema } from './mail';
import { holdReasonOf, SEND_PREFIX, sendRecordSchema } from './send';
import { EASTERN, localParts } from './localClock';
import { createAccountFirmSource, type FirmSource } from './firms';
import { readResearchCounter } from './pool';

/**
 * `GET /v1/week` (FSS target design section 3; slice S5): the last seven Eastern days, counted from the permanent
 * records and nothing else.
 *
 *   calls              `CALL#`, by the outcome David logged, on the day he says the call happened
 *   emails sent        `SEND#` in state `accepted`, on the day it was accepted
 *   replies            `REPLY#`, one per matched message
 *   callbacks          `CALLBACK#`: promised on the day the call promised it, kept on the day it was resolved `made`
 *   firms researched   the firm source's own research stamp (`FIRM#.researchRevision` above zero, at `researchedAt`)
 *   spend              S4's daily research counters, with the days they no longer cover named rather than read as zero
 *   holds              `ATTEMPT#` outcomes of `held`, by the user-facing reason S3's `holdReasonOf` maps the code to
 *
 * Days are America/New_York calendar days, so a call at 22:00 Eastern belongs to the day David was living in. The
 * window is the seven days ending today inclusive. `ATTEMPT#` is the one source with a TTL (thirty days), which is
 * why the hold counts are described as what the log still holds; every other number here is permanent.
 *
 * This view reads. It never writes, never sends, never dials and never asks a provider anything.
 */

/** The seven Eastern dates ending on the day `now` falls in, oldest first. Pure. */
export function easternWeek(now: string): string[] {
  const today = localParts(now, EASTERN).date;
  const midnight = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, index) => new Date(midnight - (6 - index) * 86400000).toISOString().slice(0, 10));
}

/** Which Eastern day an instant falls in, or null when it is not a readable instant. Pure. */
export function easternDay(instant: string | null): string | null {
  if (instant === null) return null;
  try { return localParts(instant, EASTERN).date; } catch { return null; }
}

/** Only an accepted send left the building. A `dispatching` or `unknown` row is not a sent email and is not counted. */
const SENT_STATE = 'accepted';
/** S4's research counters keep three days (design section 2), so the older days of a week have none by design. */
const RESEARCH_COUNTER_KEEPS_DAYS = 3;

type Day = { date: string; calls: number; emailsSent: number; replies: number; callbacksPromised: number; callbacksKept: number; firmsResearched: number };

export async function readWeekView(store: DynamoStore, options: { firms?: FirmSource } = {}): Promise<WeekView> {
  const asOf = store.now();
  const dates = easternWeek(asOf);
  const inWindow = new Set(dates);
  const days = new Map<string, Day>(dates.map(date => [date, { date, calls: 0, emailsSent: 0, replies: 0, callbacksPromised: 0, callbacksKept: 0, firmsResearched: 0 }]));
  const bump = (date: string | null, field: Exclude<keyof Day, 'date'>, by = 1): void => {
    if (date === null || !inWindow.has(date)) return;
    const day = days.get(date);
    if (day) day[field] += by;
  };

  const [callRows, sendRows, replyRows, callbackRows, firms, attemptRows, counters] = await Promise.all([
    store.list<unknown>(CALL_PREFIX), store.list<unknown>(SEND_PREFIX), store.list<unknown>(REPLY_PREFIX), store.list<unknown>(CALLBACK_PREFIX),
    (options.firms ?? createAccountFirmSource(store)).listFirms(), store.list<unknown>(ATTEMPT_PREFIX),
    Promise.all(dates.map(async date => ({ date, counter: await readResearchCounter(store, date) }))),
  ]);

  // Calls, by the outcome David logged, on the day he says the call happened.
  const byOutcome = new Map<V1CallOutcome, number>();
  let callTotal = 0;
  for (const row of callRows) {
    const parsed = callRecordSchema.safeParse(row.stored.data);
    if (!parsed.success) continue;
    const date = easternDay(parsed.data.observedAt);
    if (date === null || !inWindow.has(date)) continue;
    callTotal += 1;
    byOutcome.set(parsed.data.outcome, (byOutcome.get(parsed.data.outcome) ?? 0) + 1);
    bump(date, 'calls');
  }

  let emailsSent = 0;
  for (const row of sendRows) {
    const parsed = sendRecordSchema.safeParse(row.stored.data);
    if (!parsed.success || parsed.data.state !== SENT_STATE) continue;
    const date = easternDay(parsed.data.sentAt);
    if (date === null || !inWindow.has(date)) continue;
    emailsSent += 1;
    bump(date, 'emailsSent');
  }

  let replies = 0;
  for (const row of replyRows) {
    const parsed = replyRecordSchema.safeParse(row.stored.data);
    if (!parsed.success) continue;
    const date = easternDay(parsed.data.receivedAt);
    if (date === null || !inWindow.has(date)) continue;
    replies += 1;
    bump(date, 'replies');
  }

  let promised = 0, kept = 0;
  for (const row of callbackRows) {
    const parsed = callbackRecordSchema.safeParse(row.stored.data);
    if (!parsed.success) continue;
    const promisedOn = easternDay(parsed.data.promisedAt);
    if (promisedOn !== null && inWindow.has(promisedOn)) { promised += 1; bump(promisedOn, 'callbacksPromised'); }
    if (parsed.data.state !== 'made') continue;
    const keptOn = easternDay(parsed.data.resolvedAt);
    if (keptOn !== null && inWindow.has(keptOn)) { kept += 1; bump(keptOn, 'callbacksKept'); }
  }

  // One firm counted once, on the day its research landed. The firm source is the one place that stamp lives:
  // `researchRevision` above zero is a firm research actually worked on, and `researchedAt` is when it last did.
  // A firm David entered by hand has no revision and is never counted here, whatever else it has.
  const researchedOn = new Map<string, string>();
  for (const firm of firms) {
    if (firm.researchRevision <= 0) continue;
    const date = easternDay(firm.researchedAt);
    if (date !== null && inWindow.has(date)) researchedOn.set(firm.firmId, date);
  }
  for (const date of researchedOn.values()) bump(date, 'firmsResearched');

  // The holds the attempt log still holds. It expires after thirty days, so these are a reading of the log, not a total.
  const holds = new Map<string, { reason: V1HoldReason; code: string; count: number }>();
  for (const row of attemptRows) {
    const parsed = z.object({ at: z.iso.datetime({ precision: 3 }), outcome: z.string().max(20), reason: z.string().max(40).nullable() }).safeParse(row.stored.data);
    if (!parsed.success || parsed.data.outcome !== 'held' || parsed.data.reason === null) continue;
    const date = easternDay(parsed.data.at);
    if (date === null || !inWindow.has(date)) continue;
    const code = parsed.data.reason;
    const held = holds.get(code);
    if (held) held.count += 1; else holds.set(code, { reason: holdReasonOf(code), code, count: 1 });
  }

  // S4's counters keep three days, so a week's older days have none. That is said as `daysMissing`, never summed
  // in as a zero: the total is only ever over the days a counter was actually read.
  let spent = 0, daysCounted = 0;
  for (const { counter } of counters) {
    if (counter === null) continue;
    spent += counter.spent;
    daysCounted += 1;
  }

  return weekViewSchema.parse({
    asOf, from: dates[0]!, to: dates[dates.length - 1]!, days: dates.map(date => days.get(date)!),
    calls: { total: callTotal, byOutcome: [...byOutcome.entries()].map(([outcome, count]) => ({ outcome, count })).sort((a, b) => a.outcome < b.outcome ? -1 : 1) },
    emailsSent, replies, callbacks: { promised, kept }, firmsResearched: researchedOn.size,
    spend: { spent: daysCounted === 0 ? null : spent, daysCounted, daysMissing: dates.length - daysCounted,
      counterKeepsDays: RESEARCH_COUNTER_KEEPS_DAYS },
    holds: [...holds.values()].sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1)),
  });
}
