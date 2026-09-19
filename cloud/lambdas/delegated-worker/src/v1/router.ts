import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { attemptKindSchema, DIAGNOSTICS_ATTEMPT_LIMIT, diagnosticsViewSchema, pairRedeemRequestSchema, pairRedeemResponseSchema,
  v1CommandReceiptSchema, v1CommandSchema, type V1Command, type V1CommandReceipt } from '../../../../../src/shared/contracts/v1Contract';
import { DynamoReadUnavailable, fingerprint, keyPart, type DynamoStore } from '../dynamoStore';
import type { WorkerHttpResponse } from '../handler';
import type { WorkerAuth } from '../workerAuth';
import { listAttempts, recordAttempt } from './attempts';
import { V1Devices, V1PairRefused, V1Unauthenticated, type V1Principal } from './devices';
import { readLastTick } from './lastTick';
import { applyReplyDecision, approveDraft, requestFollowup } from './mail';
import type { MailboxAccess } from './mailbox';
import { planSetStatePosture, postureSummary, readPostures } from './postures';
import { readQueueSummary } from './queueView';
import { readSettingsView } from './settings';
import { planApproveTemplate, planSetSendingLimit } from './templates';
import { readTodayView } from './today';

/**
 * The mailbox and the network as the API sees them: not at all. The three mailbox commands only write records, and
 * the modules they share with the runner take those boundaries as arguments, so this is what the API passes in.
 * A command that somehow tried to reach a mailbox from here would be refused rather than quietly succeeding.
 */
const mailboxRefused: MailboxAccess = { access: async () => ({ connected: false, reason: 'mailbox_not_connected' }) };
const fetchRefused: typeof globalThis.fetch = async () => { throw new Error('api_has_no_provider_access'); };

/**
 * The `/v1` routes of the rebuilt core (FSS target design section 3), mounted inside the existing handler so
 * that David only redeploys the worker:
 *
 *   POST /v1/pair/redeem      unauthenticated   a pairing code in, the device token out, once
 *   GET  /v1/diagnostics      device token      the last attempts (kind, limit), the last tick, the devices, the postures
 *   GET  /v1/today            device token      the morning list as cards, dialability computed at request time (S1)
 *   GET  /v1/settings         device token      postures by state and the clearance reference texts (S1b; the rest of Settings is S5)
 *   POST /v1/commands         device token      idempotent by commandId, per device; `revoke_device` (S0), `set_state_posture` (S1)
 *
 * Errors: 401 `{ error: 'unauthenticated' }` (with `reason: 'device_expired'` once a device's ninety days are over),
 * 404 `{ error: 'not_found' }` for any other `/v1` path or method, 400 `{ error: 'invalid_request' }` on a body or
 * query the contract refuses, 400 or 429 `{ error: 'pair_refused', reason }` on a refused code. Every POST records
 * one attempt (`pairing` or `command`); GET views record none. Every command transaction carries a ConditionCheck
 * that the calling device is still unrevoked, so a revocation is effective mid-request, not on the next poll.
 * The handler owns the security headers and passes `respond`, so this module never builds a response by hand.
 */

export type V1RouterInput = {
  auth: WorkerAuth;
  method: 'GET' | 'POST';
  path: string;
  query: URLSearchParams;
  authorization: string | undefined;
  /** The parsed JSON body; may throw on malformed JSON, which is an invalid request here. */
  body: () => unknown;
  respond: (statusCode: number, body: unknown) => WorkerHttpResponse;
};

export const v1CommandKey = (commandId: string): string => `V1COMMAND#${keyPart(commandId)}`;

const diagnosticsQuerySchema = z.strictObject({ kind: attemptKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(DIAGNOSTICS_ATTEMPT_LIMIT).optional() });
/** A receipt is bound to the device that issued the command; a replay from any other device is a conflict. */
const receiptRecordSchema = z.strictObject({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), kind: z.string(), receipt: v1CommandReceiptSchema,
  at: z.iso.datetime({ precision: 3 }), deviceId: z.string().uuid() });

