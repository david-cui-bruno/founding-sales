import { z } from 'zod';
import { accountInstantSchema } from '../../../../../src/shared/contracts/accountContract';
import { mailMessageSchema } from '../../../../../src/shared/contracts/mailThreadContract';
import { REPLY_TEMPLATE_IDS, renderReplyTemplate, type ReplyTemplateId } from '../../../../../src/shared/contracts/replyTemplateContract';
import { attemptReasonSchema, type V1HoldReason } from '../../../../../src/shared/contracts/v1Contract';
import { createPreparedGmailSender } from '../../../../../src/main/outreach/providers/gmailProvider';
import { requestJsonOnce } from '../../../../../src/main/outreach/providers/providerHttp';
import type { FrozenEmail } from '../../../../../src/main/outreach/providers/providerTypes';
import { verifySentMatch } from '../sendReconciler';
import { keyPart, type DynamoStore } from '../dynamoStore';
import { campaignEnrollmentKey, campaignVersionKey, territoryEnrollmentKey } from '../workerCampaignRepository';
import { jobMessageId, jobMessageUuid, jobRef, sendStepJobId } from '../queue/jobs';
import { attemptCode, recordAttempt } from './attempts';
import { createAccountFirmSource, type FirmCard, type FirmSource } from './firms';
import type { MailboxAccess } from './mailbox';
import { posturesByState, readPostures, stateClearance } from './postures';
import { createSequencePort, createSuppressionPort, type SequencePort, type SuppressionPort, type NextStep } from './sequenceBridge';
import { readSendingSettings, readSendUsage, readTemplate, sendAnchorSchema, sendCounterKey, sendCounterSchema, sendingCapForDay,
  SEND_ANCHOR_KEY, SEND_COUNTER_TTL_SECONDS, readPaused, templateApproved } from './templates';

/**
 * The send fence (FSS target design section 2 and the review's finding 2; slice S3). One due template step goes out
 * exactly once, whatever happens to the message, the runner or the revision.
 *
 *   SEND#<firmId>#<stepId>   the fence. The context revision is INSIDE the record, never in the key, so replacing a
 *                            route or refreshing research cannot mint a second key for a step already sent.
 *   FLIGHT#<firmId>          one send per firm in flight, whatever the step: a second job for the same firm is
 *                            refused while the first is unsettled.
 *   Message-ID               deterministic from the job id and nothing else, so a result that was lost can be
 *                            settled by looking for exactly that message in the Sent folder.
 *
 * A retry that finds `accepted` finishes the step (advances the sequence and releases the flight) instead of
 * stopping, which is what kept the old fence re-enqueueing forever. A retry that finds `dispatching` older than the
 * job budget runs the Sent lookup before deciding; `unknown` with `noRetry` is never sent again by anyone.
 *
 * Every refusal before the claim is a closed hold recorded on the step, never a silent skip. Nothing in this file
 * dials, books or decides that something was sent: only the provider's own acceptance, or the Sent folder, does.
 */

export const SEND_PREFIX = 'SEND#';
export const sendKey = (firmId: string, stepId: string): string => `${SEND_PREFIX}${keyPart(firmId)}#${keyPart(stepId)}`;
export const FLIGHT_PREFIX = 'FLIGHT#';
export const flightKey = (firmId: string): string => `${FLIGHT_PREFIX}${keyPart(firmId)}`;
/** An address the provider said it could not deliver to. Written by `mail.poll` on a bounce; read here as `no_email`. */
export const ROUTE_INVALID_PREFIX = 'ROUTE_INVALID#';
export const invalidRouteKey = (firmId: string, handle: string): string => `${ROUTE_INVALID_PREFIX}${keyPart(firmId)}#${keyPart(handle.trim().toLowerCase())}`;
export const invalidRouteSchema = z.strictObject({ version: z.literal(1), firmId: z.string().min(1).max(200), handle: z.string().min(1).max(320),
  reason: attemptReasonSchema, evidenceRef: z.string().max(200).nullable(), at: accountInstantSchema });

/** A claim older than this is stale: the runner that made it is long gone, so the Sent lookup decides, not a resend. */
export const SEND_BUDGET_MS = 5 * 60_000;
/**
 * How old the firm's evidence may be when a template quotes it. Ninety days is S3's number, written down here so the
 * hold is a real condition rather than a comment; Settings narrows it when S5 ships the control.
 */
export const SEND_EVIDENCE_MAX_AGE_DAYS = 90;

export const SEND_STATES = ['dispatching', 'accepted', 'not_sent', 'unknown'] as const;
export const frozenEmailSchema = z.strictObject({ from: z.string().min(1).max(320), to: z.string().min(1).max(320),
  subject: z.string().min(1).max(240), body: z.string().min(1).max(24000) });
