import { describe, expect, it } from 'vitest';
import { ConditionalCommandHarness } from './sdkHarness';
import { WorkerAuth } from '../src/workerAuth';
import { RemoteGoogleAuthorization } from '../src/remoteGoogleAuthorization';
import { OwnerCommandCoordinator } from '../src/ownerCommandCoordinator';
import { TerritoryPolicyRepository, replyTemplateStateKey } from '../src/territoryPolicyRepository';
import { DynamoStore } from '../src/dynamoStore';
import { replyTemplateCommandSchema, type ReplyTemplateCommand } from '../../../../src/shared/contracts/ownerCommandContract';
import { decideTemplateEmailStep, replyTemplateContentHash, REPLY_TEMPLATE_SUBJECT, type ReplyTemplateCommandPayload,
  type WorkerReplyTemplateState } from '../../../../src/shared/contracts/replyTemplateContract';
import { REPLY_TEMPLATE_SEEDS, REPLY_TEMPLATE_SEED_HASHES } from '../../../../src/main/outreach/templates/replyTemplateSeeds';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-09-18T12:00:00.000Z';
const seed = (id: 'T1' | 'T2' | 'T3' | 'T4' | 'T5') => REPLY_TEMPLATE_SEEDS.find(entry => entry.id === id)!;
const approvePayload = (id: 'T1' | 'T2' | 'T3' | 'T4' | 'T5'): ReplyTemplateCommandPayload =>
  ({ kind: 'template-approve', templateId: id, revision: 1, subject: seed(id).subject, body: seed(id).body, contentHash: REPLY_TEMPLATE_SEED_HASHES[id] });

async function fixture() {
  const dynamo = new ConditionalCommandHarness();
  const options = { dynamo, tableName: 'fictional-templates', workspaceId: 'ws', clock: { now: () => now } };
  const auth = new WorkerAuth(options);
  const issued = await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 });
  const pairing = await auth.redeemPairing(issued.code, 'fictional');
  const bearer = `Bearer ${pairing.credential}`;
  const coordinator = new OwnerCommandCoordinator({ auth, authorization: new RemoteGoogleAuthorization({ auth }) });
  const store = new DynamoStore(options);
  const repository = new TerritoryPolicyRepository(options);
  let commands = 0;
  const command = (payload: ReplyTemplateCommandPayload, id = uuid(++commands)): ReplyTemplateCommand =>
    replyTemplateCommandSchema.parse({ commandId: id, workspaceId: 'ws', accountId: REPLY_TEMPLATE_SUBJECT,
      expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'reply-template', payload });
  const apply = (payload: ReplyTemplateCommandPayload, id?: string) => coordinator.apply(command(payload, id), bearer);
  const state = async (): Promise<WorkerReplyTemplateState | null> => (await repository.readTemplateState())?.data ?? null;
  return { dynamo, options, auth, pairing, bearer, coordinator, store, repository, apply, command, state };
}

