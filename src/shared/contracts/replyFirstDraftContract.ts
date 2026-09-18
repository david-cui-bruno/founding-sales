import { z } from 'zod';
import { accountReplyDraftSchema, replyDraftResultSchema, reconcileReplyDraftSchema } from './mailThreadContract';
import { accountIdSchema as id } from './accountContract';
import { commandReceiptSchema } from './delegationContract';

/**
 * D9: the first draft of an inbound reply is written on this Mac with the OpenAI key from
 * Settings → Connections. The worker gets no second model boundary: it only ever sees the
 * resulting text as an ordinary edited revision of the saved draft it already holds.
 *
 * `model` means the provider produced this revision. `edited` means the founder's own text is
 * the newest revision, so a regenerate would overwrite it. `model_unconfigured` is the honest
 * state when no key is stored: nothing is generated, nothing is written, and the editor still
 * works by hand. Nothing in this contract sends, dials or books.
 */
export const replyFirstDraftGenerationSchema = z.enum(['model', 'edited', 'model_unconfigured']);
export type ReplyFirstDraftGeneration = z.infer<typeof replyFirstDraftGenerationSchema>;

/** A regenerate is a new admit against the same thread identity, so the request binds the
 * revision, thread revision and context revision the founder actually read. */
export const admitReplyFirstDraftSchema = reconcileReplyDraftSchema.extend({
  expectedRevision: z.number().int().positive().safe(),
  expectedThreadRevision: z.number().int().positive().safe(),
  expectedContextRevision: id,
});
export type AdmitReplyFirstDraft = z.infer<typeof admitReplyFirstDraftSchema>;

/** `citedEvidenceIds` is what the model actually cited for this revision. The saved draft's own
 * `evidenceIds` are part of its immutable identity and are never rebased by a regenerate, so the
 * citations are reported here rather than written over the record's received evidence. */
export const replyFirstDraftResultSchema = replyDraftResultSchema.extend({
  state: replyFirstDraftGenerationSchema, citedEvidenceIds: z.array(z.string().min(1).max(200)).max(200),
});
export type ReplyFirstDraftResult = z.infer<typeof replyFirstDraftResultSchema>;

/** A model admit either bumps the revision by one as an ordinary edit, or changes nothing at all
 * (`model_unconfigured`, or an exact replay of the revision already saved). It never rebases. */
export function boundReplyFirstDraftResult(request: AdmitReplyFirstDraft) {
  return replyFirstDraftResultSchema.refine(result =>
    result.draft.accountId === request.accountId && result.draft.id === request.draftId
    && result.draft.threadRevision === request.expectedThreadRevision && result.draft.contextRevision === request.expectedContextRevision
    && (result.state === 'model'
      ? result.draft.revision === request.expectedRevision + 1 && result.draft.generation === 'edited'
      : result.draft.revision === request.expectedRevision && result.citedEvidenceIds.length === 0), 'reply_first_draft_response_mismatch');
}

/**
 * The founder's statement when approving a reply. It is the recorded legal basis for the
 * one reply he is approving, not standing permission: `ongoing_correspondence` means this firm
 * wrote into the thread being answered, `requested_followup` means they asked for this email.
 * The basis is carried in the approve-reply command the worker admits as dispatch permission.
 */
export const replyApprovalStatementSchema = z.enum(['ongoing_correspondence', 'requested_followup']);
export type ReplyApprovalStatement = z.infer<typeof replyApprovalStatementSchema>;

/** Approving records the approval; it does not send. Submitting is what asks the worker to send. */
export const approveReplySchema = z.strictObject({
  accountId: id, draftId: id, approvalId: id, commandId: z.uuid(), intentCommandId: z.uuid(), actionId: id,
  expectedRevision: z.number().int().positive().safe(), statement: replyApprovalStatementSchema,
});
export type ApproveReply = z.infer<typeof approveReplySchema>;

export const submitApprovedReplySchema = z.strictObject({ accountId: id, approvalId: id, commandId: z.uuid() });
export type SubmitApprovedReply = z.infer<typeof submitApprovedReplySchema>;

/** `held` carries a local reason and no command: nothing was queued, so nothing can be sent. */
export const replyApprovalStatusSchema = z.strictObject({
  accountId: id, draftId: id, approvalId: id, draftRevision: z.number().int().positive().safe(),
  statement: replyApprovalStatementSchema,
  /** When this approval stops being usable. The exact instant David approved is recorded by the
   * worker with the permission it admits; the desktop stores the command, not a second clock
   * reading, so it reports the bound expiry rather than asserting an approval time of its own. */
  approvalExpiresAt: z.string().datetime().nullable(),
  approvalCommandId: z.uuid().nullable(), submitCommandId: z.uuid().nullable(),
  state: z.enum(['held', 'approved', 'pending', 'applied', 'rejected']),
  receipt: commandReceiptSchema.nullable(), reason: z.string().max(1000).nullable(),
}).refine(status => (status.state === 'held') === (status.approvalCommandId === null)
  && (status.state === 'held') === (status.approvalExpiresAt === null)
  && (status.submitCommandId === null ? status.receipt === null : true)
  && (status.state === 'rejected' ? status.reason !== null : true), 'reply_approval_status_binding');
export type ReplyApprovalStatus = z.infer<typeof replyApprovalStatusSchema>;

export function boundReplyApprovalStatus(request: ApproveReply | SubmitApprovedReply) {
  return replyApprovalStatusSchema.refine(status => status.accountId === request.accountId && status.approvalId === request.approvalId
    && ('draftId' in request ? status.draftId === request.draftId && status.statement === request.statement : true)
    && ('statement' in request ? status.approvalCommandId === null || status.approvalCommandId === request.commandId : status.submitCommandId === null || status.submitCommandId === request.commandId),
    'reply_approval_identity_mismatch');
}

/** Every suppression is permanent by design; this read has no undo and writes nothing. */
export const suppressionEntrySchema = z.strictObject({
  kind: z.enum(['account_opt_out', 'never_call', 'handle_opt_out', 'person_opt_out', 'retired_route']),
  subject: z.string().min(1).max(2048), accountId: id.nullable(), observedAt: z.string().min(1).max(64),
  why: z.string().min(1).max(500), evidenceRef: z.string().max(500).nullable(),
});
export type SuppressionEntry = z.infer<typeof suppressionEntrySchema>;
export const SUPPRESSION_READ_LIMIT = 200;
export const suppressionListSchema = z.strictObject({
  entries: z.array(suppressionEntrySchema).max(SUPPRESSION_READ_LIMIT),
  truncated: z.boolean(), generatedAt: z.string().datetime(),
});
export type SuppressionList = z.infer<typeof suppressionListSchema>;

export { accountReplyDraftSchema };