export const sendRecordSchema = z.strictObject({
  version: z.literal(1),
  firmId: z.string().min(1).max(200),
  stepId: z.string().min(1).max(200),
  state: z.enum(SEND_STATES),
  /** The research revision the step's text quoted, recorded inside the fence so a bump never mints a second key. */
  contextRevision: z.number().int().nonnegative(),
  jobId: z.string().min(1).max(200),
  messageId: z.string().min(1).max(200),
  providerMessageId: z.string().max(200).nullable(),
  providerThreadId: z.string().max(200).nullable(),
  frozen: frozenEmailSchema,
  templateId: z.enum(REPLY_TEMPLATE_IDS).nullable(),
  claimedAt: accountInstantSchema,
  sentAt: accountInstantSchema.nullable(),
  reconciledAt: accountInstantSchema.nullable(),
  /** A result nobody can settle: never attempted again, by any job, ever. */
  noRetry: z.boolean(),
  reason: attemptReasonSchema.nullable(),
});
export type SendRecord = z.infer<typeof sendRecordSchema>;

/** `jobId` null is the released lock: the record stays so its revision keeps fencing, but no send is in flight. */
export const flightRecordSchema = z.strictObject({ version: z.literal(1), firmId: z.string().min(1).max(200), jobId: z.string().min(1).max(200).nullable(), since: accountInstantSchema });
export type FlightRecord = z.infer<typeof flightRecordSchema>;

/** Every closed code a send may be held or settled under, and the user-facing reason David reads beside it. */
export const SEND_HOLD_REASON: Readonly<Record<string, V1HoldReason>> = Object.freeze({
  paused: 'paused',
  mailbox_not_connected: 'mailbox_not_connected',
  template_not_approved: 'template_not_approved',
  template_variable_missing: 'template_not_approved',
  step_has_no_template: 'template_not_approved',
  cap_reached: 'cap_reached',
  suppressed: 'suppressed',
  no_email: 'no_email',
  no_posture: 'state_not_cleared',
  posture_not_calling: 'state_not_cleared',
  posture_review_overdue: 'state_not_cleared',
  state_unknown: 'state_not_cleared',
  evidence_stale: 'evidence_stale',
  provider_error: 'provider_error',
  send_unknown: 'send_unknown',
});
export const holdReasonOf = (code: string): V1HoldReason => SEND_HOLD_REASON[code] ?? 'provider_error';

export type SendOutcome =
  | { outcome: 'sent'; record: SendRecord }
  | { outcome: 'already_accepted'; record: SendRecord }
  | { outcome: 'settled'; record: SendRecord }
  | { outcome: 'held'; code: string; reason: V1HoldReason }
  | { outcome: 'refused'; code: 'firm_send_in_flight' | 'claim_lost' | 'step_unknown' };

export type SendDependencies = {
  store: DynamoStore;
  mailbox: MailboxAccess;
  fetch: typeof globalThis.fetch;
  firms?: FirmSource;
  sequence?: SequencePort;
  suppression?: SuppressionPort;
};

/** What a step needs to be sent, read once from the records that are the truth today (S1's adapter and the enrollment pair). */
export type SendContext = {
  firm: FirmCard;
  enrollmentId: string;
  startedAt: string;
  contextRevision: number;
  stepId: string;
  templateId: ReplyTemplateId | null;
  next: NextStep;
};

const enrollmentLightSchema = z.object({ id: z.string(), startedAt: z.string(), contextRevision: z.number().int().nonnegative().optional(), campaignVersionId: z.string() });
const versionLightSchema = z.object({ id: z.string(), steps: z.array(z.object({ id: z.string(), channel: z.enum(['call', 'email', 'linkedin']), delayHours: z.number() })) });
const territoryLightSchema = z.object({ accountId: z.string(), enrollmentId: z.string(), versionId: z.string(),
  heldSteps: z.array(z.object({ stepId: z.string(), templateId: z.string().optional() })).max(40) });

