import { z } from 'zod';
import { accountIdSchema as id, accountInstantSchema as instant } from './accountContract';
import { commandReceiptSchema } from './commandReceiptContract';
const revision = z.number().int().positive().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const email = z.string().email().max(254).refine(v => /^[\x21-\x7e]+$/.test(v));
const subject = z.string().max(240).refine(v => !/[\x00-\x1f\x7f]/.test(v)); // eslint-disable-line no-control-regex
export const originalCallRefSchema = z.strictObject({ commandId: id, handoffId: id, actionId: id, commandFingerprint: hash, outcomeEventId: id, outcomeEventHash: hash });
export type OriginalCallRef = z.infer<typeof originalCallRefSchema>;
export const requestedRecipientSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('account_route'), routeId: id, routeVersion: revision, email }),
  z.strictObject({ kind: z.literal('owner_supplied'), email, originalCall: originalCallRefSchema }),
]);
export type RequestedRecipient = z.infer<typeof requestedRecipientSchema>;
export const requestedMailContextSchema = z.strictObject({ scopeRevision: revision.nullable(), scopeFingerprint: hash.nullable(), inboundContextRevision: revision.nullable(), inboundContextFingerprint: hash })
  .refine(c => (c.scopeRevision === null) === (c.scopeFingerprint === null));
export type RequestedMailContext = z.infer<typeof requestedMailContextSchema>;
export const requestedFollowupDraftSchema = z.strictObject({ kind: z.literal('requested_phone_followup'), id, accountId: id, revision,
  mailboxSubject: id, sender: email, recipient: email, recipientBinding: requestedRecipientSchema,
  accountVersion: revision, researchRevision: revision, contextRevision: hash, originalCall: originalCallRefSchema,
  mailContext: requestedMailContextSchema, subject, body: z.string().max(20000).refine(v => !v.includes('\0')),
  evidenceIds: z.array(id).max(200), generation: z.enum(['model', 'edited']), updatedAt: instant })
  .refine(d => d.recipient === d.recipientBinding.email && (d.recipientBinding.kind !== 'owner_supplied' || JSON.stringify(d.originalCall) === JSON.stringify(d.recipientBinding.originalCall)), 'requested_recipient_mismatch');
export type RequestedFollowupDraft = z.infer<typeof requestedFollowupDraftSchema>;
export const approveRequestedFollowupSchema = z.strictObject({ draft: requestedFollowupDraftSchema, expectedRemoteDraftRevision: revision.nullable(), approvalId: id, actionId: id, intentCommandId: z.uuid(),
  request: z.strictObject({ statement: z.literal('recipient_requested_information_by_email'), recipient: email }), expiresAt: instant })
  .refine(v => v.request.recipient === v.draft.recipient && v.draft.subject.trim().length > 0 && v.draft.body.trim().length > 0);
export type ApproveRequestedFollowup = z.infer<typeof approveRequestedFollowupSchema>;
export const prepareRequestedFollowupSchema = z.strictObject({ accountId: id, originalCall: originalCallRefSchema, recipientBinding: requestedRecipientSchema, expectedAccountVersion: revision, mode: z.enum(['manual', 'model']) });
export type PrepareRequestedFollowup = z.infer<typeof prepareRequestedFollowupSchema>;
export const getRequestedFollowupSchema = z.strictObject({ accountId: id, draftId: id });
export type GetRequestedFollowup = z.infer<typeof getRequestedFollowupSchema>;
export const editRequestedFollowupSchema = getRequestedFollowupSchema.extend({ expectedRevision: revision, subject, body: z.string().max(20000).refine(v => !v.includes('\0')) });
export type EditRequestedFollowup = z.infer<typeof editRequestedFollowupSchema>;
export const requestedApprovalStatusSchema = z.strictObject({ receipt: z.lazy(() => commandReceiptSchema), state: z.enum(['pending_preflight', 'materialized', 'needs_review', 'expired', 'revoked']), intentCommandId: id.nullable(), reason: z.string().max(1000).nullable() });
export type RequestedApprovalStatus = z.infer<typeof requestedApprovalStatusSchema>;
export const savedRequestedFollowupSchema = z.strictObject({ draft: requestedFollowupDraftSchema, stale: z.boolean(), approval: requestedApprovalStatusSchema.nullable() });
export type SavedRequestedFollowup = z.infer<typeof savedRequestedFollowupSchema>;
