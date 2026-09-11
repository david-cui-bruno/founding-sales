import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCampaignFixture } from '../fixtures/campaignWorkspace';
import { requestedFollowupFixture } from '../fixtures/requestedFollowup';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { accountFingerprint } from '../../src/main/domain/accounts/accountEvidence';
import { createCompanyResearchWorker } from '../../src/main/research/companyResearchWorker';
import { ownerCommandSchema } from '../../src/shared/contracts/ownerCommandContract';
import { workerEventSchema } from '../../src/shared/contracts/delegationContract';

async function fixture() {
  const f = await createCampaignFixture();
  const services = createDomainServices({ database: f.db, clock: f.clock, ids: { next: () => { throw Error('read allocated ID'); } }, expectedWorkspaceId: f.workspaceId });
  return { ...f, read: () => services.daily.get() };
}

describe('D3a persisted review regressions', () => {
  it('aggregates worker-parked research in trusted scope without research answers or read writes', async () => {
    const f = await fixture(); try {
      const store = new AccountRepository({ database: f.db, clock: f.clock, ids: { next: randomUUID }, research: { maxBudgetMicros: 10000 } });
      const foreign = store.create({ commandId: randomUUID(), name: 'Other workspace fixture', domain: null });
      f.db.raw.prepare("INSERT INTO delegated_authorities VALUES(?,?,'local',0,'local',0,?)").run(foreign.id, 'other', f.now);
      const worker = createCompanyResearchWorker({ store, clock: f.clock, pages: { research: async () => { throw Error('fixture research failure, no network'); } } });
      for (const accountId of [f.account.id, f.account.id, foreign.id]) {
        store.enqueue({ commandId: randomUUID(), accountId, limits: { maxCompanies: 1, maxPages: 1, maxBytes: 100, maxCostMicros: 100 } });
        expect(await worker.runNext(new AbortController().signal)).toBe('parked');
      }
      f.db.raw.prepare('UPDATE meeting_first_call_settings SET new_call_slots=0').run();
      const before = f.db.raw.prepare('SELECT total_changes() AS n').get();
      const snapshot = f.read();
      expect(snapshot.issues).toEqual([{ code: 'research_failed', count: 2 }]);
      expect(snapshot.freshness.kind).toBe('incomplete');
      expect(snapshot.answers).toEqual([]);
      expect(f.db.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    } finally { f.close(); }
  });

  it.each(['foreign_workspace', 'wrong_receipt', 'valid'] as const)('binds persisted requested approval: %s', async corruption => {
    const f = await fixture(); try {
      const { draft } = requestedFollowupFixture(f.account.id, 2);
      const commandId = randomUUID();
      const receipt = { commandId, status: 'applied' as const, authorityGeneration: 0, aggregateVersion: 2, reason: null as null };
      const status = { receipt, state: 'materialized' as const, intentCommandId: randomUUID(), reason: null as null };
      const command = ownerCommandSchema.parse({ commandId, workspaceId: corruption === 'foreign_workspace' ? 'other' : f.workspaceId, accountId: f.account.id, expectedAuthorityGeneration: 0, expectedVersion: 1, kind: 'approve-requested-followup', payload: { draft, expectedRemoteDraftRevision: null, approvalId: 'approval', actionId: 'action', intentCommandId: status.intentCommandId, request: { statement: 'recipient_requested_information_by_email', recipient: draft.recipient }, expiresAt: '2026-09-10T12:00:00.000Z' } });
      f.db.raw.prepare('INSERT INTO delegated_requested_followup_drafts VALUES(?,?,?,?,?,?,?,?)').run(f.workspaceId, f.account.id, draft.id, draft.revision, draft.contextRevision, JSON.stringify(draft), JSON.stringify(status), f.now);
      f.db.raw.prepare('INSERT INTO delegated_commands VALUES(?,?,?,?,?,?,?)').run(commandId, f.workspaceId, f.account.id, accountFingerprint(command), JSON.stringify(command), JSON.stringify({ ...receipt, commandId: corruption === 'wrong_receipt' ? randomUUID() : commandId }), f.now);
      if (corruption !== 'wrong_receipt') {
        const event = workerEventSchema.parse({ id: randomUUID(), workspaceId: command.workspaceId, accountId: f.account.id, authorityGeneration: 0, aggregateVersion: 2, kind: 'requested_followup.status', payload: { commandId, draftId: draft.id, status } });
        f.db.raw.prepare('INSERT INTO delegated_applied_events VALUES(?,?,?,?,?,?,?,?,?)').run(event.id, event.workspaceId, f.account.id, 'execution', 2, 0, accountFingerprint(event), JSON.stringify(event), f.now);
      }
      const before = f.db.raw.prepare('SELECT total_changes() AS n').get();
      const snapshot = f.read();
      const answer = snapshot.answers.find(a => a.kind === 'requested_followup');
      expect(answer?.kind).toBe('requested_followup');
      if (answer?.kind !== 'requested_followup') throw Error('missing saved draft');
      expect(answer.draft).toEqual(draft);
      expect(answer.approval).toEqual(corruption === 'valid' ? status : null);
      if (corruption !== 'valid') expect(snapshot.issues).toContainEqual({ code: 'invalid_local_record', count: 1 });
      expect(f.db.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    } finally { f.close(); }
  });

  it.each(['id', 'campaign_id', 'version', 'hash'] as const)('rejects dirty frozen campaign %s before dependent lookups', async field => {
    const f = await fixture(); try {
      // Insert a new unapproved row with valid JSON but deliberately contradictory outer identity.
      const version = { ...f.versions[0]!, id: randomUUID(), campaignId: randomUUID(), version: 1 };
      const rowId = field === 'id' ? randomUUID() : version.id;
      f.db.raw.prepare('INSERT INTO campaign_versions VALUES(?,?,?,?,?,?,?)').run(f.workspaceId, rowId, field === 'campaign_id' ? randomUUID() : version.campaignId,
        field === 'version' ? 2 : version.version, JSON.stringify(version), field === 'hash' ? 'f'.repeat(64) : accountFingerprint(version), f.now);
      const before = f.db.raw.prepare('SELECT total_changes() AS n').get();
      const snapshot = f.read();
      expect(snapshot.campaigns.map(c => c.version.id).sort()).toEqual(f.versions.map(v => v.id).sort());
      expect(snapshot.issues).toContainEqual({ code: 'invalid_local_record', count: 1 });
      // Existing approved rows must still validate against frozen approvedAt:null, not the overlaid timestamp.
      expect(snapshot.campaigns.every(c => c.version.approvedAt === f.now)).toBe(true);
      expect(f.db.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    } finally { f.close(); }
  });
});
