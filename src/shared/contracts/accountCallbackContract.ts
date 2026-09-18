import { z } from 'zod';
import { accountIdSchema as id } from './accountContract';
import { accountCallbackSchema } from './dailyContract';

/**
 * The renderer-to-main contract for the callback David promises on a call (design D13).
 * Saving a callback is a local record only: it never dials, sends, books or queues an
 * owner command. The renderer names the human report that created the promise, so a
 * retry after an uncertain result reaches the same row instead of promising twice.
 */
export const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}, 'callback_due_date');
export const saveAccountCallbackSchema = z.strictObject({
  accountId: id,
  /** The business day in the firm's local zone, as the renderer resolved it. Never an instant. */
  dueOn: localDateSchema,
  note: z.string().min(1).max(10000).nullable(),
  /** The `complete-manual` command whose outcome promised this callback. */
  sourceCommandId: id,
}).strict();
export type SaveAccountCallback = z.infer<typeof saveAccountCallbackSchema>;
export const closeAccountCallbackSchema = z.strictObject({ id, expectedRevision: z.number().int().positive().safe(), state: z.enum(['done', 'cancelled']) });
export type CloseAccountCallback = z.infer<typeof closeAccountCallbackSchema>;
export const readAccountCallbacksSchema = z.strictObject({ accountIds: z.array(id).max(1000) });
export type ReadAccountCallbacks = z.infer<typeof readAccountCallbacksSchema>;
export const accountCallbackListSchema = z.array(accountCallbackSchema).max(5000);

/** One local business day count. Weekends are skipped; public holidays are not modelled and are not claimed to be. */
export function addBusinessDays(dueOn: string, days: number): string {
  const parsed = localDateSchema.parse(dueOn);
  if (!Number.isSafeInteger(days) || days < 0 || days > 3650) throw new Error('callback_business_days_range');
  const [year, month, day] = parsed.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekend = () => date.getUTCDay() === 0 || date.getUTCDay() === 6;
  for (let remaining = days; remaining > 0;) { date.setUTCDate(date.getUTCDate() + 1); if (!weekend()) remaining -= 1; }
  while (weekend()) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
/** The local calendar date of an instant in a named IANA zone. Throws on an unusable zone rather than guessing UTC. */
export function localDateIn(instant: string, timezone: string): string {
  const parsed = Date.parse(instant);
  if (!Number.isFinite(parsed)) throw new Error('callback_instant_unreadable');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(parsed));
  return localDateSchema.parse(parts);
}
