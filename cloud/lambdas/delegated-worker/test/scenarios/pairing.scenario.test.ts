import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pairRedeemResponseSchema } from '../../../../../src/shared/contracts/v1Contract';
import { DynamoStore } from '../../src/dynamoStore';
import { DEVICE_PREFIX, DEVICE_TOKEN_LIFETIME_MS, PAIR_FAILURE_LIMIT, PAIRCODE_PREFIX, pairFailureCounterKey, V1Devices, V1PairRefused, V1Unauthenticated } from '../../src/v1/devices';
import { listAttempts } from '../../src/v1/attempts';
import { parseOperatorArgs, runOperatorPairing, type OperatorDependencies } from '../../src/operatorPairing';
import { ConditionalCommandHarness } from '../sdkHarness';
import { v1Fixture } from './v1Fixture';

/**
 * Pairing with one device token, on the real store and the in-memory Dynamo harness. The code is minted the
 * way the operator tool mints it, redeemed the way a fresh client redeems it, and the token is the only
 * credential the device ever holds. Nothing here reaches AWS or any provider.
 */
const START = '2026-09-18T12:00:00.000Z';
/** Ninety days after START: the instant a device paired at START stops being accepted. */
const START_PLUS_90_DAYS = '2026-12-17T12:00:00.000Z';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
/** A well-formed code nobody minted. */
const unknownCode = () => randomBytes(32).toString('base64url');
const hourOf = (instant: string) => Math.floor(Date.parse(instant) / 3_600_000);
const rows = (db: ConditionalCommandHarness, prefix: string) => db.dump().filter(item => item.sk!.S!.startsWith(prefix));

function deviceFixture(start = START) {
  const db = new ConditionalCommandHarness(); let now = start;
  const store = new DynamoStore({ dynamo: db, tableName: 'fictional-table', workspaceId: 'ws', clock: { now: () => now } });
  return { db, store, devices: new V1Devices(store), advance: (value: string) => { now = value; } };
}

