import { describe, expect, it } from 'vitest';
import { phoneHandoffResultSchema, reservePhoneHandoffCommandSchema } from '../src/phoneHandoff.ts';

const id = '11111111-1111-4111-8111-111111111111';
const binding = { attemptId: id, firmId: id, routeId: id, reservedAt: '2026-10-19T16:00:00.000Z', expiresAt: '2026-10-19T16:00:15.000Z' };
const fresh = { ...binding, actionable: true, e164: '+14015550187', telUri: 'tel:+14015550187', validForMilliseconds: 15_000 };

describe('durable phone handoff wire boundary', () => {
  it('accepts exactly one bounded fresh endpoint', () => {
    expect(phoneHandoffResultSchema.parse(fresh)).toEqual(fresh);
  });
  it.each([
    { telUri: 'tel:+14015550188' },
    { validForMilliseconds: 15_001 },
    { expiresAt: '2026-10-19T16:00:16.000Z' },
    { expiresAt: binding.reservedAt },
    { expiresAt: '2026-10-19T16:00:01.000Z', validForMilliseconds: 1001 },
  ])('rejects mismatched or overlong dispatch authority %j', patch => {
    expect(phoneHandoffResultSchema.safeParse({ ...fresh, ...patch }).success).toBe(false);
  });
  it('reconciles erased identity without restoring an endpoint', () => {
    const replay = { ...binding, routeId: null, actionable: false, e164: null, telUri: null, validForMilliseconds: 0, reason: 'handoff_reconciliation_required' };
    expect(phoneHandoffResultSchema.parse(replay)).toEqual(replay);
    expect(phoneHandoffResultSchema.safeParse({ ...replay, telUri: fresh.telUri }).success).toBe(false);
    expect(phoneHandoffResultSchema.safeParse({ ...replay, e164: fresh.e164 }).success).toBe(false);
  });
  it('takes actor and device only from authenticated server context', () => {
    const request = { commandId: 'handoff:1', clientVersion: '1.0.55', firmId: id, routeId: id, routeVersion: 1 };
    expect(reservePhoneHandoffCommandSchema.safeParse(request).success).toBe(true);
    for (const patch of [{ actorUserId: id }, { deviceId: id }, { itemId: 'not-a-uuid' }, { routeVersion: 0 }]) {
      expect(reservePhoneHandoffCommandSchema.safeParse({ ...request, ...patch }).success).toBe(false);
    }
  });
});
