import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { diagnosticsViewSchema, v1CommandReceiptSchema } from '../../../../../src/shared/contracts/v1Contract';
import { SOURCE_LAST_TICK_KEY } from '../../src/tickLog';
import { listAttempts, recordAttempt } from '../../src/v1/attempts';
import { v1CommandKey } from '../../src/v1/router';
import { v1Fixture } from './v1Fixture';

/**
 * The `/v1` diagnostics view and the one S0 command, on the real handler. A device reads what the worker
 * tried; a revoked device is refused on its very next request; a repeated command id is answered once.
 */
describe('/v1/diagnostics and /v1/commands on the real handler', () => {
  it('answers 401 without a token, 200 with a valid diagnosticsViewSchema body, 404 for unknown /v1 paths and 400 for a bad query', async () => {
    const f = v1Fixture();
    const anonymous = await f.request('GET', '/v1/diagnostics');
    expect(anonymous.statusCode).toBe(401); expect(f.json(anonymous)).toEqual({ error: 'unauthenticated' });
    const forged = await f.request('GET', '/v1/diagnostics', { authorization: `Bearer ${'x'.repeat(43)}` });
    expect(forged.statusCode).toBe(401);
    // A GET view never writes an attempt, not even a refused one.
    expect(await listAttempts(f.store, {})).toHaveLength(0);

    const device = await f.pairDevice();
    f.advance('2026-09-18T12:01:00.000Z');
    const view = await f.request('GET', '/v1/diagnostics', { authorization: device.bearer });
    expect(view.statusCode).toBe(200);
    expect(view.headers).toMatchObject({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    const body = diagnosticsViewSchema.parse(f.json(view));
    expect(body.asOf).toBe('2026-09-18T12:01:00.000Z');
    expect(body.lastTick).toBeNull();
    expect(body.devices).toEqual([{ deviceId: device.deviceId, label: 'David MacBook', createdAt: '2026-09-18T12:00:00.000Z', lastSeenAt: '2026-09-18T12:01:00.000Z', revokedAt: null }]);
    // The pairing itself is the first attempt the device can see; the token is nowhere in the view.
    expect(body.attempts).toEqual([{ at: '2026-09-18T12:00:00.000Z', kind: 'pairing', outcome: 'ok', reason: null, detail: 'device paired', durationMs: expect.any(Number), ref: device.deviceId }]);
    expect(view.body).not.toContain(device.deviceToken);

    // The last tick record, when one exists, is reduced to its instant, status and duration.
    await f.store.transact([f.store.put(SOURCE_LAST_TICK_KEY, { event: 'SCHEDULED_RUN_COMPLETED', version: 1, at: '2026-09-18T11:55:00.000Z', durationMs: 1234, status: 'completed', held: 0 }, null)]);
    const withTick = diagnosticsViewSchema.parse(f.json(await f.request('GET', '/v1/diagnostics', { authorization: device.bearer })));
    expect(withTick.lastTick).toEqual({ at: '2026-09-18T11:55:00.000Z', status: 'completed', durationMs: 1234 });

    // kind and limit are honoured; anything else on the query is refused before the router runs.
    for (let index = 0; index < 8; index++) {
      f.advance(`2026-09-18T12:${String(10 + index).padStart(2, '0')}:00.000Z`);
      await recordAttempt(f.store, { kind: index % 2 ? 'tick_phase' : 'tick', outcome: 'ok', reason: null, detail: `n${index}`, durationMs: null, ref: null });
    }
    const limited = diagnosticsViewSchema.parse(f.json(await f.request('GET', '/v1/diagnostics', { authorization: device.bearer, query: 'limit=5' })));
    expect(limited.attempts.map(attempt => attempt.detail)).toEqual(['n7', 'n6', 'n5', 'n4', 'n3']);
    const filtered = diagnosticsViewSchema.parse(f.json(await f.request('GET', '/v1/diagnostics', { authorization: device.bearer, query: 'kind=tick_phase&limit=3' })));
    expect(filtered.attempts.map(attempt => attempt.detail)).toEqual(['n7', 'n5', 'n3']);
    expect((await f.request('GET', '/v1/diagnostics', { authorization: device.bearer, query: 'kind=nonsense' })).statusCode).toBe(400);
    expect(f.json(await f.request('GET', '/v1/diagnostics', { authorization: device.bearer, query: 'limit=0' }))).toEqual({ error: 'invalid_request' });
    expect((await f.request('GET', '/v1/diagnostics', { authorization: device.bearer, query: 'cursor=1' })).statusCode).toBe(400);

    expect((await f.request('POST', '/v1/diagnostics', { authorization: device.bearer, body: {} })).statusCode).toBe(404);
    const unknown = await f.request('GET', '/v1/nothing-here', { authorization: device.bearer });
    expect(unknown.statusCode).toBe(404); expect(f.json(unknown)).toEqual({ error: 'not_found' });
  });

  it('revokes a device through /v1/commands so its next request is 401, answers a repeated commandId with duplicate, and refuses a conflicting reuse', async () => {
    const f = v1Fixture();
    const first = await f.pairDevice('First Mac');
    f.advance('2026-09-18T12:00:30.000Z');
    const second = await f.pairDevice('Second Mac');
    f.advance('2026-09-18T12:02:00.000Z');

    expect((await f.request('POST', '/v1/commands', { body: { commandId: randomUUID(), kind: 'revoke_device', deviceId: second.deviceId } })).statusCode).toBe(401);
    const malformed = await f.request('POST', '/v1/commands', { authorization: first.bearer, body: { commandId: randomUUID(), kind: 'pause' } });
    expect(malformed.statusCode).toBe(400); expect(f.json(malformed)).toEqual({ error: 'invalid_request' });
    expect((await f.request('POST', '/v1/commands', { authorization: first.bearer, body: '{not json' })).statusCode).toBe(400);
    expect((await f.request('POST', '/v1/commands', { authorization: first.bearer, body: { commandId: randomUUID(), kind: 'revoke_device', deviceId: second.deviceId, extra: 1 } })).statusCode).toBe(400);

    const commandId = randomUUID();
    const applied = await f.request('POST', '/v1/commands', { authorization: first.bearer, body: { commandId, kind: 'revoke_device', deviceId: second.deviceId } });
    expect(applied.statusCode).toBe(200);
    expect(v1CommandReceiptSchema.parse(f.json(applied))).toEqual({ commandId, outcome: 'applied', reason: null });
    expect(f.db.inspect(v1CommandKey(commandId))).toMatchObject({ kind: 'revoke_device', receipt: { outcome: 'applied' }, deviceId: first.deviceId });

    // The revoked device is refused on its very next request; the revoking device still reads.
    const refused = await f.request('GET', '/v1/diagnostics', { authorization: second.bearer });
    expect(refused.statusCode).toBe(401);
    const view = diagnosticsViewSchema.parse(f.json(await f.request('GET', '/v1/diagnostics', { authorization: first.bearer })));
    expect(view.devices.map(device => [device.label, device.revokedAt])).toEqual([['First Mac', null], ['Second Mac', '2026-09-18T12:02:00.000Z']]);

    // The same commandId again is answered from the receipt, with the first answer's outcome, and writes no second receipt.
    const duplicate = await f.request('POST', '/v1/commands', { authorization: first.bearer, body: { commandId, kind: 'revoke_device', deviceId: second.deviceId } });
    expect(v1CommandReceiptSchema.parse(f.json(duplicate))).toEqual({ commandId, outcome: 'duplicate', reason: 'applied' });
    expect(f.db.dump().filter(item => item.sk!.S!.startsWith('V1COMMAND#'))).toHaveLength(1);
    // The same commandId with a different payload is a conflict, never a second application.
    const conflict = await f.request('POST', '/v1/commands', { authorization: first.bearer, body: { commandId, kind: 'revoke_device', deviceId: first.deviceId } });
    expect(f.json(conflict)).toEqual({ commandId, outcome: 'refused', reason: 'command_conflict' });
    expect((await f.request('GET', '/v1/diagnostics', { authorization: first.bearer })).statusCode).toBe(200);

    // Revoking an unknown or already revoked device is refused with the reason, and the refusal is itself a receipt.
    const unknownId = randomUUID();
    const unknown = await f.request('POST', '/v1/commands', { authorization: first.bearer, body: { commandId: unknownId, kind: 'revoke_device', deviceId: randomUUID() } });
    expect(f.json(unknown)).toEqual({ commandId: unknownId, outcome: 'refused', reason: 'device_unknown' });
    expect(f.json(await f.request('POST', '/v1/commands', { authorization: first.bearer, body: { commandId: unknownId, kind: 'revoke_device', deviceId: randomUUID() } }))).toMatchObject({ outcome: 'refused', reason: 'command_conflict' });
    const againId = randomUUID();
    expect(f.json(await f.request('POST', '/v1/commands', { authorization: first.bearer, body: { commandId: againId, kind: 'revoke_device', deviceId: second.deviceId } }))).toEqual({ commandId: againId, outcome: 'refused', reason: 'device_revoked' });
    expect(f.json(await f.request('POST', '/v1/commands', { authorization: first.bearer, body: { commandId: againId, kind: 'revoke_device', deviceId: second.deviceId } }))).toEqual({ commandId: againId, outcome: 'duplicate', reason: 'device_revoked' });

    // Every /v1/commands request left exactly one command attempt with the command id as its ref and no token anywhere.
    // The clock stood still for all of them, and the log promises no order among same-instant attempts, so compare the multiset.
    const attempts = await listAttempts(f.store, { kind: 'command' });
    const sorted = (rows: (string | null)[][]) => rows.map(row => row.join(':')).sort();
    expect(sorted(attempts.map(attempt => [attempt.outcome, attempt.reason]))).toEqual(sorted([
      ['ok', 'duplicate'], ['failed', 'device_revoked'], ['failed', 'command_conflict'], ['failed', 'device_unknown'], ['failed', 'command_conflict'], ['ok', 'duplicate'], ['ok', null],
      ['failed', 'invalid_request'], ['failed', 'invalid_request'], ['failed', 'invalid_request'], ['failed', 'unauthenticated']]));
    expect(attempts.filter(attempt => attempt.reason === null)[0]).toMatchObject({ ref: commandId, detail: 'kind=revoke_device' });
    const dump = JSON.stringify(f.db.dump());
    expect(dump).not.toContain(first.deviceToken); expect(dump).not.toContain(second.deviceToken);

    // A device may revoke itself; from then on it is 401 like any other credential.
    const selfId = randomUUID();
    expect(f.json(await f.request('POST', '/v1/commands', { authorization: first.bearer, body: { commandId: selfId, kind: 'revoke_device', deviceId: first.deviceId } }))).toEqual({ commandId: selfId, outcome: 'applied', reason: null });
    expect((await f.request('GET', '/v1/diagnostics', { authorization: first.bearer })).statusCode).toBe(401);
  });
});
