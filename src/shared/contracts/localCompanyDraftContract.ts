import { z } from 'zod';
import { accountIdSchema, accountInstantSchema, accountSourceSchema } from './accountContract';
const version = z.number().int().positive().safe();
export const companyDraftEmailSchema = z.string().trim().max(254).regex(/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/).pipe(z.email()).transform(value => value.toLowerCase());
const quoteSchema = z.string().min(1).max(12000).refine(value => value.trim().length > 0);
export const admitCompanyDraftEmailSchema = z.object({ commandId: z.uuid(), accountId: accountIdSchema, expectedAccountVersion: version,
  email: companyDraftEmailSchema, sourceId: accountIdSchema, quote: quoteSchema, selection: z.literal('published_company_business_inbox') }).strict();
export const openCompanyDraftSchema = z.object({ commandId: z.uuid(), accountId: accountIdSchema, routeId: accountIdSchema,
  expectedRouteVersion: version, expectedAccountVersion: version }).strict();
export const getCompanyDraftSchema = z.union([z.object({ accountId: accountIdSchema, draftId: accountIdSchema }).strict(),
  z.object({ accountId: accountIdSchema, routeId: accountIdSchema }).strict()]);
export const saveCompanyDraftSchema = z.object({ commandId: z.uuid(), accountId: accountIdSchema, draftId: accountIdSchema, expectedRevision: version,
  subject: z.string().max(240).refine(value => ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)), body: z.string().max(20000).refine(value => !value.includes('\0')) }).strict();
export const companyDraftPublicationSchema = z.object({ sourceId: accountIdSchema, url: accountSourceSchema.shape.url, sha256: z.string().regex(/^[a-f0-9]{64}$/),
  fetchedAt: accountInstantSchema, quote: quoteSchema }).strict();
export const companyDraftRecipientSchema = z.object({ routeId: accountIdSchema, routeVersion: version, email: companyDraftEmailSchema, personId: z.null() }).strict();
export const companyDraftAdmissionReceiptSchema = z.object({ commandId: z.uuid(), accountId: accountIdSchema, accountVersion: version,
  recipientBinding: companyDraftRecipientSchema, publication: companyDraftPublicationSchema, selection: z.literal('published_company_business_inbox') }).strict()
  .refine(receipt => companyDraftMailboxOccurrences(receipt.publication.quote, receipt.recipientBinding.email).length > 0);
export const localCompanyDraftSchema = z.object({ kind: z.literal('local_company_email'), status: z.literal('unsent'), id: accountIdSchema,
  accountId: accountIdSchema, revision: version, recipientBinding: companyDraftRecipientSchema, accountVersionAtOpen: version,
  sourceIds: z.array(accountIdSchema).min(1).max(100), publication: companyDraftPublicationSchema, companyLabel: z.string().min(1).max(300),
  subject: saveCompanyDraftSchema.shape.subject, body: saveCompanyDraftSchema.shape.body, createdAt: accountInstantSchema, updatedAt: accountInstantSchema }).strict()
  .refine(draft => draft.sourceIds.includes(draft.publication.sourceId) && new Set(draft.sourceIds).size === draft.sourceIds.length
    && companyDraftMailboxOccurrences(draft.publication.quote, draft.recipientBinding.email).length > 0 && draft.updatedAt >= draft.createdAt);
export const companyDraftReadSchema = z.object({ draft: localCompanyDraftSchema, stale: z.boolean(),
  reason: z.enum(['suppressed', 'route_changed', 'evidence_unavailable']).nullable(), editable: z.boolean() }).strict()
  .refine(value => value.stale === (value.reason !== null) && value.editable === (value.reason !== 'suppressed'));
export const companyDraftMutationReceiptSchema = z.object({ commandId: z.uuid(), accountId: accountIdSchema, draftId: accountIdSchema,
  operation: z.enum(['open', 'save']), appliedRevision: version, recipientBinding: companyDraftRecipientSchema, publication: companyDraftPublicationSchema }).strict();
export const companyDraftMutationResultSchema = z.object({ receipt: companyDraftMutationReceiptSchema, current: companyDraftReadSchema }).strict()
  .refine(value => value.receipt.accountId === value.current.draft.accountId && value.receipt.draftId === value.current.draft.id
    && value.receipt.appliedRevision <= value.current.draft.revision
    && JSON.stringify(value.receipt.recipientBinding) === JSON.stringify(value.current.draft.recipientBinding)
    && JSON.stringify(value.receipt.publication) === JSON.stringify(value.current.draft.publication));
