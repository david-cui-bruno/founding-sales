import { z } from 'zod';

/**
 * What the mornings actually produced, on the founder's own calendar.
 *
 * Every number here is **derived** from records the desktop already stores and
 * cannot rewrite: consumed call handoffs, applied hand-reported call outcomes
 * and their notes, promised callbacks, saved drafts, observed reply threads and
 * the immutable action outcomes the worker's own events wrote.
 * There is no usage table and no per-morning write, so reading the summary
 * changes nothing and a summary computed twice from the same database is equal.
 *
 * Two facts are deliberately absent, because no stored record carries them:
 *
 * - **Spend.** Discovery and research spend live in the worker's status, not in
 *   this database. The footer already reads that status once per stored sync; the
 *   weekly block shows the figures from that last read, or `unknown`. Nothing in
 *   the renderer polls the worker on a timer to fill this in, and nothing here
 *   ever reports a spend of zero for a status it could not read.
 * - **Mornings opened and firms listed.** The morning list is computed at read
 *   time and never stored, so no past day's list can be recovered. `mornings`
 *   and `firms` therefore count mornings and firms with *recorded work*: a local
 *   date, or a firm, that a consumed handoff, an outcome, a note, a callback, a
 *   draft or an observed reply actually names. A morning David opened and did
 *   nothing on is not counted, and the copy says so.
 */
const count = z.number().int().nonnegative().safe();
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * The reasons a stored record is held. These are the exact `reason` values the
 * daily read puts on a held answer; the summary groups the week's held records
 * by the same strings, so the block never invents a hold category.
 */
export const usageHoldReasons = ['requires_owner_preflight', 'reply_capability_unverified'] as const;
export type UsageHoldReason = typeof usageHoldReasons[number];

/** One count per real call outcome (`actualAccountCallOutcomes`). `cancelled`, `not_called`, `unknown` and `opt_out` are not calls that happened. */
export const usageOutcomeCountsSchema = z.strictObject({
  connected: count, interested: count, not_interested: count, gatekeeper: count,
  voicemail: count, no_answer: count, busy: count, wrong_number: count,
});
export type UsageOutcomeCounts = z.infer<typeof usageOutcomeCountsSchema>;

export const usageWindowSchema = z.strictObject({
  /** The Monday and the Sunday of this week, as local dates in the founder's zone. */
  from: localDate, to: localDate,
  /** Distinct local dates in the window with at least one recorded fact. Never more than seven. */
  mornings: count.max(7),
  /** Distinct firms with at least one recorded fact in the window. */
  firms: count,
  /** Call handoffs consumed in the window: the durable proof that a call was placed. */
  callsPlaced: count,
  outcomes: usageOutcomeCountsSchema,
  /** Outcomes whose report carried a note. */
  notes: count,
  /** Callbacks promised in the window, and callbacks whose promised day fell in it and are now done. */
  callbacksPromised: count, callbacksKept: count,
  /** Reply drafts and requested-followup drafts written in the window. Writing a draft is never sending it. */
  drafts: count,
  /** Template sequence emails the worker's provider accepted in the window, counted from the immutable
   *  outcome rows the worker's own events wrote. A draft is not one of these: this counts sends. */
  emailsSent: count,
  /** Inbound reply messages the worker observed with a date in the window. */
  replies: count,
  holds: z.array(z.strictObject({ reason: z.enum(usageHoldReasons), count: count.min(1) })).max(usageHoldReasons.length),
}).refine(w => w.from <= w.to, 'usage_window_bounds')
  .refine(w => new Set(w.holds.map(hold => hold.reason)).size === w.holds.length, 'usage_hold_duplicate')
  .refine(w => w.holds.every((hold, index) => index === 0 || hold.reason > w.holds[index - 1]!.reason), 'usage_hold_order');
export type UsageWindow = z.infer<typeof usageWindowSchema>;

export const usageSummarySchema = z.strictObject({
  /** The founder's workspace zone. Every date in the summary is a local date in it. */
  timezone: z.string().min(1).max(64),
  thisWeek: usageWindowSchema,
  lastWeek: usageWindowSchema,
}).refine(s => s.lastWeek.to < s.thisWeek.from, 'usage_weeks_overlap');
export type UsageSummary = z.infer<typeof usageSummarySchema>;