function parseBody<T>(body: () => unknown, schema: z.ZodType<T>): { success: true; data: T } | { success: false } {
  let raw: unknown;
  try { raw = body(); } catch { return { success: false }; }
  const parsed = schema.safeParse(raw);
  return parsed.success ? { success: true, data: parsed.data } : { success: false };
}

const unauthenticated = (respond: V1RouterInput['respond'], error: V1Unauthenticated): WorkerHttpResponse =>
  respond(401, error.reason ? { error: 'unauthenticated', reason: error.reason } : { error: 'unauthenticated' });

/** The receipt a repeated commandId gets: `duplicate` with the first answer's reason (or its outcome) for the device that
 *  issued it; `command_conflict` for a different payload or a different device. */
function repeatedReceipt(stored: unknown, expectedFingerprint: string, command: V1Command, principal: V1Principal): V1CommandReceipt {
  const parsed = receiptRecordSchema.safeParse(stored);
  if (!parsed.success) throw new Error('v1_receipt_corrupt');
  if (parsed.data.deviceId !== principal.deviceId || parsed.data.fingerprint !== expectedFingerprint) return { commandId: command.commandId, outcome: 'refused', reason: 'command_conflict' };
  return { commandId: command.commandId, outcome: 'duplicate', reason: parsed.data.receipt.reason ?? parsed.data.receipt.outcome };
}

/**
 * Applies one command exactly once. The receipt is written under `V1COMMAND#<commandId>` in the same transaction as
 * the command's own write and as the check that the caller is still an active device, so a lost response is answered
 * from the receipt, a second copy can never apply, and a revocation that lands mid-request refuses the write.
 */