export type AdmitCompanyDraftEmail = z.infer<typeof admitCompanyDraftEmailSchema>;
export type OpenCompanyDraft = z.infer<typeof openCompanyDraftSchema>;
export type GetCompanyDraft = z.infer<typeof getCompanyDraftSchema>;
export type SaveCompanyDraft = z.infer<typeof saveCompanyDraftSchema>;
export type CompanyDraftAdmissionReceipt = z.infer<typeof companyDraftAdmissionReceiptSchema>;
export type CompanyDraftPublication = z.infer<typeof companyDraftPublicationSchema>;
export type LocalCompanyDraft = z.infer<typeof localCompanyDraftSchema>;
export type CompanyDraftRead = z.infer<typeof companyDraftReadSchema>;
export type CompanyDraftMutationResult = z.infer<typeof companyDraftMutationResultSchema>;
/** A preparation is an ephemeral proposal, never a durable draft mutation. */
export const prepareCompanyDraftSchema = z.object({ accountId: accountIdSchema, draftId: accountIdSchema, expectedRevision: version }).strict();
const preparationFactSchema = z.object({ id: z.string().regex(/^company-draft:[a-f0-9]{64}$/), text: z.string().min(1).max(3000) }).strict();
export const preparedCompanyDraftSchema = z.object({
  accountId: accountIdSchema, draftId: accountIdSchema, baseRevision: version, accountVersion: version,
  recipientBinding: companyDraftRecipientSchema,
  subject: saveCompanyDraftSchema.shape.subject.max(200).refine(value => value.trim().length > 0),
  body: saveCompanyDraftSchema.shape.body.max(12000).refine(value => value.trim().length > 0),
  grounding: z.object({ facts: z.array(preparationFactSchema).min(1).max(8),
    usedFactIds: z.array(preparationFactSchema.shape.id).min(1).max(8), playbookVersion: z.literal('2026-09-08') }).strict(),
}).strict().refine(value => {
  const ids = new Set(value.grounding.facts.map(fact => fact.id));
  return ids.size === value.grounding.facts.length
    && new Set(value.grounding.usedFactIds).size === value.grounding.usedFactIds.length
    && value.grounding.usedFactIds.every(id => ids.has(id))
    && value.grounding.facts.reduce((bytes, fact) => bytes + new TextEncoder().encode(fact.text).length, 0) <= 12000;
}, 'Company preparation grounding mismatch');
export type PrepareCompanyDraft = z.infer<typeof prepareCompanyDraftSchema>;
export type PreparedCompanyDraft = z.infer<typeof preparedCompanyDraftSchema>;
export function companyDraftPrepareReply(input: PrepareCompanyDraft) {
  return preparedCompanyDraftSchema.refine(result => result.accountId === input.accountId && result.draftId === input.draftId
    && result.baseRevision === input.expectedRevision, 'Company preparation identity mismatch');
}
export function companyDraftAdmissionReply(input: AdmitCompanyDraftEmail) {
  return companyDraftAdmissionReceiptSchema.refine(result => result.commandId === input.commandId && result.accountId === input.accountId
    && result.accountVersion === input.expectedAccountVersion + 1 && result.recipientBinding.email === input.email
    && result.publication.sourceId === input.sourceId && result.publication.quote === input.quote);
}
export function companyDraftGetReply(input: GetCompanyDraft) {
  return companyDraftReadSchema.nullable().refine(result => result === null || (result.draft.accountId === input.accountId
    && ('draftId' in input ? result.draft.id === input.draftId : result.draft.recipientBinding.routeId === input.routeId)));
}
export function companyDraftOpenReply(input: OpenCompanyDraft) {
  return companyDraftMutationResultSchema.refine(result => result.receipt.operation === 'open' && result.receipt.commandId === input.commandId
    && result.receipt.accountId === input.accountId && result.receipt.recipientBinding.routeId === input.routeId
    && result.receipt.recipientBinding.routeVersion === input.expectedRouteVersion);
}
export function companyDraftSaveReply(input: SaveCompanyDraft) {
  return companyDraftMutationResultSchema.refine(result => result.receipt.operation === 'save' && result.receipt.commandId === input.commandId
    && result.receipt.accountId === input.accountId && result.receipt.draftId === input.draftId && result.receipt.appliedRevision === input.expectedRevision + 1
    && (result.current.draft.revision !== result.receipt.appliedRevision || (result.current.draft.subject === input.subject && result.current.draft.body === input.body)));
}

/** Consume whole ASCII mailbox-shaped tokens in the original source, not clipped quotations. */
export function companyDraftMailboxOccurrences(text: string, email: string): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  const tokens = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+/g;
  for (const token of text.matchAll(tokens)) {
    const parsed = companyDraftEmailSchema.safeParse(token[0]);
    const before = [...text.slice(0, token.index)].at(-1) ?? '', after = [...text.slice(token.index + token[0].length)][0] ?? '';
    if (/[\p{L}\p{N}\p{M}_@]/u.test(before) || /[\p{L}\p{N}\p{M}_@+-]/u.test(after)) continue;
    if (parsed.success && parsed.data === email) found.push({ start: token.index, end: token.index + token[0].length });
  }
  return found;
}
