import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConditionalCommandHarness } from './sdkHarness';
import { WorkerAuth } from '../src/workerAuth';
import { RemoteGoogleAuthorization } from '../src/remoteGoogleAuthorization';
import { OwnerCommandCoordinator } from '../src/ownerCommandCoordinator';
import { createWorkerAccountRepository } from '../src/workerAccountRepository';
import { TerritoryPolicyRepository, territoryCallPolicyKey, territoryEnrollmentKey } from '../src/territoryPolicyRepository';
import { DynamoStore, fingerprint } from '../src/dynamoStore';
import { executionAuthorityKey } from '../src/executionRepository';
import { campaignApprovalKey, campaignEnrollmentKey, campaignSlotKey, campaignVersionKey } from '../src/workerCampaignRepository';
import { intakeRegistryKey } from '../src/intakeBarrier';
import { ownerSourceKey, territoryPolicyCommandSchema, type TerritoryPolicyCommand } from '../../../../src/shared/contracts/ownerCommandContract';
import { DEFAULT_TERRITORY_CALL_POLICY_DEFINITION as DEFAULT, TERRITORY_CALL_POLICY_SUBJECT, deriveTerritoryCampaignVersion, territoryCallPolicyId,
  territoryEnrollmentCommandId, territoryExecutionContextId } from '../../../../src/shared/contracts/territoryCallPolicyContract';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-09-18T12:00:00.000Z';
async function fixture() {
  const dynamo = new ConditionalCommandHarness();
  const options = { dynamo, tableName: 'fictional-territory', workspaceId: 'ws', clock: { now: () => now } };
  const auth = new WorkerAuth(options);
  const issued = await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 });
  const pairing = await auth.redeemPairing(issued.code, 'fictional');
  const bearer = `Bearer ${pairing.credential}`;
  const coordinator = new OwnerCommandCoordinator({ auth, authorization: new RemoteGoogleAuthorization({ auth }) });
  const store = new DynamoStore(options);
  const accounts = createWorkerAccountRepository(options);
  let commands = 0;
  const command = (payload: TerritoryPolicyCommand['payload'], id = uuid(++commands)) => territoryPolicyCommandSchema.parse({ commandId: id, workspaceId: 'ws', accountId: TERRITORY_CALL_POLICY_SUBJECT,
    expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'territory-policy', payload });
  const apply = (payload: TerritoryPolicyCommand['payload'], id?: string) => coordinator.apply(command(payload, id), bearer);
  /** A Places-born firm exactly as the research coordinator materialises it: create, listed-phone source attestation, listed route. */
  const firm = async (n: number, phone: string) => {
    const account = await accounts.create({ commandId: uuid(100 + n), name: `Fictional PM ${n}`, domain: `fictional-${n}.example` });
    const source = { id: `place-${n}`, url: `https://places.example.invalid/${n}`, fetchedAt: now, sha256: 'a'.repeat(64), excerpt: 'Business listing', permitted: true };
    const route = { id: `route-${n}`, accountId: account.id, personId: null, channel: 'phone' as const, value: phone, purpose: 'business' as const, evidenceIds: [source.id], verification: 'listed' as const };
    await accounts.recordFetchedSource({ accountId: account.id, source });
    await accounts.admitEvidence({ commandId: uuid(200 + n), accountId: account.id, expectedVersion: 1, sources: [source], claims: [], routes: [route] });
    return { account, route };
  };
  return { dynamo, options, auth, pairing, bearer, coordinator, store, accounts, apply, command, firm };
}
const approve = { kind: 'policy.approve' as const, expectedRevision: 0, definition: DEFAULT };

