import { z } from 'zod';
import { accountIdSchema as id, accountInstantSchema as instant } from './accountContract';
import { commandReceiptSchema } from './commandReceiptContract';
import { sha256Utf8 } from '../crypto/sha256';
import { CALLIE_OUTREACH_PRODUCT_SENTENCE } from '../product/callieProductFacts';

/**
 * The five follow-up templates David approves once (design D13, his decision of 17 September 2026).
 * A template is revision-tracked text he edits and approves; an approval is standing, so the worker
 * may send that template as a sequence step without another click, and any edit revokes it until he
 * approves the new revision. Nothing here sends, dials or books: approving records his statement and
 * the sha256 of the exact subject and body the worker is allowed to send.
 *
 * The body rules of the 17 September templates file are enforced by this schema, not by review: one
 * approved product sentence, under ninety words, plain text, at most one URL, no pricing or guarantee
 * language, only the named variables, and the pinned sign-off as the closing lines.
 */
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** The workspace-level subject every reply-template command names where an account id would otherwise stand. */
export const REPLY_TEMPLATE_SUBJECT = 'reply-templates';
export const REPLY_TEMPLATE_IDS = ['T1', 'T2', 'T3', 'T4', 'T5'] as const;
export type ReplyTemplateId = typeof REPLY_TEMPLATE_IDS[number];
/**
 * What the template is for. The five seeded templates use the first five; `meeting_confirmation` and
 * `not_interested_reply` are named by the batch brief and reserved, with no seeded text behind them.
 */
export const REPLY_TEMPLATE_PURPOSES = ['after_conversation', 'missed_you', 'check_back_later', 'short_value_note',
  'last_note', 'meeting_confirmation', 'not_interested_reply'] as const;
export type ReplyTemplatePurpose = typeof REPLY_TEMPLATE_PURPOSES[number];
/** The only placeholders a template body or subject may name. Anything else is refused, never invented at send time. */
export const REPLY_TEMPLATE_VARIABLES = ['firm', 'city', 'callback_date', 'next_step', 'my_name', 'my_phone', 'booking_link'] as const;
export type ReplyTemplateVariable = typeof REPLY_TEMPLATE_VARIABLES[number];
/** Pinned by David on 17 September 2026. Every body ends with exactly these four lines. */
export const REPLY_TEMPLATE_SIGN_OFF = 'Best,\nDavid\nFounder, Callie\nusecallie.com · (469) 469-8262';
/** "Under ninety words" from the templates file, counted over the whole body including the sign-off. */
export const REPLY_TEMPLATE_MAX_WORDS = 89;
export const REPLY_TEMPLATE_MAX_URLS = 1;
/**
 * No pricing and no guarantees, from the rules baked into the templates file. Ordinary words that merely
 * describe a customer's own cost ("cost", "spend") are not on this list: the refusal is about claims Callie
 * makes, not about what the recipient already pays.
 */
export const REPLY_TEMPLATE_FORBIDDEN_PHRASES = ['guarantee', 'guaranteed', 'guarantees', 'warranty', 'pricing', 'price',
  'priced', 'prices', 'discount', 'free trial', 'risk-free', 'money back', 'refund', 'we promise', 'i promise',
  'we will', 'we guarantee', 'no obligation', 'roi'] as const;