describe('standing template approvals on the worker', () => {
  it('records one approval per template with the exact text and hash, replays by command id, and never writes authority or an event', async () => {
    const f = await fixture();
    expect(await f.state()).toBeNull();
    const receipt = await f.apply(approvePayload('T4'), uuid(10));
    expect(receipt).toEqual({ commandId: uuid(10), status: 'applied', authorityGeneration: 0, aggregateVersion: 1, reason: null });
    const stored = await f.state();
    expect(stored).toEqual({ paused: false, updatedAt: now, approvals: [{ templateId: 'T4', revision: 1, subject: seed('T4').subject,
      body: seed('T4').body, contentHash: REPLY_TEMPLATE_SEED_HASHES.T4, approvedAt: now, commandId: uuid(10) }] });
    // Approving is never a send and never an authority grant: only the one workspace record moved.
    expect(await f.store.get('AUTH#ws')).toBeNull();
    const keys = f.dynamo.transactions.flatMap(transaction => (transaction.TransactItems ?? [])
      .map(item => item.Put?.Item?.sk?.S ?? item.ConditionCheck?.Key?.sk?.S ?? ''));
    expect(keys.filter(key => key.startsWith('EVENT#') || key.startsWith('OUTBOX#'))).toEqual([]);
    expect(keys.filter(key => key.startsWith('REPLY_TEMPLATE_STATE#'))).toHaveLength(1);

    const transactions = f.dynamo.transactions.length;
    expect(await f.apply(approvePayload('T4'), uuid(10))).toEqual(receipt);
    expect(f.dynamo.transactions).toHaveLength(transactions);
    await expect(f.apply(approvePayload('T5'), uuid(10))).rejects.toThrow('command_fingerprint_conflict');

    await f.apply(approvePayload('T5'));
    expect((await f.state())!.approvals.map(approval => approval.templateId)).toEqual(['T4', 'T5']);
    // A second, identical approval of an already approved template is a read, not a second write.
    const settled = f.dynamo.transactions.length;
    expect(await f.apply(approvePayload('T4'))).toMatchObject({ status: 'applied' });
    expect(f.dynamo.transactions.length).toBeGreaterThan(settled);
    expect((await f.state())!.approvals).toHaveLength(2);
  });

  it('refuses a template-approve whose hash does not match the text it carries, before the command is stored', async () => {
    const f = await fixture();
    const forged = { ...approvePayload('T4'), contentHash: REPLY_TEMPLATE_SEED_HASHES.T5 };
    expect(() => f.command(forged as ReplyTemplateCommandPayload)).toThrow();
    // A body that breaks a rule is refused by the same schema, so the worker never stores unapproved-shaped text.
    expect(() => f.command({ kind: 'template-approve', templateId: 'T4', revision: 1, subject: 'Hi {firm}',
      body: 'Callie answers the phone.', contentHash: replyTemplateContentHash({ id: 'T4', revision: 1, subject: 'Hi {firm}', body: 'Callie answers the phone.' }) })).toThrow();
    expect(await f.state()).toBeNull();
    expect(await f.store.get(replyTemplateStateKey('ws'))).toBeNull();
  });

  it('revokes only the named revision and pauses the workspace once', async () => {
    const f = await fixture();
    await f.apply(approvePayload('T4'));
    expect(await f.apply({ kind: 'template-revoke', templateId: 'T4', revision: 2 })).toMatchObject({ status: 'rejected', reason: 'template_not_approved' });
    expect((await f.state())!.approvals).toHaveLength(1);
    expect(await f.apply({ kind: 'template-revoke', templateId: 'T4', revision: 1 })).toMatchObject({ status: 'applied' });
    expect((await f.state())!.approvals).toEqual([]);
    expect(await f.apply({ kind: 'template-revoke', templateId: 'T4', revision: 1 })).toMatchObject({ status: 'rejected', reason: 'template_not_approved' });
    expect(await f.apply({ kind: 'template-pause', paused: true })).toMatchObject({ status: 'applied' });
    expect((await f.state())!.paused).toBe(true);
    expect(await f.apply({ kind: 'template-pause', paused: true })).toMatchObject({ status: 'rejected', reason: 'template_pause_unchanged' });
    expect(await f.apply({ kind: 'template-pause', paused: false })).toMatchObject({ status: 'applied' });
    expect((await f.state())!.paused).toBe(false);
  });
});

