import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { instant, uuid } from './foundationRows.ts';
import {manualLiteralPhoneCoverageSchema, manualLiteralPhoneSourceSchema, manualLiteralPhoneDiagnosticsSchema} from './manualLiteralPhone.ts';

/** Private manual worklist only. Raw observations are never canonical Firms or contact authority. */
export const manualProspectStateSchema = z.enum(['new', 'kept', 'skipped', 'wrong_number']);
/** Exact retained-source selection only; no number or original prose in custody. */
export const manualPhoneChoiceSchema = z.strictObject({
  runId: uuid, observationId: uuid, blockId: z.string().min(1).max(80),
  labelStart: z.number().int().min(0).max(16000), labelEnd: z.number().int().min(1).max(16000),
  start: z.number().int().min(0).max(16000), end: z.number().int().min(1).max(16000),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u), relevantTextHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).refine(v=>v.end>v.start&&v.end-v.start<=200&&v.labelEnd>v.labelStart&&v.labelEnd-v.labelStart<=200&&v.start>=v.labelEnd);
export const manualPhoneSchema = z.strictObject({
  value: z.string().regex(/^\+[1-9]\d{7,14}$/u), choice: manualPhoneChoiceSchema,
  sourceUrl: z.string().min(1).max(2000), retrievedAt: instant, expiresAt: instant,
});
export type ManualPhoneChoice = z.infer<typeof manualPhoneChoiceSchema>;
export const manualProspectListInputSchema = z.strictObject({
  state: z.enum(['all', 'new', 'kept', 'skipped', 'wrong_number']),
  offset: z.number().int().min(0).max(1000000),
  includeManualPhone: z.boolean().optional(),
  candidateId: uuid.optional(), expectedRevision: z.number().int().positive().optional(),
}).refine(v=>(v.candidateId===undefined&&v.expectedRevision===undefined)||(v.candidateId!==undefined&&v.expectedRevision!==undefined&&v.offset===0));
/** A queue label is never a canonical identity decision. Original observedName survives. */
export const manualProspectPresentationSchema = z.strictObject({
  label: z.string().trim().min(1).max(300),
  basis: z.enum(['retained_name', 'source_title', 'site_label']),
  kind: z.enum(['apparent_company', 'non_company', 'unresolved']),
  reason: z.string().trim().min(1).max(200),
});
const retainedFactPhoneSourceSchema = z.strictObject({
  runId: uuid, observationId: uuid, blockId: z.string().min(1).max(80),
  url: z.string().min(1).max(2000), retrievedAt: instant,
});
const manualPhoneSourceSchema = z.union([retainedFactPhoneSourceSchema, manualLiteralPhoneSourceSchema]);
const coverage = manualLiteralPhoneCoverageSchema.optional();
/** Permitted retained facts or exact literal original spans. An Endpoint is not a Route. */
export const manualProspectPhoneEvidenceSchema = z.discriminatedUnion('state', [
  z.strictObject({state: z.literal('not_extracted'), reason: z.enum([
    'no_retained_phone_field', 'no_current_permitted_phone_evidence', 'retained_text_not_extracted',
    'bounded_scan_incomplete', 'optional_source_changed', 'retained_ancestry_unavailable',
    'original_not_usable',
  ]), coverage}),
  z.strictObject({state: z.literal('absent'), basis: z.literal('retained_source_declares_absent'), coverage}),
  z.strictObject({state: z.literal('conflicting'), reason: z.enum([
    'multiple_retained_numbers', 'retained_source_ambiguous', 'unresolved_retained_literal',
  ]), sources: z.array(manualPhoneSourceSchema).max(16), coverage, diagnostics: manualLiteralPhoneDiagnosticsSchema.optional()}),
  z.strictObject({state: z.literal('observed'), value: z.string().regex(/^\+[1-9]\d{7,14}$/u),
    sources: z.array(manualPhoneSourceSchema).min(1).max(16), coverage}),
]).superRefine((value, ctx) => {
  if(value.state !== 'observed') return;
  for(const source of value.sources) {
    if('method' in source && (source.normalizedValue !== value.value || value.coverage?.state !== 'complete'
      || value.coverage.observations < 1 || value.coverage.blocks < 1))
      ctx.addIssue({code:'custom', message:'A selected literal needs matching endpoint and complete authorized coverage.'});
  }
  if(value.coverage && value.coverage.state !== 'complete')
    ctx.addIssue({code:'custom', message:'Incomplete or changed evidence cannot select a phone.'});
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
  presentation: manualProspectPresentationSchema.optional(),
  phoneEvidence: manualProspectPhoneEvidenceSchema.optional(),
  manualPhone: manualPhoneSchema.optional(),
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
}).superRefine((value, ctx) => {
  if (value.phoneEvidence?.state === 'observed') {
    if (value.observedPhone !== value.phoneEvidence.value || value.phoneBasis !== 'retained_observation')
      ctx.addIssue({code: 'custom', message: 'Observed phone must match its retained evidence.'});
  } else if (value.observedPhone !== null || value.phoneBasis !== 'unknown') {
    ctx.addIssue({code: 'custom', message: 'A phone value requires explicit retained provenance.'});
  }
});
export const manualProspectListSchema = z.strictObject({
  prospects: z.array(manualProspectSchema).max(50),
  hasMore: z.boolean(),
});
export const manualProspectFeedbackInputSchema = z.strictObject({
  candidateId: uuid,
  expectedRevision: z.number().int().positive(),
  state: z.enum(['kept', 'skipped', 'wrong_number']),
  phoneChoice: manualPhoneChoiceSchema.nullable().optional(),
}).refine(v=>v.state==='kept'||v.phoneChoice==null);
export const manualProspectFeedbackPayloadSchema = manualProspectFeedbackInputSchema.safeExtend({
  commandId: commandIdSchema,
});
export const manualProspectFeedbackCommandSchema = manualProspectFeedbackPayloadSchema.safeExtend({
  clientVersion: semanticVersionSchema,
});
export const manualProspectFeedbackSavedSchema = z.strictObject({
  candidateId: uuid,
  revision: z.number().int().positive(),
  state: manualProspectStateSchema,
  phoneChoice: manualPhoneChoiceSchema.nullable().optional(),
});
export type ManualProspect = z.infer<typeof manualProspectSchema>;
