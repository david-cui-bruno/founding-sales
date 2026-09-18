import { describe, expect, it } from 'vitest';
import { fixture, dispatchFixture } from './dispatchFixture';
import { dispatchCapPolicyKey } from '../src/dispatchRepository';
import { senderFirstSendKey } from '../src/remoteGoogleAuthorization';
import { SENDER_RAMP_DEFAULT } from '../../../../src/shared/contracts/workerPolicyContract';

const sender = 'sender@example.invalid';
const day = '2026-09-09';
const capKey = `DISPATCH_CAP#${encodeURIComponent(sender)}#${day}`;
const seedUsed = async (f: Awaited<ReturnType<typeof fixture>>, used: number) =>
  f.store.transact([f.store.put(capKey, { sender, day, used }, null)]);
const ramped = async (f: Awaited<ReturnType<typeof fixture>>) => f.policy.configureCaps({ sender, dailyLimit: 40, ramp: SENDER_RAMP_DEFAULT }, 1);
const plan = (f: Awaited<ReturnType<typeof fixture>>) => f.policy.reservationPlan({ ...f.intent.action, expectedVersion: 2 }, f.access.accessEvidence);

describe('sender cap ramp enforced where the flat cap is enforced', () => {
  it('records the first send day once and fences it on every later reservation', async () => {
    const f = await fixture(); await ramped(f);
    expect(f.dynamo.inspect(senderFirstSendKey(sender))).toBeUndefined();
    const items = (await plan(f)).finalize();
    const keys = items.map(item => item.ConditionCheck?.Key?.sk?.S ?? item.Put?.Item?.sk?.S);
    expect(keys).toContain(senderFirstSendKey(sender));
    expect(new Set(keys).size).toBe(keys.length);
    await f.store.transact(items);
    expect(f.dynamo.inspect(senderFirstSendKey(sender))).toEqual({ sender, firstSendAt: '2026-09-09T00:04:00.000Z' });
  });
  it('reads and fences the recorded anchor instead of writing a new one', async () => {
    const f = await fixture(); await ramped(f);
    await f.store.transact([f.store.put(senderFirstSendKey(sender), { sender, firstSendAt: '2026-09-06T00:00:00.000Z' }, null)]);
    const items = (await plan(f)).finalize();
    expect(items.filter(item => item.Put?.Item?.sk?.S === senderFirstSendKey(sender))).toEqual([]);
    expect(items.some(item => item.ConditionCheck?.Key?.sk?.S === senderFirstSendKey(sender))).toBe(true);
    await f.store.transact(items);
    expect(f.dynamo.inspect(senderFirstSendKey(sender))).toEqual({ sender, firstSendAt: '2026-09-06T00:00:00.000Z' });
  });
  it('holds at the start value on ramp day one and admits the reservation below it', async () => {
    const f = await fixture(); await ramped(f);
    await seedUsed(f, 10);
    await expect(plan(f)).rejects.toThrow('dispatch_cap_reached');
    const g = await fixture(); await ramped(g);
    await seedUsed(g, 9);
    expect((await plan(g)).finalize().length).toBeGreaterThan(0);
  });
  it('admits more once the recorded first send is calendar days old', async () => {
    const f = await fixture(); await ramped(f);
    await f.store.transact([f.store.put(senderFirstSendKey(sender), { sender, firstSendAt: '2026-09-06T00:00:00.000Z' }, null)]);
    await seedUsed(f, 15);
    expect((await plan(f)).finalize().length).toBeGreaterThan(0);
    const g = await fixture(); await ramped(g);
    await g.store.transact([g.store.put(senderFirstSendKey(sender), { sender, firstSendAt: '2026-09-06T00:00:00.000Z' }, null)]);
    await seedUsed(g, 16);
    await expect(plan(g)).rejects.toThrow('dispatch_cap_reached');
  });
  it('keeps the flat cap when the stored policy has no ramp', async () => {
    const f = await fixture();
    expect(f.dynamo.inspect(dispatchCapPolicyKey(sender))).toEqual({ sender, dailyLimit: 3 });
    await seedUsed(f, 3);
    await expect(plan(f)).rejects.toThrow('dispatch_cap_reached');
  });
});

describe('the worker-held grant is what sends and what reads replies', () => {
  it('holds with mailbox_not_connected instead of throwing when no grant is connected', async () => {
    const f = await dispatchFixture();
    const grantKey = `GOOGLE_GRANT#${f.intent.pairingId}`;
    const stored = (await f.store.get<Record<string, unknown>>(grantKey))!;
    await f.store.transact([f.store.put(grantKey, { grant: null, revoked: false, ciphertext: null }, stored.rev)]);
    const outcome = await f.service().dispatch(f.intent.commandId);
    expect(outcome).toEqual({ status: 'held', reason: 'mailbox_not_connected' });
    expect(f.sends()).toBe(0);
  });
  it('holds with mailbox_not_connected after the grant is revoked', async () => {
    const f = await dispatchFixture();
    const grantKey = `GOOGLE_GRANT#${f.intent.pairingId}`;
    const stored = (await f.store.get<Record<string, unknown>>(grantKey))!;
    await f.store.transact([f.store.put(grantKey, { ...stored.data, revoked: true, providerRevocation: 'confirmed' }, stored.rev)]);
    expect(await f.service().dispatch(f.intent.commandId)).toEqual({ status: 'held', reason: 'mailbox_not_connected' });
    expect(f.sends()).toBe(0);
  });
});
