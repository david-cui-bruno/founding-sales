import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { accountInstantSchema } from '../../../../../src/shared/contracts/accountContract';
import { mailMessageSchema, replyClassificationSchema, type MailMessage, type ReplyClassification } from '../../../../../src/shared/contracts/mailThreadContract';
import { classifyReply } from '../../../../../src/main/outreach/replyClassification';
import { requestJsonOnce } from '../../../../../src/main/outreach/providers/providerHttp';
import { keyPart, type DynamoStore } from '../dynamoStore';
import { jobRef } from '../queue/jobs';
import { recordAttempt } from './attempts';
import { createAccountFirmSource, type FirmCard, type FirmSource } from './firms';
import type { MailboxAccess } from './mailbox';
import { invalidRouteKey, invalidRouteSchema, readSend, SEND_PREFIX, sendRecordSchema, type SendDependencies } from './send';
import { createSequencePort, createSuppressionPort, type SequencePort, type SuppressionPort } from './sequenceBridge';

/**
 * The mailbox side of the rebuilt core (FSS target design sections 2 and 4; slice S3): `mail.poll` reads what came
 * back, matches it to a firm, records it once, and lets David's own rules decide what happens next.
 *
 *   MAILBOX#cursor        historyId, since, pageToken and a revision, compare-and-set by the poll, so two polls
 *                         cannot both advance it and no message is skipped when one of them loses.
 *   REPLY#<gmailMessageId> one permanent record per matched message. Written absent-fenced, so a message that
 *                         arrives in two polls is matched once and acted on once.
 *
 * Matching is the review's rule, in order: the References or In-Reply-To header carrying a Message-ID this
 * workspace's send fence wrote, and only then the sender address against a firm's business email. The history
 * query stays scoped to known senders, which is what keeps the disclosure text true.
 *
 * What a reply does is David's decision, not the worker's. A whole message of "stop" or "unsubscribe", in any
 * case, is an opt-out: the suppression set is written and the sequence stops. A delivery failure marks the route
 * invalid and drafts nothing. An out-of-office is ignored. Everything else pauses the sequence under the hold
 * `replied` and waits, and when the reply is unambiguous a `DRAFT#` is opened for it. The worker never writes the
 * prose of a reply: a draft carries text only once David supplies it, exactly as the carried reply-draft path does.
 */

export const MAILBOX_CURSOR_KEY = 'MAILBOX#cursor';
export const REPLY_PREFIX = 'REPLY#';
export const replyKey = (gmailMessageId: string): string => `${REPLY_PREFIX}${keyPart(gmailMessageId)}`;
export const DRAFT_PREFIX = 'DRAFT#';
export const draftKey = (firmId: string, draftId: string): string => `${DRAFT_PREFIX}${keyPart(firmId)}#${keyPart(draftId)}`;

/** How far back a first scan looks, and the ceiling the Gmail history window imposes anyway. */
export const MAIL_SCAN_WINDOW_DAYS = 30;
/** Pages of message ids one poll reads. Bounded so a poll always fits inside the runner's budget. */
export const MAIL_POLL_MAX_PAGES = 5;
/** Addresses one scan query names. The real gate is the sender check in code; this only keeps the query bounded. */
export const MAIL_SCAN_MAX_SENDERS = 25;
export const MAIL_BODY_MAX_BYTES = 24000;

export const mailboxCursorSchema = z.strictObject({
  version: z.literal(1),
  mailbox: z.string().min(1).max(320),
  mode: z.enum(['scan', 'history']),
  historyId: z.string().regex(/^\d+$/).nullable(),
  pageToken: z.string().min(1).max(2048).nullable(),
  since: accountInstantSchema,
  revision: z.number().int().positive(),
  updatedAt: accountInstantSchema,
});
export type MailboxCursor = z.infer<typeof mailboxCursorSchema>;

