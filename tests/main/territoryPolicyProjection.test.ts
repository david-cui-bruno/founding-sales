import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCampaignFixture } from '../fixtures/campaignWorkspace';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { ExecutionClient } from '../../src/main/delegation/executionClient';
import { SqlDelegationTransport } from '../../src/main/delegation/delegationSync';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { DailyReadService } from '../../src/main/domain/today/dailyReadService';
import { describeCampaignRow } from '../../src/renderer/features/campaigns/campaignListLabel';
import { ConditionalCommandHarness } from '../../cloud/lambdas/delegated-worker/test/sdkHarness';
import { WorkerAuth } from '../../cloud/lambdas/delegated-worker/src/workerAuth';
import { createWorkerHandler } from '../../cloud/lambdas/delegated-worker/src/handler';
import { createWorkerAccountRepository } from '../../cloud/lambdas/delegated-worker/src/workerAccountRepository';
import { territoryPolicyCommandSchema } from '../../src/shared/contracts/ownerCommandContract';
import { DEFAULT_TERRITORY_CALL_POLICY_DEFINITION, TERRITORY_CALL_POLICY_SUBJECT, deriveTerritoryCampaignVersion } from '../../src/shared/contracts/territoryCallPolicyContract';
import type { WorkerEvent } from '../../src/shared/contracts/delegationContract';

