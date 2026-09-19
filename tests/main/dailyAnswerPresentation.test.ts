import { randomUUID, createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createDomainServices } from '../../src/main/domain/createDomainServices';

import { createCampaignFixture } from '../fixtures/campaignWorkspace';
import { requestedFollowupFixture } from '../fixtures/requestedFollowup';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { accountFingerprint } from '../../src/main/domain/accounts/accountEvidence';
import type { RequestedFollowupDraft } from '../../src/shared/contracts/requestedFollowupContract';
async function requestedFixture(options: { owner?: boolean; person?: 'deleted' | 'blank' | 'missing'; role?: 'conflict' | 'expired' | 'future' | 'unsupported' | 'malformed'; note?: string; call?: 'hash' | 'foreign' | 'future' | 'malformed' } = {}) {
  const f = await createCampaignFixture();
  const raw = f.db.raw, personId = 'named-person';
  raw.prepare('INSERT INTO persons(id,display_name,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?)').run(personId, options.person === 'blank' ? ' ' : 'Nora Exact', f.now, f.now, options.person === 'deleted' ? f.now : null);
  const accounts = new AccountRepository({ database: f.db, clock: f.clock, ids: { next: randomUUID }, sourcePolicy: { attest: () => true } });
  const sourceId = 'named-source';
  const route = { id: 'named-route', accountId: f.account.id, personId: options.person === 'missing' ? null : personId, channel: 'email' as const, value: 'nora@fixture.invalid', purpose: 'business' as const, verification: 'published' as const, evidenceIds: [sourceId] };
  accounts.admitEvidence({ commandId: randomUUID(), accountId: f.account.id, expectedVersion: 2, claims: [], sources: [{ id: sourceId, url: 'https://example.invalid/team', fetchedAt: f.now, sha256: 'c'.repeat(64), excerpt: 'Nora Exact, portfolio manager', permitted: true }], routes: [route, { ...route, id: 'phone1', channel: 'phone', value: '+12025550123' }] });
  accounts.admitEvidence({ commandId: randomUUID(), accountId: f.account.id, expectedVersion: 3, claims: [], sources: [], routes: [{ ...route, value: 'another@fixture.invalid', personId: null }] });
  if (options.role !== 'unsupported') {
    accounts.admitLinks({ commandId: randomUUID(), accountId: f.account.id, expectedVersion: 4, links: [{ id: 'role-a', kind: 'person_role', personId, role: 'Portfolio manager', relationship: 'team', authority: 'unconfirmed', authorityEvidenceIds: [], evidenceIds: [sourceId], validFrom: options.role === 'future' ? '2027-01-01T00:00:00.000Z' : '2026-01-01T00:00:00.000Z', validTo: options.role === 'expired' ? f.now : null }, ...(options.role === 'conflict' ? [{ id: 'role-b', kind: 'person_role' as const, personId, role: 'Different role', relationship: 'team', authority: 'unconfirmed' as const, authorityEvidenceIds: [] as string[], evidenceIds: [sourceId], validFrom: '2026-01-01T00:00:00.000Z', validTo: null as null }] : [])] });
    if (options.role === 'malformed') { raw.exec('DROP TRIGGER pm_account_links_no_update'); raw.prepare("UPDATE pm_account_links SET valid_from='malformed' WHERE id='role-a'").run(); }
  }
  const call = requestedFollowupFixture(f.account.id, 4, options.note);
  const h = { ...call.handoff, targetHash: createHash('sha256').update('+12025550123').digest('hex') };
  const command = { ...call.command, workspaceId: f.workspaceId, payload: { ...call.command.payload, targetHash: h.targetHash } };
  const event = { ...call.event, workspaceId: options.call === 'foreign' ? 'foreign' : f.workspaceId };
  if (options.call === 'future' && event.kind === 'manual.outcome' && command.kind === 'complete-manual') {
    event.payload = { ...event.payload, observedAt: '2027-01-01T00:00:00.000Z' }; command.payload = { ...command.payload, outcome: event.payload };
  }
  const handoffEvent = { ...call.handoffEvent, workspaceId: f.workspaceId, payload: h };
  const ref = { ...call.ref, commandFingerprint: accountFingerprint(command), outcomeEventHash: accountFingerprint(event) };
  const draft: RequestedFollowupDraft = { ...call.draft, originalCall: ref, recipient: route.value, recipientBinding: options.owner ? { kind: 'owner_supplied', email: route.value, originalCall: ref } : { kind: 'account_route', routeId: route.id, routeVersion: 1, email: route.value } };
  raw.prepare('INSERT INTO delegated_commands VALUES(?,?,?,?,?,?,?)').run(command.commandId, f.workspaceId, f.account.id, options.call === 'hash' ? 'f'.repeat(64) : ref.commandFingerprint, JSON.stringify(command), JSON.stringify(call.receipt), f.now);
  for (const e of [handoffEvent, event]) raw.prepare('INSERT INTO delegated_applied_events VALUES(?,?,?,?,?,?,?,?,?)').run(e.id, f.workspaceId, f.account.id, 'execution', e.aggregateVersion, e.authorityGeneration, accountFingerprint(e), options.call === 'malformed' && e.id === event.id ? '{}' : JSON.stringify(e), f.now);
  raw.prepare('INSERT INTO delegated_manual_handoffs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(f.workspaceId, f.account.id, h.handoffId, h.actionId, 0, h.targetHash, h.contentHash, h.contextRevision, h.channel, h.routeId, h.routeVersion, h.expiresAt, handoffEvent.id, f.now, null);
  raw.prepare('INSERT INTO delegated_requested_followup_drafts VALUES(?,?,?,?,?,?,?,?)').run(f.workspaceId, f.account.id, draft.id, draft.revision, draft.contextRevision, JSON.stringify(draft), null, f.now);
  const services = createDomainServices({ database: f.db, clock: f.clock, ids: { next: () => { throw Error('read allocated ID'); } }, expectedWorkspaceId: f.workspaceId });
  return { ...f, draft, read: () => services.daily.get(), answer: () => services.daily.get().answers.find(a => a.kind === 'requested_followup') };
}
it('joins exact historical email identity, role evidence and human note without rewriting saved work', async () => {
  const f = await requestedFixture({ note: 'Please email information.' }); try {
    const before = f.db.raw.prepare('SELECT total_changes() AS n').get(), saved = f.db.raw.prepare('SELECT * FROM delegated_requested_followup_drafts').all();
    expect(f.answer()).toMatchObject({ draft: f.draft, capability: 'held', presentation: { contact: { displayName: 'Nora Exact', route: { version: 1, value: 'nora@fixture.invalid' }, role: { value: 'Portfolio manager', linkId: 'role-a', evidenceIds: ['named-source'] } }, callContext: { basis: 'human_reported_call_outcome', observedAt: '2026-09-08T12:00:00.000Z', noteText: 'Please email information.' } } });
    expect(f.db.raw.prepare('SELECT * FROM delegated_requested_followup_drafts').all()).toEqual(saved); expect(f.db.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  } finally { f.close(); }
});
it.each(['conflict', 'expired', 'future', 'unsupported', 'malformed'] as const)('omits %s role while retaining identity', async role => {
  const f = await requestedFixture({ role }); try { expect(f.answer()).toMatchObject({ draft: f.draft, presentation: { contact: { displayName: 'Nora Exact', role: null } } }); } finally { f.close(); }
});
it.each(['deleted', 'blank', 'missing'] as const)('omits %s person without dropping valid call or draft', async person => {
  const f = await requestedFixture({ person }); try { expect(f.answer()).toMatchObject({ draft: f.draft, presentation: { contact: null, callContext: { outcome: 'connected' } } }); } finally { f.close(); }
});
it.each(['hash', 'foreign', 'future', 'malformed'] as const)('omits %s call evidence while preserving exact recipient', async call => {
  const f = await requestedFixture({ call }); try { expect(f.answer()).toMatchObject({ draft: f.draft, presentation: { contact: { displayName: 'Nora Exact' }, callContext: null } }); } finally { f.close(); }
});
it('keeps owner-supplied recipient unnamed and missing note distinct from valid outcome time', async () => {
  const f = await requestedFixture({ owner: true }); try { expect(f.answer()).toMatchObject({ draft: f.draft, presentation: { contact: null, callContext: { linkedContact: { displayName: 'Nora Exact', basis: 'original_call_route' }, noteText: null, observedAt: '2026-09-08T12:00:00.000Z' } } }); } finally { f.close(); }
});

it('retains valid identity and call time when optional human note is malformed', async () => {
  const f = await requestedFixture({ note: 'bad\0note' }); try {
    expect(f.answer()).toMatchObject({ draft: f.draft, presentation: { contact: { displayName: 'Nora Exact' }, callContext: { outcome: 'connected', noteText: null, observedAt: '2026-09-08T12:00:00.000Z' } } });
  } finally { f.close(); }
});
import { ownerCommandSchema } from '../../src/shared/contracts/ownerCommandContract';
import { workerEventSchema } from '../../src/shared/contracts/delegationContract';
import { dailySnapshotSchema } from '../../src/shared/contracts/dailyContract';
it('preserves exact approval and command bytes through optional identity loss, while keeping global scope checks', async () => {
  const f = await requestedFixture(); try {
    const commandId = randomUUID();
    const receipt = { commandId, status: 'applied' as const, authorityGeneration: 0, aggregateVersion: 3, reason: null as null };
    const status = { receipt, state: 'materialized' as const, intentCommandId: randomUUID(), reason: null as null };
    const command = ownerCommandSchema.parse({ commandId, workspaceId: f.workspaceId, accountId: f.account.id, expectedAuthorityGeneration: 0, expectedVersion: 2, kind: 'approve-requested-followup', payload: { draft: f.draft, expectedRemoteDraftRevision: null, approvalId: 'approval', actionId: 'email-action', intentCommandId: status.intentCommandId, request: { statement: 'recipient_requested_information_by_email', recipient: f.draft.recipient }, expiresAt: '2026-09-10T12:00:00.000Z' } });
    f.db.raw.prepare('UPDATE delegated_requested_followup_drafts SET approval_json=?').run(JSON.stringify(status));
    f.db.raw.prepare('INSERT INTO delegated_commands VALUES(?,?,?,?,?,?,?)').run(commandId, f.workspaceId, f.account.id, accountFingerprint(command), JSON.stringify(command), JSON.stringify(receipt), f.now);
    const event = workerEventSchema.parse({ id: randomUUID(), workspaceId: f.workspaceId, accountId: f.account.id, authorityGeneration: 0, aggregateVersion: 3, kind: 'requested_followup.status', payload: { commandId, draftId: f.draft.id, status } });
    f.db.raw.prepare('INSERT INTO delegated_applied_events VALUES(?,?,?,?,?,?,?,?,?)').run(event.id, f.workspaceId, f.account.id, 'execution', 3, 0, accountFingerprint(event), JSON.stringify(event), f.now);
    const snapshot = f.read(), answer = snapshot.answers.find(a => a.kind === 'requested_followup');
    expect(answer).toMatchObject({ draft: f.draft, approval: status, presentation: { contact: { displayName: 'Nora Exact' } } });
    if (answer?.kind !== 'requested_followup') throw Error('missing requested');
    for (const changed of [{ ...answer.presentation, asOf: '2020-01-01T00:00:00.000Z' }, { ...answer.presentation, binding: { ...answer.presentation.binding, workspaceId: 'foreign' } }]) {
      const parsed = dailySnapshotSchema.parse({ ...snapshot, answers: [{ ...answer, presentation: changed }] });
      expect(parsed.answers[0]).not.toHaveProperty('presentation');
      expect(parsed.answers[0]).toMatchObject({ draft: f.draft, approval: status });
    }
    expect(dailySnapshotSchema.safeParse({ ...snapshot, workspaceId: null }).success).toBe(false);
    f.db.raw.prepare("UPDATE persons SET display_name=' ' WHERE id='named-person'").run();
    const saved = f.db.raw.prepare('SELECT * FROM delegated_requested_followup_drafts').all(), commands = f.db.raw.prepare('SELECT * FROM delegated_commands ORDER BY command_id').all(), before = f.db.raw.prepare('SELECT total_changes() n').get();
    expect(f.answer()).toMatchObject({ draft: f.draft, approval: status, presentation: { contact: null } });
    expect(f.db.raw.prepare('SELECT * FROM delegated_requested_followup_drafts').all()).toEqual(saved);
    expect(f.db.raw.prepare('SELECT * FROM delegated_commands ORDER BY command_id').all()).toEqual(commands);
    expect(f.db.raw.prepare('SELECT total_changes() n').get()).toEqual(before);
  } finally { f.close(); }
});

it('degrades producer-admitted invalid role only, preserving exact requested name and original call context', async () => {
  const f = await requestedFixture({ role: 'unsupported', note: 'Original human note' }); try {
    const accounts = new AccountRepository({ database: f.db, clock: f.clock, ids: { next: randomUUID } });
    accounts.admitLinks({ commandId: randomUUID(), accountId: f.account.id, expectedVersion: 4, links: [{ id: 'invalid-display-role', kind: 'person_role', personId: 'named-person', role: 'Portfolio\0manager', relationship: 'team', authority: 'unconfirmed', authorityEvidenceIds: [], evidenceIds: ['named-source'], validFrom: '2026-01-01T00:00:00.000Z', validTo: null }] });
    const before = f.db.raw.prepare('SELECT total_changes() n').get();
    expect(f.answer()).toMatchObject({ draft: f.draft, presentation: { contact: { displayName: 'Nora Exact', role: null }, callContext: { noteText: 'Original human note', observedAt: '2026-09-08T12:00:00.000Z' }, issues: expect.arrayContaining([{ field: 'role', reason: 'invalid_source' }]) } });
    expect(f.db.raw.prepare('SELECT total_changes() n').get()).toEqual(before);
  } finally { f.close(); }
});
