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