/** The step's context, or null when the firm, the enrollment or the step is not there. Reading is never sending. */
export async function readSendContext(store: DynamoStore, firm: FirmCard, stepId: string): Promise<SendContext | null> {
  const territoryRow = await store.get<unknown>(territoryEnrollmentKey(firm.firmId));
  const territory = territoryRow ? territoryLightSchema.safeParse(territoryRow.data) : null;
  if (!territory?.success) return null;
  const [enrollmentRow, versionRow] = await Promise.all([store.get<unknown>(campaignEnrollmentKey(territory.data.enrollmentId)),
    store.get<unknown>(campaignVersionKey(territory.data.versionId))]);
  const enrollment = enrollmentRow ? enrollmentLightSchema.safeParse(enrollmentRow.data) : null;
  const version = versionRow ? versionLightSchema.safeParse(versionRow.data) : null;
  if (!enrollment?.success || !version?.success) return null;
  const index = version.data.steps.findIndex(step => step.id === stepId);
  if (index < 0) return null;
  const held = territory.data.heldSteps.find(step => step.stepId === stepId);
  const templateId = z.enum(REPLY_TEMPLATE_IDS).safeParse(held?.templateId);
  const following = version.data.steps[index + 1];
  return { firm, enrollmentId: enrollment.data.id, startedAt: enrollment.data.startedAt,
    contextRevision: enrollment.data.contextRevision ?? 0, stepId, templateId: templateId.success ? templateId.data : null,
    next: following ? { stepId: following.id, dueAt: new Date(Date.parse(enrollment.data.startedAt) + following.delayHours * 3600000).toISOString() } : null };
}

export type SendPlan = { send: true; frozen: z.infer<typeof frozenEmailSchema>; templateId: ReplyTemplateId } | { send: false; code: string };

/**
 * Every hold, in the order David reads them (design section 5): his own pause, his mailbox, his approval, the
 * arithmetic of the cap, the suppression set, the address, the state posture, the age of the evidence. The first
 * one that fails is the answer; nothing later is even read. Deciding is never sending.
 */
export async function planSend(deps: SendDependencies, context: SendContext, signal: AbortSignal): Promise<SendPlan> {
  const store = deps.store;
  const now = store.now();
  const suppression = deps.suppression ?? createSuppressionPort(store);
  const paused = await readPaused(store);
  if (paused.paused) return { send: false, code: 'paused' };
  const mailbox = await deps.mailbox.access(signal);
  if (!mailbox.connected) return { send: false, code: 'mailbox_not_connected' };
  if (context.templateId === null) return { send: false, code: 'step_has_no_template' };
  const [{ settings }, held] = await Promise.all([readSendingSettings(store), readTemplate(store, context.templateId)]);
  if (!templateApproved(held.record, settings.postalAddress)) return { send: false, code: 'template_not_approved' };
  const usage = await readSendUsage(store, now);
  if (usage.used >= sendingCapForDay(settings, usage.firstSendAt, now).today) return { send: false, code: 'cap_reached' };
  const email = context.firm.businessEmail;
  if (await suppression.isSuppressed(context.firm.firmId, email ? [email] : [])) return { send: false, code: 'suppressed' };
  if (context.firm.suppressed) return { send: false, code: 'suppressed' };
  // A bounce marked this address invalid: the firm has no usable email until David admits another route.
  if (!email || await store.get<unknown>(invalidRouteKey(context.firm.firmId, email))) return { send: false, code: 'no_email' };
  if (!context.firm.state) return { send: false, code: 'state_unknown' };
  const clearance = stateClearance(posturesByState(await readPostures(store)), context.firm.state, now);
  if (clearance.code !== null) return { send: false, code: clearance.code };
  if (Date.parse(now) - Date.parse(context.firm.researchedAt) > SEND_EVIDENCE_MAX_AGE_DAYS * 86400000) return { send: false, code: 'evidence_stale' };
  const rendered = renderReplyTemplate({ subject: held.record.subject, body: held.record.body, variables: [] },
    { firm: context.firm.name, ...(context.firm.city ? { city: context.firm.city } : {}) });
  if ('hold' in rendered) return { send: false, code: 'template_variable_missing' };
  return { send: true, templateId: context.templateId,
    frozen: frozenEmailSchema.parse({ from: mailbox.email, to: email, subject: rendered.rendered.subject, body: rendered.rendered.body }) };
}

export async function readSend(store: DynamoStore, firmId: string, stepId: string): Promise<{ record: SendRecord; rev: number } | null> {
  const row = await store.get<unknown>(sendKey(firmId, stepId));
  if (!row) return null;
  const parsed = sendRecordSchema.safeParse(row.data);
  return parsed.success ? { record: parsed.data, rev: row.rev } : null;
}

export async function readFlight(store: DynamoStore, firmId: string): Promise<{ record: FlightRecord; rev: number } | null> {
  const row = await store.get<unknown>(flightKey(firmId));
  if (!row) return null;
  const parsed = flightRecordSchema.safeParse(row.data);
  return parsed.success ? { record: parsed.data, rev: row.rev } : null;
}

/** Releases the firm's lock, and only when it is still ours: another job's flight is never cleared by this one. */
async function releaseFlight(store: DynamoStore, firmId: string, jobId: string): Promise<void> {
  const held = await readFlight(store, firmId);
  if (!held || held.record.jobId !== jobId) return;
  try { await store.transact([store.put(flightKey(firmId), flightRecordSchema.parse({ ...held.record, jobId: null }), held.rev)]); }
  catch { /* Another writer moved the lock on; it is no longer ours to release. */ }
}

