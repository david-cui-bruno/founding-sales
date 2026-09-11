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

/** Explicit owner testimony, not an externally verified or model-derived milestone. */
const ownerMilestoneEvidence = {
  occurredAt: z.string().datetime({ offset: true }),
  sourceRef: z.string().trim().min(1).max(2048),
  ownerNote: z.string().trim().min(1).max(4000),
};
export const acquisitionMilestoneReportSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('meeting_attended'), ...ownerMilestoneEvidence,
    meetingId: id.max(255), calendarId: id.max(255), providerEventId: z.string().regex(/^[0-9a-v]{5,1024}$/) }),
  z.strictObject({ kind: z.literal('pilot_willingness'), ...ownerMilestoneEvidence, pilotId: id.max(255) }),
  z.strictObject({ kind: z.literal('pilot_started'), ...ownerMilestoneEvidence, pilotId: id.max(255) }),
]);
export type AcquisitionMilestoneReport = z.infer<typeof acquisitionMilestoneReportSchema>;
/** The authenticated owner handler derives source and observedAt, never a model or caller-supplied provenance flag. */
export const acquisitionMilestonePayloadSchema = z.strictObject({ commandId: id.max(255), report: acquisitionMilestoneReportSchema,
  observedAt: z.string().datetime({ offset: true }), source: z.literal('owner_report'),
}).refine(payload => Date.parse(payload.report.occurredAt) <= Date.parse(payload.observedAt), 'Milestone occurrence cannot follow observation.');
export type AcquisitionMilestonePayload = z.infer<typeof acquisitionMilestonePayloadSchema>;
