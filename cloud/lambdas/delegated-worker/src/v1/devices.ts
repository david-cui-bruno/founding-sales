import { randomBytes, randomUUID } from 'node:crypto';
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import type { DiagnosticsDevice, PairRedeemResponse } from '../../../../../src/shared/contracts/v1Contract';
import type { DynamoStore, Stored } from '../dynamoStore';
import { secretHash } from '../workerAuth';

/**
 * One device token, all scopes (FSS target design section 3). A pairing code the operator tool minted is
 * redeemed once by a fresh client for a device token; the worker keeps only the SHA-256 of either. There are
 * no scopes, no generations and no emergency credential. Losing the Mac means minting a new code that names
 * the lost device (`replaceDeviceId`), which the redeem revokes in the same transaction that creates the new
 * one; a token is accepted for ninety days from pairing and then the Mac pairs again.
 *
 * Sort keys, all in the workspace partition:
 *   PAIRCODE#<sha256(code)>   { label, expiresAt, consumedAt, replaceDeviceId? }  plus a `ttl` attribute shortly after expiry
 *   DEVICE#<sha256(token)>    { deviceId, label, createdAt, lastSeenAt, revokedAt }  plus a top-level `revokedAt` once revoked,
 *                             which is what a command transaction's ConditionCheck reads
 *   COUNTER#pair_fail#<hour>  { count }  with a two hour `ttl`; only consumed and expired codes count, and redeems are
 *                             refused after five in the hour. A malformed or unknown code is refused without any write.
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
/** A device token is accepted for ninety days from pairing; after that the Mac pairs again with a fresh code. */
export const DEVICE_TOKEN_LIFETIME_MS = 90 * 24 * 3_600_000;
/** A consumed or expired code row lingers this long past its expiry before Dynamo's TTL removes it. */
const PAIRCODE_TTL_GRACE_SECONDS = 3600;

const SECRET = /^[A-Za-z0-9_-]{43}$/;
const secret = () => randomBytes(32).toString('base64url');
const instant = z.iso.datetime({ precision: 3 });
const uuid = z.string().uuid();
const labelSchema = z.string().min(1).max(80).refine(value => ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127));
/** The stored code. `replaceDeviceId` names the device the redeem retires in the same transaction (a lost Mac). */
const pairCodeRecordSchema = z.strictObject({ label: labelSchema, expiresAt: instant, consumedAt: instant.nullable(), replaceDeviceId: uuid.optional() });
/** The stored device row. `expiresAt` is derived from `createdAt` for the view and never stored. */
export const deviceRecordSchema = z.strictObject({ deviceId: uuid, label: labelSchema, createdAt: instant, lastSeenAt: instant.nullable(), revokedAt: instant.nullable() });
export type DeviceRecord = z.infer<typeof deviceRecordSchema>;
const counterSchema = z.strictObject({ count: z.number().int().nonnegative() });

export type PairRefusalReason = 'code_invalid' | 'code_unknown' | 'code_consumed' | 'code_expired' | 'too_many_failures';
/** A redeem the worker refused, with the closed reason the attempt log records. The HTTP body never says more than this. */
export class V1PairRefused extends Error {
  constructor(readonly reason: PairRefusalReason) { super('pair_refused'); this.name = 'V1PairRefused'; }
}
/** A refused credential. `reason` is `device_expired` when the device's ninety days are over and null otherwise: an unknown
 *  token and a revoked device are refused alike, without saying which. */
export class V1Unauthenticated extends Error {
  constructor(readonly reason: 'device_expired' | null = null) { super('unauthenticated'); this.name = 'V1Unauthenticated'; }
}
/** The device behind a request. `key` is its DEVICE# sort key, for the ConditionCheck a command transaction carries; it never leaves the worker. */
export type V1Principal = { deviceId: string; label: string; key: string };
export type RevokePlan = { item: TransactWriteItem } | { refused: 'device_unknown' | 'device_revoked' };

export const deviceExpiresAt = (createdAt: string): string => new Date(Date.parse(createdAt) + DEVICE_TOKEN_LIFETIME_MS).toISOString();