describe('territory call policy on the worker', () => {
  it('approves once with revision CAS, replays by command id, pauses and resumes, and never writes authority or an event by itself', async () => {
    const f = await fixture();
    const unread = await f.apply({ kind: 'policy.read' });
    expect(unread).toEqual({ receipt: { commandId: expect.any(String), status: 'applied', authorityGeneration: 0, aggregateVersion: 0, reason: null }, policy: null });
    const stale = await f.apply({ ...approve, expectedRevision: 1 });
    expect(stale).toMatchObject({ receipt: { status: 'rejected', reason: 'policy_revision_conflict', aggregateVersion: 0 }, policy: null });
    const approved = await f.apply(approve, uuid(10));
    expect(approved.receipt).toEqual({ commandId: uuid(10), status: 'applied', authorityGeneration: 0, aggregateVersion: 1, reason: null });
    expect(approved.policy).toMatchObject({ ...DEFAULT, policyId: territoryCallPolicyId('ws'), workspaceId: 'ws', pairingId: f.pairing.pairingId, revision: 1, state: 'active', approvedRevision: 1, approvedAt: now });
    const transactions = f.dynamo.transactions.length;
    expect(await f.apply(approve, uuid(10))).toEqual(approved);
    expect(f.dynamo.transactions).toHaveLength(transactions);
    await expect(f.apply({ ...approve, definition: { ...DEFAULT, offer: 'Changed offer' } }, uuid(10))).rejects.toThrow('command_fingerprint_conflict');
    expect(await f.apply({ ...approve, expectedRevision: 1 })).toMatchObject({ receipt: { status: 'rejected', reason: 'policy_unchanged', aggregateVersion: 1 } });
    const paused = await f.apply({ kind: 'policy.set-state', expectedRevision: 1, state: 'paused' });
    expect(paused).toMatchObject({ receipt: { status: 'applied', aggregateVersion: 2 }, policy: { revision: 2, state: 'paused', approvedRevision: 1, approvedAt: now } });
    expect(await f.apply({ kind: 'policy.set-state', expectedRevision: 2, state: 'paused' })).toMatchObject({ receipt: { status: 'rejected', reason: 'policy_state_unchanged' } });
    const resumed = await f.apply({ kind: 'policy.set-state', expectedRevision: 2, state: 'active' });
    expect(resumed.policy).toMatchObject({ revision: 3, state: 'active', approvedRevision: 1 });
    expect((await f.apply({ kind: 'policy.read' })).policy).toEqual(resumed.policy);
    expect(f.dynamo.inspect(territoryCallPolicyKey('ws'))).toEqual(resumed.policy);
    expect(await f.store.list('AUTH#')).toEqual([]);
    expect(await f.store.list('EVENT#')).toEqual([]);
    await expect(f.coordinator.reconcile(f.command({ kind: 'policy.read' }), f.bearer)).rejects.toThrow('command_requires_explicit_reconciliation');
  });
  it('grants authority, the approved derived version, the enrollment and the no-mail call prerequisites in one transaction, holds email steps, replays and honours pause', async () => {
    const f = await fixture();
    const first = await f.firm(1, '+14015550101');
    expect(await f.accounts.applyTerritoryPolicy(first.account.id, first.route.id)).toEqual({ outcome: 'no_policy', accountId: first.account.id, policyId: null, revision: null });
    expect(await f.store.get(executionAuthorityKey(first.account.id))).toBeNull();
    await f.apply(approve);
    const policy = (await new TerritoryPolicyRepository(f.options).read())!.data;
    const version = deriveTerritoryCampaignVersion(policy, first.account.id);
    const before = f.dynamo.transactions.length;
    const result = await f.accounts.applyTerritoryPolicy(first.account.id, first.route.id);
    if (result.outcome !== 'enrolled') throw new Error(result.outcome);
    expect(result).toMatchObject({ accountId: first.account.id, routeId: first.route.id, policyId: policy.policyId, revision: 1, commandId: territoryEnrollmentCommandId(policy, first.account.id), versionId: version.id, grantedAt: now,
      heldSteps: [{ stepId: version.steps[2]!.id, channel: 'email', reason: 'mailbox_not_connected' }, { stepId: version.steps[4]!.id, channel: 'email', reason: 'mailbox_not_connected' }] });
    expect(f.dynamo.transactions).toHaveLength(before + 1);
    const keys = f.dynamo.transactions[before]!.TransactItems!.map(item => (item.Put?.Item ?? item.ConditionCheck?.Key)!.sk!.S!);
    expect(keys).toEqual(expect.arrayContaining([campaignVersionKey(version.id), campaignApprovalKey(version.id), campaignEnrollmentKey(result.enrollmentId), campaignSlotKey(first.account.id),
      executionAuthorityKey(first.account.id), ownerSourceKey(first.account.id), intakeRegistryKey(first.account.id), territoryEnrollmentKey(first.account.id), territoryCallPolicyKey('ws'), 'EVENT_HEAD']));
    expect(f.dynamo.inspect(executionAuthorityKey(first.account.id))).toEqual({ authority: { accountId: first.account.id, owner: 'worker', generation: 1, state: 'active' }, version: 1 });
    expect(f.dynamo.inspect(campaignVersionKey(version.id))).toEqual(version);
    expect(f.dynamo.inspect(campaignApprovalKey(version.id))).toEqual({ snapshotHash: fingerprint(version), approvedAt: now });
    expect(f.dynamo.inspect(campaignEnrollmentKey(result.enrollmentId))).toMatchObject({ accountId: first.account.id, selectedRouteId: first.route.id, selectedRouteVersion: 1, personId: null,
      campaignVersionId: version.id, currentStepId: version.steps[0]!.id, state: 'active', version: 1, executionContextId: territoryExecutionContextId(policy, first.account.id), contextRevision: 1 });
    expect(f.dynamo.inspect(ownerSourceKey(first.account.id))).toMatchObject({ state: 'active', mailboxSubject: null, calendarId: null, research: null, pairingId: f.pairing.pairingId, revision: 1 });
    expect(f.dynamo.inspect(intakeRegistryKey(first.account.id))).toEqual({ accountId: first.account.id, adapters: [], manualDependencies: [] });
    const events = (await f.store.eventsAfter(null)).events;
    const grant = events.find(event => event.kind === 'authority.granted');
    if (grant?.kind !== 'authority.granted') throw new Error('grant event missing');
    expect(grant).toMatchObject({ accountId: first.account.id, authorityGeneration: 1, aggregateVersion: 1, payload: { policyId: policy.policyId, revision: 1, receipt: { commandId: result.commandId, status: 'applied', aggregateVersion: 1 } } });
    expect(grant.campaign.version).toEqual({ ...version, approvedAt: now });
    expect(grant.campaign.enrollment?.id).toBe(result.enrollmentId);
    expect(events.map(event => event.kind)).toEqual(['research.created', 'research.evidence', 'authority.granted']);
    // The identical create is a replay: the same record, no second grant.
    expect(await f.accounts.applyTerritoryPolicy(first.account.id, first.route.id)).toEqual({ ...result, outcome: 'replayed' });
    expect(f.dynamo.transactions).toHaveLength(before + 1);
    // Pausing stops new enrollments; the existing enrollment keeps its state. Resuming enrolls under the new revision.
    await f.apply({ kind: 'policy.set-state', expectedRevision: 1, state: 'paused' });
    const second = await f.firm(2, '+14015550102');
    expect(await f.accounts.applyTerritoryPolicy(second.account.id, second.route.id)).toEqual({ outcome: 'policy_paused', accountId: second.account.id, policyId: policy.policyId, revision: 2 });
    expect(await f.store.get(executionAuthorityKey(second.account.id))).toBeNull();
    expect(f.dynamo.inspect(campaignEnrollmentKey(result.enrollmentId))).toMatchObject({ state: 'active' });
    await f.apply({ kind: 'policy.set-state', expectedRevision: 2, state: 'active' });
    const resumed = await f.accounts.applyTerritoryPolicy(second.account.id, second.route.id);
    expect(resumed).toMatchObject({ outcome: 'enrolled', revision: 3, versionId: deriveTerritoryCampaignVersion({ ...policy, revision: 3 }, second.account.id).id });
    // A route the firm does not have and a firm someone already owns are holds, never grants.
    const third = await f.firm(3, '+14015550103');
    expect(await f.accounts.applyTerritoryPolicy(third.account.id, 'route-missing')).toMatchObject({ outcome: 'route_unavailable', revision: 3 });
    await f.store.transact([f.store.put(executionAuthorityKey(third.account.id), { authority: { accountId: third.account.id, owner: 'local', generation: 0, state: 'local' }, version: 0 }, null)]);
    expect(await f.accounts.applyTerritoryPolicy(third.account.id, third.route.id)).toMatchObject({ outcome: 'authority_exists' });
    expect(await f.store.get(campaignSlotKey(third.account.id))).toBeNull();
  });
  it('lets the owner prepare a manual call for a policy-enrolled firm with no per-firm grant, and keeps account_already_enrolled authoritative', async () => {
    const f = await fixture();
    await f.apply(approve);
    const firm = await f.firm(1, '+14015550101');
    const result = await f.accounts.applyTerritoryPolicy(firm.account.id, firm.route.id);
    if (result.outcome !== 'enrolled') throw new Error(result.outcome);
    const policy = (await new TerritoryPolicyRepository(f.options).read())!.data;
    const version = deriveTerritoryCampaignVersion(policy, firm.account.id);
    const prepare = { commandId: uuid(50), workspaceId: 'ws', accountId: firm.account.id, expectedAuthorityGeneration: 1, expectedVersion: 1, kind: 'prepare-manual',
      payload: { actionId: 'action-1', channel: 'call', routeId: firm.route.id, routeVersion: 1, targetHash: createHash('sha256').update('+14015550101').digest('hex'), contentHash: 'b'.repeat(64),
        contextRevision: territoryExecutionContextId(policy, firm.account.id), campaign: { campaignId: version.campaignId, campaignRevision: 1, enrollmentId: result.enrollmentId, enrollmentRevision: 1, stepId: version.steps[0]!.id } } };
    const receipt = await f.coordinator.apply(prepare, f.bearer);
    expect(receipt).toMatchObject({ commandId: uuid(50), status: 'applied', authorityGeneration: 1, aggregateVersion: 2 });
    const events = (await f.store.eventsAfter(null)).events;
    expect(events.at(-1)).toMatchObject({ kind: 'manual.handoff', accountId: firm.account.id, aggregateVersion: 2, payload: { channel: 'call', routeId: firm.route.id, actionId: 'action-1' } });
    expect(f.dynamo.inspect(executionAuthorityKey(firm.account.id))).toMatchObject({ authority: { owner: 'worker', state: 'active', generation: 1 }, version: 2 });
    // A desktop enrollment of the same firm is refused by the existing slot rule; the policy enrollment stays the one.
    const enroll = { commandId: uuid(51), workspaceId: 'ws', accountId: firm.account.id, expectedAuthorityGeneration: 1, expectedVersion: 2, kind: 'campaign-command',
      payload: { kind: 'campaign.enroll', enrollmentId: uuid(52), campaignVersionId: version.id, selectedRouteId: firm.route.id, executionContextId: 'desktop-context', contextRevision: 1 } };
    await expect(f.coordinator.apply(enroll, f.bearer)).rejects.toThrow('account_already_enrolled');
  });
});
