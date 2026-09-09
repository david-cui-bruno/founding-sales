import { z } from 'zod';
import { accountIdSchema as id, accountInstantSchema as instant } from './accountContract';
import { commandReceiptSchema } from './delegationContract';
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const linkedInBodySchema = z.string().min(1).max(24000).refine(body => body.trim().length > 0 && !body.includes('\0'));
export const linkedInPrepareSchema = z.strictObject({ stepId: id, expectedVersion: revision });
export const linkedInRevisionSchema = z.strictObject({ draftId: id, expectedRevision: revision });
export const linkedInSaveSchema = linkedInRevisionSchema.extend({ body: linkedInBodySchema });
export const linkedInReportSchema = linkedInRevisionSchema.extend({ commandId: z.uuid(),
  outcome: z.enum(['human_reported_sent', 'reply', 'no_reply', 'opt_out', 'cancelled', 'not_sent', 'unknown']),
  observedAt: instant, replyText: z.string().min(1).max(24000).optional() }).refine(input => input.replyText === undefined || input.outcome === 'reply');
export const linkedInDraftSchema = z.strictObject({ id, workspaceId: id, accountId: id, enrollmentId: id, campaignVersionId: id,
  personId: id.nullable(), stepId: id, routeId: id, routeVersion: revision, contextRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), executionContextId: id,
  revision, body: linkedInBodySchema, contentHash: hash, targetHash: hash, state: z.enum(['draft', 'approved', 'held', 'closed']), updatedAt: instant });
export const linkedInActionSchema = z.strictObject({ draftId: id, revision, status: z.enum(['copied', 'opened']) });
export const linkedInReportResultSchema = z.strictObject({ draftId: id, revision, receipt: commandReceiptSchema });
export type LinkedInDraft = z.infer<typeof linkedInDraftSchema>;
export type LinkedInPrepare = z.infer<typeof linkedInPrepareSchema>;
export type LinkedInRevision = z.infer<typeof linkedInRevisionSchema>;
export type LinkedInSave = z.infer<typeof linkedInSaveSchema>;
export type LinkedInReport = z.infer<typeof linkedInReportSchema>;
export interface LinkedInApi {
  prepare(input: LinkedInPrepare): Promise<LinkedInDraft>;
  save(input: LinkedInSave): Promise<LinkedInDraft>;
  get(input: LinkedInRevision): Promise<LinkedInDraft>;
  open(input: LinkedInRevision): Promise<z.infer<typeof linkedInActionSchema>>;
  copy(input: LinkedInRevision): Promise<z.infer<typeof linkedInActionSchema>>;
  reportOutcome(input: LinkedInReport): Promise<z.infer<typeof linkedInReportResultSchema>>;
}
