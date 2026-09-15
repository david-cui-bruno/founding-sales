import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCampaignFixture } from '../fixtures/campaignWorkspace';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { DailyReadService } from '../../src/main/domain/today/dailyReadService';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { requestedFollowupFixture } from '../fixtures/requestedFollowup';
import { createLinkedInFixture } from '../fixtures/linkedInWorkspace';
import { openDatabase, closeDatabase } from '../../src/main/db/database';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';

async function fixture() {
  const f = await createCampaignFixture();
  const services = createDomainServices({ database: f.db, clock: f.clock, ids: { next: randomUUID }, expectedWorkspaceId: f.workspaceId });
  const read = (workspaceId: string | undefined = f.workspaceId) => new DailyReadService({ database: f.db, clock: f.clock, ids: { next: () => { throw Error('read allocated ID'); } }, today: services.today, settings: services.workspaceSettings, workspaceId }).get();
  return { ...f, services, read };
}
describe('daily persisted local snapshot', () => {
  it('skips persisted email-only new calls without removing their evidence or writing', async () => {
    const f = await fixture(); try {
      const saved = (accountId: string, channel: 'email' | 'phone') => {
        let firstId = true;
        const accounts = new AccountRepository({ database: f.db, clock: f.clock,
          ids: { next: () => { if (firstId) { firstId = false; return accountId; } return randomUUID(); } }, sourcePolicy: { attest: source => source.url === 'https://example.invalid/team' } });
        const account = accounts.create({ commandId: randomUUID(), name: accountId, domain: 'example.invalid' });
        const sourceId = randomUUID();
        accounts.admitEvidence({ commandId: randomUUID(), accountId, expectedVersion: account.version,
          sources: [{ id: sourceId, url: 'https://example.invalid/team', fetchedAt: f.now,
            sha256: 'a'.repeat(64), excerpt: 'Fictional regional residential manager business contact.', permitted: true }],
          claims: [
            { kind: 'fact', key: 'residential_scope', value: 'Residential property management', evidenceIds: [sourceId] },
            { kind: 'fact', key: 'operating_footprint', value: 'Regional property manager', evidenceIds: [sourceId] },
          ],
          routes: [{ id: randomUUID(), accountId, personId: null, channel,
            value: channel === 'email' ? 'office@example.invalid' : '+12025550103',
            purpose: 'business', verification: 'published', evidenceIds: [sourceId] }],
        });
        return accounts.snapshot(accountId, f.now);
      };
      // DailyReadService reads account IDs in order, so the email precedes the phone.
      const email = saved('queue-a-email', 'email');
      const phone = saved('queue-b-phone', 'phone');
      f.db.raw.prepare('UPDATE meeting_first_call_settings SET new_call_slots=1').run();
      const before = f.db.raw.prepare('SELECT total_changes() AS n').get();
      const snapshot = f.read(); // This real reader throws if any ID is allocated.
      expect(snapshot.accounts.find(a => a.account.id === email.account.id)).toEqual(email);
      expect(snapshot.accounts.find(a => a.account.id === phone.account.id)).toEqual(phone);
      expect(snapshot.accounts.findIndex(a => a.account.id === email.account.id))
        .toBeLessThan(snapshot.accounts.findIndex(a => a.account.id === phone.account.id));
      expect(f.db.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
      expect(snapshot.calls.accountIds).toEqual([phone.account.id]);
      expect(f.read().revision).toBe(snapshot.revision);
      expect(f.db.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    } finally { f.close(); }
  });

  it('reads frozen campaigns and company-only accounts with exact B3 due calls without any writes', async () => {
    const f = await fixture(); try {
      const enrollment = f.repo.enroll({ commandId: randomUUID(), accountId: f.account.id, selectedRouteId: f.routes[0].id, campaignVersionId: f.versions[0].id, executionContextId: 'ctx', contextRevision: 1 });
      f.db.raw.prepare('UPDATE meeting_first_call_settings SET new_call_slots=3').run();
      const before = f.db.raw.prepare('SELECT total_changes() AS n').get();
      const snapshot = f.read();
      expect(snapshot.workflowMode).toBe('legacy');
      expect(snapshot.accounts[0]!.routes.every(r => r.personId === null)).toBe(true);
      expect(snapshot.calls.accountIds).toEqual([f.account.id]);
      expect(snapshot.callSettings.newCallSlots).toBe(3);
      expect(snapshot.campaigns[0]!.enrollments.concat(snapshot.campaigns[1]!.enrollments)).toEqual([enrollment]);
      expect(snapshot.campaigns.map(c => c.version.offer)).toEqual(f.versions.map(v => v.offer));
      expect(f.read().revision).toBe(snapshot.revision);
      expect(f.db.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    } finally { f.close(); }
  });
  it('returns no data for unknown scope, excludes other workspace ownership, and reports dirty rows', async () => {
    const f = await fixture(); try {
      new DelegationRepository({ database: f.db, workspaceId: 'other', clock: f.clock }).initializeLocalAuthority(f.account.id);
      expect(f.read().accounts).toEqual([]);
      const unknown = new DailyReadService({ database: f.db, clock: f.clock, ids: { next: randomUUID }, today: f.services.today, settings: f.services.workspaceSettings }).get();
      expect(unknown.workspaceId).toBeNull(); expect(unknown.accounts).toEqual([]);
      expect(unknown.issues).toContainEqual({ code: 'scope_unknown', count: 1 });
    } finally { f.close(); }
  });
  it('projects only C5 event identities and never synthesizes provider times on unknown outcomes', async () => {
    const f = await fixture(); try {
      const repository = new DelegationRepository({ database: f.db, workspaceId: f.workspaceId, clock: f.clock });
      repository.initializeLocalAuthority(f.account.id);
      const commandId = randomUUID();
      repository.queueCommand({ commandId, workspaceId: f.workspaceId, accountId: f.account.id, expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'delegate', payload: { delegationId: 'delegation', approvedAt: f.now } });
      repository.applyWorkerEvent({ id: randomUUID(), workspaceId: f.workspaceId, accountId: f.account.id, authorityGeneration: 1, aggregateVersion: 1, kind: 'authority.changed', payload: { authority: { accountId: f.account.id, owner: 'worker', generation: 1, state: 'active' }, receipt: { commandId, status: 'applied', authorityGeneration: 1, aggregateVersion: 1, reason: null } } });
      const identity = { meetingId: 'meeting', calendarId: 'calendar', providerEventId: 'b'.repeat(64) };
      const payload: import('../../src/shared/contracts/meetingContract').MeetingOutcomePayload = { commandId: 'meeting-command', observedAt: f.now, outcome: { ...identity, status: 'unknown' as const, reason: 'timeout', event: null } };
      f.db.raw.prepare('INSERT INTO persons(id,display_name,created_at,updated_at) VALUES(?,?,?,?)').run('legacy-person', 'Legacy fixture', f.now, f.now);
      f.db.raw.prepare("INSERT INTO activities(id,person_id,kind,direction,channel,occurred_at,observed_outcome,metadata_json,created_at) VALUES('legacy-booked','legacy-person','call','outbound','phone',?,'interview_booked','{}',?)").run(f.now, f.now);
      const booked: import('../../src/shared/contracts/meetingContract').MeetingOutcomePayload = { ...payload, outcome: { ...identity, status: 'booked' as const, reason: null as null, event: { ...identity, status: 'confirmed' as const, etag: 'etag', start: f.now, end: '2026-09-09T12:30:00.000Z', attendees: [], meetUrl: null as null } } };
      expect(repository.applyWorkerEvent({ id: randomUUID(), workspaceId: f.workspaceId, accountId: f.account.id, authorityGeneration: 1, aggregateVersion: 2, kind: 'meeting.outcome', payload: booked })).toBe('applied');
      expect(f.read().meetings.map(m => m.id)).toEqual(['meeting']);
      expect(f.read().meetings[0]!.payload).toEqual(booked);
      repository.applyWorkerEvent({ id: randomUUID(), workspaceId: f.workspaceId, accountId: f.account.id, authorityGeneration: 1, aggregateVersion: 3, kind: 'meeting.outcome', payload });
      const snapshot = f.read();
      expect(snapshot.meetings).toEqual([{ id: 'meeting', accountId: f.account.id, revision: 2, payload }]);
      expect(snapshot.ownerStatus[0]).toMatchObject({ authority: { generation: 1, owner: 'worker' }, executionVersion: 3, status: 'owner_applied' });
      f.db.raw.prepare("UPDATE delegated_meetings SET projection_json='{}'").run();
      expect(f.read().meetings).toEqual([]);
      expect(f.read().issues).toContainEqual({ code: 'invalid_local_record', count: 1 });
    } finally { f.close(); }
  });
});

it('keeps saved requested followup identity but drops an unbound approval rather than presenting it as applied', async () => {
  const f = await fixture(); try {
    const { draft, receipt } = requestedFollowupFixture(f.account.id, 2);
    f.db.raw.prepare('INSERT INTO delegated_requested_followup_drafts VALUES(?,?,?,?,?,?,?,?)').run(f.workspaceId, f.account.id, draft.id, draft.revision, draft.contextRevision, JSON.stringify(draft), JSON.stringify({ receipt, state: 'materialized', intentCommandId: 'intent', reason: null }), f.now);
    const snapshot = f.read();
    expect(snapshot.answers).toContainEqual({ kind: 'requested_followup', accountId: f.account.id, draft, approval: null, capability: 'held', reason: 'requires_owner_preflight' });
    expect(snapshot.issues).toContainEqual({ code: 'invalid_local_record', count: 1 });
  } finally { f.close(); }
});

it('recovers exact saved D2 manual draft without preparing, opening, copying or consuming a handoff', async () => {
  const f = await createLinkedInFixture(); try {
    const draft = f.drafts.create(f.drafts.requireStep(f.version.steps[0]!.id, 1), 'Existing manual text');
    const services = createDomainServices({ database: f.db, clock: f.clock, ids: { next: () => { throw Error('Unexpected ID'); } }, expectedWorkspaceId: f.workspaceId });
    const before = f.db.raw.prepare('SELECT total_changes() AS n').get();
    const answer = services.daily.get().answers.find(a => a.kind === 'manual_linkedin');
    if (answer?.kind !== 'manual_linkedin') throw Error('missing manual answer');
    const { presentation, ...saved } = answer;
    expect(presentation?.contact).toMatchObject({ personId: f.personId, displayName: 'Fictional Person' });
    expect(saved).toEqual({ kind: 'manual_linkedin', accountId: f.account.id, draft, capability: 'manual_only', recovery: { draftId: draft.id, revision: 1, approvalCommandId: null, attempts: [], handoffId: null, started: false } });
    expect(f.db.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  } finally { f.close(); }
});

it('preserves an exact saved reply, marks stale context, and reads the same revision after encrypted reopen', async () => {
  const f = await fixture(); try {
    const thread: import('../../src/shared/contracts/mailThreadContract').ThreadProjection = { thread: { accountId: f.account.id, mailboxSubject: 'mailbox', provider: 'gmail', providerThreadId: 'thread', messages: [{ id: 'message', threadId: 'thread', rfcMessageId: null, references: [], from: ['person@example.invalid'], to: ['founder@example.invalid'], cc: [], date: f.now, subject: 'Reply', bodyParts: [{ mimeType: 'text/plain', text: 'Tell me more', truncated: false }] }] }, revision: 2, contextRevision: 'context2', signals: [{ kind: 'substantive', evidence: [{ messageId: 'message', quote: 'Tell me more' }], requiresApproval: true }] };
    const draft: import('../../src/shared/contracts/mailThreadContract').AccountReplyDraft = { id: 'reply', accountId: f.account.id, threadId: 'thread', mailboxSubject: 'mailbox', threadRevision: 1, contextRevision: 'context1', revision: 1, recipient: 'person@example.invalid', sender: 'founder@example.invalid', subject: 'Re: Reply', body: 'Saved answer', evidenceIds: ['message'], generation: 'edited', updatedAt: f.now };
    f.db.raw.prepare('INSERT INTO delegated_threads VALUES(?,?,?,?,?,?,?,?,?)').run(f.workspaceId, f.account.id, 'thread', 'gmail', 'thread', 2, 'context2', JSON.stringify(thread), f.now);
    f.db.raw.prepare('INSERT INTO delegated_reply_drafts VALUES(?,?,?,?,?,?,?,?,?)').run(f.workspaceId, f.account.id, draft.id, draft.threadId, 1, 1, draft.contextRevision, JSON.stringify(draft), f.now);
    const snapshot = f.read();
    expect(snapshot.answers).toContainEqual({ kind: 'reply', accountId: f.account.id, thread, draft, stale: true, capability: 'held', reason: 'reply_capability_unverified' });
    const reopened = openDatabase({ path: f.path, key: f.key });
    try {
      const services = createDomainServices({ database: reopened, clock: f.clock, ids: { next: randomUUID }, expectedWorkspaceId: f.workspaceId });
      expect(services.daily.get()).toEqual(snapshot);
    } finally { closeDatabase(reopened); }
    f.db.raw.prepare("INSERT INTO workspace_workflow_state VALUES(1,'meeting_first',1,?)").run(f.now);
    expect(f.read().workflowMode).toBe('meeting_first');
    expect(f.read().revision).not.toBe(snapshot.revision);
  } finally { f.close(); }
});

it('retains new B3 account allocation alongside warm campaign work, using configured slots', async () => {
  const f = await fixture(); try {
    f.repo.enroll({ commandId: randomUUID(), accountId: f.account.id, selectedRouteId: f.routes[0].id, campaignVersionId: f.versions[0].id, executionContextId: 'ctx', contextRevision: 1 });
    const accounts = new AccountRepository({ database: f.db, clock: f.clock, ids: { next: randomUUID }, sourcePolicy: { attest: () => true } });
    const cold = accounts.create({ commandId: randomUUID(), name: 'Fictional new PM', domain: null });
    const source = randomUUID();
    accounts.admitEvidence({ commandId: randomUUID(), accountId: cold.id, expectedVersion: 1, sources: [{ id: source, url: 'https://example.invalid/team', fetchedAt: f.now, sha256: 'c'.repeat(64), excerpt: 'Residential local PM phone', permitted: true }], claims: [{ key: 'residential_scope', kind: 'fact', value: 'residential', evidenceIds: [source] }, { key: 'operating_footprint', kind: 'fact', value: 'local', evidenceIds: [source] }], routes: [{ id: randomUUID(), accountId: cold.id, personId: null, channel: 'phone', value: '+12025550105', purpose: 'business', verification: 'published', evidenceIds: [source] }] });
    f.db.raw.prepare('UPDATE meeting_first_call_settings SET new_call_slots=1,total_call_capacity=1').run();
    expect(f.read().calls).toEqual({ accountIds: [f.account.id, cold.id], workloadConflict: true });
    f.db.raw.prepare('UPDATE meeting_first_call_settings SET new_call_slots=0').run();
    expect(f.read().calls.accountIds).toEqual([f.account.id]);
  } finally { f.close(); }
});