export const REPLY_DECISIONS = ['stop', 'continue'] as const;
export const replyRecordSchema = z.strictObject({
  version: z.literal(1),
  gmailMessageId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200),
  firmId: z.string().min(1).max(200),
  /** Which rule matched: the Message-ID this workspace sent, or the sender address. Never a guess. */
  matchedBy: z.enum(['message_id', 'sender']),
  classification: replyClassificationSchema,
  sender: z.string().min(1).max(320),
  subject: z.string().max(4000),
  receivedAt: accountInstantSchema,
  at: accountInstantSchema,
  draftId: z.string().max(200).nullable(),
  decision: z.enum(REPLY_DECISIONS).nullable(),
  resolvedAt: accountInstantSchema.nullable(),
  /** The step whose Message-ID matched, when that is how the reply was found. */
  stepId: z.string().max(200).nullable(),
});
export type ReplyRecord = z.infer<typeof replyRecordSchema>;

export const DRAFT_STATUSES = ['pending', 'approved', 'sent'] as const;
export const draftRecordSchema = z.strictObject({
  version: z.literal(1),
  firmId: z.string().min(1).max(200),
  draftId: z.string().min(1).max(200),
  kind: z.enum(['reply', 'followup']),
  status: z.enum(DRAFT_STATUSES),
  subject: z.string().min(1).max(240),
  /** Null until David writes it. The worker never composes the prose of a reply. */
  text: z.string().max(24000).nullable(),
  replyId: z.string().max(200).nullable(),
  inReplyTo: z.string().max(200).nullable(),
  threadId: z.string().max(200).nullable(),
  to: z.string().min(1).max(320),
  createdAt: accountInstantSchema,
  updatedAt: accountInstantSchema,
  approvedAt: accountInstantSchema.nullable(),
});
export type DraftRecord = z.infer<typeof draftRecordSchema>;

/** Replies whose classification is clear enough that a draft may be opened without asking David what it was. */
const UNAMBIGUOUS = new Set<ReplyClassification['kind']>(['substantive', 'scheduling', 'rejection']);
/** Replies David has to settle himself before the sequence moves at all. */
const NEEDS_DECISION = new Set<ReplyClassification['kind']>(['ambiguous', 'mixed']);

/**
 * The classification the design asks for: the carried `classifyReply`, plus the one addition the security review
 * named. A message whose whole authored text is "stop" or "unsubscribe", in any case and with or without a full
 * stop, is an opt-out and nothing else. Pure.
 */
export function classifyV1Reply(message: MailMessage): ReplyClassification {
  const authored = message.bodyParts.map(part => part.text).join('\n')
    .split(/\r?\n/).filter(line => !/^\s*>/.test(line)).join('\n').trim();
  const truncated = message.bodyParts.some(part => part.truncated);
  if (!truncated && /^(?:stop|unsubscribe)[.!]?$/i.test(authored)) {
    return replyClassificationSchema.parse({ kind: 'opt_out', evidence: [{ messageId: message.id, quote: authored.slice(0, 500) }], requiresApproval: true });
  }
  return classifyReply(message);
}

export async function readMailboxCursor(store: DynamoStore): Promise<{ cursor: MailboxCursor; rev: number } | null> {
  const row = await store.get<unknown>(MAILBOX_CURSOR_KEY);
  if (!row) return null;
  const parsed = mailboxCursorSchema.safeParse(row.data);
  return parsed.success ? { cursor: parsed.data, rev: row.rev } : null;
}

/** Every Message-ID this workspace's fence wrote, and the firm and step behind it. One prefix query. */
export async function sentMessageIndex(store: DynamoStore): Promise<Map<string, { firmId: string; stepId: string }>> {
  const index = new Map<string, { firmId: string; stepId: string }>();
  for (const row of await store.list<unknown>(SEND_PREFIX)) {
    const parsed = sendRecordSchema.safeParse(row.stored.data);
    if (parsed.success) index.set(parsed.data.messageId.toLowerCase(), { firmId: parsed.data.firmId, stepId: parsed.data.stepId });
  }
  return index;
}

const gmailListSchema = z.object({ messages: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/) })).max(100).optional(),
  nextPageToken: z.string().max(2048).optional(), historyId: z.string().regex(/^\d+$/).optional(),
  history: z.array(z.object({ messagesAdded: z.array(z.object({ message: z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/) }) })).max(100).optional() })).max(100).optional() });
type GmailPart = { mimeType?: string; filename?: string; body?: { data?: string }; parts?: GmailPart[] };
const gmailRawSchema = z.object({ id: z.string(), threadId: z.string(), internalDate: z.string().regex(/^\d+$/),
  payload: z.object({ headers: z.array(z.object({ name: z.string().max(100), value: z.string().max(4000) })).max(100) }).passthrough() });

