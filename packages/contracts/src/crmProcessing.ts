import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { canonicalSourceReferenceSchema } from './people.ts';

/** Lookup identity is exact; dates, attribution and quoted content come from the server. */
export const crmSourceLookupSchema = canonicalSourceReferenceSchema.pick({
  workspaceId: true, sourceId: true, kind: true, revision: true, contentHash: true, locator: true,
});

export const crmProcessingReadSchema = z.object({ source: crmSourceLookupSchema }).strict();
export const crmProcessingRequestSchema = crmProcessingReadSchema.extend({
  commandId: commandIdSchema, clientVersion: semanticVersionSchema,
}).strict();

export const crmExtractionPurposeSaveSchema = z.object({
  commandId: commandIdSchema, clientVersion: semanticVersionSchema,
  expectedRevision: z.number().int().min(0), enabled: z.boolean(),
  endpointId: z.string().trim().min(1).max(100), modelVersion: z.string().trim().min(1).max(200),
  accessGrantVersion: z.string().trim().min(1).max(200), dataHandlingVersion: z.string().trim().min(1).max(200),
  dailyCeilingCents: z.number().int().min(1).max(100000), monthlyCeilingCents: z.number().int().min(1).max(1000000),
  inputTokenPriceMicros: z.number().int().min(1).max(1000000), outputTokenPriceMicros: z.number().int().min(1).max(1000000),
}).strict();

export const crmProcessingHealthReadSchema = crmSourceLookupSchema.pick({ sourceId: true, kind: true }).strict();

export const crmExtractionFinancialSchema = z.object({
  dispatchState: z.enum(['reserved','calling','settled','unknown_acceptance','released']),
  settlementState: z.enum(['reserved','calling','settled','estimated','released']),
  settledCents: z.number().int().min(0),
}).strict();
export const crmClaimContextSchema=z.object({personId:z.uuid().nullable(),firmIds:z.array(z.uuid()).max(100),relationships:z.array(z.object({relationshipId:z.uuid(),revision:z.number().int().positive()}).strict()).max(100),review:z.enum(['current','required'])}).strict();
export type CrmClaimContext=z.infer<typeof crmClaimContextSchema>;

export const crmExtractionClaimSchema = z.object({
  claimId: z.uuid(),claimRevision:z.literal(1),claimHash:z.string().regex(/^[a-f0-9]{64}$/u),context:crmClaimContextSchema, kind: z.enum(['need','objection','commitment']),
  interpretation: z.string().min(1).max(1000), status: z.enum(['stated','inferred']),
  quote: z.string().min(1).max(2000), source: canonicalSourceReferenceSchema,
}).strict();
export const crmExtractionGenerationSchema = z.object({
  generationId: z.uuid(),contextHash:z.string().regex(/^[a-f0-9]{64}$/u),authorizationHash:z.string().regex(/^[a-f0-9]{64}$/u), purposeRevision: z.number().int().min(0),
  sourceRevision: z.number().int().positive(), processorVersion: z.string().min(1).max(100),
  modelVersion: z.string().max(200).nullable(),
  state: z.enum(['unavailable','pending','processing','complete','failed','stale','deleted','unknown_acceptance']),
  reason: z.string().max(100).nullable(), claims: z.array(crmExtractionClaimSchema).max(50),
  financial: crmExtractionFinancialSchema.nullable().optional(),
}).strict();
export const crmProcessingHealthSchema = z.object({
  sourceId: z.uuid(), sourceRevision: z.number().int().positive(),
  availability: canonicalSourceReferenceSchema.shape.availability,
  generations: z.array(crmExtractionGenerationSchema).max(50), truncated: z.boolean(),unknownAcceptance:z.boolean(),
}).strict();
export type CrmProcessingHealth = z.infer<typeof crmProcessingHealthSchema>;
export const crmProcessingResultSchema = z.union([
  crmExtractionGenerationSchema,
  z.object({state:z.literal('not_requested'),claims:z.array(crmExtractionClaimSchema).length(0)}).strict(),
]);
export const crmResolvedSourceSchema = z.object({
 state:z.literal('available'),source:canonicalSourceReferenceSchema,
 extent:z.object({unit:z.literal('utf16'),length:z.number().int().min(0)}).strict(),
 passage:z.object({text:z.string().max(2000),locator:z.string().max(200),speaker:z.string().nullable()}).strict().nullable(),
}).strict();
export const crmExtractionPurposeSchema = z.union([
 z.object({configured:z.literal(false),enabled:z.literal(false),revision:z.literal(0),modelVersion:z.null(),endpoint:z.null(),dailyCeilingCents:z.literal(0),monthlyCeilingCents:z.literal(0),unavailableReason:z.literal('purpose_not_configured')}).strict(),
 z.object({configured:z.literal(true),enabled:z.boolean(),revision:z.number().int().positive(),modelVersion:z.string().max(200),endpointId:z.string().max(100),accessGrantVersion:z.string().max(200),dataHandlingVersion:z.string().max(200),dailyCeilingCents:z.number().int().positive(),monthlyCeilingCents:z.number().int().positive(),inputTokenPriceMicros:z.number().int().positive(),outputTokenPriceMicros:z.number().int().positive(),unavailableReason:z.string().nullable()}).strict(),
]);

export const crmProcessingRecordReadSchema=z.object({kind:z.enum(['call_session','meeting']),recordId:z.uuid()}).strict();
export const crmProcessingRecordHealthSchema=z.object({sources:z.array(crmProcessingHealthSchema).max(50),truncated:z.boolean()}).strict();
export type CrmProcessingRecordHealth=z.infer<typeof crmProcessingRecordHealthSchema>;
