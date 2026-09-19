import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCampaignFixture } from '../fixtures/campaignWorkspace';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { DailyReadService } from '../../src/main/domain/today/dailyReadService';
import { buildDailySnapshot } from '../../src/main/domain/today/dailyProjection';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { requestedFollowupFixture } from '../fixtures/requestedFollowup';
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

it('D2 morning list: 40 worker-prepared firms with listed phones give 30 new firms after every due firm, and a call this morning leaves 29', async () => {
  const f = await fixture(); try {
    const { TodayService } = await import('../../src/main/domain/today/todayService');
    const due = f.repo.enroll({ commandId: randomUUID(), accountId: f.account.id, selectedRouteId: f.routes[0].id, campaignVersionId: f.versions[0].id, executionContextId: 'ctx', contextRevision: 1 });
    expect(due.state).toBe('active');
    const accounts = new AccountRepository({ database: f.db, clock: f.clock, ids: { next: randomUUID }, sourcePolicy: { attest: () => true } });
    const prepared: string[] = [];
    for (let index = 0; index < 40; index++) {
      // A Places-born firm as the worker prepares it: a listed phone from the Google Business Profile, the listing as its source, a fact on every other firm.
      const firm = accounts.create({ commandId: randomUUID(), name: `Fictional Territory PM ${String(index).padStart(2, '0')}`, domain: `firm-${index}.example.invalid` });
      const listing = randomUUID();
      accounts.admitEvidence({ commandId: randomUUID(), accountId: firm.id, expectedVersion: 1,
        sources: [{ id: listing, url: 'https://places.googleapis.com/v1/places:searchText', fetchedAt: f.now, sha256: 'e'.repeat(64), permitted: true,
          excerpt: JSON.stringify({ id: `place-${index}`, displayName: firm.name, formattedAddress: `${index} Main St, Providence, RI 02903, USA`, nationalPhoneNumber: '(401) 555-0100', websiteUri: `https://firm-${index}.example.invalid/` }) }],
        claims: index % 2 === 0 ? [{ key: 'residential_scope', kind: 'fact', value: 'Residential property management', evidenceIds: [listing] }] : [],
        routes: [{ id: randomUUID(), accountId: firm.id, personId: null, channel: 'phone', value: `+1401555${String(100 + index).padStart(4, '0')}`, purpose: 'business', verification: 'listed', evidenceIds: [listing] }] });
      prepared.push(firm.id);
    }
    const before = f.db.raw.prepare('SELECT total_changes() AS n').get();
    const morning = f.read();
    expect(f.db.raw.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    // Unconfigured Settings: the stored record is unchanged in the hashed snapshot; the default allocation is reported beside it, without an incomplete-snapshot issue.
    expect(morning.callSettings).toEqual({ newCallSlots: null, totalCallCapacity: null });
    expect(morning.allocation).toEqual({ newCallSlots: 30, source: 'default' });
    const { allocation: omitted, ...hashed } = morning; void omitted;
    expect(buildDailySnapshot({ ...hashed, generatedAt: morning.freshness.generatedAt, approvals: morning.answers }).revision).toBe(morning.revision);
    expect(morning.issues.map(issue => issue.code)).not.toContain('call_allocation_unconfigured');
    expect(morning.freshness.kind).toBe('local_snapshot');
    expect(morning.calls.accountIds).toHaveLength(31);
    expect(morning.calls.accountIds[0]).toBe(f.account.id); // the due sequence step first
    const listed = morning.calls.accountIds.slice(1);
    expect(listed.every(id => prepared.includes(id))).toBe(true);
    // Evidence richness before name: every firm with a residential fact precedes every firm without one, names ascending inside.
    const richness = (id: string) => morning.accounts.find(a => a.account.id === id)!.claims.length;
    const firstThin = listed.findIndex(id => richness(id) === 0);
    expect(firstThin).toBe(20);
    expect(listed.slice(firstThin).every(id => richness(id) === 0)).toBe(true);
    const names = (ids: string[]) => ids.map(id => morning.accounts.find(a => a.account.id === id)!.account.name);
    expect(names(listed.slice(0, firstThin))).toEqual([...names(listed.slice(0, firstThin))].sort((a, b) => a.localeCompare(b, 'en')));
    // One call to a listed firm this morning: the firm leaves the list and its slot is spent (29 new); the due firm stays.
    const called = listed[4]!;
    const today = new TodayService({ database: f.db, unitOfWork: f.services.unitOfWork, clock: f.clock, repository: f.services.todayRepository,
      priorities: f.services.prioritization, outboundPermission: f.services.outboundPermission, workspaceSettings: f.services.workspaceSettings,
      actualCalls: () => [{ accountId: called, commandId: randomUUID(), attemptId: randomUUID(), outcome: 'no_answer', reportedAt: f.now }] });
    const after = new DailyReadService({ database: f.db, clock: f.clock, ids: { next: () => { throw Error('read allocated ID'); } }, today, settings: f.services.workspaceSettings, workspaceId: f.workspaceId }).get();
    expect(after.calls.accountIds).toHaveLength(30);
    expect(after.calls.accountIds[0]).toBe(f.account.id);
    expect(after.calls.accountIds).not.toContain(called);
    expect(after.calls.accountIds.slice(1)).toEqual(listed.filter(id => id !== called).slice(0, 29));
    // Settings can still turn the default down or off.
    f.db.raw.prepare('UPDATE meeting_first_call_settings SET new_call_slots=5').run();
    const configured = f.read();
    expect(configured.callSettings).toEqual({ newCallSlots: 5, totalCallCapacity: null });
    expect(configured.allocation).toEqual({ newCallSlots: 5, source: 'configured' });
    expect(configured.calls.accountIds).toEqual([f.account.id, ...listed.slice(0, 5)]);
  } finally { f.close(); }
});