const addressesOf = (value: string): string[] => value.split(',').flatMap(part => {
  const clean = part.trim();
  const angle = /^[^<>]*<([^<>]+)>$/.exec(clean);
  const address = (angle?.[1] ?? clean).toLowerCase();
  return z.string().email().safeParse(address).success ? [address] : [];
});

/** One Gmail message as this slice reads it: headers, and the plain-text parts up to the body ceiling. Pure. */
export function parseGmailMessage(raw: unknown): MailMessage | null {
  const parsed = gmailRawSchema.safeParse(raw);
  if (!parsed.success) return null;
  const value = parsed.data;
  const header = (name: string): string => {
    const values = value.payload.headers.filter(item => item.name.toLowerCase() === name);
    return values.length === 1 ? values[0]!.value : '';
  };
  const parts: MailMessage['bodyParts'] = [];
  let remaining = MAIL_BODY_MAX_BYTES;
  const walk = (node: GmailPart, depth: number): void => {
    if (depth > 10 || parts.length >= 4) return;
    if (!node.filename && (node.mimeType === 'text/plain' || node.mimeType === 'text/html') && node.body?.data) {
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(node.body.data, 'base64url')); } catch { return; }
      const bounded = Buffer.from(text).subarray(0, remaining).toString('utf8');
      remaining -= Buffer.byteLength(bounded);
      parts.push({ mimeType: node.mimeType, text: bounded, truncated: bounded.length < text.length });
    }
    for (const child of node.parts ?? []) walk(child, depth + 1);
  };
  walk((value.payload as unknown as GmailPart), 0);
  const message = mailMessageSchema.safeParse({ id: value.id, threadId: value.threadId, rfcMessageId: header('message-id') || null,
    references: (`${header('references')} ${header('in-reply-to')}`).match(/<[^<>\s]+>/g) ?? [],
    from: addressesOf(header('from')), to: addressesOf(header('to')), cc: addressesOf(header('cc')),
    date: new Date(Number(value.internalDate)).toISOString(), subject: header('subject'), bodyParts: parts });
  return message.success ? message.data : null;
}

export type MailDependencies = SendDependencies & { sequence?: SequencePort; suppression?: SuppressionPort; firms?: FirmSource };
export type PollReport = { read: number; matched: number; recorded: number; optOuts: number; bounces: number; drafts: number;
  held: 'mailbox_not_connected' | null; cursorAdvanced: boolean };

/**
 * One `mail.poll` job. Reads from the mailbox cursor, matches what it finds, records each matched message once and
 * applies David's rules. It never sends, and it never advances the cursor past a page it did not finish reading.
 */
