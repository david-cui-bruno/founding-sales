import { z } from 'zod';
import { CALL_ANALYSIS_OBJECTION_CATEGORIES } from './callAnalysis.ts';
import { uuid } from './foundationRows.ts';

/**
 * The daily recap (slice 3a, lane C; DESIGN-S3A §2.10, David's decision 9).
 *
 * `GET /calls/recap?date=YYYY-MM-DD` reads the day's analysed calls and reports what recurs.
 * It is a read and nothing else: no table, no stored aggregate, no model call, no scores.
 *
 *   * **daily**: the calls whose session fell on that business date;
 *   * **small sample** below `RECAP_SMALL_SAMPLE_BELOW` analysed calls, so the desktop says
 *     "Small sample: n calls" rather than present a pattern as a finding;
 *   * an objection is **recurring** once it appears in `RECAP_RECURRING_AT` calls or more, and
 *     is always shown as "in k of n calls" with its verbatim quotes;
 *   * **one coaching observation**, taken as the analysis wrote it (it cites transcript lines),
 *     or none.
 */
export const RECAP_SMALL_SAMPLE_BELOW = 5;
export const RECAP_RECURRING_AT = 2;
export const RECAP_MAX_QUOTES = 3;

export const callRecapResponseSchema = z.object({
  businessDate: z.iso.date(),
  businessTimeZone: z.string().min(1).max(64),
  /** n: the day's calls that have a completed analysis. */
  callsAnalysed: z.number().int().min(0),
  smallSample: z.boolean(),
  objections: z.array(
    z.object({
      category: z.enum(CALL_ANALYSIS_OBJECTION_CATEGORIES),
      /** k: how many of the n calls raised it (a call raising it twice counts once). */
      calls: z.number().int().min(1),
      recurring: z.boolean(),
      quotes: z.array(z.object({ quote: z.string().min(1).max(500), callSessionId: uuid })).max(RECAP_MAX_QUOTES),
    }),
  ),
  coaching: z.object({ observation: z.string().min(1).max(500), callSessionId: uuid }).nullable(),
});
export type CallRecapResponse = z.infer<typeof callRecapResponseSchema>;