describe('territory policy grant projected on the desktop', () => {
  it('approves the policy through the real gateway, then a worker-prepared firm arrives with worker authority, an approved version and a due enrollment, with no desktop command', async () => {
    const f = await createCampaignFixture();
    try {
      const options = { dynamo: new ConditionalCommandHarness(), tableName: 'fictional-territory-table', workspaceId: f.workspaceId, clock: f.clock };
      const auth = new WorkerAuth(options);
      const pairing = await auth.redeemPairing((await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 })).code, 'fictional-territory-device');
      const handler = createWorkerHandler({ auth, host: 'territory.example.invalid' });
      const paths: string[] = [];
      const http: typeof fetch = async (input, init) => {
        const url = new URL(String(input)); paths.push(url.pathname);
        const response = await handler({ version: '2.0', rawPath: url.pathname, rawQueryString: url.search.slice(1), headers: { host: url.host, 'x-forwarded-proto': 'https', authorization: new Headers(init?.headers).get('authorization') ?? '' },
          requestContext: { domainName: url.host, http: { method: init?.method ?? 'GET', sourceIp: 'fictional' } }, ...(init?.body ? { body: String(init.body) } : {}) });
        return new Response(response.body, { status: response.statusCode, headers: response.headers });
      };
      const repository = new DelegationRepository({ database: f.db, workspaceId: f.workspaceId, clock: f.clock, sourcePolicy: { attest: source => source.url.startsWith('https://places.example.invalid/') } });
      const transport = new SqlDelegationTransport({ database: f.db, workspaceId: f.workspaceId, pairingId: pairing.pairingId, clock: f.clock });
      const client = new ExecutionClient({ repository, transport, pairing: { endpoint: 'https://territory.example.invalid', workspaceId: f.workspaceId, credential: pairing.credential }, fetch: http });
      const signal = () => new AbortController().signal;
      const command = (payload: unknown, commandId = randomUUID()) => territoryPolicyCommandSchema.parse({ commandId, workspaceId: f.workspaceId, accountId: TERRITORY_CALL_POLICY_SUBJECT, expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'territory-policy', payload });
      expect(await client.territoryPolicy(command({ kind: 'policy.read' }), signal())).toMatchObject({ receipt: { status: 'applied', aggregateVersion: 0 }, policy: null });
      const approveId = randomUUID();
      const approved = await client.territoryPolicy(command({ kind: 'policy.approve', expectedRevision: 0, definition: DEFAULT_TERRITORY_CALL_POLICY_DEFINITION }, approveId), signal());
      expect(approved.receipt).toEqual({ commandId: approveId, status: 'applied', authorityGeneration: 0, aggregateVersion: 1, reason: null });
      expect(approved.policy).toMatchObject({ workspaceId: f.workspaceId, pairingId: pairing.pairingId, revision: 1, state: 'active' });
      // The policy is workspace-level: nothing was queued in the account outbox and nothing arrives as an event.
      expect(repository.pendingCommands()).toEqual([]);
      expect(await client.sync(signal())).toMatchObject({ ownerFresh: true, applied: 0, gaps: 0 });
      // The worker prepares a firm the way the Places path does, then applies the policy itself.
      const accounts = createWorkerAccountRepository(options);
      const account = await accounts.create({ commandId: randomUUID(), name: 'Places Fictional PM', domain: 'places-fictional.example' });
      const source = { id: 'place-1', url: 'https://places.example.invalid/place-1', fetchedAt: f.now, sha256: 'a'.repeat(64), excerpt: 'Business listing with phone', permitted: true };
      const route = { id: 'route-listed', accountId: account.id, personId: null as null, channel: 'phone' as const, value: '+14015550199', purpose: 'business' as const, evidenceIds: [source.id], verification: 'listed' as const };
      await accounts.recordFetchedSource({ accountId: account.id, source });
      await accounts.admitEvidence({ commandId: randomUUID(), accountId: account.id, expectedVersion: 1, sources: [source], routes: [route], claims: [
        { key: 'residential_scope', kind: 'fact', value: 'Residential property management', evidenceIds: [source.id] },
        { key: 'operating_footprint', kind: 'fact', value: 'Regional operator', evidenceIds: [source.id] }] });
      const outcome = await accounts.applyTerritoryPolicy(account.id, route.id);
      if (outcome.outcome !== 'enrolled') throw new Error(outcome.outcome);
      const version = deriveTerritoryCampaignVersion(approved.policy!, account.id);
      expect(outcome.versionId).toBe(version.id);
      // One sync projects the research stream and the grant; the desktop never queued a command for this firm.
      const sync = await client.sync(signal());
      expect(sync).toMatchObject({ ownerFresh: true, gaps: 0, applied: 3 });
      expect(repository.authority(account.id)).toEqual({ accountId: account.id, owner: 'worker', generation: 1, state: 'active' });
      expect(repository.executionVersion(account.id)).toBe(1);
      expect(repository.getCommand(outcome.commandId)).toBeNull();
      expect(f.repo.getVersion(version.id)).toEqual({ ...version, approvedAt: f.now });
      expect(f.repo.getEnrollment(outcome.enrollmentId)).toMatchObject({ state: 'active', accountId: account.id, campaignVersionId: version.id, currentStepId: version.steps[0]!.id, selectedRouteId: route.id, selectedRouteVersion: 1, version: 1 });
      const applied = f.db.raw.prepare("SELECT event_json FROM delegated_applied_events WHERE account_id=? AND stream='execution'").all(account.id) as { event_json: string }[];
      expect(applied.map(row => (JSON.parse(row.event_json) as WorkerEvent).kind)).toEqual(['authority.granted']);
      // Today's read sees the worker owner applied and the firm due on its day-zero call step.
      const services = createDomainServices({ database: f.db, clock: f.clock, ids: { next: randomUUID }, expectedWorkspaceId: f.workspaceId });
      const snapshot = new DailyReadService({ database: f.db, clock: f.clock, ids: { next: randomUUID }, today: services.today, settings: services.workspaceSettings, workspaceId: f.workspaceId }).get();
      expect(snapshot.ownerStatus.find(o => o.accountId === account.id)).toEqual({ accountId: account.id, authority: { accountId: account.id, owner: 'worker', generation: 1, state: 'active' }, executionVersion: 1, pendingCommands: [], status: 'owner_applied' });
      expect(snapshot.calls.accountIds).toContain(account.id);
      const campaign = snapshot.campaigns.find(c => c.version.id === version.id)!;
      expect(campaign.enrollments.map(e => e.id)).toEqual([outcome.enrollmentId]);
      expect(describeCampaignRow(campaign, snapshot.accounts)).toEqual({ title: 'Places Fictional PM · Territory policy v1', detail: 'Version 1 · Enrolled' });
      // A repeated create replays on the worker and adds nothing on the desktop.
      expect((await accounts.applyTerritoryPolicy(account.id, route.id)).outcome).toBe('replayed');
      expect(await client.sync(signal())).toMatchObject({ ownerFresh: true, applied: 0, gaps: 0 });
      expect(paths.every(path => ['/commands', '/events'].includes(path))).toBe(true);
    } finally { f.close(); }
  });
  it('refuses a grant for a firm the desktop already owns or never researched, and refuses the policy in the account outbox', async () => {
    const f = await createCampaignFixture();
    try {
      const repository = new DelegationRepository({ database: f.db, workspaceId: f.workspaceId, clock: f.clock });
      repository.initializeLocalAuthority(f.account.id);
      const version = { ...f.versions[0]!, approvedAt: f.now };
      const grant = (accountId: string): WorkerEvent => ({ id: randomUUID(), workspaceId: f.workspaceId, accountId, authorityGeneration: 1, aggregateVersion: 1, kind: 'authority.granted',
        payload: { authority: { accountId, owner: 'worker', generation: 1, state: 'active' }, policyId: 'territory-policy-fictional', revision: 1, receipt: { commandId: '11111111-1111-4111-8111-111111111111', status: 'applied', authorityGeneration: 1, aggregateVersion: 1, reason: null } },
        campaign: { commandId: '11111111-1111-4111-8111-111111111111', version: { ...version, cohortAccountIds: [accountId] }, evidence: null,
          enrollment: { id: 'enrollment', accountId, selectedRouteId: f.routes[0]!.id, selectedRouteVersion: 1, personId: null, campaignVersionId: version.id, currentStepId: version.steps[0]!.id, version: 1, state: 'active', executionContextId: 'context', contextRevision: 1, startedAt: f.now } } });
      expect(() => repository.applyWorkerEvent(grant(f.account.id))).toThrow('Authority already assigned');
      expect(() => repository.applyWorkerEvent(grant('never-researched'))).toThrow(/researched account/);
      expect(f.db.raw.prepare('SELECT COUNT(*) AS n FROM delegated_applied_events').get()).toEqual({ n: 0 });
      expect(() => repository.queueCommand(territoryPolicyCommandSchema.parse({ commandId: randomUUID(), workspaceId: f.workspaceId, accountId: TERRITORY_CALL_POLICY_SUBJECT, expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'territory-policy', payload: { kind: 'policy.read' } })))
        .toThrow('territory_policy_requires_policy_path');
    } finally { f.close(); }
  });
});
