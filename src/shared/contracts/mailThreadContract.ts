import { z } from 'zod';
const id = z.string().min(1).max(255);
const providerId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const header = z.string().max(998).refine(value => !/[\r\n\x00]/.test(value)); // eslint-disable-line no-control-regex
export const mailMessageSchema = z.strictObject({ id: providerId, threadId: providerId,
  rfcMessageId: header.nullable(), references: z.array(header).max(50),
  from: z.array(z.string().email()).min(1).max(20), to: z.array(z.string().email()).max(20), cc: z.array(z.string().email()).max(20),
  date: z.string().datetime(), subject: header,
  bodyParts: z.array(z.strictObject({ mimeType: z.enum(['text/plain', 'text/html']), text: z.string().max(24000), truncated: z.boolean() })).max(4),
});
export type MailMessage = z.infer<typeof mailMessageSchema>;
export const relevantThreadSchema = z.strictObject({ accountId: id, mailboxSubject: id, provider: z.literal('gmail'),
  providerThreadId: providerId, messages: z.array(mailMessageSchema).min(1).max(200) }).refine(t => t.messages.every(m => m.threadId === t.providerThreadId) && new Set(t.messages.map(m => m.id)).size === t.messages.length);
export type RelevantThread = z.infer<typeof relevantThreadSchema>;
const scopeRevision = z.number().int().positive().safe();
const sortedUnique = (values: string[]) => values.every((value, index) => index === 0 || value > values[index - 1]!);
export const mailAccountScopeSchema = z.strictObject({ version: z.literal(1), accountId: id, mailboxSubject: id,
  revision: scopeRevision, participantAddresses: z.array(z.string().email().max(254).regex(/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+$/)).min(1).max(20).refine(sortedUnique),
  knownThreadIds: z.array(providerId).max(100).refine(sortedUnique), since: z.string().datetime(), approvedAt: z.string().datetime() })
  .refine(scope => scope.since <= scope.approvedAt);
export type MailAccountScope = z.infer<typeof mailAccountScopeSchema>;
const scopeBinding = { scopeRevision: scopeRevision.nullable().optional(), scopeFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional() };
/** Account-scoped checkpoints, never stored as synthetic provider threads. A scan
 * captures historyId BEFORE listing, so history replay covers arrivals during it. */
export const mailCheckpointSchema = z.strictObject({ version: z.literal(1), accountId: id, mailboxSubject: id,
  ...scopeBinding, mode: z.enum(['scan', 'history']), historyId: z.string().regex(/^\d+$/), pageToken: z.string().min(1).max(2048).nullable(), since: z.string().datetime() });
export type MailCheckpoint = z.infer<typeof mailCheckpointSchema>;
export type ThreadReadRequest = { accountId: string; knownThreadIds: string[]; participantAddresses: string[]; since: string;
  scope?: MailAccountScope; cursor: MailCheckpoint | null; maxPages: number; maxBodyBytes: number };
export type ThreadPage = { threads: RelevantThread[]; nextCursor: MailCheckpoint; complete: boolean };
export const replyClassificationSchema = z.strictObject({ kind: z.enum(['substantive', 'scheduling', 'mixed', 'opt_out', 'rejection', 'out_of_office', 'delivery_failure', 'ambiguous']),
  evidence: z.array(z.strictObject({ messageId: providerId, quote: z.string().max(500) })).min(1).max(10), requiresApproval: z.literal(true) });
export type ReplyClassification = z.infer<typeof replyClassificationSchema>;
export const threadProjectionSchema = z.strictObject({ thread: relevantThreadSchema, revision: z.number().int().positive(), contextRevision: id,
  signals: z.array(replyClassificationSchema).max(200) }).refine(p => p.signals.every(s => s.evidence.every(e => {
    const message = p.thread.messages.find(m => m.id === e.messageId);
    return message !== undefined && message.bodyParts.map(part => part.text).join('\n').includes(e.quote);
  })), 'unsupported_signal_evidence');
export type ThreadProjection = z.infer<typeof threadProjectionSchema>;
export const approvalInvalidationSchema = z.strictObject({ threadId: providerId, previousRevision: z.number().int().nonnegative(), revision: z.number().int().positive(), contextRevision: id });
export type ApprovalInvalidation = z.infer<typeof approvalInvalidationSchema>;
export const threadObservedPayloadSchema = z.strictObject({ projection: threadProjectionSchema, approvalInvalidation: approvalInvalidationSchema, observedAt: z.string().datetime() }).refine(p =>
  p.approvalInvalidation.threadId === p.projection.thread.providerThreadId && p.approvalInvalidation.revision === p.projection.revision
  && p.approvalInvalidation.previousRevision + 1 === p.projection.revision && p.approvalInvalidation.contextRevision === p.projection.contextRevision, 'thread_invalidation_mismatch');
export type ThreadObservedPayload = z.infer<typeof threadObservedPayloadSchema>;
export type IntakeResult = { changed: boolean; revision: number; signals: ReplyClassification[]; projection: ThreadProjection; approvalInvalidation: ApprovalInvalidation | null };
/** Account replies do not fabricate legacy person/cycle IDs and carry no send authority. */
export const accountReplyDraftSchema = z.strictObject({ id, accountId: id, threadId: providerId, mailboxSubject: id,
  threadRevision: z.number().int().positive(), contextRevision: id, revision: z.number().int().positive(),
  recipient: z.string().email().max(254), sender: z.string().email().max(254), subject: header.max(240),
  body: z.string().max(20000).refine(value => !value.includes('\0')), evidenceIds: z.array(id).max(200),
  generation: z.enum(['model', 'edited']), updatedAt: z.string().datetime() });
export type AccountReplyDraft = z.infer<typeof accountReplyDraftSchema>;
export type SavedReplyDraft = { draft: AccountReplyDraft; stale: boolean };
export const mailPollStateSchema = z.strictObject({ ...scopeBinding, attemptId: id, accountId: id, mailboxSubject: id,
  status: z.enum(['pending', 'complete', 'failed']), startedAt: z.string().datetime(), completedAt: z.string().datetime().nullable() })
  .refine(p => p.status === 'pending' ? p.completedAt === null : p.completedAt !== null && p.completedAt >= p.startedAt);
export type MailPollState = z.infer<typeof mailPollStateSchema>;
export const mailCursorEnvelopeSchema = z.strictObject({ scope: mailAccountScopeSchema.nullable().default(null), checkpoint: mailCheckpointSchema.nullable(), poll: mailPollStateSchema.nullable() })
  .refine(e => (!e.poll || !e.checkpoint || e.poll.accountId === e.checkpoint.accountId && e.poll.mailboxSubject === e.checkpoint.mailboxSubject)
    && (e.poll?.status !== 'complete' || e.checkpoint?.mode === 'history' && e.checkpoint.pageToken === null));
export type MailCursorEnvelope = z.infer<typeof mailCursorEnvelopeSchema>;