export async function runMailPollJob(deps: MailDependencies, input: { jobId: string }, signal: AbortSignal): Promise<PollReport> {
  const store = deps.store;
  const started = Date.now();
  const report: PollReport = { read: 0, matched: 0, recorded: 0, optOuts: 0, bounces: 0, drafts: 0, held: null, cursorAdvanced: false };
  const mailbox = await deps.mailbox.access(signal);
  if (!mailbox.connected) {
    report.held = 'mailbox_not_connected';
    await recordAttempt(store, { kind: 'poll', outcome: 'held', reason: 'mailbox_not_connected',
      detail: { code: 'mailbox_not_connected', jobId: jobRef(input.jobId) }, durationMs: Date.now() - started, ref: jobRef(input.jobId) });
    return report;
  }
  const firms = await (deps.firms ?? createAccountFirmSource(store)).listFirms();
  const byEmail = new Map<string, FirmCard>();
  for (const firm of firms) if (firm.businessEmail) byEmail.set(firm.businessEmail.toLowerCase(), firm);
  const sent = await sentMessageIndex(store);

  const get = async (path: string, params: Record<string, string>): Promise<unknown> => {
    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
    url.search = new URLSearchParams(params).toString();
    const response = await requestJsonOnce({ fetch: deps.fetch, signal, url: url.href, maxBytes: 512000,
      init: { method: 'GET', headers: { Authorization: `Bearer ${mailbox.accessToken}` } } });
    if (response.status === 404) return { status: 404 };
    if (response.status !== 200) throw new Error('gmail_read_rejected');
    return response.data;
  };

  const held = await readMailboxCursor(store);
  const now = store.now();
  const since = held?.cursor.since ?? new Date(Date.parse(now) - MAIL_SCAN_WINDOW_DAYS * 86400000).toISOString();
  let cursor: MailboxCursor = held?.cursor.mailbox === mailbox.email ? held.cursor
    : mailboxCursorSchema.parse({ version: 1, mailbox: mailbox.email, mode: 'scan', historyId: null, pageToken: null, since,
      revision: (held?.cursor.revision ?? 0) + 1, updatedAt: now });

  const profileHistoryId = async (): Promise<string> => {
    const profile = z.object({ historyId: z.string().regex(/^\d+$/) }).parse(await get('profile', {}));
    return profile.historyId;
  };
  // A scan captures the history id BEFORE listing, so anything that arrives during the scan is replayed later.
  if (cursor.historyId === null) cursor = { ...cursor, historyId: await profileHistoryId(), mode: 'scan' };

  const senders = [...byEmail.keys()].sort().slice(0, MAIL_SCAN_MAX_SENDERS);
  for (let page = 0; page < MAIL_POLL_MAX_PAGES; page++) {
    signal.throwIfAborted();
    let listing: z.infer<typeof gmailListSchema>;
    if (cursor.mode === 'history') {
      const params: Record<string, string> = { startHistoryId: cursor.historyId!, historyTypes: 'messageAdded' };
      if (cursor.pageToken) params.pageToken = cursor.pageToken;
      const raw = await get('history', params);
      // Gmail forgot this history id: start again from the profile rather than skipping whatever it covered.
      if ((raw as { status?: number }).status === 404) { cursor = { ...cursor, mode: 'scan', historyId: await profileHistoryId(), pageToken: null }; page--; continue; }
      listing = gmailListSchema.parse(raw);
    } else {
      if (senders.length === 0) break;
      const params: Record<string, string> = { maxResults: '20',
        q: `after:${Math.floor(Date.parse(since) / 1000)} {${senders.map(address => `from:${address}`).join(' ')}}` };
      if (cursor.pageToken) params.pageToken = cursor.pageToken;
      listing = gmailListSchema.parse(await get('messages', params));
    }
    const ids = [...new Set(cursor.mode === 'history'
      ? (listing.history ?? []).flatMap(entry => (entry.messagesAdded ?? []).map(added => added.message.id))
      : (listing.messages ?? []).map(entry => entry.id))];
    for (const messageId of ids) {
      signal.throwIfAborted();
      const raw = await get(`messages/${messageId}`, { format: 'full' });
      if ((raw as { status?: number }).status === 404) continue;
      const message = parseGmailMessage(raw);
      if (!message || message.id !== messageId) continue;
      report.read++;
      const applied = await recordReply(deps, { message, sent, byEmail });
      if (applied.matched) report.matched++;
      if (applied.recorded) report.recorded++;
      if (applied.classification === 'opt_out') report.optOuts++;
      if (applied.classification === 'delivery_failure') report.bounces++;
      if (applied.draftId) report.drafts++;
    }
    const token = listing.nextPageToken ?? null;
    cursor = { ...cursor, pageToken: token,
      ...(token === null ? { mode: 'history' as const, historyId: cursor.mode === 'history' ? (listing.historyId ?? cursor.historyId) : cursor.historyId } : {}) };
    if (token === null) break;
  }

  const current = await readMailboxCursor(store);
  const next = mailboxCursorSchema.parse({ ...cursor, revision: (current?.cursor.revision ?? 0) + 1, updatedAt: store.now() });
  try { await store.transact([store.put(MAILBOX_CURSOR_KEY, next, current?.rev ?? null)]); report.cursorAdvanced = true; }
  catch { /* Another poll advanced the cursor first; its page covered the same messages, each of which is recorded once. */ }
  await recordAttempt(store, { kind: 'poll', outcome: 'ok', reason: null, detail: { code: 'mail_poll', count: report.read, jobId: jobRef(input.jobId) },
    durationMs: Date.now() - started, ref: jobRef(input.jobId) });
  return report;
}

export type ReplyApplication = { matched: boolean; recorded: boolean; classification: ReplyClassification['kind'] | null; draftId: string | null };