/** The one place the daily counter moves: at the claim, before the provider call, so a lost result can only hold, never over-send. */
function consumeCapItems(store: DynamoStore, usage: Awaited<ReturnType<typeof readSendUsage>>, now: string) {
  const counter = sendCounterSchema.parse({ version: 1, date: usage.date, used: usage.used + 1 });
  const items = [store.put(sendCounterKey(usage.date), counter, usage.rev, { ttl: Math.floor(Date.parse(now) / 1000) + SEND_COUNTER_TTL_SECONDS })];
  if (usage.firstSendAt === null && usage.anchorRev === null) items.push(store.put(SEND_ANCHOR_KEY, sendAnchorSchema.parse({ version: 1, firstSendAt: now }), null));
  return items;
}

/** Finishes a step whose send is accepted: the sequence moves on and the firm's lock is released. Idempotent. */
async function finishAccepted(deps: SendDependencies, context: SendContext, record: SendRecord): Promise<void> {
  const sequence = deps.sequence ?? createSequencePort(deps.store);
  await sequence.recordSent({ firmId: context.firm.firmId, enrollmentId: context.enrollmentId, startedAt: context.startedAt,
    currentStepId: context.stepId, nextDueAt: null, stepId: context.stepId, sentAt: record.sentAt ?? record.claimedAt, next: context.next });
  await releaseFlight(deps.store, context.firm.firmId, record.jobId);
}

export type SendJobInput = { jobId: string; firmId: string; stepId: string };

/**
 * One `mail.send_step` job. The whole fence in one function, in the order the design gives it: settle what is
 * already recorded, check the holds, take the firm's lock, claim the step, send, record, advance, release.
 */
