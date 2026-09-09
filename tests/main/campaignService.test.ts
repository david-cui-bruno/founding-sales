import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCampaignFixture } from '../fixtures/campaignWorkspace';
import { CampaignService } from '../../src/main/domain/campaign/campaignService';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { ExecutionClient } from '../../src/main/delegation/executionClient';
import { SqlDelegationTransport } from '../../src/main/delegation/delegationSync';

describe('campaign normal durable command service', () => {
  it('queues an exact campaign command offline without local mutation or false owner acknowledgment', async () => {
    const f = await createCampaignFixture();
    try {
      const repository = new DelegationRepository({ database: f.db, workspaceId: f.workspaceId, clock: f.clock });
      repository.initializeLocalAuthority(f.account.id);
      f.db.raw.prepare("UPDATE delegated_authorities SET owner='worker',state='active',generation=3,aggregate_version=5 WHERE account_id=?").run(f.account.id);
      const transport = new SqlDelegationTransport({ database: f.db, workspaceId: f.workspaceId, pairingId: randomUUID(), clock: f.clock });
      let requests = 0;
      const execution = new ExecutionClient({ repository, transport, pairing: { endpoint: 'https://fictional.example.invalid', workspaceId: f.workspaceId, credential: 'x'.repeat(43) },
        fetch: async () => { requests++; throw new Error('fictional disconnected'); } });
      const service = new CampaignService({ workspaceId: f.workspaceId, delegation: repository, execution });
      const commandId = randomUUID();
      const result = await service.submit({ commandId, accountId: f.account.id, payload: { kind: 'campaign.enroll', enrollmentId: randomUUID(), campaignVersionId: f.versions[0].id,
        selectedRouteId: f.routes[0].id, executionContextId: 'fictional-context', contextRevision: 1 } });
      expect(result).toMatchObject({ status: 'pending', authorityGeneration: 3 });
      expect(repository.getCommand(commandId)).toMatchObject({ kind: 'campaign-command', expectedAuthorityGeneration: 3, expectedVersion: 5 });
      expect(f.db.raw.prepare('SELECT count(*) AS n FROM campaign_enrollments').get()).toEqual({ n: 0 });
      expect(requests).toBe(1);
      f.db.raw.prepare("UPDATE delegated_authorities SET state='paused' WHERE account_id=?").run(f.account.id);
      await expect(service.submit({ commandId: randomUUID(), accountId: f.account.id, payload: { kind: 'campaign.enroll', enrollmentId: randomUUID(), campaignVersionId: f.versions[0].id,
        selectedRouteId: f.routes[0].id, executionContextId: 'fictional-context', contextRevision: 1 } })).rejects.toThrow('campaign_owner_unavailable');
      expect(requests).toBe(1);
    } finally { f.close(); }
  });
});
