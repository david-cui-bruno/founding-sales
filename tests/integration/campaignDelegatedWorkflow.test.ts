import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCampaignFixture } from '../fixtures/campaignWorkspace';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { ExecutionClient } from '../../src/main/delegation/executionClient';
import { SqlDelegationTransport } from '../../src/main/delegation/delegationSync';
import { CampaignService } from '../../src/main/domain/campaign/campaignService';
import { ConditionalCommandHarness } from '../../cloud/lambdas/delegated-worker/test/sdkHarness';
import { WorkerAuth } from '../../cloud/lambdas/delegated-worker/src/workerAuth';
import { createWorkerHandler } from '../../cloud/lambdas/delegated-worker/src/handler';
import { DynamoExecutionRepository } from '../../cloud/lambdas/delegated-worker/src/executionRepository';
import { DynamoStore, fingerprint } from '../../cloud/lambdas/delegated-worker/src/dynamoStore';
import type { CampaignCommandPayload } from '../../src/shared/contracts/campaignContract';

describe('campaign commands through real authenticated handler and SQL projector', () => {
  it('persists strategy approval and account enrollment only after ordered owner events, with replay and no provider calls', async () => {
    const f = await createCampaignFixture();
    try {
      const options = { dynamo: new ConditionalCommandHarness(), tableName: 'fictional-campaign-table', workspaceId: f.workspaceId, clock: f.clock };
      const auth = new WorkerAuth(options);
      const issued = await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 });
      const pairing = await auth.redeemPairing(issued.code, 'fictional-campaign-device');
      const store = new DynamoStore(options); const account = { ...f.account, version: 2 };
      const routes = f.routes.map(route => ({ ...route, version: 1 }));
      await store.transact([store.put(`ACCOUNT#${f.account.id}`, { account, routes, claims: [], sources: [], researchRevision: 1, history: [{ at: f.now, account, routes, claims: [] }] }, null)]);
      await new DynamoExecutionRepository(options).seedLocalAuthority(f.account.id);
      const repository = new DelegationRepository({ database: f.db, workspaceId: f.workspaceId, clock: f.clock });
      repository.initializeLocalAuthority(f.account.id);
      const handler = createWorkerHandler({ auth, host: 'campaign.example.invalid' });
      const paths: string[] = [];
      const http: typeof fetch = async (input, init) => {
        const url = new URL(String(input)); paths.push(url.pathname);
        const response = await handler({ version: '2.0', rawPath: url.pathname, rawQueryString: url.search.slice(1), headers: { host: url.host, 'x-forwarded-proto': 'https', authorization: new Headers(init?.headers).get('authorization') ?? '' },
          requestContext: { domainName: url.host, http: { method: init?.method ?? 'GET', sourceIp: 'fictional' } }, ...(init?.body ? { body: String(init.body) } : {}) });
        return new Response(response.body, { status: response.statusCode, headers: response.headers });
      };
      const transport = new SqlDelegationTransport({ database: f.db, workspaceId: f.workspaceId, pairingId: pairing.pairingId, clock: f.clock });
      const client = new ExecutionClient({ repository, transport, pairing: { endpoint: 'https://campaign.example.invalid', workspaceId: f.workspaceId, credential: pairing.credential }, fetch: http });
      await client.submit({ commandId: randomUUID(), workspaceId: f.workspaceId, accountId: f.account.id, expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'delegate', payload: { delegationId: randomUUID(), approvedAt: f.now } });
      expect(await client.sync(new AbortController().signal)).toMatchObject({ ownerFresh: true, gaps: 0 });
      const service = new CampaignService({ workspaceId: f.workspaceId, delegation: repository, execution: client });
      const apply = async (payload: CampaignCommandPayload, beforeSync?: () => void) => {
        const commandId = randomUUID(); const request = { commandId, accountId: f.account.id, payload };
        expect(await service.submit(request)).toMatchObject({ status: 'pending' });
        beforeSync?.();
        expect(await client.sync(new AbortController().signal)).toMatchObject({ ownerFresh: true, gaps: 0 });
        expect(repository.commandStatus(commandId)).toMatchObject({ status: 'applied' });
        expect(await service.submit(request)).toMatchObject({ status: 'applied' });
      };
      const version = { ...f.versions[0], id: randomUUID(), campaignId: randomUUID(), version: 1 };
      await apply({ kind: 'campaign.version', version }, () => expect(() => f.repo.getVersion(version.id)).toThrow('campaign_missing'));
      expect(f.repo.getVersion(version.id).approvedAt).toBeNull();
      await apply({ kind: 'campaign.approve', campaignVersionId: version.id, snapshotHash: fingerprint(version), approvedAt: f.now });
      const enrollmentId = randomUUID();
      await apply({ kind: 'campaign.enroll', enrollmentId, campaignVersionId: version.id, selectedRouteId: f.routes[0].id, executionContextId: 'fictional-current-context', contextRevision: 1 });
      expect(f.repo.getEnrollment(enrollmentId)).toMatchObject({ state: 'active', campaignVersionId: version.id });
      expect(paths.every(path => ['/commands', '/events'].includes(path))).toBe(true);
    } finally { f.close(); }
  });
});
