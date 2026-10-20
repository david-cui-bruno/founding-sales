import { describe, expect, it } from 'vitest';
import { createPhoneHandoff } from '../src/main/phoneHandoff.ts';
import { createAuthedClient } from '../src/main/authedClient.ts';
import type { DialHandoff } from '../src/main/dialHandoff.ts';
import { NATIONAL_DNC_UNCHECKED_WARNING } from '@fss/contracts';
const firmId = '22222222-2222-4222-8222-222222222222';
const routeId = '33333333-3333-4333-8333-333333333333';
const attemptId = '44444444-4444-4444-8444-444444444444';
const e164 = '+14015550123';
const target = { firmId, routeId, routeVersion: 1, e164 };
const now = Date.parse('2026-10-19T14:00:00Z');
const fresh = { attemptId, firmId, routeId, reservedAt: new Date(now).toISOString(), expiresAt: new Date(now + 15000).toISOString(),
  actionable: true, e164, telUri: `tel:${e164}`, validForMilliseconds: 15000 };
function fixture(options: { delay?: number; wall?: number; replay?: boolean; offlineFirst?: boolean; errorStatus?: number; malformedFirst?: boolean; throws?: boolean; invalid?: boolean; riskReceipt?: string } = {}) {
  const bodies: Record<string, unknown>[] = [];
  const opened: unknown[] = [];
  let ticks = 0;
  const api = createAuthedClient({ baseUrl: 'https://fixture.invalid', clientVersion: '1.0.0', accessToken: async () => ({ token: 'fixture', generation: 1 }),
    send: async (_url, init) => {
      bodies.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>);
      ticks += options.delay ?? 0;
      if (options.offlineFirst && bodies.length === 1) throw new Error('lost answer');
      if (options.errorStatus && bodies.length === 1) return { status: options.errorStatus, body: { error: 'fixture_http_failure' } };
      if (options.malformedFirst && bodies.length === 1) return { status: 200, body: { result: fresh } };
      const replay = options.replay || ((options.offlineFirst || options.errorStatus || options.malformedFirst) && bodies.length > 1);
      const result = options.riskReceipt ? { ...fresh, nationalDnc: { status: 'not_checked_owner_risk', basis: 'owner_self_test',
        receiptId: options.riskReceipt, warning: NATIONAL_DNC_UNCHECKED_WARNING } } : fresh;
      return { status: 200, body: { status: 'accepted', replayed: replay, result: options.invalid ? { ...result, telUri: 'tel:+14015550199' } : replay
        ? { ...fresh, actionable: false, e164: null, telUri: null, validForMilliseconds: 0, reason: 'handoff_reconciliation_required' } : result } };
    } });
  const handoff: DialHandoff = { checkSetup: async () => ({ ready: true }), open: async value => {
    opened.push(value); if (options.throws) throw new Error('unknown OS dispatch'); return { status: 'opened', e164 };
  } };
  const bridge = createPhoneHandoff({ api, handoff, monotonic: () => ticks, wallNow: () => options.wall ?? now });
  return { bridge, opened, bodies };
}
describe('durable phone-app launch gate', () => {
  it('opens owner-risk only when response repeats the exact receipt displayed before click', async () => {
    const receiptId = '55555555-5555-4555-8555-555555555555';
    const value = fixture({ riskReceipt: receiptId });
    expect((await value.bridge.dispatch({ ...target, expectedNationalDncReceiptId: receiptId }, () => true)).notice).toBe('dial_opened');
    expect(value.bodies[0]?.['expectedNationalDncReceiptId']).toBe(receiptId);
    expect(value.opened).toHaveLength(1);
    for (const expected of [undefined, null, attemptId]) {
      const blocked = fixture({ riskReceipt: receiptId });
      expect((await blocked.bridge.dispatch({ ...target, ...(expected === undefined ? {} : { expectedNationalDncReceiptId: expected }) }, () => true)).notice).toBe('handoff_reconciliation_required');
      expect(blocked.opened).toHaveLength(0);
    }
    const legacy = fixture();
    expect((await legacy.bridge.dispatch({ ...target, expectedNationalDncReceiptId: receiptId }, () => true)).notice).toBe('handoff_reconciliation_required');
    expect(legacy.opened).toHaveLength(0);
  });
  it('pins the originally displayed receipt across ambiguous answer retries rather than rebinding a command', async () => {
    const receiptId = '55555555-5555-4555-8555-555555555555';
    const value = fixture({ offlineFirst: true, riskReceipt: receiptId });
    await value.bridge.dispatch({ ...target, expectedNationalDncReceiptId: receiptId }, () => true);
    await value.bridge.dispatch({ ...target, expectedNationalDncReceiptId: attemptId }, () => true);
    expect(value.bodies.map(body => body['expectedNationalDncReceiptId'])).toEqual([receiptId, receiptId]);
    expect(value.opened).toHaveLength(0);
  });
  it('opens exactly once using a parsed fresh server grant, never a local endpoint alone', async () => {
    const f = fixture();
    expect(await f.bridge.dispatch(target, () => true)).toEqual({ notice: 'dial_opened', attemptId });
    expect(f.opened).toEqual([{ e164, telUri: `tel:${e164}` }]);
    expect(await f.bridge.dispatch(target, () => true)).toEqual({ notice: 'handoff_reconciliation_required', attemptId });
    expect(f.opened).toHaveLength(1);
    expect(f.bodies[0]?.['commandId']).toBe(f.bodies[1]?.['commandId']);
    expect(f.bodies[0]).toMatchObject({ firmId, routeId, routeVersion: 1 });
    expect(f.bodies[0]).not.toHaveProperty('expectedNationalDncReceiptId');
  });
  it.each([{ delay: 15000 }, { delay: 20000, wall: now - 60000 }, { wall: now + 15000 }, { replay: true }, { invalid: true }])('fails closed for expired, slow, rollback, replay or malformed answer %j', async options => {
    const f = fixture(options);
    expect((await f.bridge.dispatch(target, () => true)).notice).toBe('handoff_reconciliation_required');
    expect(f.opened).toHaveLength(0);
  });
  it.each([{ offlineFirst: true }, { errorStatus: 500 }, { errorStatus: 404 }, { malformedFirst: true }])('ambiguous answer %j explicitly reconciles the same command and never opens the replay', async options => {
    const f = fixture(options);
    expect((await f.bridge.dispatch(target, () => true)).notice).toBe('handoff_reconciliation_required');
    expect(await f.bridge.dispatch(target, () => true)).toEqual({ notice: 'handoff_reconciliation_required', attemptId });
    expect(f.bodies[0]?.['commandId']).toBe(f.bodies[1]?.['commandId']);
    expect(f.opened).toHaveLength(0);
  });
  it('a thrown launch remains used and unknown rather than becoming retryable', async () => {
    const f = fixture({ throws: true });
    expect(await f.bridge.dispatch(target, () => true)).toEqual({ notice: 'dial_opened_unknown', attemptId });
    expect((await f.bridge.dispatch(target, () => true)).notice).toBe('handoff_reconciliation_required');
    expect(f.opened).toHaveLength(1);
  });
  it('never opens after a stale window or wrong endpoint answer', async () => {
    const f = fixture();
    expect((await f.bridge.dispatch(target, () => false)).notice).toBe('handoff_reconciliation_required');
    expect(f.bodies).toHaveLength(0);
    expect((await f.bridge.dispatch({ ...target, e164: '+14015550199' }, () => true)).notice).toBe('handoff_reconciliation_required');
    expect(f.opened).toHaveLength(0);
  });
});
