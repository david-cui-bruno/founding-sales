import { randomBytes, randomUUID } from 'node:crypto';
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { diagnosticsDeviceSchema, type DiagnosticsDevice, type PairRedeemResponse } from '../../../../../src/shared/contracts/v1Contract';
import type { DynamoStore, Stored } from '../dynamoStore';
import { secretHash } from '../workerAuth';

/**
 * One device token, all scopes (FSS target design section 3). A pairing code the operator tool minted is
 * redeemed once by a fresh client for a device token; the worker keeps only the SHA-256 of either. There are
 * no scopes, no generations and no emergency credential: losing the Mac means minting a new code and
 * revoking the old device.
 *
 * Sort keys, all in the workspace partition:
 *   PAIRCODE#<sha256(code)>   { label, expiresAt, consumedAt }  plus a `ttl` attribute shortly after expiry
 *   DEVICE#<sha256(token)>    { deviceId, label, createdAt, lastSeenAt, revokedAt }
 *   COUNTER#pair_fail#<hour>  { count }  with a two hour `ttl`; redeems are refused after five failures in the hour
 */

export const PAIRCODE_PREFIX = 'PAIRCODE#';
export const DEVICE_PREFIX = 'DEVICE#';
export const pairCodeKey = (code: string): string => `${PAIRCODE_PREFIX}${secretHash(code)}`;
export const deviceKey = (token: string): string => `${DEVICE_PREFIX}${secretHash(token)}`;
export const pairFailureCounterKey = (hour: number): string => `COUNTER#pair_fail#${hour}`;
/** A device code lives between one and fifteen minutes; the operator tool enforces the same bounds. */
export const DEVICE_CODE_EXPIRY_SECONDS = { min: 60, max: 900 } as const;
export const PAIR_FAILURE_LIMIT = 5;
/** `lastSeenAt` is refreshed at most this often, so a 60 s poll does not write the device row every minute. */
export const LAST_SEEN_INTERVAL_MS = 3_600_000;
/** A consumed or expired code row lingers this long past its expiry before Dynamo's TTL removes it. */
const PAIRCODE_TTL_GRACE_SECONDS = 3600;

const SECRET = /^[A-Za-z0-9_-]{43}$/;
const secret = () => randomBytes(32).toString('base64url');
const instant = z.iso.datetime({ precision: 3 });
const labelSchema = z.string().min(1).max(80).refine(value => ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127));
const pairCodeRecordSchema = z.strictObject({ label: labelSchema, expiresAt: instant, consumedAt: instant.nullable() });
const counterSchema = z.strictObject({ count: z.number().int().nonnegative() });

export type PairRefusalReason = 'code_invalid' | 'code_unknown' | 'code_consumed' | 'code_expired' | 'too_many_failures';
/** A redeem the worker refused, with the closed reason the attempt log records. The HTTP body never says more than this. */
export class V1PairRefused extends Error {
  constructor(readonly reason: PairRefusalReason) { super('pair_refused'); this.name = 'V1PairRefused'; }
}
export class V1Unauthenticated extends Error {
  constructor() { super('unauthenticated'); this.name = 'V1Unauthenticated'; }
}
export type V1Principal = { deviceId: string; label: string };
export type RevokePlan = { item: TransactWriteItem } | { refused: 'device_unknown' | 'device_revoked' };

export class V1Devices {
  constructor(private readonly store: DynamoStore) {}

  /** Trusted operator composition only; never reachable over HTTP. The code is returned once, for the private output file. */
  async mintPairCode(input: { label: string; expiresInSeconds: number }): Promise<{ code: string; expiresAt: string }> {
    const label = labelSchema.parse(input.label);
    const seconds = z.number().int().min(DEVICE_CODE_EXPIRY_SECONDS.min).max(DEVICE_CODE_EXPIRY_SECONDS.max).parse(input.expiresInSeconds);
    const now = this.store.now();
    const expiresAt = new Date(Date.parse(now) + seconds * 1000).toISOString();
    const code = secret();
    await this.store.transact([this.store.put(pairCodeKey(code), { label, expiresAt, consumedAt: null }, null, { ttl: codeTtl(expiresAt) })]);
    return { code, expiresAt };
  }