/**
 * Matches one message to a firm, records it once, and applies David's rules. The `REPLY#` write is absent-fenced,
 * so the same message seen in two polls is acted on exactly once: the second poll finds the record and stops.
 */
export async function recordReply(deps: MailDependencies, input: { message: MailMessage; sent: Map<string, { firmId: string; stepId: string }>; byEmail: Map<string, FirmCard> }): Promise<ReplyApplication> {
  const store = deps.store;
  const message = input.message;
  const threaded = message.references.map(value => value.toLowerCase()).find(value => input.sent.has(value));
  const matched = threaded ? { ...input.sent.get(threaded)!, matchedBy: 'message_id' as const } : null;
  const sender = message.from[0]!;
  const bySender = matched ? null : input.byEmail.get(sender.toLowerCase());
  const firmId = matched?.firmId ?? bySender?.firmId ?? null;
  if (firmId === null) return { matched: false, recorded: false, classification: null, draftId: null };

  const existing = await store.get<unknown>(replyKey(message.id));
  if (existing) return { matched: true, recorded: false, classification: replyRecordSchema.safeParse(existing.data).data?.classification.kind ?? null, draftId: null };

  const classification = classifyV1Reply(message);
  const now = store.now();
  const draftId = UNAMBIGUOUS.has(classification.kind) ? randomUUID() : null;
  const record = replyRecordSchema.parse({ version: 1, gmailMessageId: message.id, threadId: message.threadId, firmId,
    matchedBy: matched?.matchedBy ?? 'sender', classification, sender, subject: message.subject, receivedAt: message.date, at: now,
    draftId, decision: null, resolvedAt: classification.kind === 'out_of_office' ? now : null, stepId: matched?.stepId ?? null });
  try { await store.transact([store.put(replyKey(message.id), record, null)]); }
  catch { return { matched: true, recorded: false, classification: classification.kind, draftId: null }; }

  await applyReplyEffects(deps, record, sender);
  if (draftId) await openReplyDraft(deps, record, message);
  return { matched: true, recorded: true, classification: classification.kind, draftId };
}

/** The sequence seed the bridge needs when a reply changes a firm's state, read from the records that are the truth today. */
async function seedOf(deps: MailDependencies, firmId: string): Promise<{ firmId: string; enrollmentId: string; startedAt: string; currentStepId: string | null; nextDueAt: string | null } | null> {
  const firms = await (deps.firms ?? createAccountFirmSource(deps.store)).listFirms();
  const firm = firms.find(candidate => candidate.firmId === firmId);
  if (!firm?.enrollment) return null;
  return { firmId, enrollmentId: firm.enrollment.enrollmentId, startedAt: firm.enrollment.startedAt,
    currentStepId: firm.enrollment.currentStepId, nextDueAt: firm.enrollment.nextDueAt };
}

/** What a classified reply does. Every branch is David's own rule; none of them sends anything. */
export async function applyReplyEffects(deps: MailDependencies, record: ReplyRecord, sender: string): Promise<void> {
  const store = deps.store;
  const sequence = deps.sequence ?? createSequencePort(store);
  const suppression = deps.suppression ?? createSuppressionPort(store);
  const seed = await seedOf(deps, record.firmId);
  const kind = record.classification.kind;
  if (kind === 'opt_out') {
    await suppression.suppress({ firmId: record.firmId, handles: [sender], reason: 'opt_out', source: 'reply',
      evidenceRef: record.gmailMessageId, recordedBy: 'mail.poll' });
    if (seed) await sequence.stop({ ...seed, code: 'opt_out' });
    return;
  }
  if (kind === 'delivery_failure') {
    // The route, not the firm: a bounced address is marked invalid so the fence holds `no_email`, and nothing is drafted.
    await markRouteInvalid(store, record.firmId, sender, record.gmailMessageId);
    if (seed) await sequence.holdStep({ ...seed, stepId: seed.currentStepId ?? record.stepId ?? record.firmId, code: 'no_email' });
    return;
  }
  // An out-of-office is not a reply: the sequence keeps its place and David is not asked anything.
  if (kind === 'out_of_office') return;
  if (seed) await sequence.pauseForReply({ ...seed, code: 'replied' });
}

