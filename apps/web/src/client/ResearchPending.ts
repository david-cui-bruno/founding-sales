import { z } from 'zod';
import { qualifiedResearchSelectionSchema, uuid, instant } from '@fss/contracts';

export const RESEARCH_PENDING_KEY = 'callie.browser.pending-research.v1';
export const researchPendingSchema = z.strictObject({
  identity: z.string(), commandId: uuid, selection: qualifiedResearchSelectionSchema,
  expiresAt: instant, createdFirmId: uuid.optional(),
});
export type PendingResearch = z.infer<typeof researchPendingSchema>;
