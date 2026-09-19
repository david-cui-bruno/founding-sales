import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { diagnosticsViewSchema, v1CommandReceiptSchema } from '../../../../../src/shared/contracts/v1Contract';
import { SOURCE_LAST_TICK_KEY } from '../../src/tickLog';
import { listAttempts, recordAttempt } from '../../src/v1/attempts';
import { v1CommandKey } from '../../src/v1/router';
import { v1Fixture } from './v1Fixture';

/**
 * The `/v1` diagnostics view and the one S0 command, on the real handler. A device reads what the worker
 * tried; a revoked device is refused on its very next request, or mid-request if the revocation lands while
 * its command is in flight; a repeated command id is answered once, and only to the device that issued it.
 */
const START_PLUS_90_DAYS = '2026-12-17T12:00:00.000Z';

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
    expect(body.devices).toEqual([{ deviceId: device.deviceId, label: 'David MacBook', createdAt: '2026-09-18T12:00:00.000Z', lastSeenAt: '2026-09-18T12:01:00.000Z', revokedAt: null, expiresAt: START_PLUS_90_DAYS }]);
    // The pairing itself is the first attempt the device can see; the token is nowhere in the view.
    expect(body.attempts).toEqual([{ at: '2026-09-18T12:00:00.000Z', kind: 'pairing', outcome: 'ok', reason: null, detail: { code: 'device_paired' }, durationMs: expect.any(Number), ref: device.deviceId }]);
    expect(view.body).not.toContain(device.deviceToken);

    // The last tick record, when one exists, is reduced to its instant, status and duration.
    await f.store.transact([f.store.put(SOURCE_LAST_TICK_KEY, { event: 'SCHEDULED_RUN_COMPLETED', version: 1, at: '2026-09-18T11:55:00.000Z', durationMs: 1234, status: 'completed', held: 0 }, null)]);
    const withTick = diagnosticsViewSchema.parse(f.json(await f.request('GET', '/v1/diagnostics', { authorization: device.bearer })));
    expect(withTick.lastTick).toEqual({ at: '2026-09-18T11:55:00.000Z', status: 'completed', durationMs: 1234 });

    // kind and limit are honoured; anything else on the query is refused before the router runs.
    for (let index = 0; index < 8; index++) {
      f.advance(`2026-09-18T12:${String(10 + index).padStart(2, '0')}:00.000Z`);
      await recordAttempt(f.store, { kind: index % 2 ? 'tick_phase' : 'tick', outcome: 'ok', reason: null, detail: { code: 'sample', count: index }, durationMs: null, ref: null });
    }
    const limited = diagnosticsViewSchema.parse(f.json(await f.request('GET', '/v1/diagnostics', { authorization: device.bearer, query: 'limit=5' })));
    expect(limited.attempts.map(attempt => attempt.detail?.count)).toEqual([7, 6, 5, 4, 3]);
    const filtered = diagnosticsViewSchema.parse(f.json(await f.request('GET', '/v1/diagnostics', { authorization: device.bearer, query: 'kind=tick_phase&limit=3' })));
    expect(filtered.attempts.map(attempt => attempt.detail?.count)).toEqual([7, 5, 3]);
    expect((await f.request('GET', '/v1/diagnostics', { authorization: device.bearer, query: 'kind=nonsense' })).statusCode).toBe(400);
    expect(f.json(await f.request('GET', '/v1/diagnostics', { authorization: device.bearer, query: 'limit=0' }))).toEqual({ error: 'invalid_request' });
    expect((await f.request('GET', '/v1/diagnostics', { authorization: device.bearer, query: 'cursor=1' })).statusCode).toBe(400);

    expect((await f.request('POST', '/v1/diagnostics', { authorization: device.bearer, body: {} })).statusCode).toBe(404);
    const unknown = await f.request('GET', '/v1/nothing-here', { authorization: device.bearer });
    expect(unknown.statusCode).toBe(404); expect(f.json(unknown)).toEqual({ error: 'not_found' });
  });

  it('revokes a device through /v1/commands so its next request is 401, answers a repeated commandId with duplicate to its own device only, and refuses a conflicting reuse', async () => {
    const f = v1Fixture();
    const first = await f.pairDevice('First Mac');
    f.advance('2026-09-18T12:00:30.000Z');
    const second = await f.pairDevice('Second Mac');
    f.advance('2026-09-18T12:01:00.000Z');
    const third = await f.pairDevice('Third Mac');
    f.advance('2026-09-18T12:02:00.000Z');

    expect((await f.request('POST', '/v1/commands', { body: { commandId: randomUUID(), kind: 'revoke_device', deviceId: second.deviceId } })).statusCode).toBe(401);
    const malformed = await f.request('POST', '/v1/commands', { authorization: first.bearer, body: { commandId: randomUUID(), kind: 'pause' } });
    expect(malformed.statusCode).toBe(400); expect(f.json(malformed)).toEqual({ error: 'invalid_request' });
    expect((await f.request('POST', '/v1/commands', { authorization: first.bearer, body: '{not json' })).statusCode).toBe(400);
    expect((await f.request('POST', '/v1/commands', { authorization: first.bearer, body: { commandId: randomUUID(), kind: 'revoke_device', deviceId: second.deviceId, extra: 1 } })).statusCode).toBe(400);
    // A command id is a UUID v4, not any UUID.
    const v1Id = await f.request('POST', '/v1/commands', { authorization: first.bearer, body: { commandId: '11111111-1111-1111-1111-111111111111', kind: 'revoke_device', deviceId: second.deviceId } });
    expect(v1Id.statusCode).toBe(400); expect(f.json(v1Id)).toEqual({ error: 'invalid_request' });

    const commandId = randomUUID();
    const applied = await f.request('POST', '/v1/commands', { authorization: first.bearer, body: { commandId, kind: 'revoke_device', deviceId: second.deviceId } });
    expect(applied.statusCode).toBe(200);
    expect(v1CommandReceiptSchema.parse(f.json(applied))).toEqual({ commandId, outcome: 'applied', reason: null });
    expect(f.db.inspect(v1CommandKey(commandId))).toMatchObject({ kind: 'revoke_device', receipt: { outcome: 'applied' }, deviceId: first.deviceId });

    // The revoked device is refused on its very next request; the revoking device still reads.
    const refused = await f.request('GET', '/v1/diagnostics', { authorization: second.bearer });
    expect(refused.statusCode).toBe(401);
    const view = diagnosticsViewSchema.parse(f.json(await f.request('GET', '/v1/diagnostics', { authorization: first.bearer })));
    expect(view.devices.map(device => [device.label, device.revokedAt])).toEqual([['First Mac', null], ['Second Mac', '2026-09-18T12:02:00.000Z'], ['Third Mac', null]]);

    // The same commandId again from the same device is answered from the receipt, with the first answer's outcome, and writes no second receipt.
    const duplicate = await f.request('POST', '/v1/commands', { authorization: first.bearer, body: { commandId, kind: 'revoke_device', deviceId: second.deviceId } });
    expect(v1CommandReceiptSchema.parse(f.json(duplicate))).toEqual({ commandId, outcome: 'duplicate', reason: 'applied' });
    expect(f.db.dump().filter(item => item.sk!.S!.startsWith('V1COMMAND#'))).toHaveLength(1);
    // Receipts are per device: the same commandId and payload from another device is a conflict, never a replay.
    const foreign = await f.request('POST', '/v1/commands', { authorization: third.bearer, body: { commandId, kind: 'revoke_device', deviceId: second.deviceId } });
    expect(f.json(foreign)).toEqual({ commandId, outcome: 'refused', reason: 'command_conflict' });
    // The same commandId with a different payload is a conflict, never a second application.
    const conflict = await f.request('POST', '/v1/commands', { authorization: first.bearer, body: { commandId, kind: 'revoke_device', deviceId: first.deviceId } });
    expect(f.json(conflict)).toEqual({ commandId, outcome: 'refused', reason: 'command_conflict' });
    expect((await f.request('GET', '/v1/diagnostics', { authorization: first.bearer })).statusCode).toBe(200);
    expect((await f.request('GET', '/v1/diagnostics', { authorization: third.bearer })).statusCode).toBe(200);

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
      ['ok', 'duplicate'], ['failed', 'device_revoked'], ['failed', 'command_conflict'], ['failed', 'device_unknown'], ['failed', 'command_conflict'], ['failed', 'command_conflict'], ['ok', 'duplicate'], ['ok', null],
      ['failed', 'invalid_request'], ['failed', 'invalid_request'], ['failed', 'invalid_request'], ['failed', 'invalid_request'], ['failed', 'unauthenticated']]));
    expect(attempts.filter(attempt => attempt.reason === null)[0]).toMatchObject({ ref: commandId, detail: { code: 'revoke_device', commandId } });
    const dump = JSON.stringify(f.db.dump());
    expect(dump).not.toContain(first.deviceToken); expect(dump).not.toContain(second.deviceToken); expect(dump).not.toContain(third.deviceToken);

    // A device may revoke itself; from then on it is 401 like any other credential.
    const selfId = randomUUID();
    expect(f.json(await f.request('POST', '/v1/commands', { authorization: first.bearer, body: { commandId: selfId, kind: 'revoke_device', deviceId: first.deviceId } }))).toEqual({ commandId: selfId, outcome: 'applied', reason: null });
    expect((await f.request('GET', '/v1/diagnostics', { authorization: first.bearer })).statusCode).toBe(401);
  });

  it('a revocation from another device while a command is in flight refuses that command: the transaction checks the caller is still active', async () => {
    const f = v1Fixture();
    const a = await f.pairDevice('A');
    f.advance('2026-09-18T12:00:10.000Z');
    const b = await f.pairDevice('B');
    f.advance('2026-09-18T12:00:20.000Z');
    const c = await f.pairDevice('C');
    f.advance('2026-09-18T12:01:00.000Z');
    const bCommandId = randomUUID(); let fired = false; let revokeStatus = 0;
    f.onTransaction(async items => {
      if (fired || !items.some(item => item.Put?.Item?.sk?.S === v1CommandKey(bCommandId))) return;
      fired = true;
      // A revokes B after B authenticated and before B's command commits, exactly as a second client would.
      revokeStatus = (await f.request('POST', '/v1/commands', { authorization: a.bearer, body: { commandId: randomUUID(), kind: 'revoke_device', deviceId: b.deviceId } })).statusCode;
    });
    const response = await f.request('POST', '/v1/commands', { authorization: b.bearer, body: { commandId: bCommandId, kind: 'revoke_device', deviceId: c.deviceId } });
    f.onTransaction(null);
    expect(fired).toBe(true); expect(revokeStatus).toBe(200);
    expect(response.statusCode).toBe(401); expect(f.json(response)).toEqual({ error: 'unauthenticated' });
    // B's write never landed: no receipt under B's command id, C is untouched, and B is out.
    expect(f.db.inspect(v1CommandKey(bCommandId))).toBeUndefined();
    expect((await f.request('GET', '/v1/diagnostics', { authorization: c.bearer })).statusCode).toBe(200);
    expect((await f.request('GET', '/v1/diagnostics', { authorization: b.bearer })).statusCode).toBe(401);
    // The refused transaction carried the check on B's own DEVICE# row, beside the receipt and the revocation it tried to write.
    const attempted = f.db.transactions.find(transaction => transaction.TransactItems?.some(item => item.Put?.Item?.sk?.S === v1CommandKey(bCommandId)))!;
    const check = attempted.TransactItems!.find(item => item.ConditionCheck?.Key?.sk?.S?.startsWith('DEVICE#'))!;
    expect(check.ConditionCheck!.ConditionExpression).toContain('attribute_not_exists(#revokedAt)');
    expect((await listAttempts(f.store, { kind: 'command' })).find(attempt => attempt.ref === bCommandId)).toMatchObject({ outcome: 'failed', reason: 'unauthenticated', detail: { code: 'unauthenticated', commandId: bCommandId } });
  });
});