/** Opens a pending draft for an unambiguous reply. The worker never writes the text: David supplies it on approval. */
export async function openReplyDraft(deps: MailDependencies, record: ReplyRecord, message: MailMessage): Promise<DraftRecord | null> {
  const store = deps.store;
  const now = store.now();
  const subject = message.subject.toLowerCase().startsWith('re:') ? message.subject : `Re: ${message.subject || 'your reply'}`;
  const draft = draftRecordSchema.parse({ version: 1, firmId: record.firmId, draftId: record.draftId!, kind: 'reply', status: 'pending',
    subject: subject.slice(0, 240), text: null, replyId: record.gmailMessageId, inReplyTo: message.rfcMessageId, threadId: message.threadId,
    to: record.sender, createdAt: now, updatedAt: now, approvedAt: null });
  try { await store.transact([store.put(draftKey(record.firmId, draft.draftId), draft, null)]); }
  catch { return null; }
  return draft;
}

export async function markRouteInvalid(store: DynamoStore, firmId: string, handle: string, evidenceRef: string): Promise<void> {
  const key = invalidRouteKey(firmId, handle);
  if (await store.get<unknown>(key)) return;
  const record = invalidRouteSchema.parse({ version: 1, firmId, handle: handle.trim().toLowerCase(), reason: 'delivery_failure',
    evidenceRef, at: store.now() });
  try { await store.transact([store.put(key, record, null)]); } catch { /* Another poll marked it first. */ }
}

export async function readReplies(store: DynamoStore): Promise<ReplyRecord[]> {
  return (await store.list<unknown>(REPLY_PREFIX)).flatMap(row => {
    const parsed = replyRecordSchema.safeParse(row.stored.data);
    return parsed.success ? [parsed.data] : [];
  }).sort((a, b) => a.receivedAt < b.receivedAt ? 1 : -1);
}

export async function readDrafts(store: DynamoStore, firmId?: string): Promise<DraftRecord[]> {
  const prefix = firmId ? `${DRAFT_PREFIX}${keyPart(firmId)}#` : DRAFT_PREFIX;
  return (await store.list<unknown>(prefix)).flatMap(row => {
    const parsed = draftRecordSchema.safeParse(row.stored.data);
    return parsed.success ? [parsed.data] : [];
  }).sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);
}

export type ReplyDecisionOutcome = { applied: true; decision: 'stop' | 'continue' } | { applied: false; reason: 'reply_unknown' | 'reply_already_decided' };

/** `reply_decision`. David's answer to an ambiguous reply: stop suppresses permanently, continue resumes the cadence. */
export async function applyReplyDecision(deps: MailDependencies, input: { replyId: string; decision: 'stop' | 'continue'; recordedBy: string }): Promise<ReplyDecisionOutcome> {
  const store = deps.store;
  const row = await store.get<unknown>(replyKey(input.replyId));
  const parsed = row ? replyRecordSchema.safeParse(row.data) : null;
  if (!parsed?.success) return { applied: false, reason: 'reply_unknown' };
  if (parsed.data.decision !== null) return { applied: false, reason: 'reply_already_decided' };
  const now = store.now();
  const record = replyRecordSchema.parse({ ...parsed.data, decision: input.decision, resolvedAt: now });
  await store.transact([store.put(replyKey(input.replyId), record, row!.rev)]);
  const sequence = deps.sequence ?? createSequencePort(store);
  const suppression = deps.suppression ?? createSuppressionPort(store);
  const seed = await seedOf(deps, record.firmId);
  if (input.decision === 'stop') {
    await suppression.suppress({ firmId: record.firmId, handles: [record.sender], reason: 'reply_stop', source: 'reply',
      evidenceRef: record.gmailMessageId, recordedBy: input.recordedBy });
    if (seed) await sequence.stop({ ...seed, code: 'reply_stop' });
  } else if (seed) await sequence.resume({ ...seed });
  return { applied: true, decision: input.decision };
}

export type DraftCommandOutcome = { applied: true; draft: DraftRecord } | { applied: false; reason: string };

