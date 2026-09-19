import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { accountInstantSchema } from '../../../../../src/shared/contracts/accountContract';
import { REPLY_TEMPLATE_IDS, REPLY_TEMPLATE_SIGN_OFF, REPLY_TEMPLATE_VARIABLES, replyTemplateContentHash, replyTemplateTextIssues,
  type ReplyTemplateId } from '../../../../../src/shared/contracts/replyTemplateContract';
import { REPLY_TEMPLATE_SEEDS } from '../../../../../src/main/outreach/templates/replyTemplateSeeds';
import type { DynamoStore } from '../dynamoStore';
import { EASTERN, localParts } from './localClock';

/**
 * The five templates and the sending settings of the rebuilt core (FSS target design sections 2 and 3; slice S3).
 *
 * `TEMPLATE#T1..T5` carry David's text and one standing approval each: the worker may send an approved template
 * as a sequence step without another click, so the approval records the exact subject and body and their sha256,
 * and any edit returns the template to draft. Approving is never sending.
 *
 * The footer is the new rule the security review added: a body may not be approved unless it ends with the
 * footer block, which is the pinned sign-off (name, title, site, phone) followed by the postal address from
 * `SETTINGS#sending` and the stop line. The postal address lives in the settings, not in the template, so one
 * edit changes every template's footer, and an approval is bound to the address it was approved with: change
 * the address and the approval no longer matches, which the send fence reads as `template_not_approved`.
 *
 * The ceiling is fixed in code (forty a day, warm-up ten plus two): `set_sending_limit` may only narrow it,
 * never widen it, and the day the cap and the ramp count in is America/New_York, computed with Intl.
 */

export const TEMPLATE_PREFIX = 'TEMPLATE#';
export const templateKey = (templateId: string): string => `${TEMPLATE_PREFIX}${z.enum(REPLY_TEMPLATE_IDS).parse(templateId)}`;
export const SENDING_SETTINGS_KEY = 'SETTINGS#sending';
/** Written by Settings (S5); read here and by the send fence. Absent means not paused. */
export const PAUSED_SETTINGS_KEY = 'SETTINGS#paused';
export const sendCounterKey = (easternDate: string): string => `COUNTER#${z.iso.date().parse(easternDate)}#sends`;
/** The send counter is arithmetic about one day; three days on is long enough to read it and short enough to forget it. */
export const SEND_COUNTER_TTL_SECONDS = 3 * 24 * 3600;

/** The one stop line every approved body ends with. Pinned text: an edit here is a product decision, not a refactor. */
export const SENDING_STOP_LINE = 'Reply "stop" and I will not email you again.';
/** The footer block a body must end with: the pinned sign-off, the postal address, the stop line. Pure. */
export function footerBlock(postalAddress: string): string {
  return `${REPLY_TEMPLATE_SIGN_OFF}\n${postalAddress.trim()}\n${SENDING_STOP_LINE}`;
}

/** How long a postal address may be, here and in the command contract. */
export const POSTAL_ADDRESS_MAX = 200;
/** The ceiling David fixed in code on 17 September 2026. Settings may narrow each number; nothing may widen one. */
export const SENDING_CEILING = Object.freeze({ dailyLimit: 40, startPerDay: 10, stepPerDay: 2, maxPerDay: 40 });

const limit = z.number().int().nonnegative().max(10000);
export const sendingSettingsSchema = z.strictObject({
  version: z.literal(1),
  dailyLimit: limit,
  ramp: z.strictObject({ startPerDay: limit, stepPerDay: limit, maxPerDay: limit }),
  /** The postal address the footer carries. Null until David sets one; no template can be approved without it. */
  postalAddress: z.string().trim().min(1).max(200).nullable(),
  revision: z.number().int().positive(),
  updatedAt: accountInstantSchema,
// Every number is checked against the ceiling fixed in code and against nothing else, so David may narrow the
// daily limit without having to restate the ramp: today's cap is the smallest of all four numbers anyway.
}).refine(settings => settings.dailyLimit <= SENDING_CEILING.dailyLimit && settings.ramp.startPerDay <= SENDING_CEILING.startPerDay
  && settings.ramp.stepPerDay <= SENDING_CEILING.stepPerDay && settings.ramp.maxPerDay <= SENDING_CEILING.maxPerDay,
'sending_limit_exceeds_code_ceiling');
export type SendingSettings = z.infer<typeof sendingSettingsSchema>;

