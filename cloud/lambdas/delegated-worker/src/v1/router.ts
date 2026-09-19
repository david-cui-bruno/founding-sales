import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { attemptKindSchema, DIAGNOSTICS_ATTEMPT_LIMIT, diagnosticsViewSchema, pairRedeemRequestSchema, pairRedeemResponseSchema,
  v1CommandReceiptSchema, v1CommandSchema, type V1Command, type V1CommandReceipt } from '../../../../../src/shared/contracts/v1Contract';
import { DynamoReadUnavailable, fingerprint, keyPart, type DynamoStore } from '../dynamoStore';
import type { WorkerHttpResponse } from '../handler';
import { SOURCE_LAST_TICK_KEY } from '../tickLog';
import type { WorkerAuth } from '../workerAuth';
import { listAttempts, recordAttempt } from './attempts';
import { V1Devices, V1PairRefused, V1Unauthenticated, type V1Principal } from './devices';

/**
 * The `/v1` routes of the rebuilt core (FSS target design section 3), mounted inside the existing handler so
 * that David only redeploys the worker:
 *
 *   POST /v1/pair/redeem      unauthenticated   a pairing code in, the device token out, once
 *   GET  /v1/diagnostics      device token      the last attempts (kind, limit), the last tick, the devices
 *   POST /v1/commands         device token      idempotent by commandId; S0 ships `revoke_device` only
 *
 * Errors: 401 `{ error: 'unauthenticated' }`, 404 `{ error: 'not_found' }` for any other `/v1` path or method,
 * 400 `{ error: 'invalid_request' }` on a body or query the contract refuses, 400 or 429 `{ error: 'pair_refused',
 * reason }` on a refused code. Every POST records one attempt (`pairing` or `command`); GET views record none.
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

export const V1_ROUTES = { pairRedeem: '/v1/pair/redeem', diagnostics: '/v1/diagnostics', commands: '/v1/commands' } as const;
export const v1CommandKey = (commandId: string): string => `V1COMMAND#${keyPart(commandId)}`;

const diagnosticsQuerySchema = z.strictObject({ kind: attemptKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(DIAGNOSTICS_ATTEMPT_LIMIT).optional() });
/** Only the three fields the view needs are read off the persisted tick record; the rest of it stays where it is. */
const lastTickSchema = z.object({ at: z.iso.datetime({ precision: 3 }), status: z.enum(['inactive', 'completed', 'aborted']), durationMs: z.number().int().nonnegative() });
const receiptRecordSchema = z.strictObject({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), kind: z.string(), receipt: v1CommandReceiptSchema,
  at: z.iso.datetime({ precision: 3 }), deviceId: z.string().uuid() });

function parseBody<T>(body: () => unknown, schema: z.ZodType<T>): { success: true; data: T } | { success: false } {
  let raw: unknown;
  try { raw = body(); } catch { return { success: false }; }
  const parsed = schema.safeParse(raw);
  return parsed.success ? { success: true, data: parsed.data } : { success: false };
}

async function readLastTick(store: DynamoStore) {
  const row = await store.get<unknown>(SOURCE_LAST_TICK_KEY);
  const parsed = lastTickSchema.safeParse(row?.data);
  return parsed.success ? { at: parsed.data.at, status: parsed.data.status, durationMs: parsed.data.durationMs } : null;
}

/** The receipt a repeated commandId gets: the first answer's reason (or its outcome), or a conflict when the payload differs. */
function repeatedReceipt(stored: unknown, expectedFingerprint: string, commandId: string): V1CommandReceipt {
  const parsed = receiptRecordSchema.safeParse(stored);
  if (!parsed.success) throw new Error('v1_receipt_corrupt');
  if (parsed.data.fingerprint !== expectedFingerprint) return { commandId, outcome: 'refused', reason: 'command_conflict' };
  return { commandId, outcome: 'duplicate', reason: parsed.data.receipt.reason ?? parsed.data.receipt.outcome };
}

/**
 * Applies one command exactly once. The receipt is written under `V1COMMAND#<commandId>` in the same transaction
 * as the command's own write, so a lost response is answered from the receipt and a second copy can never apply.
 */