const WORDS = (value: string): number => value.trim().length === 0 ? 0 : value.trim().split(/\s+/).length;
const URLS = (value: string): number => (value.match(/https?:\/\//g) ?? []).length;
const PLACEHOLDERS = (value: string): string[] => (value.match(/\{[^{}]*\}/g) ?? []).map(match => match.slice(1, -1));
const allowed = new Set<string>(REPLY_TEMPLATE_VARIABLES);
/** Every rule the templates file bakes in, as one refusal list. The first mismatch names itself and nothing else. */
export function replyTemplateTextIssues(input: { subject: string; body: string }): string[] {
  const issues: string[] = [];
  const { subject, body } = input;
  if (subject.trim().length === 0) issues.push('template_subject_empty');
  if (/[\x00-\x1f\x7f]/.test(subject)) issues.push('template_subject_not_one_line'); // eslint-disable-line no-control-regex
  if (URLS(subject) > 0) issues.push('template_subject_url');
  if (/[\x00-\x08\x0b-\x1f\x7f]|\r/.test(body)) issues.push('template_body_not_plain_text'); // eslint-disable-line no-control-regex
  if (/<[a-z/!][^>]*>/i.test(body)) issues.push('template_body_markup');
  if (WORDS(body) > REPLY_TEMPLATE_MAX_WORDS) issues.push('template_body_too_long');
  if (URLS(body) > REPLY_TEMPLATE_MAX_URLS) issues.push('template_body_multiple_urls');
  if (!body.endsWith(REPLY_TEMPLATE_SIGN_OFF)) issues.push('template_sign_off_missing');
  if (!body.includes(CALLIE_OUTREACH_PRODUCT_SENTENCE)) issues.push('template_product_sentence_missing');
  const lowered = `${subject}\n${body}`.toLowerCase();
  if (REPLY_TEMPLATE_FORBIDDEN_PHRASES.some(phrase => new RegExp(`(^|[^a-z])${phrase.replace(/[-.]/g, '\\$&')}([^a-z]|$)`).test(lowered))
    || /[$€£]\s?\d|\d\s?%/.test(lowered)) issues.push('template_pricing_or_guarantee_language');
  if ([...PLACEHOLDERS(subject), ...PLACEHOLDERS(body)].some(name => !allowed.has(name))) issues.push('template_unknown_variable');
  return issues;
}
export const replyTemplateApprovalSchema = z.strictObject({
  state: z.enum(['draft', 'approved', 'revoked']),
  /** The revision the approval covers, and the sha256 of exactly that revision's subject and body. */
  approvedRevision: revision.nullable(), approvedAt: instant.nullable(), contentHash: hash.nullable(),
}).refine(approval => (approval.state === 'approved') === (approval.approvedRevision !== null)
  && (approval.approvedRevision === null) === (approval.approvedAt === null)
  && (approval.approvedRevision === null) === (approval.contentHash === null), 'template_approval_binding');
export type ReplyTemplateApproval = z.infer<typeof replyTemplateApprovalSchema>;
export const replyTemplateSchema = z.strictObject({
  id: z.enum(REPLY_TEMPLATE_IDS), name: z.string().trim().min(1).max(120), purpose: z.enum(REPLY_TEMPLATE_PURPOSES),
  subject: z.string().min(1).max(160), body: z.string().min(1).max(4000),
  variables: z.array(z.enum(REPLY_TEMPLATE_VARIABLES)).max(REPLY_TEMPLATE_VARIABLES.length),
  revision, approval: replyTemplateApprovalSchema, updatedAt: instant,
}).superRefine((template, ctx) => {
  for (const issue of replyTemplateTextIssues(template)) ctx.addIssue({ code: 'custom', message: issue });
  const used = new Set([...PLACEHOLDERS(template.subject), ...PLACEHOLDERS(template.body)]);
  if (new Set(template.variables).size !== template.variables.length) ctx.addIssue({ code: 'custom', message: 'template_variables_duplicated' });
  if ([...used].some(name => !template.variables.includes(name as ReplyTemplateVariable))) ctx.addIssue({ code: 'custom', message: 'template_variables_incomplete' });
  if (template.approval.approvedRevision !== null && template.approval.approvedRevision > template.revision) ctx.addIssue({ code: 'custom', message: 'template_approval_revision' });
  if (template.approval.state === 'approved' && (template.approval.approvedRevision !== template.revision
    || template.approval.contentHash !== replyTemplateContentHash(template))) ctx.addIssue({ code: 'custom', message: 'template_approval_content' });
});
export type ReplyTemplate = z.infer<typeof replyTemplateSchema>;
/** The exact text the worker is allowed to send: the template identity, its revision and its subject and body. */
export function replyTemplateContentHash(template: { id: string; revision: number; subject: string; body: string }): string {
  return sha256Utf8(JSON.stringify({ kind: 'reply_template_content', version: 1, id: template.id,
    revision: template.revision, subject: template.subject, body: template.body }));
}
/** Workspace-level sending state. `paused` holds every template's sends without revoking a single approval. */
export const replyTemplateSettingsSchema = z.strictObject({ paused: z.boolean(), revision, updatedAt: instant });
export type ReplyTemplateSettings = z.infer<typeof replyTemplateSettingsSchema>;
export const replyTemplateSnapshotSchema = z.strictObject({
  templates: z.array(replyTemplateSchema).max(REPLY_TEMPLATE_IDS.length), settings: replyTemplateSettingsSchema,
}).refine(snapshot => new Set(snapshot.templates.map(template => template.id)).size === snapshot.templates.length, 'template_snapshot_duplicated');
export type ReplyTemplateSnapshot = z.infer<typeof replyTemplateSnapshotSchema>;

/** Local edit. Saving text always returns the template to `revoked` when it had been approved. */
export const editReplyTemplateSchema = z.strictObject({ templateId: z.enum(REPLY_TEMPLATE_IDS), expectedRevision: revision,
  subject: z.string().min(1).max(160), body: z.string().min(1).max(4000) });
export type EditReplyTemplate = z.infer<typeof editReplyTemplateSchema>;
/**
 * Renderer to main. The renderer names the command identity so a retry resends the same owner command;
 * main reads the template text from its own storage and never accepts subject or body from the renderer here.
 */
export const replyTemplateRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('read') }),
  z.strictObject({ kind: z.literal('approve'), commandId: z.uuid(), templateId: z.enum(REPLY_TEMPLATE_IDS), expectedRevision: revision }),
  z.strictObject({ kind: z.literal('revoke'), commandId: z.uuid(), templateId: z.enum(REPLY_TEMPLATE_IDS), expectedRevision: revision }),
  z.strictObject({ kind: z.literal('pause'), commandId: z.uuid(), paused: z.boolean() }),
]);
export type ReplyTemplateRequest = z.infer<typeof replyTemplateRequestSchema>;
export const replyTemplateStatusSchema = z.strictObject({ snapshot: replyTemplateSnapshotSchema, receipt: commandReceiptSchema.nullable() });
export type ReplyTemplateStatus = z.infer<typeof replyTemplateStatusSchema>;

