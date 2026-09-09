import { expect, it } from 'vitest';
import { SqlRequestedFollowupRepository, type RequestedOwnerContext } from '../../src/main/outreach/requestedFollowupRepository';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
it('reads only the actual requested-draft table and does not fabricate missing rows', async () => {
  const f = await createPmFixture();
  try {
    const repo = new SqlRequestedFollowupRepository({ database: f.db, workspaceId: 'ws', clock: { now: () => PM_NOW }, mailbox: () => ({ subject: 'sub1', sender: 'founder@fixture.invalid' }) });
    expect(repo.get('a1', 'missing')).toBeNull();
  } finally { f.close(); }
});
import { randomUUID, createHash } from 'node:crypto';
import { requestedFollowupFixture } from '../fixtures/requestedFollowup';
import { accountFingerprint } from '../../src/main/domain/accounts/accountEvidence';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { createTestWorkspaceKey } from '../fixtures/tempDatabase';
import { createRequestedFollowupService } from '../../src/main/outreach/requestedFollowupService';
async function fixture() {
  const local = await createPmFixture();
  const account = local.repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: null });
  const excerpt = 'Fictional phone +12025550123';
  local.repo.admitEvidence({ commandId: randomUUID(), accountId: account.id, expectedVersion: 1,
    sources: [{ id: 'phone-source', url: 'https://example.invalid/team', fetchedAt: PM_NOW, sha256: createHash('sha256').update(excerpt).digest('hex'), excerpt, permitted: true }], claims: [],
    routes: [{ id: 'phone1', accountId: account.id, personId: null, channel: 'phone', value: '+12025550123', purpose: 'business', verification: 'published', evidenceIds: ['phone-source'] }] });
  const f = requestedFollowupFixture(account.id, 2), raw = local.db.raw;
  new DelegationRepository({ database: local.db, workspaceId: 'ws', clock: { now: () => PM_NOW } }).initializeLocalAuthority(account.id);
  raw.prepare('UPDATE delegated_authorities SET aggregate_version=2 WHERE account_id=?').run(account.id);
  raw.prepare('INSERT INTO delegated_commands VALUES(?,?,?,?,?,?,?)').run(f.command.commandId, 'ws', account.id, f.ref.commandFingerprint, JSON.stringify(f.command), JSON.stringify({ ...f.receipt, status: 'pending' }), PM_NOW);
  for (const event of [f.handoffEvent, f.event]) raw.prepare('INSERT INTO delegated_applied_events VALUES(?,?,?,?,?,?,?,?,?)').run(event.id, 'ws', account.id, 'execution', event.aggregateVersion, event.authorityGeneration, accountFingerprint(event), JSON.stringify(event), PM_NOW);
  const h = f.handoff;
  raw.prepare('INSERT INTO delegated_manual_handoffs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('ws', account.id, h.handoffId, h.actionId, 0, h.targetHash, h.contentHash, h.contextRevision, h.channel, h.routeId, h.routeVersion, h.expiresAt, f.handoffEvent.id, PM_NOW, f.command.commandId);
  const deps = { database: local.db, workspaceId: 'ws', clock: { now: () => PM_NOW }, mailbox: () => ({ subject: 'sub1', sender: f.draft.sender }) };
  return { ...f, local, deps, repo: new SqlRequestedFollowupRepository(deps) };
}
it('persists real encrypted manual edit/restart without fake Person/thread and respects immutable call evidence', async () => {
  const f = await fixture();
  try {
    const service = createRequestedFollowupService({ store: f.repo, clock: f.deps.clock, id: () => 'local-manual' });
    const saved = await service.prepareRequestedFollowup({ accountId: f.draft.accountId, originalCall: f.ref, recipientBinding: f.draft.recipientBinding, expectedAccountVersion: 2, mode: 'manual' }, new AbortController().signal);
    expect(saved.draft).toMatchObject({ body: '', generation: 'edited' }); expect(saved.stale).toBe(true);
    const edited = await service.editRequestedFollowup({ accountId: f.draft.accountId, draftId: 'local-manual', expectedRevision: 1, subject: 'Requested information', body: 'My editable information' });
    expect(() => f.repo.save({ ...edited.draft, revision: 3, sender: 'other@fixture.invalid' }, 2)).toThrow();
    closeDatabase(f.local.db); const reopened = openDatabase({ path: f.local.db.path, key: createTestWorkspaceKey() });
    try { const restored = new SqlRequestedFollowupRepository({ ...f.deps, database: reopened });
      expect(restored.get(f.draft.accountId, 'local-manual')?.draft).toEqual(edited.draft);
      expect(reopened.raw.prepare('SELECT count(*) n FROM delegated_threads').get()).toEqual({ n: 0 });
      expect(reopened.raw.prepare('SELECT * FROM persons ORDER BY id').all()).toEqual(f.local.historicalPersons);
      expect(() => restored.save({ ...edited.draft, revision: 3, originalCall: { ...f.ref, outcomeEventHash: 'b'.repeat(64) } }, 2)).toThrow();
    } finally { closeDatabase(reopened); }
  } finally { f.local.close(); }
});
it('worker-owned preparation requires actual current owner proof instead of a local-only cursor', async () => {
  const f = await fixture();
  try {
    f.local.db.raw.prepare("UPDATE delegated_authorities SET owner='worker',state='active' WHERE account_id=?").run(f.draft.accountId);
    const input = { accountId: f.draft.accountId, originalCall: f.ref, recipientBinding: f.draft.recipientBinding, expectedAccountVersion: 2, mode: 'manual' as const };
    expect(() => f.repo.readContext(input)).toThrow('requested_owner_context_required');
  } finally { f.local.close(); }
});
it('worker owner proof rejects foreign, expired, changed and detached contexts at consumption', async () => {
  const f = await fixture();
  try {
    f.local.db.raw.prepare("UPDATE delegated_authorities SET owner='worker',state='active' WHERE account_id=?").run(f.draft.accountId);
    const input = { accountId: f.draft.accountId, originalCall: f.ref, recipientBinding: f.draft.recipientBinding, expectedAccountVersion: 2, mode: 'manual' as const };
    const proof: RequestedOwnerContext = { workspaceId: 'ws', accountId: f.draft.accountId, mailbox: f.deps.mailbox(), mailContext: f.draft.mailContext, accountVersion: 2, researchRevision: 1, authorityGeneration: 0, aggregateVersion: 2, cursor: null, expiresAt: '2026-09-08T12:00:30.000Z' };
    const repo = (ownerContext: () => RequestedOwnerContext) => new SqlRequestedFollowupRepository({ ...f.deps, ownerContext });
    expect(repo(() => proof).readContext(input).mailContext).toEqual(proof.mailContext);
    for (const bad of [{ ...proof, accountId: 'foreign' }, { ...proof, expiresAt: PM_NOW }, { ...proof, authorityGeneration: 2 }, { ...proof, mailContext: { ...proof.mailContext, inboundContextFingerprint: 'b'.repeat(64) } }]) {
      expect(() => repo(() => bad).readContext(input)).toThrow();
    }
    expect(() => repo(() => { throw new Error('lease detached'); }).readContext(input)).toThrow('lease detached');
  } finally { f.local.close(); }
});
it('editing clears only the mutable approval pointer, preserving immutable call and command history', async () => {
  const f = await fixture();
  try {
    f.repo.save(f.draft, null);
    const approval = { receipt: { ...f.receipt, commandId: 'approval-command' }, state: 'materialized', intentCommandId: 'intent1', reason: null as null };
    f.local.db.raw.prepare('UPDATE delegated_requested_followup_drafts SET approval_json=? WHERE id=?').run(JSON.stringify(approval), f.draft.id);
    const before = f.local.db.raw.prepare('SELECT * FROM delegated_applied_events ORDER BY id').all();
    f.repo.save({ ...f.draft, revision: 2, body: 'New reviewed text' }, 1);
    expect(f.repo.get(f.draft.accountId, f.draft.id)?.approval).toBeNull();
    expect(f.local.db.raw.prepare('SELECT * FROM delegated_applied_events ORDER BY id').all()).toEqual(before);
  } finally { f.local.close(); }
});
