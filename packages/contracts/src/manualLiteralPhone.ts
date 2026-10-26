import {z} from 'zod';
import {instant, uuid} from './foundationRows.ts';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const url = z.string().min(1).max(2000);
const revision = z.number().int().positive();
const offset = z.number().int().min(0).max(4000);
export const manualLiteralPhoneCoverageSchema = z.strictObject({
  parser: z.literal('manual-literal-phone-v1'),
  state: z.enum(['complete', 'unavailable', 'changed', 'bounded']),
  observations: z.number().int().min(0).max(8),
  blocks: z.number().int().min(0).max(800),
});
const authority = z.discriminatedUnion('kind', [
  z.strictObject({kind: z.literal('candidate_source'), sourceUrl: url}),
  z.strictObject({kind: z.literal('discovery_origin'), sourceUrl: url,
    provider: z.string().min(1).max(100), release: z.string().min(1).max(300),
    recordId: z.string().min(1).max(500), retrievedAt: instant.nullable()}),
  z.strictObject({kind: z.literal('retained_evidence'), evidenceId: uuid}),
  z.strictObject({kind: z.literal('phone_discovery'), runId: uuid, expiresAt: instant}),
]);
const lineage = z.discriminatedUnion('kind', [
  z.strictObject({kind: z.literal('provider_original')}),
  z.strictObject({kind: z.literal('retained_interpretation'), decisionId: uuid,
    originalRunId: uuid, originalRevision: revision, resultRevision: revision}),
]);
/** A refusal location explains retained evidence, never a selected endpoint or new original export. */
export const manualLiteralPhoneDiagnosticSchema = z.strictObject({
  reason: z.enum(['unattached_label_content', 'unsupported_literal', 'ambiguous_context']),
  runId: uuid, observationId: uuid, blockId: z.string().min(1).max(80),
  url, retrievedAt: instant, contentHash: hash, relevantTextHash: hash,
  parser: z.literal('manual-literal-phone-v1'),
  label: z.string().min(1).max(200), labelStart: offset, labelEnd: offset,
  authority, lineage,
}).superRefine((value, ctx) => {
  if(value.labelEnd <= value.labelStart || value.labelEnd-value.labelStart !== value.label.length)
    ctx.addIssue({code:'custom', message:'Diagnostic label offsets must preserve its exact UTF-16 length.'});
});
export const manualLiteralPhoneDiagnosticsSchema = z.strictObject({
  entries: z.array(manualLiteralPhoneDiagnosticSchema).max(16),
  truncated: z.boolean(),
  // Earliest discovery dependency, including entries omitted by diagnostic bounds.
  expiresAt: instant.optional(),
});
/** A literal is an authorized original span, never verified ownership or calling authority. */
export const manualLiteralPhoneSourceSchema = z.strictObject({
  method: z.literal('retained_original_literal'),
  runId: uuid, observationId: uuid, blockId: z.string().min(1).max(80),
  url, retrievedAt: instant, contentHash: hash, relevantTextHash: hash,
  parser: z.literal('manual-literal-phone-v1'),
  literal: z.string().min(1).max(200), start: offset, end: offset,
  label: z.string().min(1).max(200), labelStart: offset, labelEnd: offset,
  normalizedValue: z.string().regex(/^\+[1-9]\d{7,14}$/u).nullable(),
  normalization: z.literal('existing-canonicalize-phone-v1'),
  normalizationBasis: z.enum(['explicit_country_code', 'default_us', 'unsupported']),
  authority, lineage,
}).superRefine((value, ctx) => {
  if(value.end <= value.start || value.end-value.start !== value.literal.length)
    ctx.addIssue({code:'custom', message:'Literal offsets must preserve its exact UTF-16 length.'});
  if(value.labelEnd <= value.labelStart || value.labelEnd-value.labelStart !== value.label.length)
    ctx.addIssue({code:'custom', message:'Label offsets must preserve its exact UTF-16 length.'});
  if((value.normalizedValue === null) !== (value.normalizationBasis === 'unsupported'))
    ctx.addIssue({code:'custom', message:'Unsupported literals cannot claim a normalized endpoint.'});
});