/** What the worker uses when David has narrowed nothing: the code ceiling itself, with no postal address yet. */
export const defaultSendingSettings = (updatedAt: string): SendingSettings => sendingSettingsSchema.parse({
  version: 1, dailyLimit: SENDING_CEILING.dailyLimit,
  ramp: { startPerDay: SENDING_CEILING.startPerDay, stepPerDay: SENDING_CEILING.stepPerDay, maxPerDay: SENDING_CEILING.maxPerDay },
  postalAddress: null, revision: 1, updatedAt });

export async function readSendingSettings(store: DynamoStore): Promise<{ settings: SendingSettings; rev: number | null }> {
  const row = await store.get<unknown>(SENDING_SETTINGS_KEY);
  const parsed = row ? sendingSettingsSchema.safeParse(row.data) : null;
  return parsed?.success ? { settings: parsed.data, rev: row!.rev } : { settings: defaultSendingSettings(store.now()), rev: row?.rev ?? null };
}

export type SendingLimitInput = { dailyLimit?: number; ramp?: { startPerDay: number; stepPerDay: number; maxPerDay: number }; postalAddress?: string };
export type SendingLimitOutcome = { applied: true; settings: SendingSettings; reason?: undefined } | { applied: false; reason: 'sending_limit_exceeds_code_ceiling' | 'sending_limit_invalid' };

/**
 * `set_sending_limit`. Every number is checked against the ceiling fixed in code before anything is written, so a
 * request that would widen the cap is refused whole rather than partly applied. Storing a limit is not permission
 * to send: it only says how few.
 */
export async function planSetSendingLimit(store: DynamoStore, input: SendingLimitInput): Promise<{ item: TransactWriteItem; settings: SendingSettings } | { refused: SendingLimitOutcome }> {
  const held = await readSendingSettings(store);
  const candidate = { ...held.settings, ...(input.dailyLimit === undefined ? {} : { dailyLimit: input.dailyLimit }),
    ...(input.ramp === undefined ? {} : { ramp: input.ramp }),
    ...(input.postalAddress === undefined ? {} : { postalAddress: input.postalAddress.trim() }),
    revision: held.settings.revision + (held.rev === null ? 0 : 1), updatedAt: store.now() };
  const parsed = sendingSettingsSchema.safeParse(candidate);
  if (!parsed.success) {
    const ceiling = parsed.error.issues.some(issue => issue.message === 'sending_limit_exceeds_code_ceiling');
    return { refused: { applied: false, reason: ceiling ? 'sending_limit_exceeds_code_ceiling' : 'sending_limit_invalid' } };
  }
  return { item: store.put(SENDING_SETTINGS_KEY, parsed.data, held.rev), settings: parsed.data };
}

export async function setSendingLimit(store: DynamoStore, input: SendingLimitInput): Promise<SendingLimitOutcome> {
  const plan = await planSetSendingLimit(store, input);
  if ('refused' in plan) return plan.refused;
  await store.transact([plan.item]);
  return { applied: true, settings: plan.settings };
}

/** Whether every send is paused. Absent record means not paused; a record the schema refuses is treated as paused. */
export async function readPaused(store: DynamoStore): Promise<{ paused: boolean; reason: string | null }> {
  const row = await store.get<unknown>(PAUSED_SETTINGS_KEY);
  if (!row) return { paused: false, reason: null };
  const parsed = z.object({ paused: z.boolean(), reason: z.string().max(200).nullable().optional() }).safeParse(row.data);
  if (!parsed.success) return { paused: true, reason: 'paused_record_unreadable' };
  return { paused: parsed.data.paused, reason: parsed.data.reason ?? null };
}