describe('device pairing on the store', () => {
  it('mints a code stored only as its hash, redeems it once for a token stored only as its hash, and refuses the same code again (which counts)', async () => {
    const f = deviceFixture();
    const minted = await f.devices.mintPairCode({ label: 'David MacBook', expiresInSeconds: 600 });
    expect(minted.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(minted.expiresAt).toBe('2026-09-18T12:10:00.000Z');
    const codeRow = rows(f.db, PAIRCODE_PREFIX)[0]!;
    expect(codeRow.sk!.S).toBe(`${PAIRCODE_PREFIX}${sha256(minted.code)}`);
    expect(JSON.parse(codeRow.data!.S!)).toEqual({ label: 'David MacBook', expiresAt: minted.expiresAt, consumedAt: null });
    expect(Number(codeRow.ttl!.N)).toBeGreaterThanOrEqual(Math.floor(Date.parse(minted.expiresAt) / 1000));
    expect(JSON.stringify(f.db.dump())).not.toContain(minted.code);

    f.advance('2026-09-18T12:01:00.000Z');
    const redeemed = await f.devices.redeem(minted.code);
    expect(pairRedeemResponseSchema.parse(redeemed)).toEqual(redeemed);
    expect(redeemed.deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(redeemed.workspaceId).toBe('ws');
    const deviceRow = rows(f.db, DEVICE_PREFIX)[0]!;
    expect(deviceRow.sk!.S).toBe(`${DEVICE_PREFIX}${sha256(redeemed.deviceToken)}`);
    expect(JSON.parse(deviceRow.data!.S!)).toEqual({ deviceId: redeemed.deviceId, label: 'David MacBook', createdAt: '2026-09-18T12:01:00.000Z', lastSeenAt: null, revokedAt: null });
    expect(JSON.stringify(f.db.dump())).not.toContain(redeemed.deviceToken);
    expect(f.db.inspect(codeRow.sk!.S!)).toMatchObject({ consumedAt: '2026-09-18T12:01:00.000Z' });

    await expect(f.devices.redeem(minted.code)).rejects.toMatchObject({ reason: 'code_consumed' });
    expect(rows(f.db, DEVICE_PREFIX)).toHaveLength(1);
    expect(f.db.inspect(pairFailureCounterKey(hourOf('2026-09-18T12:01:00.000Z')))).toEqual({ count: 1 });
  });

  it('refuses an unknown or malformed code without any write; only consumed and expired codes count, and the sixth counted failure refuses even a valid code', async () => {
    // Minted at 12:50 so that the hour boundary at 13:00 falls inside the valid code's fifteen minutes.
    const f = deviceFixture('2026-09-18T12:50:00.000Z');
    const expired = await f.devices.mintPairCode({ label: 'Old code', expiresInSeconds: 60 });
    const valid = await f.devices.mintPairCode({ label: 'Fresh code', expiresInSeconds: 900 });
    f.advance('2026-09-18T12:51:00.000Z');
    const hour = hourOf('2026-09-18T12:51:00.000Z');
    await expect(f.devices.redeem(expired.code)).rejects.toMatchObject({ reason: 'code_expired' });
    expect(f.db.inspect(pairFailureCounterKey(hour))).toEqual({ count: 1 });
    const writes = f.db.transactions.length;
    await expect(f.devices.redeem(unknownCode())).rejects.toMatchObject({ reason: 'code_unknown' });
    await expect(f.devices.redeem('not-a-code')).rejects.toMatchObject({ reason: 'code_invalid' });
    // The code was looked up first and found missing (or never looked up at all): nothing was written for either.
    expect(f.db.transactions).toHaveLength(writes);
    expect(f.db.inspect(pairFailureCounterKey(hour))).toEqual({ count: 1 });
    for (let attempt = 0; attempt < 4; attempt++) await expect(f.devices.redeem(expired.code)).rejects.toMatchObject({ reason: 'code_expired' });
    expect(f.db.inspect(pairFailureCounterKey(hour))).toEqual({ count: PAIR_FAILURE_LIMIT });
    const counterRow = f.db.dump().find(item => item.sk!.S === pairFailureCounterKey(hour))!;
    expect(Number(counterRow.ttl!.N)).toBe((hour + 2) * 3600);
    // The sixth attempt in the hour is refused before the code is even looked at, and the valid code stays unconsumed.
    const sixth = await f.devices.redeem(valid.code).catch((error: unknown) => error);
    expect(sixth).toBeInstanceOf(V1PairRefused); expect(sixth).toMatchObject({ reason: 'too_many_failures' });
    expect(f.db.inspect(`${PAIRCODE_PREFIX}${sha256(valid.code)}`)).toMatchObject({ consumedAt: null });
    expect(rows(f.db, DEVICE_PREFIX)).toHaveLength(0);
    // The next hour starts clean, and the valid code (expiring 13:05) redeems.
    f.advance('2026-09-18T13:00:30.000Z');
    const redeemed = await f.devices.redeem(valid.code);
    expect(redeemed.deviceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('fifty unknown codes leave no COUNTER# item and write nothing at all', async () => {
    const f = deviceFixture();
    for (let attempt = 0; attempt < 50; attempt++) await expect(f.devices.redeem(unknownCode())).rejects.toMatchObject({ reason: 'code_unknown' });
    expect(rows(f.db, 'COUNTER#')).toEqual([]);
    expect(f.db.dump()).toEqual([]);
    expect(f.db.transactions).toHaveLength(0);
  });

  it('authenticates the bearer token, refreshes lastSeenAt at most hourly, and refuses a revoked device and any other credential', async () => {
    const f = deviceFixture();
    const minted = await f.devices.mintPairCode({ label: 'David MacBook', expiresInSeconds: 600 });
    const redeemed = await f.devices.redeem(minted.code);
    const bearer = `Bearer ${redeemed.deviceToken}`;
    f.advance('2026-09-18T12:05:00.000Z');
    expect(await f.devices.authenticate(bearer)).toMatchObject({ deviceId: redeemed.deviceId, label: 'David MacBook' });
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
    expect(await f.devices.listDevices()).toEqual([{ deviceId: redeemed.deviceId, label: 'David MacBook', createdAt: START, lastSeenAt: '2026-09-18T13:05:00.000Z', revokedAt: null, expiresAt: START_PLUS_90_DAYS }]);
    expect(await f.devices.planRevoke('00000000-0000-4000-8000-000000000000')).toEqual({ refused: 'device_unknown' });
    const plan = await f.devices.planRevoke(redeemed.deviceId);
    expect('item' in plan).toBe(true);
    if ('item' in plan) await f.store.transact([plan.item]);
    await expect(f.devices.authenticate(bearer)).rejects.toBeInstanceOf(V1Unauthenticated);
    // The revocation is also a top-level attribute, which is what a command transaction's ConditionCheck reads.
    expect(f.db.dump().find(item => item.sk!.S === key)!.revokedAt).toEqual({ S: '2026-09-18T13:05:00.000Z' });
    expect(await f.devices.planRevoke(redeemed.deviceId)).toEqual({ refused: 'device_revoked' });
    expect((await f.devices.listDevices())[0]).toMatchObject({ revokedAt: '2026-09-18T13:05:00.000Z' });
  });

  it('stops accepting a device ninety days after it was paired, says so, and the view says when', async () => {
    expect(DEVICE_TOKEN_LIFETIME_MS).toBe(90 * 24 * 3_600_000);
    const f = deviceFixture();
    const redeemed = await f.devices.redeem((await f.devices.mintPairCode({ label: 'David MacBook', expiresInSeconds: 600 })).code);
    const bearer = `Bearer ${redeemed.deviceToken}`;
    f.advance('2026-12-17T11:59:59.999Z');
    expect(await f.devices.authenticate(bearer)).toMatchObject({ deviceId: redeemed.deviceId });
    expect(await f.devices.listDevices()).toEqual([expect.objectContaining({ deviceId: redeemed.deviceId, expiresAt: START_PLUS_90_DAYS, revokedAt: null })]);
    f.advance(START_PLUS_90_DAYS);
    const refused = await f.devices.authenticate(bearer).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(V1Unauthenticated); expect(refused).toMatchObject({ reason: 'device_expired' });
    // A refusal is not a sighting.
    expect(f.db.inspect(`${DEVICE_PREFIX}${sha256(redeemed.deviceToken)}`)).toMatchObject({ lastSeenAt: '2026-12-17T11:59:59.999Z' });
  });

  it('a code minted to replace a device revokes that device in the same transaction that creates the new one', async () => {
    const f = deviceFixture();
    const old = await f.devices.redeem((await f.devices.mintPairCode({ label: 'Old Mac', expiresInSeconds: 600 })).code);
    f.advance('2026-09-18T12:05:00.000Z');
    const replacement = await f.devices.mintPairCode({ label: 'New Mac', expiresInSeconds: 600, replaceDeviceId: old.deviceId });
    expect(f.db.inspect(`${PAIRCODE_PREFIX}${sha256(replacement.code)}`)).toEqual({ label: 'New Mac', expiresAt: '2026-09-18T12:15:00.000Z', consumedAt: null, replaceDeviceId: old.deviceId });
    const writes = f.db.transactions.length;
    const fresh = await f.devices.redeem(replacement.code);
    expect(f.db.transactions).toHaveLength(writes + 1);
    const keys = f.db.transactions.at(-1)!.TransactItems!.map(item => item.Put!.Item!.sk!.S!);
    expect(keys.filter(key => key.startsWith(DEVICE_PREFIX))).toHaveLength(2);
    expect(keys.filter(key => key.startsWith(PAIRCODE_PREFIX))).toHaveLength(1);
    await expect(f.devices.authenticate(`Bearer ${old.deviceToken}`)).rejects.toBeInstanceOf(V1Unauthenticated);
    expect(await f.devices.authenticate(`Bearer ${fresh.deviceToken}`)).toMatchObject({ deviceId: fresh.deviceId, label: 'New Mac' });
    expect(await f.devices.listDevices()).toEqual([
      expect.objectContaining({ deviceId: old.deviceId, revokedAt: '2026-09-18T12:05:00.000Z' }),
      expect.objectContaining({ deviceId: fresh.deviceId, revokedAt: null }),
    ]);
    // Nothing left to revoke is not a refusal: a code naming an already revoked device, or one that never existed, still pairs.
    const again = await f.devices.mintPairCode({ label: 'Third Mac', expiresInSeconds: 600, replaceDeviceId: old.deviceId });
    expect((await f.devices.redeem(again.code)).deviceId).toMatch(/^[0-9a-f-]{36}$/);
    const stray = await f.devices.mintPairCode({ label: 'Fourth Mac', expiresInSeconds: 600, replaceDeviceId: '00000000-0000-4000-8000-0000000000ff' });
    expect((await f.devices.redeem(stray.code)).deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await f.devices.authenticate(`Bearer ${fresh.deviceToken}`)).toMatchObject({ deviceId: fresh.deviceId });
  });

  it('refuses to mint outside the label, expiry and replaced-device bounds without writing', async () => {
    const f = deviceFixture();
    for (const input of [{ label: '', expiresInSeconds: 600 }, { label: 'x'.repeat(81), expiresInSeconds: 600 }, { label: 'tab\there', expiresInSeconds: 600 },
      { label: 'ok', expiresInSeconds: 59 }, { label: 'ok', expiresInSeconds: 901 }, { label: 'ok', expiresInSeconds: 60.5 },
      { label: 'ok', expiresInSeconds: 600, replaceDeviceId: 'not-a-device' }, { label: 'ok', expiresInSeconds: 600, replaceDeviceId: '' }]) {
      await expect(f.devices.mintPairCode(input)).rejects.toThrow();
    }
    expect(f.db.dump()).toHaveLength(0);
  });
});

describe('POST /v1/pair/redeem on the real handler', () => {
  /** The exact argument shape David runs, minus his four identifiers; the same values with --execute mint the code. */
  const mintArgs = ['--mint-device-code', '--account', '123456789012', '--region', 'us-east-1', '--table', 'worker-table',
    '--workspace', 'ws', '--label', 'David MacBook', '--expires', '600', '--output', '/private/operator/device-code'];
  /** Operator dependencies over the fixture's own store, saving the code into `saved` instead of a file. */
  function operatorDeps(f: ReturnType<typeof v1Fixture>, saved: { code: string | null }): OperatorDependencies {
    return {
      reserveOutput: async () => ({ save: async code => { saved.code = code; }, close: async () => {} }),
      connect: async () => ({
        getCallerIdentity: async () => ({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/operator' }),
        describeTable: async () => ({ TableName: 'worker-table', TableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/worker-table', TableStatus: 'ACTIVE' }),
        dynamo: { send: command => f.db.send(command) }, close: () => {},
      }),
    };
  }

  it('the operator tool mints the code (dry run, then execute against the same store), the fresh client redeems it, and a second code with --replace-device retires the first device on redemption', async () => {
    // The fixture clock sits before the real clock the tool stamps expiry with, so the minted codes are unexpired here.
    const f = v1Fixture('2026-09-01T00:00:00.000Z');
    expect(parseOperatorArgs(mintArgs)).toMatchObject({ mode: 'device_code', label: 'David MacBook', expires: 600, workspace: 'ws', scopes: [], rotate: null, replaceDevice: null, execute: false });
    const saved: { code: string | null } = { code: null };
    const deps = operatorDeps(f, saved);
    const dry = await runOperatorPairing(mintArgs, deps);
    expect(dry).toEqual({ exitCode: 0, message: 'Dry-run valid. No IO performed, identity and destination are NOT verified. No device code issued.' });
    expect(saved.code).toBeNull(); expect(f.db.dump()).toHaveLength(0);
    const executed = await runOperatorPairing([...mintArgs, '--execute'], deps);
    expect(executed).toEqual({ exitCode: 0, message: 'Device code saved to private output. No code printed.' });
    expect(saved.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(f.db.dump())).not.toContain(saved.code);
    const redeemed = await f.request('POST', '/v1/pair/redeem', { body: { code: saved.code } });
    expect(redeemed.statusCode).toBe(200);
    const token = pairRedeemResponseSchema.parse(f.json(redeemed));
    const view = await f.request('GET', '/v1/diagnostics', { authorization: `Bearer ${token.deviceToken}` });
    expect(view.statusCode).toBe(200);
    expect(f.json(view)).toMatchObject({ devices: [{ deviceId: token.deviceId, label: 'David MacBook', revokedAt: null }] });
    expect((await f.request('POST', '/v1/pair/redeem', { body: { code: saved.code } })).statusCode).toBe(400);

    // David lost the Mac: one code replaces the device. The old token is refused the moment the new one is redeemed.
    const replaceArgs = [...mintArgs.map(argument => argument === 'David MacBook' ? 'Replacement Mac' : argument), '--replace-device', token.deviceId];
    expect(parseOperatorArgs(replaceArgs)).toMatchObject({ mode: 'device_code', replaceDevice: token.deviceId });
    saved.code = null;
    expect(await runOperatorPairing([...replaceArgs, '--execute'], deps)).toEqual({ exitCode: 0, message: 'Device code saved to private output. No code printed.' });
    const replaced = await f.request('POST', '/v1/pair/redeem', { body: { code: saved.code } });
    expect(replaced.statusCode).toBe(200);
    const next = pairRedeemResponseSchema.parse(f.json(replaced));
    expect((await f.request('GET', '/v1/diagnostics', { authorization: `Bearer ${token.deviceToken}` })).statusCode).toBe(401);
    const after = await f.request('GET', '/v1/diagnostics', { authorization: `Bearer ${next.deviceToken}` });
    expect(after.statusCode).toBe(200);
    // Both devices were created at the fixture's one instant, so the list's order between them is unspecified: check each by id.
    const listed = (f.json(after) as { devices: { deviceId: string; label: string; revokedAt: string | null }[] }).devices;
    expect(listed).toHaveLength(2);
    expect(listed.find(device => device.deviceId === token.deviceId)).toMatchObject({ revokedAt: expect.any(String) });
    expect(listed.find(device => device.deviceId === next.deviceId)).toMatchObject({ label: 'Replacement Mac', revokedAt: null });
  });

  it('redeems a minted code for a token once, refuses the same code, an expired code and the sixth counted failure in an hour, and records every attempt', async () => {
    // Minted at 12:50 so the hour boundary falls inside the codes' lifetime, as in the store-level scenario.
    const f = v1Fixture('2026-09-18T12:50:00.000Z');
    const minted = await f.devices.mintPairCode({ label: 'David MacBook', expiresInSeconds: 600 });
    const expired = await f.devices.mintPairCode({ label: 'Old code', expiresInSeconds: 60 });
    f.advance('2026-09-18T12:51:00.000Z');
    // One second between requests: same-instant attempts share a key prefix and the log promises no order among them.
    let second = 0;
    const redeem = (body: unknown, query?: string) => { f.advance(`2026-09-18T12:51:${String(++second).padStart(2, '0')}.000Z`); return f.request('POST', '/v1/pair/redeem', { body, query }); };
    const hour = hourOf('2026-09-18T12:51:00.000Z');

    const redeemed = await redeem({ code: minted.code });
    expect(redeemed.statusCode).toBe(200);
    const token = pairRedeemResponseSchema.parse(f.json(redeemed));
    expect(token.workspaceId).toBe('ws'); expect(token.deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(f.db.dump())).not.toContain(token.deviceToken);
    expect(JSON.stringify(f.db.dump())).not.toContain(minted.code);
    // The token works on the authenticated route straight away.
    expect((await f.request('GET', '/v1/diagnostics', { authorization: `Bearer ${token.deviceToken}` })).statusCode).toBe(200);

    const again = await redeem({ code: minted.code });
    expect(again.statusCode).toBe(400); expect(f.json(again)).toEqual({ error: 'pair_refused', reason: 'code_consumed' });
    const stale = await redeem({ code: expired.code });
    expect(stale.statusCode).toBe(400); expect(f.json(stale)).toEqual({ error: 'pair_refused', reason: 'code_expired' });
    expect(f.db.inspect(pairFailureCounterKey(hour))).toEqual({ count: 2 });
    // Malformed, schema-invalid and unknown codes are refused without touching the counter.
    const malformed = await redeem({ code: 'x' });
    expect(malformed.statusCode).toBe(400); expect(f.json(malformed)).toEqual({ error: 'pair_refused', reason: 'code_invalid' });
    const schema = await redeem({ code: unknownCode(), extra: true });
    expect(schema.statusCode).toBe(400); expect(f.json(schema)).toEqual({ error: 'invalid_request' });
    const unknown = await redeem({ code: unknownCode() });
    expect(unknown.statusCode).toBe(400); expect(f.json(unknown)).toEqual({ error: 'pair_refused', reason: 'code_unknown' });
    expect(f.db.inspect(pairFailureCounterKey(hour))).toEqual({ count: 2 });
    // Two more expired and one more consumed attempt make five.
    expect((await redeem({ code: expired.code })).statusCode).toBe(400);
    expect((await redeem({ code: expired.code })).statusCode).toBe(400);
    expect((await redeem({ code: minted.code })).statusCode).toBe(400);
    expect(f.db.inspect(pairFailureCounterKey(hour))).toEqual({ count: PAIR_FAILURE_LIMIT });
    const fresh = await f.devices.mintPairCode({ label: 'Second Mac', expiresInSeconds: 600 });
    const sixth = await redeem({ code: fresh.code });
    expect(sixth.statusCode).toBe(429); expect(f.json(sixth)).toEqual({ error: 'pair_refused', reason: 'too_many_failures' });
    expect(rows(f.db, DEVICE_PREFIX)).toHaveLength(1);
    // GET on the redeem path is not a route; a query string on it is refused by the handler's allowlist.
    expect((await f.request('GET', '/v1/pair/redeem')).statusCode).toBe(404);
    expect((await redeem({ code: fresh.code }, 'kind=tick')).statusCode).toBe(400);

    const attempts = await listAttempts(f.store, { kind: 'pairing' });
    expect(attempts.map(attempt => [attempt.outcome, attempt.reason])).toEqual([
      ['failed', 'too_many_failures'], ['failed', 'code_consumed'], ['failed', 'code_expired'], ['failed', 'code_expired'],
      ['failed', 'code_unknown'], ['failed', 'invalid_request'], ['failed', 'code_invalid'], ['failed', 'code_expired'], ['failed', 'code_consumed'], ['ok', null]]);
    expect(attempts.at(-1)).toMatchObject({ ref: token.deviceId, detail: { code: 'device_paired' } });
    // In the next hour the fresh code redeems.
    f.advance('2026-09-18T13:00:30.000Z');
    expect((await f.request('POST', '/v1/pair/redeem', { body: { code: fresh.code } })).statusCode).toBe(200);
  });

  it('fifty unknown codes are each refused as code_unknown, leave no COUNTER# item, and are each one pairing attempt', async () => {
    const f = v1Fixture();
    for (let attempt = 0; attempt < 50; attempt++) {
      f.advance(`2026-09-18T12:${String(Math.floor(attempt / 60)).padStart(2, '0')}:${String(attempt % 60).padStart(2, '0')}.000Z`);
      const response = await f.request('POST', '/v1/pair/redeem', { body: { code: unknownCode() } });
      expect(response.statusCode).toBe(400); expect(f.json(response)).toEqual({ error: 'pair_refused', reason: 'code_unknown' });
    }
    expect(rows(f.db, 'COUNTER#')).toEqual([]);
    expect(rows(f.db, PAIRCODE_PREFIX)).toEqual([]);
    expect(rows(f.db, 'ATTEMPT#')).toHaveLength(50);
    expect(await listAttempts(f.store, { kind: 'pairing' })).toHaveLength(20);
    // The hour never reached its limit, so a real code still redeems.
    const minted = await f.devices.mintPairCode({ label: 'David MacBook', expiresInSeconds: 600 });
    expect((await f.request('POST', '/v1/pair/redeem', { body: { code: minted.code } })).statusCode).toBe(200);
  });

  it('a paired device is refused ninety days later with the reason, on the view and on commands alike', async () => {
    const f = v1Fixture();
    const device = await f.pairDevice();
    f.advance('2026-12-17T11:59:59.999Z');
    expect((await f.request('GET', '/v1/diagnostics', { authorization: device.bearer })).statusCode).toBe(200);
    f.advance(START_PLUS_90_DAYS);
    const view = await f.request('GET', '/v1/diagnostics', { authorization: device.bearer });
    expect(view.statusCode).toBe(401); expect(f.json(view)).toEqual({ error: 'unauthenticated', reason: 'device_expired' });
    const command = await f.request('POST', '/v1/commands', { authorization: device.bearer, body: { commandId: '00000000-0000-4000-8000-000000000001', kind: 'revoke_device', deviceId: device.deviceId } });
    expect(command.statusCode).toBe(401); expect(f.json(command)).toEqual({ error: 'unauthenticated', reason: 'device_expired' });
    expect((await listAttempts(f.store, { kind: 'command' }))[0]).toMatchObject({ outcome: 'failed', reason: 'device_expired' });
    // A device paired today sees the expired one with the instant it expired.
    const fresh = await f.pairDevice('Fresh Mac');
    const devices = (f.json(await f.request('GET', '/v1/diagnostics', { authorization: fresh.bearer })) as { devices: { deviceId: string; expiresAt: string; revokedAt: string | null }[] }).devices;
    expect(devices).toEqual([
      expect.objectContaining({ deviceId: device.deviceId, expiresAt: START_PLUS_90_DAYS, revokedAt: null }),
      expect.objectContaining({ deviceId: fresh.deviceId, expiresAt: '2027-03-17T12:00:00.000Z', revokedAt: null }),
    ]);
  });
});