/** `request_followup`. Opens a follow-up draft for a firm; David writes the text and approves it separately. */
export async function requestFollowup(deps: MailDependencies, input: { firmId: string; draftId: string; text?: string | null }): Promise<DraftCommandOutcome> {
  const store = deps.store;
  const firms = await (deps.firms ?? createAccountFirmSource(store)).listFirms();
  const firm = firms.find(candidate => candidate.firmId === input.firmId);
  if (!firm) return { applied: false, reason: 'firm_unknown' };
  if (!firm.businessEmail) return { applied: false, reason: 'no_email' };
  const suppression = deps.suppression ?? createSuppressionPort(store);
  if (firm.suppressed || await suppression.isSuppressed(firm.firmId, [firm.businessEmail])) return { applied: false, reason: 'suppressed' };
  const existing = await store.get<unknown>(draftKey(input.firmId, input.draftId));
  if (existing) {
    const parsed = draftRecordSchema.safeParse(existing.data);
    return parsed.success ? { applied: true, draft: parsed.data } : { applied: false, reason: 'draft_corrupt' };
  }
  const now = store.now();
  const draft = draftRecordSchema.parse({ version: 1, firmId: input.firmId, draftId: input.draftId, kind: 'followup', status: 'pending',
    subject: `Following up, ${firm.name}`.slice(0, 240), text: input.text ?? null, replyId: null, inReplyTo: null, threadId: null,
    to: firm.businessEmail, createdAt: now, updatedAt: now, approvedAt: null });
  await store.transact([store.put(draftKey(input.firmId, input.draftId), draft, null)]);
  return { applied: true, draft };
}

/**
 * `approve_followup_draft` and `approve_reply_draft`. David's text and his approval in one step; approving enqueues
 * `mail.send_followup`, which goes out through exactly the same fence as a sequence step. Approving is not sending.
 */
export async function approveDraft(deps: MailDependencies & { enqueue?: (input: { firmId: string; draftId: string }) => Promise<void> },
  input: { firmId: string; draftId: string; text: string }): Promise<DraftCommandOutcome> {
  const store = deps.store;
  const row = await store.get<unknown>(draftKey(input.firmId, input.draftId));
  const parsed = row ? draftRecordSchema.safeParse(row.data) : null;
  if (!parsed?.success) return { applied: false, reason: 'draft_unknown' };
  if (parsed.data.status === 'sent') return { applied: false, reason: 'draft_already_sent' };
  const suppression = deps.suppression ?? createSuppressionPort(store);
  if (await suppression.isSuppressed(input.firmId, [parsed.data.to])) return { applied: false, reason: 'suppressed' };
  const now = store.now();
  const draft = draftRecordSchema.parse({ ...parsed.data, status: 'approved', text: input.text, updatedAt: now, approvedAt: parsed.data.approvedAt ?? now });
  await store.transact([store.put(draftKey(input.firmId, input.draftId), draft, row!.rev)]);
  if (parsed.data.status !== 'approved') await deps.enqueue?.({ firmId: input.firmId, draftId: input.draftId });
  return { applied: true, draft };
}

/** What the Firm view shows about the mailbox for one firm (design section 3). A read; it decides nothing. */
export async function readFirmMailView(store: DynamoStore, firmId: string): Promise<{ sends: unknown[]; replies: ReplyRecord[]; drafts: DraftRecord[] }> {
  const [replies, drafts] = await Promise.all([readReplies(store), readDrafts(store, firmId)]);
  const sends = (await store.list<unknown>(`${SEND_PREFIX}${keyPart(firmId)}#`)).flatMap(row => {
    const parsed = sendRecordSchema.safeParse(row.stored.data);
    return parsed.success ? [{ stepId: parsed.data.stepId, state: parsed.data.state, sentAt: parsed.data.sentAt,
      reason: parsed.data.reason, templateId: parsed.data.templateId }] : [];
  });
  return { sends, replies: replies.filter(reply => reply.firmId === firmId), drafts };
}

/** The pending draft one firm's Today card shows, if any. */
export async function pendingDraftsByFirm(store: DynamoStore): Promise<Map<string, DraftRecord>> {
  const pending = new Map<string, DraftRecord>();
  for (const draft of await readDrafts(store)) if (draft.status !== 'sent' && !pending.has(draft.firmId)) pending.set(draft.firmId, draft);
  return pending;
}

/** Re-exported so the runner can settle a follow-up through the same reader the fence uses. */
export { readSend };
