import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { uuid } from './foundationRows.ts';
import { qualificationFactSchema } from './sourcingQualification.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().positive();
const originalCitation = {
  observationId: uuid,
  blockId: z.string().min(1).max(80),
  contentHash: digest,
  relevantTextHash: digest,
};
const envelope = { commandId: commandIdSchema, clientVersion: semanticVersionSchema };

/** IDs/hashes/UTF-16 offsets only. The server derives the literal name from retained text. */
export const retainedIdentityDecisionInputSchema = z.strictObject({
  candidateId: uuid,
  expectedRevision: revision,
  qualificationRunId: uuid,
  ...originalCitation,
  nameStart: z.number().int().min(0).max(2000),
  nameEnd: z.number().int().min(1).max(2000),
  decision: z.literal('confirm_literal_trade_name'),
  acknowledged: z.literal('identity_only_not_qualification'),
}).refine(value => value.nameStart < value.nameEnd, { message: 'A nonempty literal span is required.' });
export const retainedIdentityDecisionCommandSchema = retainedIdentityDecisionInputSchema.safeExtend(envelope);
export const retainedIdentityDecisionResultSchema = z.strictObject({
  decisionId: uuid, candidateId: uuid, revision, qualificationRunId: uuid,
});

export const retainedCitationSelectionSchema = z.strictObject({
  kind: qualificationFactSchema.shape.kind,
  ...originalCitation,
});
export const retainedInterpretationInputSchema = z.strictObject({
  candidateId: uuid,
  expectedRevision: revision,
  decisionId: uuid,
  qualificationRunId: uuid,
  selections: z.array(retainedCitationSelectionSchema).min(1).max(30),
  acknowledged: z.literal('new_retained_interpretation_not_original_model_result'),
}).superRefine((value, context) => {
  const keys = value.selections.map(item => `${item.kind}:${item.observationId}:${item.blockId}`);
  if (new Set(keys).size !== keys.length)
    context.addIssue({ code: 'custom', message: 'Citation roles must be unique for each original block.' });
});
export const retainedInterpretationCommandSchema = retainedInterpretationInputSchema.safeExtend(envelope);
export const retainedInterpretationResultSchema = z.strictObject({
  runId: uuid, candidateId: uuid, candidateRevision: revision, decisionId: uuid,
});
export type RetainedIdentityDecisionInput = z.infer<typeof retainedIdentityDecisionInputSchema>;
export type RetainedInterpretationInput = z.infer<typeof retainedInterpretationInputSchema>;