  /** One transaction marks the code consumed and puts the device. Every refusal counts toward the hour's five. */
  async redeem(code: string): Promise<PairRedeemResponse> {
    const now = this.store.now();
    const hour = Math.floor(Date.parse(now) / 3_600_000);
    const counter = await this.store.get<unknown>(pairFailureCounterKey(hour));
    const failures = counterSchema.safeParse(counter?.data);
    if (failures.success && failures.data.count >= PAIR_FAILURE_LIMIT) throw new V1PairRefused('too_many_failures');
    const refuse = async (reason: PairRefusalReason): Promise<never> => {
      await this.countFailure(hour, counter, failures.success ? failures.data.count : 0);
      throw new V1PairRefused(reason);
    };
    if (!SECRET.test(code)) return refuse('code_invalid');
    const key = pairCodeKey(code);
    const stored = await this.store.get<unknown>(key);
    const parsed = pairCodeRecordSchema.safeParse(stored?.data);
    if (!stored || !parsed.success) return refuse('code_unknown');
    if (parsed.data.consumedAt !== null) return refuse('code_consumed');
    if (Date.parse(parsed.data.expiresAt) <= Date.parse(now)) return refuse('code_expired');
    const deviceToken = secret(); const deviceId = randomUUID();
    const device: DiagnosticsDevice = { deviceId, label: parsed.data.label, createdAt: now, lastSeenAt: null, revokedAt: null };
    try {
      await this.store.transact([
        this.store.put(key, { ...parsed.data, consumedAt: now }, stored.rev, { ttl: codeTtl(parsed.data.expiresAt) }),
        this.store.put(deviceKey(deviceToken), device, null),
      ]);
    } catch {
      // The code's revision moved under us: a concurrent redemption consumed it first.
      return refuse('code_consumed');
    }
    return { deviceToken, deviceId, workspaceId: this.store.options.workspaceId };
  }

  private async countFailure(hour: number, counter: Stored<unknown> | null, count: number): Promise<void> {
    try { await this.store.transact([this.store.put(pairFailureCounterKey(hour), { count: count + 1 }, counter?.rev ?? null, { ttl: (hour + 2) * 3600 })]); }
    catch { /* A concurrent failure already advanced the counter; this refusal stands either way. */ }
  }

  /** The bearer token to a principal, or `V1Unauthenticated`. A revoked device is refused exactly like an unknown one. */
  async authenticate(authorization: string | undefined): Promise<V1Principal> {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? '');
    if (!match) throw new V1Unauthenticated();
    const key = deviceKey(match[1]!);
    const stored = await this.store.get<unknown>(key);
    const parsed = diagnosticsDeviceSchema.safeParse(stored?.data);
    if (!stored || !parsed.success || parsed.data.revokedAt !== null) throw new V1Unauthenticated();
    const now = this.store.now();
    if (parsed.data.lastSeenAt === null || Date.parse(now) - Date.parse(parsed.data.lastSeenAt) >= LAST_SEEN_INTERVAL_MS) {
      try { await this.store.transact([this.store.put(key, { ...parsed.data, lastSeenAt: now }, stored.rev)]); }
      catch { /* Best effort: a lost lastSeenAt refresh never fails a request. */ }
    }
    return { deviceId: parsed.data.deviceId, label: parsed.data.label };
  }

  /** Every device row, oldest first. Token hashes never leave the store. */
  async listDevices(): Promise<DiagnosticsDevice[]> {
    const rows = await this.store.list<unknown>(DEVICE_PREFIX);
    return rows.flatMap(row => { const parsed = diagnosticsDeviceSchema.safeParse(row.stored.data); return parsed.success ? [parsed.data] : []; })
      .sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.deviceId < b.deviceId ? -1 : 1);
  }

  /** The fenced put that revokes one device, for the caller to commit beside its command receipt; or the closed reason it cannot. */
  async planRevoke(deviceId: string): Promise<RevokePlan> {
    const rows = await this.store.list<unknown>(DEVICE_PREFIX);
    for (const row of rows) {
      const parsed = diagnosticsDeviceSchema.safeParse(row.stored.data);
      if (!parsed.success || parsed.data.deviceId !== deviceId) continue;
      if (parsed.data.revokedAt !== null) return { refused: 'device_revoked' };
      return { item: this.store.put(row.key, { ...parsed.data, revokedAt: this.store.now() }, row.stored.rev) };
    }
    return { refused: 'device_unknown' };
  }
}

function codeTtl(expiresAt: string): number {
  return Math.floor(Date.parse(expiresAt) / 1000) + PAIRCODE_TTL_GRACE_SECONDS;
}
