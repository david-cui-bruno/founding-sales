import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { campaignFixture } from '../../cloud/lambdas/delegated-worker/test/dispatchFixture';
import { openDatabase, closeDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { CampaignRepository } from '../../src/main/domain/campaign/campaignRepository';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { workerEventSchema } from '../../src/shared/contracts/delegationContract';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';

it('projects actual C4 reservation and accepted cap events through canonical C1 SQL and durable reopen', async () => {
  const worker = await campaignFixture();
  const temp = createTempDatabase(); const key = createTestWorkspaceKey();
  let db = openDatabase({ path: temp.path, key });
  try {
    await migrateToLatest(db, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
    const clock = worker.options.clock; const workspaceId = worker.options.workspaceId;
    const accounts = new AccountRepository({ database: db, clock, ids: { next: () => 'acct' }, sourcePolicy: { attest: source => source.url === 'https://example.invalid/team' } });
    accounts.create({ commandId: randomUUID(), name: 'Fictional PM', domain: null });
    accounts.admitEvidence({ commandId: randomUUID(), accountId: 'acct', expectedVersion: 1,
      sources: [{ id: 'actual-source', url: 'https://example.invalid/team', fetchedAt: clock.now(), sha256: 'a'.repeat(64), excerpt: 'Fictional requested correspondence.', permitted: true }], claims: [],
      routes: [{ id: 'route', accountId: 'acct', personId: null, channel: 'email', value: worker.draft.recipient, purpose: 'business', evidenceIds: ['actual-source'], verification: 'confirmed' }] });
    const campaign = new CampaignRepository({ database: db, workspaceId, clock });
    // Actual D1 command plans initialize approved version/enrollment, never a seeded cap count.
    for (const payload of worker.campaignPayloads) db.raw.transaction(() => campaign.applyProjection('acct', payload)).immediate();
    const local = new DelegationRepository({ database: db, workspaceId, clock });
    local.initializeLocalAuthority('acct');
    const readCap = () => db.raw.prepare('SELECT revision,reserved,sent FROM campaign_caps WHERE workspace_id=? AND campaign_version_id=? AND channel=?')
      .get(workspaceId, worker.version.id, 'email');
    expect(readCap()).toEqual({ revision: 1, reserved: 0, sent: 0 });
    expect((await worker.service().dispatch(worker.intent.commandId)).status).toBe('provider_accepted');
    const events = (await worker.execution.eventsAfter(null)).events.map(event => workerEventSchema.parse(event));
    let reservations = 0; let accepted = 0;
    for (const event of events) {
      if (event.kind === 'authority.changed') {
        const command = worker.commands.find(command => command.commandId === event.payload.receipt.commandId);
        expect(command).toBeDefined();
        expect(local.queueCommand(command!).status).toBe('pending');
      }
      expect(local.applyWorkerEvent(event)).toBe('applied');
      expect(local.applyWorkerEvent(event)).toBe('duplicate');
      if (event.kind === 'action.outcome' && event.payload.actionId === worker.intent.action.actionId) {
        if (event.payload.state === 'dispatching') {
          reservations++; expect(event.campaign?.evidence).toBeNull();
          expect(readCap()).toEqual({ revision: 2, reserved: 1, sent: 0 });
        }
        if (event.payload.state === 'provider_accepted') {
          accepted++; expect(readCap()).toEqual({ revision: 3, reserved: 0, sent: 1 });
          expect(event.campaign?.evidence).not.toBeNull();
          expect(workerEventSchema.safeParse({ ...event, campaign: { ...event.campaign, evidence: { ...event.campaign!.evidence!, actionId: 'wrong-action' } } }).success).toBe(false);
        }
      }
    }
    expect(reservations).toBe(1); expect(accepted).toBe(1); expect(worker.sends()).toBe(1);
    closeDatabase(db); db = openDatabase({ path: temp.path, key });
    expect(readCap()).toEqual({ revision: 3, reserved: 0, sent: 1 });
    const reopened = new DelegationRepository({ database: db, workspaceId, clock });
    for (const event of events) expect(reopened.applyWorkerEvent(event)).toBe('duplicate');
    expect(readCap()).toEqual({ revision: 3, reserved: 0, sent: 1 });
  } finally { closeDatabase(db); key.bytes.fill(0); temp.cleanup(); }
});