export async function runSendStepJob(deps: SendDependencies, input: SendJobInput, signal: AbortSignal): Promise<SendOutcome> {
  const store = deps.store;
  const started = Date.now();
  const firms = await (deps.firms ?? createAccountFirmSource(store)).listFirms();
  const firm = firms.find(candidate => candidate.firmId === input.firmId);
  const context = firm ? await readSendContext(store, firm, input.stepId) : null;
  if (!context) return { outcome: 'refused', code: 'step_unknown' };

  const existing = await readSend(store, input.firmId, input.stepId);
  if (existing) {
    const record = existing.record;
    if (record.state === 'accepted') { await finishAccepted(deps, context, record); return { outcome: 'already_accepted', record }; }
    if (record.state === 'not_sent' || (record.state === 'unknown' && record.noRetry)) {
      await releaseFlight(store, input.firmId, record.jobId);
      return { outcome: 'settled', record };
    }
    // `dispatching` (a runner that never came back) and `unknown` (a result nobody saw) are both settled by the
    // Sent folder once the budget has passed, never by sending again. Inside the budget the first runner still owns it.
    if (Date.parse(store.now()) - Date.parse(record.claimedAt) < SEND_BUDGET_MS) return { outcome: 'refused', code: 'firm_send_in_flight' };
    const settled = await settleStaleSend(deps, existing, signal);
    if (settled.record.state === 'accepted') { await finishAccepted(deps, context, settled.record); return { outcome: 'already_accepted', record: settled.record }; }
    await releaseFlight(store, input.firmId, settled.record.jobId);
    return { outcome: 'settled', record: settled.record };
  }

  const plan = await planSend(deps, context, signal);
  if (!plan.send) {
    const sequence = deps.sequence ?? createSequencePort(store);
    await sequence.holdStep({ firmId: context.firm.firmId, enrollmentId: context.enrollmentId, startedAt: context.startedAt,
      currentStepId: context.stepId, nextDueAt: null, stepId: context.stepId, code: plan.code, templateId: context.templateId });
    await recordAttempt(store, { kind: 'hold', outcome: 'held', reason: plan.code, detail: { code: plan.code, firmId: input.firmId, jobId: jobRef(input.jobId) },
      durationMs: Date.now() - started, ref: jobRef(input.jobId) });
    return { outcome: 'held', code: plan.code, reason: holdReasonOf(plan.code) };
  }

  // One send per firm in flight, whatever the step or revision. The lock is taken before the claim and released by
  // this job or by reconcile; a live lock held by another job refuses this one outright.
  const flight = await readFlight(store, input.firmId);
  const now = store.now();
  if (flight && flight.record.jobId !== null && flight.record.jobId !== input.jobId
    && Date.parse(now) - Date.parse(flight.record.since) < SEND_BUDGET_MS) return { outcome: 'refused', code: 'firm_send_in_flight' };

  const usage = await readSendUsage(store, now);
  const record: SendRecord = sendRecordSchema.parse({ version: 1, firmId: input.firmId, stepId: input.stepId, state: 'dispatching',
    contextRevision: context.contextRevision, jobId: input.jobId, messageId: jobMessageId(input.jobId), providerMessageId: null,
    providerThreadId: null, frozen: plan.frozen, templateId: plan.templateId, claimedAt: now, sentAt: null, reconciledAt: null,
    noRetry: false, reason: null });
  try {
    await store.transact([
      store.put(sendKey(input.firmId, input.stepId), record, null),
      store.put(flightKey(input.firmId), flightRecordSchema.parse({ version: 1, firmId: input.firmId, jobId: input.jobId, since: now }), flight?.rev ?? null),
      ...consumeCapItems(store, usage, now)]);
  } catch {
    // Somebody else claimed the step, the firm or today's cap slot between the read and the write. Never a second send.
    return { outcome: 'refused', code: 'claim_lost' };
  }

  const mailbox = await deps.mailbox.access(signal);
  if (!mailbox.connected) {
    const settled = await recordResult(store, record, { state: 'unknown', reason: 'mailbox_not_connected', noRetry: false });
    return { outcome: 'settled', record: settled };
  }
  const frozen: FrozenEmail = { commandId: jobMessageUuid(input.jobId), from: plan.frozen.from, to: plan.frozen.to, subject: plan.frozen.subject, body: plan.frozen.body };
  const sender = createPreparedGmailSender({ accountEmail: mailbox.email, accessToken: mailbox.accessToken, fetch: deps.fetch, signal, isCurrent: () => !signal.aborted });
  let result;
  try { result = await sender.sendOnce(frozen); }
  catch { result = { status: 'unknown' as const, reasonCode: 'provider_result_unknown' }; }

  if (result.status === 'accepted') {
    const settled = await recordResult(store, record, { state: 'accepted', reason: null, noRetry: false,
      providerMessageId: result.messageId, providerThreadId: result.threadId, sentAt: store.now() });
    await finishAccepted(deps, context, settled);
    await recordAttempt(store, { kind: 'send', outcome: 'ok', reason: null, detail: { code: 'send_accepted', firmId: input.firmId, jobId: jobRef(input.jobId) },
      durationMs: Date.now() - started, ref: jobRef(input.jobId) });
    return { outcome: 'sent', record: settled };
  }
  const state = result.status === 'not_sent' ? 'not_sent' : 'unknown';
  const reason = result.status === 'not_sent' ? 'provider_error' : 'send_unknown';
  const settled = await recordResult(store, record, { state, reason, noRetry: false });
  if (state === 'not_sent') {
    const sequence = deps.sequence ?? createSequencePort(store);
    await sequence.holdStep({ firmId: context.firm.firmId, enrollmentId: context.enrollmentId, startedAt: context.startedAt,
      currentStepId: context.stepId, nextDueAt: null, stepId: context.stepId, code: 'provider_error', templateId: context.templateId });
    await releaseFlight(store, input.firmId, input.jobId);
  }
  await recordAttempt(store, { kind: 'send', outcome: 'failed', reason, detail: { code: reason, firmId: input.firmId, jobId: jobRef(input.jobId) },
    durationMs: Date.now() - started, ref: jobRef(input.jobId) });
  return { outcome: 'settled', record: settled };
}

/** Moves a claimed record to its settled state, fenced on the claim's own revision. Never invents a result. */
async function recordResult(store: DynamoStore, record: SendRecord, change: { state: SendRecord['state']; reason: string | null; noRetry: boolean;
  providerMessageId?: string; providerThreadId?: string | null; sentAt?: string; reconciledAt?: string }): Promise<SendRecord> {
  const held = await readSend(store, record.firmId, record.stepId);
  if (!held) return record;
  const next = sendRecordSchema.parse({ ...held.record, state: change.state, reason: change.reason === null ? null : attemptReasonSchema.parse(change.reason),
    noRetry: change.noRetry, providerMessageId: change.providerMessageId ?? held.record.providerMessageId,
    providerThreadId: change.providerThreadId === undefined ? held.record.providerThreadId : change.providerThreadId,
    sentAt: change.sentAt ?? held.record.sentAt, reconciledAt: change.reconciledAt ?? held.record.reconciledAt });
  try { await store.transact([store.put(sendKey(record.firmId, record.stepId), next, held.rev)]); }
  catch { return (await readSend(store, record.firmId, record.stepId))?.record ?? held.record; }
  return next;
}

