import { z } from 'zod';

const id = z.string().trim().min(1);
const metric = z.number().finite().nonnegative().nullable().optional();
export const acquisitionWindowSchema = z.object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }) })
  .refine(w => Date.parse(w.end) > Date.parse(w.start), 'Observation window must have positive duration.');
/** Normalized observed facts, never generated suggestions. Held means attended here, not C5 operational hold. */
export const acquisitionFactSchema = z.object({
  id, accountId: id, kind: id, occurredAt: z.string().datetime({ offset: true }).optional(),
  meetingId: id.optional(), pilotId: id.optional(),
  evidence: z.object({ source: z.enum(['human', 'provider']), reference: id }).optional(),
  costCents: metric, durationSeconds: metric, editSeconds: metric, modelTokens: metric,
});
export type AcquisitionFact = z.infer<typeof acquisitionFactSchema>;
export type AcquisitionWindow = z.infer<typeof acquisitionWindowSchema>;
export type AcquisitionReport = Readonly<{
  window: AcquisitionWindow; observationSeconds: number;
  manualCalls: number; conversations: number; positiveResponses: number;
  meetingsBooked: number; meetingsCancelled: number; meetingsHeld: number;
  pilotWillingness: number; pilotStarts: number; historicalEventCount: number;
  costCents: number | null; knownCostCents: number; durationSeconds: number | null;
  editSeconds: number | null; modelTokens: number | null;
}>;