async function applyCommand(store: DynamoStore, devices: V1Devices, principal: V1Principal, command: V1Command): Promise<V1CommandReceipt> {
  const key = v1CommandKey(command.commandId);
  const commandFingerprint = fingerprint(command);
  const existing = await store.get<unknown>(key);
  if (existing) return repeatedReceipt(existing.data, commandFingerprint, command, principal);
  let receipt: V1CommandReceipt;
  const items: TransactWriteItem[] = [];
  switch (command.kind) {
    case 'revoke_device': {
      const plan = await devices.planRevoke(command.deviceId);
      if ('item' in plan) { items.push(plan.item); receipt = { commandId: command.commandId, outcome: 'applied', reason: null }; }
      else receipt = { commandId: command.commandId, outcome: 'refused', reason: plan.refused };
      break;
    }
    case 'set_state_posture': {
      // David's decision for one state (S1): stamped with the instant and the device label, prior decisions kept in history.
      const plan = await planSetStatePosture(store, command, principal.label);
      items.push(plan.item); receipt = { commandId: command.commandId, outcome: 'applied', reason: null };
      break;
    }
    case 'approve_template': {
      // The standing approval (S3). Refused outright without the footer block or a postal address; approving never sends.
      const plan = await planApproveTemplate(store, command);
      if ('refused' in plan) receipt = { commandId: command.commandId, outcome: 'refused', reason: plan.refused.applied ? 'template_refused' : plan.refused.reason };
      else { items.push(plan.item); receipt = { commandId: command.commandId, outcome: 'applied', reason: null }; }
      break;
    }
    case 'set_sending_limit': {
      // Narrowing only: a request that would widen any number past the ceiling fixed in code is refused whole.
      const plan = await planSetSendingLimit(store, command);
      if ('refused' in plan) receipt = { commandId: command.commandId, outcome: 'refused', reason: plan.refused.applied ? 'sending_limit_refused' : plan.refused.reason };
      else { items.push(plan.item); receipt = { commandId: command.commandId, outcome: 'applied', reason: null }; }
      break;
    }
    // The three mailbox commands (S3) write records of their own before the receipt, because each one touches more
    // than one key: a decision writes REPLY# then the suppression set and the sequence, an approval writes DRAFT#.
    // Every one of those writes is idempotent by construction (compare-and-set on the record's own revision, or
    // absent-fenced), so a retry that lands before the receipt did repeats nothing; what it cannot promise is that
    // the effect and the receipt commit together, which is why the caller is still refused if its device is revoked
    // between the two. Approving a draft never sends it: the scheduler enqueues `mail.send_followup`, the runner
    // puts it through the same fence as a sequence step.
    case 'reply_decision': {
      const outcome = await applyReplyDecision({ store, mailbox: mailboxRefused, fetch: fetchRefused },
        { replyId: command.replyId, decision: command.decision, recordedBy: principal.label });
      receipt = outcome.applied ? { commandId: command.commandId, outcome: 'applied', reason: outcome.decision }
        : { commandId: command.commandId, outcome: 'refused', reason: outcome.reason };
      break;
    }
    case 'request_followup': {
      const outcome = await requestFollowup({ store, mailbox: mailboxRefused, fetch: fetchRefused },
        { firmId: command.firmId, draftId: command.draftId, text: command.text ?? null });
      receipt = outcome.applied ? { commandId: command.commandId, outcome: 'applied', reason: null }
        : { commandId: command.commandId, outcome: 'refused', reason: outcome.reason };
      break;
    }
    case 'approve_followup_draft':
    case 'approve_reply_draft': {
      const outcome = await approveDraft({ store, mailbox: mailboxRefused, fetch: fetchRefused },
        { firmId: command.firmId, draftId: command.draftId, text: command.text });
      receipt = outcome.applied ? { commandId: command.commandId, outcome: 'applied', reason: null }
        : { commandId: command.commandId, outcome: 'refused', reason: outcome.reason };
      break;
    }
  }
  items.push(store.put(key, { fingerprint: commandFingerprint, kind: command.kind, receipt, at: store.now(), deviceId: principal.deviceId }, null));
  // The caller must still be an active device when this commits. When the command writes the caller's own row (a
  // self-revocation) that put's revision fence is the check; a second item on the same key is not allowed.
  if (!items.some(item => item.Put?.Item?.sk?.S === principal.key)) items.push(devices.activeCheck(principal.key));
  try { await store.transact(items); }
  catch (error) {
    // The receipt slot was taken between the read and the write: answer from it.
    const committed = await store.get<unknown>(key);
    if (committed) return repeatedReceipt(committed.data, commandFingerprint, command, principal);
    // No receipt landed. A caller revoked or expired meanwhile is refused as its credential; anything else stays uncertain.
    if (!(await devices.isActive(principal.key))) throw new V1Unauthenticated();
    throw error;
  }
  return receipt;
}