async function applyCommand(store: DynamoStore, devices: V1Devices, principal: V1Principal, command: V1Command): Promise<V1CommandReceipt> {
  const key = v1CommandKey(command.commandId);
  const commandFingerprint = fingerprint(command);
  const existing = await store.get<unknown>(key);
  if (existing) return repeatedReceipt(existing.data, commandFingerprint, command.commandId);
  let receipt: V1CommandReceipt;
  const items: TransactWriteItem[] = [];
  switch (command.kind) {
    case 'revoke_device': {
      const plan = await devices.planRevoke(command.deviceId);
      if ('item' in plan) { items.push(plan.item); receipt = { commandId: command.commandId, outcome: 'applied', reason: null }; }
      else receipt = { commandId: command.commandId, outcome: 'refused', reason: plan.refused };
    }
  }
  const record = { fingerprint: commandFingerprint, kind: command.kind, receipt, at: store.now(), deviceId: principal.deviceId };
  try { await store.transact([...items, store.put(key, record, null)]); }
  catch (error) {
    // The receipt slot was taken between the read and the write: answer from it. Anything else stays uncertain.
    const committed = await store.get<unknown>(key);
    if (committed) return repeatedReceipt(committed.data, commandFingerprint, command.commandId);
    throw error;
  }
  return receipt;
}

export async function v1Router(input: V1RouterInput): Promise<WorkerHttpResponse> {
  const { respond, method, path } = input;
  const store = input.auth.store;
  const devices = new V1Devices(store);
  try {
    if (path === V1_ROUTES.pairRedeem) {
      if (method !== 'POST') return respond(404, { error: 'not_found' });
      const request = parseBody(input.body, pairRedeemRequestSchema);
      if (!request.success) {
        await recordAttempt(store, { kind: 'pairing', outcome: 'failed', reason: 'invalid_request', detail: null, durationMs: null, ref: null });
        return respond(400, { error: 'invalid_request' });
      }
      const started = Date.now();
      try {
        const redeemed = pairRedeemResponseSchema.parse(await devices.redeem(request.data.code));
        await recordAttempt(store, { kind: 'pairing', outcome: 'ok', reason: null, detail: 'device paired', durationMs: Date.now() - started, ref: redeemed.deviceId });
        return respond(200, redeemed);
      } catch (error) {
        if (!(error instanceof V1PairRefused)) throw error;
        await recordAttempt(store, { kind: 'pairing', outcome: 'failed', reason: error.reason, detail: null, durationMs: Date.now() - started, ref: null });
        return respond(error.reason === 'too_many_failures' ? 429 : 400, { error: 'pair_refused', reason: error.reason });
      }
    }
    if (path === V1_ROUTES.diagnostics) {
      if (method !== 'GET') return respond(404, { error: 'not_found' });
      try { await devices.authenticate(input.authorization); }
      catch (error) { if (error instanceof V1Unauthenticated) return respond(401, { error: 'unauthenticated' }); throw error; }
      const query = diagnosticsQuerySchema.safeParse({ kind: input.query.get('kind') ?? undefined, limit: input.query.get('limit') ?? undefined });
      if (!query.success) return respond(400, { error: 'invalid_request' });
      const [attempts, lastTick, deviceList] = await Promise.all([listAttempts(store, query.data), readLastTick(store), devices.listDevices()]);
      return respond(200, diagnosticsViewSchema.parse({ asOf: store.now(), attempts, lastTick, devices: deviceList }));
    }
    if (path === V1_ROUTES.commands) {
      if (method !== 'POST') return respond(404, { error: 'not_found' });
      let principal: V1Principal;
      try { principal = await devices.authenticate(input.authorization); }
      catch (error) {
        if (!(error instanceof V1Unauthenticated)) throw error;
        await recordAttempt(store, { kind: 'command', outcome: 'failed', reason: 'unauthenticated', detail: null, durationMs: null, ref: null });
        return respond(401, { error: 'unauthenticated' });
      }
      const request = parseBody(input.body, v1CommandSchema);
      if (!request.success) {
        await recordAttempt(store, { kind: 'command', outcome: 'failed', reason: 'invalid_request', detail: null, durationMs: null, ref: null });
        return respond(400, { error: 'invalid_request' });
      }
      const started = Date.now();
      const receipt = await applyCommand(store, devices, principal, request.data);
      await recordAttempt(store, { kind: 'command', outcome: receipt.outcome === 'refused' ? 'failed' : 'ok',
        reason: receipt.outcome === 'duplicate' ? 'duplicate' : receipt.reason, detail: `kind=${request.data.kind}`, durationMs: Date.now() - started, ref: receipt.commandId });
      return respond(200, v1CommandReceiptSchema.parse(receipt));
    }
    return respond(404, { error: 'not_found' });
  } catch (error) {
    // Never interpolate the exception: a read outage is unavailable, anything else is the worker's own error.
    if (error instanceof DynamoReadUnavailable) return respond(503, { error: 'unavailable' });
    return respond(500, { error: 'worker_error' });
  }
}