export const templateApprovalSchema = z.strictObject({
  state: z.enum(['draft', 'approved']),
  approvedRevision: z.number().int().positive().nullable(),
  approvedAt: accountInstantSchema.nullable(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  /** The postal address the approved footer carried. An address change leaves the approval behind on purpose. */
  footerPostalAddress: z.string().trim().min(1).max(200).nullable(),
});
export const templateRecordSchema = z.strictObject({
  version: z.literal(1),
  templateId: z.enum(REPLY_TEMPLATE_IDS),
  name: z.string().trim().min(1).max(120),
  subject: z.string().min(1).max(160),
  body: z.string().min(1).max(4000),
  variables: z.array(z.enum(REPLY_TEMPLATE_VARIABLES)).max(REPLY_TEMPLATE_VARIABLES.length),
  revision: z.number().int().positive(),
  approval: templateApprovalSchema,
  updatedAt: accountInstantSchema,
});
export type TemplateRecord = z.infer<typeof templateRecordSchema>;

/** The seeded revision one of one template: David's text of 17 September 2026, unapproved. Pure. */
export function seededTemplate(templateId: ReplyTemplateId, at: string): TemplateRecord {
  const seed = REPLY_TEMPLATE_SEEDS.find(entry => entry.id === templateId);
  if (!seed) throw new Error('template_seed_unknown');
  return templateRecordSchema.parse({ version: 1, templateId, name: seed.name, subject: seed.subject, body: seed.body,
    variables: [...seed.variables], revision: 1,
    approval: { state: 'draft', approvedRevision: null, approvedAt: null, contentHash: null, footerPostalAddress: null }, updatedAt: at });
}

/** Every template as it stands: the stored record where one exists, the seed where none does. Never approves anything. */
export async function readTemplates(store: DynamoStore): Promise<TemplateRecord[]> {
  const now = store.now();
  const stored = new Map<string, TemplateRecord>();
  for (const row of await store.list<unknown>(TEMPLATE_PREFIX)) {
    const parsed = templateRecordSchema.safeParse(row.stored.data);
    if (parsed.success) stored.set(parsed.data.templateId, parsed.data);
  }
  return REPLY_TEMPLATE_IDS.map(id => stored.get(id) ?? seededTemplate(id, now));
}

export async function readTemplate(store: DynamoStore, templateId: ReplyTemplateId): Promise<{ record: TemplateRecord; rev: number | null }> {
  const row = await store.get<unknown>(templateKey(templateId));
  const parsed = row ? templateRecordSchema.safeParse(row.data) : null;
  return parsed?.success ? { record: parsed.data, rev: row!.rev } : { record: seededTemplate(templateId, store.now()), rev: row?.rev ?? null };
}

/**
 * Every reason this exact subject and body may not become a standing approval, in the order David reads them.
 * Pure. The footer check is first because it is the one the security review added and the one the seeded text
 * fails: the seeds end at the sign-off, with no postal address and no stop line.
 */
export function templateApprovalIssues(input: { subject: string; body: string; postalAddress: string | null }): string[] {
  if (input.postalAddress === null) return ['postal_address_not_set'];
  const footer = footerBlock(input.postalAddress);
  if (!input.body.endsWith(footer)) return ['template_footer_missing'];
  const withoutFooter = input.body.slice(0, input.body.length - footer.length) + REPLY_TEMPLATE_SIGN_OFF;
  return replyTemplateTextIssues({ subject: input.subject, body: withoutFooter });
}

export type ApproveTemplateInput = { templateId: ReplyTemplateId; expectedRevision: number; subject: string; body: string };
export type ApproveTemplateOutcome = { applied: true; record: TemplateRecord; reason?: undefined } | { applied: false; reason: string };

/**
 * `approve_template`. David's statement about exactly this text: it is stored with its sha256 so the send fence can
 * refuse anything else, and it is refused outright when the body has no footer block. Approving is never sending.
 */
export async function planApproveTemplate(store: DynamoStore, input: ApproveTemplateInput): Promise<{ item: TransactWriteItem; record: TemplateRecord } | { refused: ApproveTemplateOutcome }> {
  const { settings } = await readSendingSettings(store);
  const held = await readTemplate(store, input.templateId);
  if (input.expectedRevision !== held.record.revision) return { refused: { applied: false, reason: 'template_revision_conflict' } };
  const issues = templateApprovalIssues({ subject: input.subject, body: input.body, postalAddress: settings.postalAddress });
  if (issues.length) return { refused: { applied: false, reason: issues[0]! } };
  const now = store.now();
  const revision = held.rev === null ? held.record.revision : held.record.revision + 1;
  const record = templateRecordSchema.parse({ ...held.record, subject: input.subject, body: input.body, revision,
    approval: { state: 'approved', approvedRevision: revision, approvedAt: now,
      contentHash: replyTemplateContentHash({ id: input.templateId, revision, subject: input.subject, body: input.body }),
      footerPostalAddress: settings.postalAddress }, updatedAt: now });
  return { item: store.put(templateKey(input.templateId), record, held.rev), record };
}

export async function approveTemplate(store: DynamoStore, input: ApproveTemplateInput): Promise<ApproveTemplateOutcome> {
  const plan = await planApproveTemplate(store, input);
  if ('refused' in plan) return plan.refused;
  await store.transact([plan.item]);
  return { applied: true, record: plan.record };
}

/**
 * Whether the standing approval still covers this template's current text and the current postal address. A template
 * whose text was edited, whose hash no longer matches, or whose footer names an address David has since changed, is
 * not approved: the send fence holds it as `template_not_approved` rather than sending text he did not approve.
 */
export function templateApproved(record: TemplateRecord, postalAddress: string | null): boolean {
  const approval = record.approval;
  if (approval.state !== 'approved' || approval.approvedRevision !== record.revision || approval.contentHash === null) return false;
  if (postalAddress === null || approval.footerPostalAddress !== postalAddress) return false;
  if (!record.body.endsWith(footerBlock(postalAddress))) return false;
  return approval.contentHash === replyTemplateContentHash({ id: record.templateId, revision: record.revision, subject: record.subject, body: record.body });
}

/**
 * Today's cap for the sender: the warm-up ramp from the first recorded send, counted in America/New_York calendar
 * days so a send at 22:00 Eastern belongs to the day David is living in, and bounded by both the settings' daily
 * limit and the ceiling fixed in code. Pure arithmetic over recorded facts; never a permission.
 */
export function sendingCapForDay(settings: SendingSettings, firstSendAt: string | null, now: string): { today: number; day: number } {
  const days = firstSendAt === null ? 0
    : Math.max(0, Math.round((Date.parse(`${localParts(now, EASTERN).date}T00:00:00Z`) - Date.parse(`${localParts(firstSendAt, EASTERN).date}T00:00:00Z`)) / 86400000));
  const ramped = settings.ramp.startPerDay + settings.ramp.stepPerDay * days;
  return { today: Math.min(ramped, settings.ramp.maxPerDay, settings.dailyLimit, SENDING_CEILING.dailyLimit), day: days + 1 };
}

export const sendCounterSchema = z.strictObject({ version: z.literal(1), date: z.iso.date(), used: z.number().int().nonnegative().max(100000) });
export type SendCounter = z.infer<typeof sendCounterSchema>;
/** The key that records when this workspace first sent; the ramp is anchored on it and it is written once. */
export const SEND_ANCHOR_KEY = 'COUNTER#send-anchor';
export const sendAnchorSchema = z.strictObject({ version: z.literal(1), firstSendAt: accountInstantSchema });

export async function readSendUsage(store: DynamoStore, now: string): Promise<{ date: string; used: number; rev: number | null; firstSendAt: string | null; anchorRev: number | null }> {
  const date = localParts(now, EASTERN).date;
  const [counterRow, anchorRow] = await Promise.all([store.get<unknown>(sendCounterKey(date)), store.get<unknown>(SEND_ANCHOR_KEY)]);
  const counter = counterRow ? sendCounterSchema.safeParse(counterRow.data) : null;
  const anchor = anchorRow ? sendAnchorSchema.safeParse(anchorRow.data) : null;
  return { date, used: counter?.success ? counter.data.used : 0, rev: counterRow?.rev ?? null,
    firstSendAt: anchor?.success ? anchor.data.firstSendAt : null, anchorRev: anchorRow?.rev ?? null };
}

/** How many more sends today's cap allows. Never negative, and never larger than the cap itself. */
export async function remainingSendsToday(store: DynamoStore, now: string): Promise<{ remaining: number; cap: number; used: number; date: string }> {
  const [{ settings }, usage] = await Promise.all([readSendingSettings(store), readSendUsage(store, now)]);
  const cap = sendingCapForDay(settings, usage.firstSendAt, now).today;
  return { remaining: Math.max(0, cap - usage.used), cap, used: usage.used, date: usage.date };
}
