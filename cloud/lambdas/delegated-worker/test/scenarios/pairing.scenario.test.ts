import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pairRedeemResponseSchema } from '../../../../../src/shared/contracts/v1Contract';
import { DynamoStore } from '../../src/dynamoStore';
import { DEVICE_PREFIX, PAIR_FAILURE_LIMIT, PAIRCODE_PREFIX, pairFailureCounterKey, V1Devices, V1PairRefused, V1Unauthenticated } from '../../src/v1/devices';
import { ConditionalCommandHarness } from '../sdkHarness';

/**
 * Pairing with one device token, on the real store and the in-memory Dynamo harness. The code is minted the
 * way the operator tool mints it, redeemed the way a fresh client redeems it, and the token is the only
 * credential the device ever holds. Nothing here reaches AWS or any provider.
 */
const START = '2026-09-18T12:00:00.000Z';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function deviceFixture(start = START) {
  const db = new ConditionalCommandHarness(); let now = start;
  const store = new DynamoStore({ dynamo: db, tableName: 'fictional-table', workspaceId: 'ws', clock: { now: () => now } });
  return { db, store, devices: new V1Devices(store), advance: (value: string) => { now = value; } };
}

describe('device pairing on the store', () => {
  it('mints a code stored only as its hash, redeems it once for a token stored only as its hash, and refuses the same code again', async () => {
    const f = deviceFixture();
    const minted = await f.devices.mintPairCode({ label: 'David MacBook', expiresInSeconds: 600 });
    expect(minted.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(minted.expiresAt).toBe('2026-09-18T12:10:00.000Z');
    const codeRow = f.db.dump().find(item => item.sk!.S!.startsWith(PAIRCODE_PREFIX))!;
    expect(codeRow.sk!.S).toBe(`${PAIRCODE_PREFIX}${sha256(minted.code)}`);
    expect(JSON.parse(codeRow.data!.S!)).toEqual({ label: 'David MacBook', expiresAt: minted.expiresAt, consumedAt: null });
    expect(Number(codeRow.ttl!.N)).toBeGreaterThanOrEqual(Math.floor(Date.parse(minted.expiresAt) / 1000));
    expect(JSON.stringify(f.db.dump())).not.toContain(minted.code);

    f.advance('2026-09-18T12:01:00.000Z');
    const redeemed = await f.devices.redeem(minted.code);
    expect(pairRedeemResponseSchema.parse(redeemed)).toEqual(redeemed);
    expect(redeemed.deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(redeemed.workspaceId).toBe('ws');
    const deviceRow = f.db.dump().find(item => item.sk!.S!.startsWith(DEVICE_PREFIX))!;
    expect(deviceRow.sk!.S).toBe(`${DEVICE_PREFIX}${sha256(redeemed.deviceToken)}`);
    expect(JSON.parse(deviceRow.data!.S!)).toEqual({ deviceId: redeemed.deviceId, label: 'David MacBook', createdAt: '2026-09-18T12:01:00.000Z', lastSeenAt: null, revokedAt: null });
    expect(JSON.stringify(f.db.dump())).not.toContain(redeemed.deviceToken);
    expect(f.db.inspect(codeRow.sk!.S!)).toMatchObject({ consumedAt: '2026-09-18T12:01:00.000Z' });

    await expect(f.devices.redeem(minted.code)).rejects.toMatchObject({ reason: 'code_consumed' });
    expect(f.db.dump().filter(item => item.sk!.S!.startsWith(DEVICE_PREFIX))).toHaveLength(1);
  });

  it('refuses an expired code, an unknown code and a malformed code, and after five failures in the hour refuses even a valid code', async () => {
    // Minted at 12:50 so that the hour boundary at 13:00 falls inside the valid code's fifteen minutes.
    const f = deviceFixture('2026-09-18T12:50:00.000Z');
    const expired = await f.devices.mintPairCode({ label: 'Old code', expiresInSeconds: 60 });
    const valid = await f.devices.mintPairCode({ label: 'Fresh code', expiresInSeconds: 900 });
    f.advance('2026-09-18T12:51:00.000Z');
    await expect(f.devices.redeem(expired.code)).rejects.toMatchObject({ reason: 'code_expired' });
    await expect(f.devices.redeem('A'.repeat(43))).rejects.toMatchObject({ reason: 'code_unknown' });
    await expect(f.devices.redeem('not-a-code')).rejects.toMatchObject({ reason: 'code_invalid' });
    await expect(f.devices.redeem('B'.repeat(43))).rejects.toMatchObject({ reason: 'code_unknown' });
    await expect(f.devices.redeem('C'.repeat(43))).rejects.toMatchObject({ reason: 'code_unknown' });
    const hour = Math.floor(Date.parse('2026-09-18T12:51:00.000Z') / 3_600_000);
    expect(f.db.inspect(pairFailureCounterKey(hour))).toEqual({ count: PAIR_FAILURE_LIMIT });
    const counterRow = f.db.dump().find(item => item.sk!.S === pairFailureCounterKey(hour))!;
    expect(Number(counterRow.ttl!.N)).toBe((hour + 2) * 3600);
    // The sixth attempt in the hour is refused before the code is even looked at, and the valid code stays unconsumed.
    const sixth = await f.devices.redeem(valid.code).catch((error: unknown) => error);
    expect(sixth).toBeInstanceOf(V1PairRefused); expect(sixth).toMatchObject({ reason: 'too_many_failures' });
    expect(f.db.inspect(`${PAIRCODE_PREFIX}${sha256(valid.code)}`)).toMatchObject({ consumedAt: null });
    expect(f.db.dump().filter(item => item.sk!.S!.startsWith(DEVICE_PREFIX))).toHaveLength(0);
    // The next hour starts clean, and the valid code (expiring 13:05) redeems.
    f.advance('2026-09-18T13:00:30.000Z');
    const redeemed = await f.devices.redeem(valid.code);
    expect(redeemed.deviceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('authenticates the bearer token, refreshes lastSeenAt at most hourly, and refuses a revoked device and any other credential', async () => {
    const f = deviceFixture();
    const minted = await f.devices.mintPairCode({ label: 'David MacBook', expiresInSeconds: 600 });
    const redeemed = await f.devices.redeem(minted.code);
    const bearer = `Bearer ${redeemed.deviceToken}`;
    f.advance('2026-09-18T12:05:00.000Z');
    expect(await f.devices.authenticate(bearer)).toEqual({ deviceId: redeemed.deviceId, label: 'David MacBook' });
    const key = `${DEVICE_PREFIX}${sha256(redeemed.deviceToken)}`;
    expect(f.db.inspect(key)).toMatchObject({ lastSeenAt: '2026-09-18T12:05:00.000Z' });
    f.advance('2026-09-18T12:30:00.000Z');
    await f.devices.authenticate(bearer);
    expect(f.db.inspect(key)).toMatchObject({ lastSeenAt: '2026-09-18T12:05:00.000Z' });
    f.advance('2026-09-18T13:05:00.000Z');
    await f.devices.authenticate(bearer);
    expect(f.db.inspect(key)).toMatchObject({ lastSeenAt: '2026-09-18T13:05:00.000Z' });
    for (const header of [undefined, '', 'Bearer', `Bearer ${'x'.repeat(43)}`, `Basic ${redeemed.deviceToken}`, redeemed.deviceToken, `Bearer ${minted.code}`]) {
      await expect(f.devices.authenticate(header)).rejects.toBeInstanceOf(V1Unauthenticated);
    }
    expect(await f.devices.listDevices()).toEqual([{ deviceId: redeemed.deviceId, label: 'David MacBook', createdAt: START, lastSeenAt: '2026-09-18T13:05:00.000Z', revokedAt: null }]);
    expect(await f.devices.planRevoke('00000000-0000-4000-8000-000000000000')).toEqual({ refused: 'device_unknown' });
    const plan = await f.devices.planRevoke(redeemed.deviceId);
    expect('item' in plan).toBe(true);
    if ('item' in plan) await f.store.transact([plan.item]);
    await expect(f.devices.authenticate(bearer)).rejects.toBeInstanceOf(V1Unauthenticated);
    expect(await f.devices.planRevoke(redeemed.deviceId)).toEqual({ refused: 'device_revoked' });
    expect((await f.devices.listDevices())[0]).toMatchObject({ revokedAt: '2026-09-18T13:05:00.000Z' });
  });

  it('refuses to mint outside the label and expiry bounds without writing', async () => {
    const f = deviceFixture();
    for (const input of [{ label: '', expiresInSeconds: 600 }, { label: 'x'.repeat(81), expiresInSeconds: 600 }, { label: 'tab\there', expiresInSeconds: 600 },
      { label: 'ok', expiresInSeconds: 59 }, { label: 'ok', expiresInSeconds: 901 }, { label: 'ok', expiresInSeconds: 60.5 }]) {
      await expect(f.devices.mintPairCode(input)).rejects.toThrow();
    }
    expect(f.db.dump()).toHaveLength(0);
  });
});
