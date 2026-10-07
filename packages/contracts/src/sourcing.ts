import { z } from 'zod';
import { businessDate, instant, uuid } from './foundationRows.ts';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';

// These URLs are references, not permission to fetch. The bounded fetcher remains
// responsible for DNS/redirect/robots checks when verification is added.
export const sourcingUrlSchema = z.string().trim().max(500).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      url.hostname.includes('.') && !url.hostname.includes(':') &&
      !/^[\d.]+$/.test(url.hostname) && !/(^|\.)(localhost|local|internal)$/.test(url.hostname);
  } catch { return false; }
}, 'Use a public HTTPS website.');
export const candidateStatusSchema = z.enum(['needs_review', 'kept', 'dismissed']);
export const candidateInputSchema = z.strictObject({
  discoveryKnownDomain: z.boolean().optional(),
  discoveryQuery: z.string().trim().min(1).max(400).optional(),
  firmName: z.string().trim().min(1).max(300),
  website: sourcingUrlSchema,
  locality: z.string().trim().min(1).max(120),
  region: z.enum(['TX','RI','MA']),
  signal: z.enum(['explicit_help','responsibility_overlap','coordination_hiring','manual_handoff','growth','tool_gap','fit_only']),
  evidence: z.string().trim().min(1).max(2000),
  sourceUrl: sourcingUrlSchema,
  observedOn: businessDate,
  preparedBy: z.string().trim().min(1).max(200),
});
export type CandidateInput = z.infer<typeof candidateInputSchema>;
export const candidateSourceCheckSchema = z.object({
  checkId:uuid,jobId:uuid,requestedAt:instant,
  state:z.enum(['pending','checked','unavailable']),
  reason:z.enum(['source_unavailable','source_not_permitted','no_readable_text','research_disabled','research_held','candidate_dismissed','candidate_not_monitored','job_failed','check_expired']).nullable(),
  checkedAt:instant.nullable(),
  lastSuccess:z.object({url:sourcingUrlSchema,contentHash:z.string().regex(/^[a-f0-9]{64}$/),retrievedAt:instant,
    excerpt:z.string().max(4000),quoteMatched:z.boolean(),firstParty:z.boolean(),truncated:z.boolean()}).nullable(),
});
export type CandidateSourceCheck=z.infer<typeof candidateSourceCheckSchema>;
export const candidateSchema = candidateInputSchema.extend({
  sourceCheck:candidateSourceCheckSchema.nullable().default(null),
  nextSourceCheckAt:instant.nullable().default(null),
  id: uuid, status: candidateStatusSchema, revision: z.number().int().min(1), createdAt: instant,
});
export type SourcingCandidate = z.infer<typeof candidateSchema>;
export const candidateListInputSchema = z.strictObject({
  status: candidateStatusSchema, offset: z.number().int().min(0).max(1000000),
});
export const discoveryStatusSchema=z.object({enabled:z.boolean(),nextRunAt:instant,lastResult:z.string().nullable(),dailyRemaining:z.number().int().min(0),monthlyRemaining:z.number().int().min(0),halted:z.boolean()});
export const candidateListSchema = z.object({qualificationWaitReason:z.string().nullable().optional(),discovery:discoveryStatusSchema.nullable().optional(),candidates:z.array(candidateSchema).max(50),hasMore:z.boolean()});
export const candidateReviewInputSchema = z.strictObject({
  id:uuid, expectedRevision:z.number().int().min(1), status:candidateStatusSchema,
});
export const candidateDeleteInputSchema = candidateReviewInputSchema.omit({status:true});
export const candidateSavedSchema = z.object({id:uuid,duplicate:z.boolean()});
export const candidateChangedSchema = z.object({id:uuid});
const envelope = {commandId:commandIdSchema,clientVersion:semanticVersionSchema};
export const candidateSaveCommandSchema = candidateInputSchema.extend(envelope);
export const candidateReviewCommandSchema = candidateReviewInputSchema.extend(envelope);
export const candidateDeleteCommandSchema = candidateDeleteInputSchema.extend(envelope);

export const candidateCheckCommandSchema = candidateDeleteInputSchema.extend(envelope);

// A reviewed name correction preserves the candidate and discovery history.
export const candidateCorrectNameInputSchema = z.strictObject({
  id:uuid, expectedRevision:z.number().int().positive(), firmName:z.string().trim().min(2).max(300),
  qualificationRunId:uuid, observationId:uuid, blockId:z.string().min(1).max(80),
  reason:z.string().trim().min(10).max(500),
});
export const candidateCorrectNameCommandSchema=candidateCorrectNameInputSchema.extend(envelope);