export class V1Devices {
  constructor(private readonly store: DynamoStore) {}

  /** Trusted operator composition only; never reachable over HTTP. The code is returned once, for the private output file. */
  async mintPairCode(input: { label: string; expiresInSeconds: number; replaceDeviceId?: string }): Promise<{ code: string; expiresAt: string }> {
    const label = labelSchema.parse(input.label);
    const seconds = z.number().int().min(DEVICE_CODE_EXPIRY_SECONDS.min).max(DEVICE_CODE_EXPIRY_SECONDS.max).parse(input.expiresInSeconds);
    const replaceDeviceId = input.replaceDeviceId === undefined ? undefined : uuid.parse(input.replaceDeviceId);
    const now = this.store.now();
    const expiresAt = new Date(Date.parse(now) + seconds * 1000).toISOString();
    const code = secret();
    const record = pairCodeRecordSchema.parse({ label, expiresAt, consumedAt: null, ...(replaceDeviceId ? { replaceDeviceId } : {}) });
    await this.store.transact([this.store.put(pairCodeKey(code), record, null, { ttl: codeTtl(expiresAt) })]);
    return { code, expiresAt };
  }

  /**
   * Looks the code up before it writes anything. A malformed or unknown code is refused without a write, so guessing
   * cannot fill the counter; a consumed or expired code counts toward the hour's five, and after five every redeem is
   * refused until the hour turns. One transaction marks the code consumed, puts the device and, for a replacement
   * code, revokes the device it names.
   */
  async redeem(code: string): Promise<PairRedeemResponse> {
    const now = this.store.now();
    const hour = Math.floor(Date.parse(now) / 3_600_000);
    const counter = await this.store.get<unknown>(pairFailureCounterKey(hour));
    const failures = counterSchema.safeParse(counter?.data);
    const count = failures.success ? failures.data.count : 0;
    if (count >= PAIR_FAILURE_LIMIT) throw new V1PairRefused('too_many_failures');
    if (!SECRET.test(code)) throw new V1PairRefused('code_invalid');
    const key = pairCodeKey(code);
    const stored = await this.store.get<unknown>(key);
    const parsed = pairCodeRecordSchema.safeParse(stored?.data);
    if (!stored || !parsed.success) throw new V1PairRefused('code_unknown');
    const counted = async (reason: PairRefusalReason): Promise<never> => {
      await this.countFailure(hour, counter, count);
      throw new V1PairRefused(reason);
    };
    if (parsed.data.consumedAt !== null) return counted('code_consumed');
    if (Date.parse(parsed.data.expiresAt) <= Date.parse(now)) return counted('code_expired');
    const deviceToken = secret(); const deviceId = randomUUID();
    const device: DeviceRecord = { deviceId, label: parsed.data.label, createdAt: now, lastSeenAt: null, revokedAt: null };
    const items = [
      this.store.put(key, { ...parsed.data, consumedAt: now }, stored.rev, { ttl: codeTtl(parsed.data.expiresAt) }),
      this.store.put(deviceKey(deviceToken), device, null),
    ];
    if (parsed.data.replaceDeviceId) {
      // Already revoked, or never there: nothing left to retire, and the new device still pairs.
      const plan = await this.planRevoke(parsed.data.replaceDeviceId);
      if ('item' in plan) items.push(plan.item);
    }
    try { await this.store.transact(items); }
    catch {
      // The code's revision moved under us: a concurrent redemption consumed it first.
      return counted('code_consumed');
    }
    return { deviceToken, deviceId, workspaceId: this.store.options.workspaceId };
  }

  private async countFailure(hour: number, counter: Stored<unknown> | null, count: number): Promise<void> {
    try { await this.store.transact([this.store.put(pairFailureCounterKey(hour), { count: count + 1 }, counter?.rev ?? null, { ttl: (hour + 2) * 3600 })]); }
    catch { /* A concurrent failure already advanced the counter; this refusal stands either way. */ }
  }

