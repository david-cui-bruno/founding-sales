import { z } from 'zod';
import { accountIdSchema as id, accountInstantSchema as instant } from './accountContract';
import { commandReceiptSchema } from './commandReceiptContract';
import { REPLY_TEMPLATE_IDS, REPLY_TEMPLATE_PURPOSES, replyTemplateValuesSchema } from './replyTemplateContract';
const revision = z.number().int().positive().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const email = z.string().email().max(254).refine(v => /^[\x21-\x7e]+$/.test(v));
const subject = z.string().max(240).refine(v => !/[\x00-\x1f\x7f]/.test(v)); // eslint-disable-line no-control-regex
export const originalCallRefSchema = z.strictObject({ commandId: id, handoffId: id, actionId: id, commandFingerprint: hash, outcomeEventId: id, outcomeEventHash: hash });
export type OriginalCallRef = z.infer<typeof originalCallRefSchema>;
export const requestedRecipientSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('account_route'), routeId: id, routeVersion: revision, email }),
  /**
   * The business email the research found on the firm's own website, as a cited `business_email` account claim
   * (D13, lane 39). `claimIndex` is the position of that claim in the account record the binding was made
   * against, so the binding names one exact recorded fact rather than "whatever address the firm has now": if the
   * claim at that index is not a `business_email` fact naming this address, the draft is refused at prepare time
   * and again at approval. This is a recipient, never permission: the sequence step's own approval is what allows
   * the send, and a firm without this claim holds with `no_business_email`.
   */
  z.strictObject({ kind: z.literal('account_claim'), claimIndex: z.number().int().nonnegative().max(199), email }),
  z.strictObject({ kind: z.literal('owner_supplied'), email, originalCall: originalCallRefSchema }),
]);
export type RequestedRecipient = z.infer<typeof requestedRecipientSchema>;
export const requestedMailContextSchema = z.strictObject({ scopeRevision: revision.nullable(), scopeFingerprint: hash.nullable(), inboundContextRevision: revision.nullable(), inboundContextFingerprint: hash })
  .refine(c => (c.scopeRevision === null) === (c.scopeFingerprint === null));
export type RequestedMailContext = z.infer<typeof requestedMailContextSchema>;
/** The template a template-mode draft was rendered from, pinned to the exact revision and hash of that text. */
export const requestedTemplateBindingSchema = z.strictObject({ templateId: z.enum(REPLY_TEMPLATE_IDS), revision: revision,
  contentHash: hash, purpose: z.enum(REPLY_TEMPLATE_PURPOSES), values: replyTemplateValuesSchema });
export type RequestedTemplateBinding = z.infer<typeof requestedTemplateBindingSchema>;
export const requestedFollowupDraftSchema = z.strictObject({ kind: z.literal('requested_phone_followup'), id, accountId: id, revision,
  mailboxSubject: id, sender: email, recipient: email, recipientBinding: requestedRecipientSchema,
  accountVersion: revision, researchRevision: revision, contextRevision: hash, originalCall: originalCallRefSchema,
  mailContext: requestedMailContextSchema, subject, body: z.string().max(20000).refine(v => !v.includes('\0')),
  evidenceIds: z.array(id).max(200), generation: z.enum(['model', 'edited', 'template']), template: requestedTemplateBindingSchema.optional(), updatedAt: instant })
  .refine(d => (d.generation === 'template') === (d.template !== undefined), 'requested_template_generation')
  .refine(d => d.recipient === d.recipientBinding.email && (d.recipientBinding.kind !== 'owner_supplied' || JSON.stringify(d.originalCall) === JSON.stringify(d.recipientBinding.originalCall)), 'requested_recipient_mismatch');
export type RequestedFollowupDraft = z.infer<typeof requestedFollowupDraftSchema>;
export const approveRequestedFollowupSchema = z.strictObject({ draft: requestedFollowupDraftSchema, expectedRemoteDraftRevision: revision.nullable(), approvalId: id, actionId: id, intentCommandId: z.uuid(),
  // A template draft is approved for what the template is for; only a manual or model draft states that the
  // recipient asked for information by email, because only that draft was prepared on that basis.
  request: z.strictObject({ statement: z.enum(['recipient_requested_information_by_email', ...REPLY_TEMPLATE_PURPOSES]), recipient: email }), expiresAt: instant })
  .refine(v => v.request.recipient === v.draft.recipient && v.draft.subject.trim().length > 0 && v.draft.body.trim().length > 0)
  .refine(v => v.draft.template
    ? v.request.statement === v.draft.template.purpose
    : v.request.statement === 'recipient_requested_information_by_email', 'requested_statement_basis');
export type ApproveRequestedFollowup = z.infer<typeof approveRequestedFollowupSchema>;
export const prepareRequestedFollowupSchema = z.strictObject({ accountId: id, originalCall: originalCallRefSchema, recipientBinding: requestedRecipientSchema,
  expectedAccountVersion: revision, mode: z.enum(['manual', 'model', 'template']),
  /** Template mode only: which approved template to render and the values the sequence already knows. */
  template: z.strictObject({ templateId: z.enum(REPLY_TEMPLATE_IDS), values: replyTemplateValuesSchema }).optional(),
  draftId: z.uuid().optional() })
  .refine(v => v.draftId === undefined || v.mode === 'manual' || v.mode === 'template', 'requested_retry_manual_only')
  .refine(v => (v.mode === 'template') === (v.template !== undefined), 'requested_template_mode_binding');
export type PrepareRequestedFollowup = z.infer<typeof prepareRequestedFollowupSchema>;
export const getRequestedFollowupSchema = z.strictObject({ accountId: id, draftId: id });
export type GetRequestedFollowup = z.infer<typeof getRequestedFollowupSchema>;
export const editRequestedFollowupSchema = getRequestedFollowupSchema.extend({ expectedRevision: revision, subject, body: z.string().max(20000).refine(v => !v.includes('\0')) });
export type EditRequestedFollowup = z.infer<typeof editRequestedFollowupSchema>;
export const requestedApprovalStatusSchema = z.strictObject({ receipt: z.lazy(() => commandReceiptSchema), state: z.enum(['pending_preflight', 'materialized', 'needs_review', 'expired', 'revoked']), intentCommandId: id.nullable(), reason: z.string().max(1000).nullable() });
export type RequestedApprovalStatus = z.infer<typeof requestedApprovalStatusSchema>;
export const savedRequestedFollowupSchema = z.strictObject({ draft: requestedFollowupDraftSchema, stale: z.boolean(), approval: requestedApprovalStatusSchema.nullable() });
export type SavedRequestedFollowup = z.infer<typeof savedRequestedFollowupSchema>;