const sentListSchema = z.object({ messages: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/) })).max(2).optional(), nextPageToken: z.string().optional() });
const sentRawSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/), threadId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
  labelIds: z.array(z.string()).max(100), internalDate: z.string().regex(/^\d+$/),
  payload: z.object({ mimeType: z.literal('text/plain'), headers: z.array(z.object({ name: z.string().max(100), value: z.string().max(4000) })).max(100),
    body: z.object({ data: z.string().max(100000), size: z.number().int().nonnegative() }) }) });

/**
 * The Sent-folder lookup, carried from `sendReconciler.ts`: one bounded query for exactly this Message-ID, then the
 * same `verifySentMatch` comparison of the message against the email the fence froze. Absence is never evidence of
 * non-delivery, and nothing here can resend: the only outcomes are accepted, not sent, or still unknown.
 */
export async function lookupSentMessage(deps: SendDependencies, record: SendRecord, signal: AbortSignal):
Promise<{ state: 'accepted'; providerMessageId: string; providerThreadId: string | null } | { state: 'not_sent' | 'unknown'; reason: string }> {
  const mailbox = await deps.mailbox.access(signal);
  if (!mailbox.connected) return { state: 'unknown', reason: 'mailbox_not_connected' };
  const uuid = jobMessageUuid(record.jobId);
  const get = async (path: string, params: Record<string, string>): Promise<unknown> => {
    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
    url.search = new URLSearchParams(params).toString();
    const response = await requestJsonOnce({ fetch: deps.fetch, signal, url: url.href, maxBytes: 200000,
      init: { method: 'GET', headers: { Authorization: `Bearer ${mailbox.accessToken}` } } });
    if (response.status !== 200) throw new Error('lookup_unavailable');
    return response.data;
  };
  try {
    const listing = sentListSchema.parse(await get('messages', { q: `in:sent rfc822msgid:${uuid}@callie.invalid`, maxResults: '2' }));
    if (listing.nextPageToken || (listing.messages?.length ?? 0) > 1) return { state: 'unknown', reason: 'sent_ambiguous' };
    if (!listing.messages?.length) return { state: 'not_sent', reason: 'sent_absent' };
    const raw = sentRawSchema.parse(await get(`messages/${listing.messages[0]!.id}`, { format: 'full' }));
    if (raw.id !== listing.messages[0]!.id || !raw.labelIds.includes('SENT')) return { state: 'unknown', reason: 'sent_mismatch' };
    const header = (name: string): string => {
      const values = raw.payload.headers.filter(item => item.name.toLowerCase() === name);
      if (values.length > 1) throw new Error('duplicate_header');
      return values[0]?.value ?? '';
    };
    const bytes = Buffer.from(raw.payload.body.data, 'base64url');
    if (bytes.toString('base64url') !== raw.payload.body.data.replace(/=+$/, '') || bytes.length !== raw.payload.body.size) return { state: 'unknown', reason: 'sent_mismatch' };
    const outcome = verifySentMatch({ commandId: uuid, from: record.frozen.from, to: record.frozen.to, subject: record.frozen.subject, body: record.frozen.body },
      [mailMessageSchema.parse({ id: raw.id, threadId: raw.threadId, rfcMessageId: header('message-id'),
        references: header('references').match(/<[^<>\s]+>/g) ?? [], from: [header('from')], to: [header('to')],
        cc: header('cc') ? header('cc').split(',').map(value => value.trim()) : [], date: new Date(Number(raw.internalDate)).toISOString(),
        subject: header('subject'), bodyParts: [{ mimeType: 'text/plain', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), truncated: false }] })]);
    if (outcome.status !== 'provider_accepted') return { state: 'unknown', reason: attemptCode(outcome.reason) };
    return { state: 'accepted', providerMessageId: outcome.providerIdentity.messageId, providerThreadId: outcome.providerIdentity.threadId };
  } catch { return { state: 'unknown', reason: 'lookup_unavailable' }; }
}

/** Settles one stale claim from the Sent folder. `not_sent` and an unresolvable `unknown` both stop the step for good. */
export async function settleStaleSend(deps: SendDependencies, held: { record: SendRecord; rev: number }, signal: AbortSignal): Promise<{ record: SendRecord }> {
  const found = await lookupSentMessage(deps, held.record, signal);
  const reconciledAt = deps.store.now();
  if (found.state === 'accepted') {
    return { record: await recordResult(deps.store, held.record, { state: 'accepted', reason: null, noRetry: false,
      providerMessageId: found.providerMessageId, providerThreadId: found.providerThreadId, sentAt: held.record.claimedAt, reconciledAt }) };
  }
  if (found.state === 'not_sent') {
    return { record: await recordResult(deps.store, held.record, { state: 'not_sent', reason: found.reason, noRetry: true, reconciledAt }) };
  }
  // Still unknown after the lookup: the result stays unknown and nobody ever tries this step again.
  return { record: await recordResult(deps.store, held.record, { state: 'unknown', reason: found.reason, noRetry: true, reconciledAt }) };
}

