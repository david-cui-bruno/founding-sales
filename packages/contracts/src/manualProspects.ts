import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { instant, uuid } from './foundationRows.ts';

/** Private manual worklist only. Raw observations are never canonical Firms or contact authority. */
export const manualProspectStateSchema = z.enum(['new', 'kept', 'skipped', 'wrong_number']);
export const manualProspectListInputSchema = z.strictObject({
  state: z.enum(['all', 'new', 'kept', 'skipped', 'wrong_number']),
  offset: z.number().int().min(0).max(1000000),
});
export const manualProspectSchema = z.strictObject({
  candidateId: uuid,
  revision: z.number().int().positive(),
  observedName: z.string().min(1).max(300),
  website: z.string().max(2000).nullable(),
  locality: z.string().max(150).nullable(),
  region: z.string().max(150).nullable(),
  observedPhone: z.string().max(200).nullable(),
  phoneBasis: z.enum(['retained_observation', 'unknown']),
  sources: z.array(z.strictObject({
    label: z.string().min(1).max(300),
    url: z.string().max(2000).nullable(),
    observedAt: instant.nullable(),
  })).min(1).max(16),
  sourceNotices: z.array(z.strictObject({
    label: z.string().min(1).max(300),
    url: z.string().max(2000).nullable(),
  })).max(512),
  retainedAt: instant,
  state: manualProspectStateSchema,
  unknowns: z.array(z.string().min(1).max(200)).max(20),
  possibleDuplicateCount: z.number().int().nonnegative(),
  qualification: z.literal('unverified'),
  contactAuthority: z.literal('not_granted'),
});
export const manualProspectListSchema = z.strictObject({
  prospects: z.array(manualProspectSchema).max(50),
  hasMore: z.boolean(),
});
export const manualProspectFeedbackInputSchema = z.strictObject({
  candidateId: uuid,
  expectedRevision: z.number().int().positive(),
  state: z.enum(['kept', 'skipped', 'wrong_number']),
});
export const manualProspectFeedbackCommandSchema = manualProspectFeedbackInputSchema.safeExtend({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
});
export const manualProspectFeedbackSavedSchema = z.strictObject({
  candidateId: uuid,
  revision: z.number().int().positive(),
  state: manualProspectStateSchema,
});
export type ManualProspect = z.infer<typeof manualProspectSchema>;