describe('whether a sequence email step may send', () => {
  const values = { firm: 'Fictional PM 1', city: 'Atlanta' };
  const cap = { today: 10, sentToday: 0 };

  it('sends only with an approved template, a connected mailbox, room under the cap and every variable filled', async () => {
    const f = await fixture();
    const step = (overrides: Partial<Parameters<TerritoryPolicyRepository['planTemplateEmailStep']>[0]> = {}) =>
      f.repository.planTemplateEmailStep({ templateId: 'T4', pairingId: f.pairing.pairingId, values,
        grant: async () => true, senderCap: async () => cap, ...overrides });

    expect(await step()).toEqual({ hold: 'template_not_approved' });
    await f.apply(approvePayload('T4'));
    const sending = await step();
    expect('send' in sending && sending.send.rendered).toEqual({
      subject: 'One question about maintenance calls at Fictional PM 1',
      body: seed('T4').body.replace(/\{firm\}/g, 'Fictional PM 1').replace('{city}', 'Atlanta'),
    });
    expect('send' in sending && sending.send.contentHash).toBe(REPLY_TEMPLATE_SEED_HASHES.T4);
    expect(await step({ grant: async () => false })).toEqual({ hold: 'mailbox_not_connected' });
    expect(await step({ senderCap: async () => ({ today: 10, sentToday: 10 }) })).toEqual({ hold: 'sender_cap_reached' });
    expect(await step({ senderCap: async () => null })).toEqual({ hold: 'sender_cap_reached' });
    expect(await step({ values: { firm: 'Fictional PM 1' } })).toEqual({ hold: 'template_variable_missing', missing: ['city'] });
    // A paused workspace holds every step without revoking a single approval David gave.
    await f.apply({ kind: 'template-pause', paused: true });
    expect(await step()).toEqual({ hold: 'template_not_approved' });
    expect((await f.state())!.approvals).toHaveLength(1);
  });

  it('never reads the Google boundary or the cap for a template that is not approved', async () => {
    const f = await fixture();
    let grants = 0, caps = 0;
    const step = () => f.repository.planTemplateEmailStep({ templateId: 'T5', pairingId: f.pairing.pairingId, values,
      grant: async () => { grants++; return true; }, senderCap: async () => { caps++; return cap; } });
    expect(await step()).toEqual({ hold: 'template_not_approved' });
    expect([grants, caps]).toEqual([0, 0]);
    await f.apply(approvePayload('T5'));
    expect('send' in (await step())).toBe(true);
    expect([grants, caps]).toEqual([1, 1]);
  });

  it('decides purely from recorded facts, in the order the founder reads them', () => {
    const approval = { templateId: 'T3' as const, revision: 1, subject: seed('T3').subject, body: seed('T3').body,
      contentHash: REPLY_TEMPLATE_SEED_HASHES.T3, approvedAt: now, commandId: uuid(1) };
    const state = { approvals: [approval], paused: false };
    const base = { templateId: 'T3' as const, state, grantConnected: true, senderCap: cap, values: { firm: 'Fictional PM 1', callback_date: '2026-10-05' } };
    expect('send' in decideTemplateEmailStep(base)).toBe(true);
    expect(decideTemplateEmailStep({ ...base, state: null })).toEqual({ hold: 'template_not_approved' });
    expect(decideTemplateEmailStep({ ...base, state: { ...state, paused: true } })).toEqual({ hold: 'template_not_approved' });
    expect(decideTemplateEmailStep({ ...base, state: { approvals: [], paused: false } })).toEqual({ hold: 'template_not_approved' });
    expect(decideTemplateEmailStep({ ...base, grantConnected: false })).toEqual({ hold: 'mailbox_not_connected' });
    expect(decideTemplateEmailStep({ ...base, senderCap: { today: 10, sentToday: 11 } })).toEqual({ hold: 'sender_cap_reached' });
    expect(decideTemplateEmailStep({ ...base, values: { firm: 'Fictional PM 1' } })).toEqual({ hold: 'template_variable_missing', missing: ['callback_date'] });
    // The text that goes out is the approved text, never the current desktop text.
    const sending = decideTemplateEmailStep(base);
    expect('send' in sending && sending.send.rendered.body.includes('check back around 2026-10-05.')).toBe(true);
    expect('send' in sending && sending.send.rendered.body.includes('{')).toBe(false);
  });
});