/** Every send still in flight or unsettled, oldest first. One prefix query; a row the schema refuses is skipped. */
export async function readUnsettledSends(store: DynamoStore): Promise<{ record: SendRecord; rev: number }[]> {
  return (await store.list<unknown>(SEND_PREFIX)).flatMap(row => {
    const parsed = sendRecordSchema.safeParse(row.stored.data);
    if (!parsed.success || parsed.data.noRetry) return [];
    return ['dispatching', 'unknown'].includes(parsed.data.state) ? [{ record: parsed.data, rev: row.stored.rev }] : [];
  }).sort((a, b) => a.record.claimedAt < b.record.claimedAt ? -1 : 1);
}

export type ReconcileReport = { checked: number; accepted: number; notSent: number; stillUnknown: number; flightsReleased: number };

/**
 * `mail.reconcile:<date>T<HH>`. Every send older than the job budget that nobody settled is looked up in the Sent
 * folder, and every flight older than the budget whose send is settled is released. It never sends anything.
 */
export async function runReconcileJob(deps: SendDependencies, signal: AbortSignal): Promise<ReconcileReport> {
  const store = deps.store;
  const started = Date.now();
  const now = store.now();
  const report: ReconcileReport = { checked: 0, accepted: 0, notSent: 0, stillUnknown: 0, flightsReleased: 0 };
  for (const held of await readUnsettledSends(store)) {
    if (Date.parse(now) - Date.parse(held.record.claimedAt) < SEND_BUDGET_MS) continue;
    report.checked++;
    const settled = await settleStaleSend(deps, held, signal);
    if (settled.record.state === 'accepted') {
      report.accepted++;
      const firms = await (deps.firms ?? createAccountFirmSource(store)).listFirms();
      const firm = firms.find(candidate => candidate.firmId === settled.record.firmId);
      const context = firm ? await readSendContext(store, firm, settled.record.stepId) : null;
      if (context) await finishAccepted(deps, context, settled.record);
    } else if (settled.record.state === 'not_sent') report.notSent++;
    else report.stillUnknown++;
    await releaseFlight(store, settled.record.firmId, settled.record.jobId);
  }
  // A flight left behind by a runner that died before it claimed anything, or after its send settled: released once
  // it is past the budget and no unsettled send still names it. A live claim is never taken away from its owner.
  const stillHeld = new Set((await readUnsettledSends(store)).map(held => held.record.jobId));
  for (const row of await store.list<unknown>(FLIGHT_PREFIX)) {
    const parsed = flightRecordSchema.safeParse(row.stored.data);
    if (!parsed.success || parsed.data.jobId === null || stillHeld.has(parsed.data.jobId)) continue;
    if (Date.parse(now) - Date.parse(parsed.data.since) < SEND_BUDGET_MS) continue;
    await releaseFlight(store, parsed.data.firmId, parsed.data.jobId);
    report.flightsReleased++;
  }
  await recordAttempt(store, { kind: 'send', outcome: report.stillUnknown > 0 ? 'held' : 'ok', reason: report.stillUnknown > 0 ? 'send_unknown' : null,
    detail: { code: 'reconcile', count: report.checked }, durationMs: Date.now() - started, ref: 'reconcile' });
  return report;
}

/** The job id one due step has. Exported so the scheduler and the runner name the same work. */
export const sendJobIdFor = (firmId: string, stepId: string): string => sendStepJobId(firmId, stepId);

/** An approved draft occupies the same fence as a sequence step, under its own step key. */
export const followupStepId = (draftId: string): string => `followup:${draftId}`;

export type FollowupDraft = { firmId: string; draftId: string; to: string; subject: string; text: string; inReplyTo: string | null; threadId: string | null };
export type FollowupOutcome = SendOutcome | { outcome: 'refused'; code: 'draft_not_approved' };

/**
 * One `mail.send_followup` job: the draft David wrote and approved, through exactly the fence a sequence step uses.
 * The holds are the same minus the template approval, because the text is his own; the lock, the claim, the
 * Message-ID and the Sent lookup are identical. A follow-up never advances the sequence.
 */
