import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { SendEvidence } from '../../cloud/lambdas/delegated-worker/src/dispatchRepository';
import { fingerprint } from '../../cloud/lambdas/delegated-worker/src/dynamoStore';
import { campaignFixture } from '../../cloud/lambdas/delegated-worker/test/dispatchFixture';
import { openDatabase, closeDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { CampaignRepository } from '../../src/main/domain/campaign/campaignRepository';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { workerEventSchema } from '../../src/shared/contracts/delegationContract';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';

it.each([{ first: 'provider_accepted', kind: 'provider_result' }, { first: 'cancelled', kind: 'provider_result' }, { first: 'cancelled', kind: 'sent_lookup' }] as const)('projects actual C4 $first/$kind contrary late fact through canonical SQL and durable reopen', async ({ first, kind }) => {
  const worker = await campaignFixture(true);
  if (first === 'cancelled') worker.onSend(async () => new Response('', { status: 403 }));
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
    expect((await worker.service().dispatch(worker.intent.commandId)).status).toBe(first === 'cancelled' ? 'not_sent' : 'provider_accepted');
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
    expect(reservations).toBe(1); expect(accepted).toBe(first === 'provider_accepted' ? 1 : 0); expect(worker.sends()).toBe(1);
    const expectedCap = { revision: 3, reserved: 0, sent: first === 'provider_accepted' ? 1 : 0 };
    const originalReceipts = db.raw.prepare('SELECT * FROM campaign_step_receipts').all();
    const original = (await worker.policy.sendEvidence(worker.intent.commandId))[0]!;
    const late: SendEvidence = { ...original, state: first === 'cancelled' ? 'provider_accepted' : 'cancelled', kind,
      reason: kind === 'sent_lookup' ? 'sent_match' : first === 'cancelled' ? 'provider_accepted' : 'provider_not_sent', providerIdentity: first === 'cancelled' ? { messageId: 'late-original-result', threadId: 'thread1' } : null };
    const outcome = { reservation: late.reservation, state: late.state, observedAt: late.observedAt, evidenceRef: `${kind === 'sent_lookup' ? 'sent' : 'send'}-${fingerprint(late)}` };
    await worker.execution.appendOutcome(outcome, late);
    const conflict = (await worker.execution.eventsAfter(null)).events.find(event => event.kind === 'action.outcome' && event.payload.evidenceRef === outcome.evidenceRef)!;
    expect(workerEventSchema.parse(conflict)).toHaveProperty('payload.state', first);
    expect(local.applyWorkerEvent(conflict)).toBe('applied');
    expect(local.applyWorkerEvent(conflict)).toBe('duplicate');
    expect(readCap()).toEqual(expectedCap);
    const receipts = db.raw.prepare('SELECT * FROM campaign_step_receipts').all();
    expect(receipts).toHaveLength(originalReceipts.length + 1);
    expect(receipts).toEqual(expect.arrayContaining(originalReceipts));
    expect(receipts).toEqual(expect.arrayContaining([expect.objectContaining({ state: late.state, outcome: expect.stringContaining('conflict:contradictory_finalized_outcome:') })]));
    expect(db.raw.prepare('SELECT state FROM campaign_enrollments WHERE id=?').get('enrollment')).toEqual({ state: 'held' });
    await worker.execution.appendOutcome(outcome, late);
    expect((await worker.execution.eventsAfter(null)).events).toHaveLength(events.length + 1);
    events.push(conflict);
    closeDatabase(db); db = openDatabase({ path: temp.path, key });
    expect(readCap()).toEqual(expectedCap);
    const reopened = new DelegationRepository({ database: db, workspaceId, clock });
    for (const event of events) expect(reopened.applyWorkerEvent(event)).toBe('duplicate');
    expect(readCap()).toEqual(expectedCap);
    expect(db.raw.prepare('SELECT * FROM campaign_step_receipts').all()).toEqual(receipts);
  } finally { closeDatabase(db); key.bytes.fill(0); temp.cleanup(); }
});