/**
 * Owner command payloads. The approval carries the id, the revision and the content hash, so the worker
 * can refuse any text David did not approve; `template-read` stores nothing.
 */
export const replyTemplateCommandPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('template-read') }),
  z.strictObject({ kind: z.literal('template-approve'), templateId: z.enum(REPLY_TEMPLATE_IDS), revision, contentHash: hash }),
  z.strictObject({ kind: z.literal('template-revoke'), templateId: z.enum(REPLY_TEMPLATE_IDS), revision }),
  z.strictObject({ kind: z.literal('template-pause'), paused: z.boolean() }),
]);
export type ReplyTemplateCommandPayload = z.infer<typeof replyTemplateCommandPayloadSchema>;
/** One standing approval as the worker holds it. `pausedAt` is the workspace switch, not a per-template state. */
export const workerReplyTemplateApprovalSchema = z.strictObject({ templateId: z.enum(REPLY_TEMPLATE_IDS), revision,
  contentHash: hash, approvedAt: instant, commandId: z.uuid() });
export type WorkerReplyTemplateApproval = z.infer<typeof workerReplyTemplateApprovalSchema>;
export const workerReplyTemplateStateSchema = z.strictObject({
  approvals: z.array(workerReplyTemplateApprovalSchema).max(REPLY_TEMPLATE_IDS.length), paused: z.boolean(), updatedAt: instant,
}).refine(state => new Set(state.approvals.map(approval => approval.templateId)).size === state.approvals.length, 'template_state_duplicated');
export type WorkerReplyTemplateState = z.infer<typeof workerReplyTemplateStateSchema>;
export const replyTemplateReceiptSchema = z.strictObject({ receipt: commandReceiptSchema, state: workerReplyTemplateStateSchema.nullable() });
export type ReplyTemplateReceipt = z.infer<typeof replyTemplateReceiptSchema>;

/**
 * Why a template email did not go out, from a closed set. Every one of these is a hold the founder can
 * read and act on; none of them is a silent skip, and none of them is ever inferred from a missing read.
 */
export const REPLY_TEMPLATE_HOLD_REASONS = ['template_not_approved', 'mailbox_not_connected', 'sender_cap_reached',
  'no_business_email', 'template_variable_missing'] as const;
export type ReplyTemplateHoldReason = typeof REPLY_TEMPLATE_HOLD_REASONS[number];
export const replyTemplateHoldReasonSchema = z.enum(REPLY_TEMPLATE_HOLD_REASONS);
/** The values a template step may fill. A variable the template names and this record does not carry is a hold. */
export const replyTemplateValuesSchema = z.strictObject({
  firm: z.string().trim().min(1).max(200).optional(), city: z.string().trim().min(1).max(120).optional(),
  callback_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), next_step: z.string().trim().min(1).max(600).optional(),
  my_name: z.string().trim().min(1).max(120).optional(), my_phone: z.string().trim().min(1).max(40).optional(),
  booking_link: z.url().max(2048).optional(),
});
export type ReplyTemplateValues = z.infer<typeof replyTemplateValuesSchema>;
export type ReplyTemplateRendered = Readonly<{ subject: string; body: string }>;
/**
 * Substitute only the named variables, only from supplied values, in the approved text. Pure: it invents
 * nothing, and a template whose variable has no value is refused rather than sent with a gap or a guess.
 */
export function renderReplyTemplate(template: Pick<ReplyTemplate, 'subject' | 'body' | 'variables'>, rawValues: ReplyTemplateValues):
{ rendered: ReplyTemplateRendered } | { hold: ReplyTemplateHoldReason; missing: readonly ReplyTemplateVariable[] } {
  const values = replyTemplateValuesSchema.parse(rawValues);
  const needed = [...new Set([...PLACEHOLDERS(template.subject), ...PLACEHOLDERS(template.body)])] as ReplyTemplateVariable[];
  const missing = needed.filter(name => values[name] === undefined);
  if (missing.length) return { hold: 'template_variable_missing', missing };
  const fill = (text: string) => text.replace(/\{([^{}]*)\}/g, (match, name: string) => values[name as ReplyTemplateVariable] ?? match);
  return { rendered: Object.freeze({ subject: fill(template.subject), body: fill(template.body) }) };
}
/** Local identity for one template-mode follow-up draft, so a retry reaches the same row instead of drafting twice. */
export function replyTemplateDraftId(input: { accountId: string; templateId: string; sourceCommandId: string }): string {
  const digest = sha256Utf8(JSON.stringify({ kind: 'reply_template_draft', version: 1, accountId: id.parse(input.accountId),
    templateId: input.templateId, sourceCommandId: input.sourceCommandId }));
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