  /** The bearer token to a principal, or `V1Unauthenticated`. A revoked device is refused exactly like an unknown one; an expired one says so. */
  async authenticate(authorization: string | undefined): Promise<V1Principal> {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? '');
    if (!match) throw new V1Unauthenticated();
    const key = deviceKey(match[1]!);
    const stored = await this.store.get<unknown>(key);
    const parsed = deviceRecordSchema.safeParse(stored?.data);
    if (!stored || !parsed.success || parsed.data.revokedAt !== null) throw new V1Unauthenticated();
    const now = this.store.now();
    if (Date.parse(now) >= Date.parse(deviceExpiresAt(parsed.data.createdAt))) throw new V1Unauthenticated('device_expired');
    if (parsed.data.lastSeenAt === null || Date.parse(now) - Date.parse(parsed.data.lastSeenAt) >= LAST_SEEN_INTERVAL_MS) {
      try { await this.store.transact([this.store.put(key, { ...parsed.data, lastSeenAt: now }, stored.rev)]); }
      catch { /* Best effort: a lost lastSeenAt refresh never fails a request. */ }
    }
    return { deviceId: parsed.data.deviceId, label: parsed.data.label, key };
  }

  /** Whether the device behind `key` is still accepted now: present, not revoked, not expired. Read after a refused transaction. */
  async isActive(key: string): Promise<boolean> {
    const stored = await this.store.get<unknown>(key);
    const parsed = deviceRecordSchema.safeParse(stored?.data);
    return !!stored && parsed.success && parsed.data.revokedAt === null && Date.parse(this.store.now()) < Date.parse(deviceExpiresAt(parsed.data.createdAt));
  }

  /** The ConditionCheck a command transaction carries so a revocation that lands mid-request refuses the write:
   *  the caller's own DEVICE# row must exist in this workspace and carry no top-level `revokedAt`. */
  activeCheck(key: string): TransactWriteItem {
    return { ConditionCheck: { TableName: this.store.options.tableName, Key: this.store.key(key),
      ConditionExpression: '#workspace = :workspace AND attribute_not_exists(#revokedAt)',
      ExpressionAttributeNames: { '#workspace': 'workspaceId', '#revokedAt': 'revokedAt' },
      ExpressionAttributeValues: { ':workspace': { S: this.store.options.workspaceId } } } };
  }

  /** Every device row, oldest first, with the instant each stops being accepted. Token hashes never leave the store. */
  async listDevices(): Promise<DiagnosticsDevice[]> {
    return (await this.deviceRows()).map(row => ({ ...row.record, expiresAt: deviceExpiresAt(row.record.createdAt) }));
  }

  /** One device by id, for the operator tool's `--replace-device` check; null when unknown. */
  async findDevice(deviceId: string): Promise<DeviceRecord | null> {
    return (await this.deviceRows()).find(row => row.record.deviceId === deviceId)?.record ?? null;
  }

  /** The fenced put that revokes one device, for the caller to commit beside its own write; or the closed reason it cannot.
   *  The revocation instant is also written as a top-level attribute, which is what `activeCheck` reads. */
  async planRevoke(deviceId: string): Promise<RevokePlan> {
    const row = (await this.deviceRows()).find(candidate => candidate.record.deviceId === deviceId);
    if (!row) return { refused: 'device_unknown' };
    if (row.record.revokedAt !== null) return { refused: 'device_revoked' };
    const revokedAt = this.store.now();
    return { item: this.store.put(row.key, { ...row.record, revokedAt }, row.rev, { revokedAt }) };
  }

  private async deviceRows(): Promise<{ key: string; rev: number; record: DeviceRecord }[]> {
    const rows = await this.store.list<unknown>(DEVICE_PREFIX);
    return rows.flatMap(row => { const parsed = deviceRecordSchema.safeParse(row.stored.data); return parsed.success ? [{ key: row.key, rev: row.stored.rev, record: parsed.data }] : []; })
      .sort((a, b) => a.record.createdAt < b.record.createdAt ? -1 : a.record.createdAt > b.record.createdAt ? 1 : a.record.deviceId < b.record.deviceId ? -1 : 1);
  }
}

function codeTtl(expiresAt: string): number {
  return Math.floor(Date.parse(expiresAt) / 1000) + PAIRCODE_TTL_GRACE_SECONDS;
}
