import { randomUUID, createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { fixture } from './dispatchFixture';
import { createIntakeBarrier, intakeRegistrySchema, intakeRegistryKey, validatePendingHandoff } from '../src/intakeBarrier';
import { fingerprint } from '../src/dynamoStore';
import { manualHandoffSchema } from '../../../../src/shared/contracts/ownerCommandContract';
import { accountRecordSchema } from '../src/workerAccountRepository';

async function handoffFixture() {
  const f = await fixture();
  const row = await f.store.get('ACCOUNT#acct'); const record = accountRecordSchema.parse(row!.data);
  const route = { id: 'phone', accountId: 'acct', personId: null, channel: 'phone' as const, value: '+12025550123', purpose: 'business' as const, evidenceIds: ['phone-source'], verification: 'published' as const, version: 1 };
  await f.store.transact([f.store.put('ACCOUNT#acct', { ...record, routes: [route], sources: [{ id: 'phone-source', url: 'https://example.invalid/team', fetchedAt: f.options.clock.now(), sha256: 'a'.repeat(64), excerpt: 'Fictional published phone', permitted: true }] }, row!.rev)]);
  const apply = async (kind: string, payload: unknown) => {
    const command = { commandId: randomUUID(), workspaceId: 'ws', accountId: 'acct', expectedAuthorityGeneration: 1, expectedVersion: await f.execution.currentVersion('acct'), kind, payload };
    await f.owner.apply(command, `Bearer ${f.pair.credential}`); return command;
  };
  const version = { id: 'manual-version', campaignId: 'manual-campaign', version: 1, audienceHash: 'a'.repeat(64), offer: 'Fictional offer', objective: 'meeting', cohortAccountIds: ['acct'], approvedAt: null,
    steps: [{ id: 'call-step', channel: 'call', condition: 'initial', delayHours: 0 }], capScope: 'campaign_version_lifetime', channelCaps: { call: 1, email: 0, linkedin: 0 }, contentPolicyHash: 'b'.repeat(64) };
  await apply('campaign-command', { kind: 'campaign.version', version });
  await apply('campaign-command', { kind: 'campaign.approve', campaignVersionId: version.id, snapshotHash: fingerprint(version), approvedAt: f.options.clock.now() });
  await apply('campaign-command', { kind: 'campaign.enroll', enrollmentId: 'manual-enrollment', campaignVersionId: version.id, selectedRouteId: route.id, executionContextId: 'manual-context', contextRevision: 1 });
  const command = await apply('prepare-manual', { actionId: 'manual-action', channel: 'call', routeId: route.id, routeVersion: 1, targetHash: createHash('sha256').update(route.value).digest('hex'), contentHash: 'b'.repeat(64), contextRevision: 'manual-context', campaign: { campaignId: version.campaignId, campaignRevision: 1, enrollmentId: 'manual-enrollment', enrollmentRevision: 1, stepId: 'call-step' } });
  const event = (await f.execution.eventsAfter(null)).events.find(event => event.kind === 'manual.handoff');
  if (event?.kind !== 'manual.handoff') throw new Error('missing actual handoff');
  const handoff = manualHandoffSchema.parse(event.payload);
  return { ...f, command, handoff, identity: { handoffId: handoff.handoffId, pairingId: f.pair.pairingId, generation: 1 }, subject: { accountId: 'acct', mailboxSubject: 'mailbox' } };
}
it('readiness for actual reserved handoff exempts only its own pending dependency, ordinary dispatch stays blocked', async () => {
  const f = await handoffFixture(); const barrier = createIntakeBarrier(f.store); const signal = new AbortController().signal;
  expect(await barrier.check(f.subject, signal)).toMatchObject({ status: 'blocked', reason: 'manual_outcome_pending' });
  const proof = await validatePendingHandoff(f.store, 'acct', f.identity);
  expect(proof?.dependency).toEqual({ commandId: f.command.commandId, actionId: 'manual-action', channel: 'call', outcome: 'pending' });
  const result = await barrier.checkHandoff(f.subject, f.identity, signal);
  expect(result.status).toBe('ready');
  if (result.status !== 'ready') throw new Error('missing readiness');
  expect(result.validUntil).toBeLessThanOrEqual(Date.parse(f.handoff.expiresAt));
  await f.store.transact(result.checks);
  const key = intakeRegistryKey('acct'); const row = await f.store.get(key); const registry = intakeRegistrySchema.parse(row!.data);
  await f.store.transact([f.store.put(key, { ...registry, manualDependencies: [...registry.manualDependencies, { commandId: randomUUID(), actionId: 'other-action', channel: 'linkedin', outcome: 'pending' }] }, row!.rev)]);
  await expect(f.store.transact(result.checks)).rejects.toThrow();
  expect(await barrier.checkHandoff(f.subject, f.identity, signal)).toMatchObject({ status: 'blocked' });
});
it.each(['missing', 'foreign_pairing', 'foreign_account', 'wrong_generation', 'expired', 'consumed', 'corrupt_command', 'corrupt_event'] as const)('handoff proof %s is held', async variation => {
  const f = await handoffFixture(); const identity = { ...f.identity }; let account = 'acct';
  if (variation === 'missing') identity.handoffId = 'missing';
  if (variation === 'foreign_pairing') identity.pairingId = randomUUID();
  if (variation === 'foreign_account') account = 'foreign';
  if (variation === 'wrong_generation') identity.generation++;
  if (variation === 'expired') f.advance(f.handoff.expiresAt);
  if (variation === 'consumed') {
    const key = `MANUAL_HANDOFF#${f.handoff.handoffId}`; const row = await f.store.get<Record<string, unknown>>(key);
    await f.store.transact([f.store.put(key, { ...row!.data, lastOutcome: { outcome: 'not_called' } }, row!.rev)]);
  }
  if (variation === 'corrupt_command' || variation === 'corrupt_event') {
    const key = `COMMAND#${f.command.commandId}`; const row = await f.store.get<{ sequence: number; fingerprint: string }>(key);
    const target = variation === 'corrupt_command' ? key : f.store.eventKey(row!.data.sequence);
    const original = await f.store.get<Record<string, unknown>>(target);
    await f.store.transact([f.store.put(target, { ...original!.data, ...(variation === 'corrupt_command' ? { fingerprint: 'bad' } : { event: {} }) }, original!.rev)]);
  }
  expect(await validatePendingHandoff(f.store, account, identity)).toBeNull();
});
it.each(['handoff', 'command', 'event', 'cursor'] as const)('final handoff proof fences concurrent %s revision changes', async target => {
  const f = await handoffFixture();
  const result = await createIntakeBarrier(f.store).checkHandoff(f.subject, f.identity, new AbortController().signal);
  expect(result.status).toBe('ready'); if (result.status !== 'ready') throw new Error('missing readiness');
  const commandKey = `COMMAND#${f.command.commandId}`; const command = await f.store.get<{ sequence: number }>(commandKey);
  const key = target === 'handoff' ? `MANUAL_HANDOFF#${f.handoff.handoffId}` : target === 'command' ? commandKey : target === 'event' ? f.store.eventKey(command!.data.sequence) : 'MAIL_CURSOR#acct#mailbox';
  const row = await f.store.get(key); expect(row).not.toBeNull();
  await f.store.transact([f.store.put(key, row!.data, row!.rev)]);
  await expect(f.store.transact(result.checks)).rejects.toThrow();
});
it('handoff readiness retains current intake failure and caller cancellation holds', async () => {
  const f = await handoffFixture(); const barrier = createIntakeBarrier(f.store);
  const controller = new AbortController(); controller.abort();
  expect(await barrier.checkHandoff(f.subject, f.identity, controller.signal)).toMatchObject({ status: 'blocked' });
  const key = 'MAIL_CURSOR#acct#mailbox'; const row = await f.store.get<Record<string, unknown>>(key);
  await f.store.transact([f.store.put(key, { ...row!.data, poll: null }, row!.rev)]);
  expect(await barrier.checkHandoff(f.subject, f.identity, new AbortController().signal)).toMatchObject({ status: 'blocked', reason: 'intake_incomplete' });
});