export async function v1Router(input: V1RouterInput): Promise<WorkerHttpResponse> {
  const { respond, method, path } = input;
  const store = input.auth.store;
  const devices = new V1Devices(store);
  try {
    // One path literal and its method per line: tests/infrastructure/delegatedWorkerRouteParity.test.ts reads these
    // lines and checks them against the API Gateway route keys Terraform provisions. Any other path or method is 404.
    if (path === '/v1/pair/redeem' && method === 'POST') {
      const request = parseBody(input.body, pairRedeemRequestSchema);
      if (!request.success) {
        await recordAttempt(store, { kind: 'pairing', outcome: 'failed', reason: 'invalid_request', detail: null, durationMs: null, ref: null });
        return respond(400, { error: 'invalid_request' });
      }
      const started = Date.now();
      try {
        const redeemed = pairRedeemResponseSchema.parse(await devices.redeem(request.data.code));
        await recordAttempt(store, { kind: 'pairing', outcome: 'ok', reason: null, detail: { code: 'device_paired' }, durationMs: Date.now() - started, ref: redeemed.deviceId });
        return respond(200, redeemed);
      } catch (error) {
        if (!(error instanceof V1PairRefused)) throw error;
        await recordAttempt(store, { kind: 'pairing', outcome: 'failed', reason: error.reason, detail: null, durationMs: Date.now() - started, ref: null });
        return respond(error.reason === 'too_many_failures' ? 429 : 400, { error: 'pair_refused', reason: error.reason });
      }
    }
    if (path === '/v1/diagnostics' && method === 'GET') {
      try { await devices.authenticate(input.authorization); }
      catch (error) { if (error instanceof V1Unauthenticated) return unauthenticated(respond, error); throw error; }
      const query = diagnosticsQuerySchema.safeParse({ kind: input.query.get('kind') ?? undefined, limit: input.query.get('limit') ?? undefined });
      if (!query.success) return respond(400, { error: 'invalid_request' });
      const [attempts, lastTick, deviceList, postures, queue] = await Promise.all([listAttempts(store, query.data), readLastTick(store), devices.listDevices(), readPostures(store), readQueueSummary(store)]);
      const asOf = store.now();
      return respond(200, diagnosticsViewSchema.parse({ asOf, attempts, lastTick, devices: deviceList, postures: postures.map(record => postureSummary(record, asOf)), queue }));
    }
    if (path === '/v1/settings' && method === 'GET') {
      // Postures by state and the clearance reference texts (S1b), so David can record postures before S5 ships the rest of Settings.
      try { await devices.authenticate(input.authorization); }
      catch (error) { if (error instanceof V1Unauthenticated) return unauthenticated(respond, error); throw error; }
      return respond(200, await readSettingsView(store));
    }
    if (path === '/v1/today' && method === 'GET') {
      // The morning list as cards (S1). Dialability is computed here, at request time, from the firm's zone; a read is never a dial.
      try { await devices.authenticate(input.authorization); }
      catch (error) { if (error instanceof V1Unauthenticated) return unauthenticated(respond, error); throw error; }
      return respond(200, await readTodayView(store));
    }
    if (path === '/v1/commands' && method === 'POST') {
      let principal: V1Principal;
      try { principal = await devices.authenticate(input.authorization); }
      catch (error) {
        if (!(error instanceof V1Unauthenticated)) throw error;
        await recordAttempt(store, { kind: 'command', outcome: 'failed', reason: error.reason ?? 'unauthenticated', detail: null, durationMs: null, ref: null });
        return unauthenticated(respond, error);
      }
      const request = parseBody(input.body, v1CommandSchema);
      if (!request.success) {
        await recordAttempt(store, { kind: 'command', outcome: 'failed', reason: 'invalid_request', detail: null, durationMs: null, ref: null });
        return respond(400, { error: 'invalid_request' });
      }
      const started = Date.now();
      let receipt: V1CommandReceipt;
      try { receipt = await applyCommand(store, devices, principal, request.data); }
      catch (error) {
        if (!(error instanceof V1Unauthenticated)) throw error;
        const reason = error.reason ?? 'unauthenticated';
        await recordAttempt(store, { kind: 'command', outcome: 'failed', reason, detail: { code: reason, commandId: request.data.commandId }, durationMs: Date.now() - started, ref: request.data.commandId });
        return unauthenticated(respond, error);
      }
      await recordAttempt(store, { kind: 'command', outcome: receipt.outcome === 'refused' ? 'failed' : 'ok',
        reason: receipt.outcome === 'duplicate' ? 'duplicate' : receipt.reason, detail: { code: request.data.kind, commandId: receipt.commandId }, durationMs: Date.now() - started, ref: receipt.commandId });
      return respond(200, v1CommandReceiptSchema.parse(receipt));
    }
    return respond(404, { error: 'not_found' });
  } catch (error) {
    // Never interpolate the exception: a read outage is unavailable, anything else is the worker's own error.
    if (error instanceof DynamoReadUnavailable) return respond(503, { error: 'unavailable' });
    return respond(500, { error: 'worker_error' });
  }
}