export async function runSendFollowupJob(deps: SendDependencies, input: { jobId: string; draft: FollowupDraft }, signal: AbortSignal): Promise<FollowupOutcome> {
  const store = deps.store;
  const started = Date.now();
  const stepId = followupStepId(input.draft.draftId);
  const firmId = input.draft.firmId;

  const existing = await readSend(store, firmId, stepId);
  if (existing) {
    const record = existing.record;
    if (record.state === 'accepted') { await releaseFlight(store, firmId, record.jobId); return { outcome: 'already_accepted', record }; }
    if (record.state === 'not_sent' || (record.state === 'unknown' && record.noRetry)) { await releaseFlight(store, firmId, record.jobId); return { outcome: 'settled', record }; }
    if (Date.parse(store.now()) - Date.parse(record.claimedAt) < SEND_BUDGET_MS) return { outcome: 'refused', code: 'firm_send_in_flight' };
    const settled = await settleStaleSend(deps, existing, signal);
    await releaseFlight(store, firmId, settled.record.jobId);
    return { outcome: settled.record.state === 'accepted' ? 'already_accepted' : 'settled', record: settled.record };
  }

  const suppression = deps.suppression ?? createSuppressionPort(store);
  const paused = await readPaused(store);
  if (paused.paused) return { outcome: 'held', code: 'paused', reason: 'paused' };
  const mailbox = await deps.mailbox.access(signal);
  if (!mailbox.connected) return { outcome: 'held', code: 'mailbox_not_connected', reason: 'mailbox_not_connected' };
  if (await suppression.isSuppressed(firmId, [input.draft.to])) return { outcome: 'held', code: 'suppressed', reason: 'suppressed' };
  if (await store.get<unknown>(invalidRouteKey(firmId, input.draft.to))) return { outcome: 'held', code: 'no_email', reason: 'no_email' };
  const now = store.now();
  const { settings } = await readSendingSettings(store);
  const usage = await readSendUsage(store, now);
  if (usage.used >= sendingCapForDay(settings, usage.firstSendAt, now).today) return { outcome: 'held', code: 'cap_reached', reason: 'cap_reached' };

  const flight = await readFlight(store, firmId);
  if (flight && flight.record.jobId !== null && flight.record.jobId !== input.jobId
    && Date.parse(now) - Date.parse(flight.record.since) < SEND_BUDGET_MS) return { outcome: 'refused', code: 'firm_send_in_flight' };

  const record: SendRecord = sendRecordSchema.parse({ version: 1, firmId, stepId, state: 'dispatching', contextRevision: 0,
    jobId: input.jobId, messageId: jobMessageId(input.jobId), providerMessageId: null, providerThreadId: null,
    frozen: frozenEmailSchema.parse({ from: mailbox.email, to: input.draft.to, subject: input.draft.subject, body: input.draft.text }),
    templateId: null, claimedAt: now, sentAt: null, reconciledAt: null, noRetry: false, reason: null });
  try {
    await store.transact([store.put(sendKey(firmId, stepId), record, null),
      store.put(flightKey(firmId), flightRecordSchema.parse({ version: 1, firmId, jobId: input.jobId, since: now }), flight?.rev ?? null),
      ...consumeCapItems(store, usage, now)]);
  } catch { return { outcome: 'refused', code: 'claim_lost' }; }

  const sender = createPreparedGmailSender({ accountEmail: mailbox.email, accessToken: mailbox.accessToken, fetch: deps.fetch, signal, isCurrent: () => !signal.aborted });
  let result;
  try { result = await sender.sendOnce({ commandId: jobMessageUuid(input.jobId), from: mailbox.email, to: input.draft.to, subject: input.draft.subject, body: input.draft.text }); }
  catch { result = { status: 'unknown' as const, reasonCode: 'provider_result_unknown' }; }
  if (result.status === 'accepted') {
    const settled = await recordResult(store, record, { state: 'accepted', reason: null, noRetry: false,
      providerMessageId: result.messageId, providerThreadId: result.threadId, sentAt: store.now() });
    await releaseFlight(store, firmId, input.jobId);
    await recordAttempt(store, { kind: 'send', outcome: 'ok', reason: null, detail: { code: 'followup_accepted', firmId, jobId: jobRef(input.jobId) },
      durationMs: Date.now() - started, ref: jobRef(input.jobId) });
    return { outcome: 'sent', record: settled };
  }
  const state = result.status === 'not_sent' ? 'not_sent' : 'unknown';
  const reason = result.status === 'not_sent' ? 'provider_error' : 'send_unknown';
  const settled = await recordResult(store, record, { state, reason, noRetry: false });
  if (state === 'not_sent') await releaseFlight(store, firmId, input.jobId);
  await recordAttempt(store, { kind: 'send', outcome: 'failed', reason, detail: { code: reason, firmId, jobId: jobRef(input.jobId) },
    durationMs: Date.now() - started, ref: jobRef(input.jobId) });
  return { outcome: 'settled', record: settled };
}
