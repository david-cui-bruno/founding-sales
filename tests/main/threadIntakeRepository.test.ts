import { mailScopeFingerprint, createGmailThreadProvider } from '../../src/main/outreach/providers/gmailThreadProvider';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SqlThreadIntakeRepository } from '../../src/main/outreach/threadIntakeRepository';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { createTestWorkspaceKey } from '../fixtures/tempDatabase';
import type { ThreadPage } from '../../src/shared/contracts/mailThreadContract';
function page(accountId: string): ThreadPage { return { complete: true, nextCursor: { version: 1, accountId, mailboxSubject: 'sub1', mode: 'history', historyId: '11', pageToken: null, since: PM_NOW }, threads: [{ accountId, mailboxSubject: 'sub1', provider: 'gmail', providerThreadId: 't1', messages: [{ id: 'm1', threadId: 't1', rfcMessageId: '<m1@fixture.invalid>', references: [], from: ['pm@fixture.invalid'], to: ['founder@fixture.invalid'], cc: [], date: PM_NOW, subject: 'reply', bodyParts: [{ mimeType: 'text/plain', text: 'Stop emailing me', truncated: false }] }] }] }; }
describe('real encrypted SQL intake atomicity', () => {
  it('persists deduplication, checkpoint, optout and context across reopen', async () => {
    const f = await createPmFixture();
    try {
      const account = f.repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: null });
      new DelegationRepository({ database: f.db, workspaceId: 'ws', clock: { now: () => PM_NOW } }).initializeLocalAuthority(account.id);
      const repo = new SqlThreadIntakeRepository({ database: f.db, workspaceId: 'ws', clock: { now: () => PM_NOW } });
      const p = page(account.id);
      expect(repo.applyPage(p, null)[0]?.revision).toBe(1);
      expect(repo.applyPage(p, p.nextCursor)[0]?.changed).toBe(false);
      expect(f.db.raw.prepare('SELECT aggregate_version FROM delegated_authorities').get()).toEqual({ aggregate_version: 0 });
      expect(f.db.raw.prepare('SELECT count(*) AS n FROM pm_account_suppression_tombstones').get()).toEqual({ n: 1 });
      closeDatabase(f.db);
      const reopened = openDatabase({ path: f.db.path, key: createTestWorkspaceKey() });
      try {
        const restored = new SqlThreadIntakeRepository({ database: reopened, workspaceId: 'ws', clock: { now: () => PM_NOW } });
        expect(restored.checkpoint(account.id, 'sub1')).toEqual(p.nextCursor);
        expect(restored.getThread(account.id, 't1')?.revision).toBe(1);
      } finally { closeDatabase(reopened); }
    } finally { f.close(); }
  });
  it('rolls back thread/context/suppression if checkpoint write fails and rejects stale pollers', async () => {
    const f = await createPmFixture();
    try {
      const account = f.repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: null });
      new DelegationRepository({ database: f.db, workspaceId: 'ws', clock: { now: () => PM_NOW } }).initializeLocalAuthority(account.id);
      const repo = new SqlThreadIntakeRepository({ database: f.db, workspaceId: 'ws', clock: { now: () => PM_NOW } });
      f.db.raw.exec("CREATE TRIGGER fixture_checkpoint_failure BEFORE INSERT ON delegated_mail_cursors BEGIN SELECT RAISE(ABORT,'fixture crash'); END");
      expect(() => repo.applyPage(page(account.id), null)).toThrow('fixture crash');
      expect(repo.getThread(account.id, 't1')).toBeNull();
      expect(f.db.raw.prepare('SELECT aggregate_version FROM delegated_authorities').get()).toEqual({ aggregate_version: 0 });
      expect(f.db.raw.prepare('SELECT count(*) AS n FROM pm_account_suppression_tombstones').get()).toEqual({ n: 0 });
      f.db.raw.exec('DROP TRIGGER fixture_checkpoint_failure');
      repo.applyPage(page(account.id), null);
      expect(() => repo.applyPage(page(account.id), null)).toThrow('stale_mail_checkpoint');
    } finally { f.close(); }
  });
});
it('holds local intake while delegating so observations cannot cross ownership transfer', async () => {
  const f = await createPmFixture();
  try {
    const account = f.repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: null });
    const delegation = new DelegationRepository({ database: f.db, workspaceId: 'ws', clock: { now: () => PM_NOW } });
    delegation.initializeLocalAuthority(account.id);
    delegation.queueCommand({ commandId: randomUUID(), workspaceId: 'ws', accountId: account.id, expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'delegate', payload: { delegationId: 'approved', approvedAt: PM_NOW } });
    const repo = new SqlThreadIntakeRepository({ database: f.db, workspaceId: 'ws', clock: { now: () => PM_NOW } });
    expect(() => repo.applyPage(page(account.id), null)).toThrow('mail_intake_wrong_owner');
  } finally { f.close(); }
});

it('durably saves account-thread drafts with CAS and preserves edits when intake invalidates context', async () => {
  const f = await createPmFixture();
  try {
    const account = f.repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: null });
    new DelegationRepository({ database: f.db, workspaceId: 'ws', clock: { now: () => PM_NOW } }).initializeLocalAuthority(account.id);
    const repo = new SqlThreadIntakeRepository({ database: f.db, workspaceId: 'ws', clock: { now: () => PM_NOW } });
    const incoming = page(account.id); incoming.threads[0]!.messages[0]!.bodyParts[0]!.text = 'How does this work?';
    const projection = repo.applyPage(incoming, null)[0]!.projection;
    const draft = { id: 'draft1', accountId: account.id, threadId: 't1', mailboxSubject: 'sub1', threadRevision: projection.revision, contextRevision: projection.contextRevision,
      revision: 1, sender: 'founder@fixture.invalid', recipient: 'pm@fixture.invalid', subject: 'Reply', body: 'Thanks', evidenceIds: ['mail:m1'], generation: 'model' as const, updatedAt: PM_NOW };
    expect(repo.saveReplyDraft(draft, null)).toEqual(draft);
    const edited = { ...draft, revision: 2, body: 'My edited reply', generation: 'edited' as const };
    repo.saveReplyDraft(edited, 1);
    expect(() => repo.saveReplyDraft(edited, 1)).toThrow('stale_draft');
    expect(() => repo.saveReplyDraft({ ...edited, revision: 3, recipient: 'stranger@fixture.invalid' }, 2)).toThrow();
    const next = page(account.id); next.nextCursor.historyId = '12'; next.threads[0]!.messages[0]!.id = 'm2';
    repo.applyPage(next, incoming.nextCursor);
    expect(repo.getReplyDraft(account.id, 'draft1')).toEqual({ draft: edited, stale: true });
    expect(() => repo.saveReplyDraft({ ...edited, revision: 3 }, 2)).toThrow();
    closeDatabase(f.db); const reopened = openDatabase({ path: f.db.path, key: createTestWorkspaceKey() });
    try { expect(new SqlThreadIntakeRepository({ database: reopened, workspaceId: 'ws', clock: { now: () => PM_NOW } }).getReplyDraft(account.id, 'draft1')).toEqual({ draft: edited, stale: true }); }
    finally { closeDatabase(reopened); }
  } finally { f.close(); }
});

import { createStoredReplyDraftService } from '../../src/main/outreach/replyDraftService';
it('prepares and saves a real account reply through injected HTTP and SQL with no legacy IDs', async () => {
  const f = await createPmFixture();
  try {
    const account = f.repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: null });
    new DelegationRepository({ database: f.db, workspaceId: 'ws', clock: { now: () => PM_NOW } }).initializeLocalAuthority(account.id);
    const store = new SqlThreadIntakeRepository({ database: f.db, workspaceId: 'ws', clock: { now: () => PM_NOW } });
    const incoming = page(account.id); incoming.threads[0]!.messages[0]!.bodyParts[0]!.text = 'How does it work?'; store.applyPage(incoming, null);
    const service = createStoredReplyDraftService({ store, accountId: account.id, sender: 'founder@fixture.invalid', id: () => 'generated1', clock: { now: () => PM_NOW },
      credentials: { apiKey: 'fixture', model: 'fixture' }, context: { personName: 'Fictional PM', organizationLabel: null, segment: 'warm', stage: 'reply', actionLabel: null, facts: [], playbook: 'Only facts' }, styleExamples: [],
      fetch: (async () => new Response(JSON.stringify({ id: 'resp', status: 'completed', model: 'fixture', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ subject: 'Reply', body: 'Thanks for asking.', evidenceIds: ['mail:m1'] }) }] }] }))) as typeof globalThis.fetch });
    const draft = await service.prepareReply('t1', 1);
    expect(draft).toMatchObject({ accountId: account.id, threadId: 't1', generation: 'model', body: 'Thanks for asking.' });
    expect(draft).not.toHaveProperty('personId');
    expect(store.getReplyDraft(account.id, 'generated1')).toEqual({ draft, stale: false });
    expect(f.db.raw.prepare('SELECT count(*) AS n FROM email_send_intents').get()).toEqual({ n: 0 });
  } finally { f.close(); }
});
it('SQL poll completeness is durable and newer failure cannot reuse prior ready proof', async () => {
  const f = await createPmFixture();
  try {
    const account = f.repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: null });
    new DelegationRepository({ database: f.db, workspaceId: 'ws', clock: { now: () => PM_NOW } }).initializeLocalAuthority(account.id);
    const repo = new SqlThreadIntakeRepository({ database: f.db, workspaceId: 'ws', clock: { now: () => PM_NOW } });
    const scope = { version: 1 as const, accountId: account.id, mailboxSubject: 'sub1', revision: 1, participantAddresses: ['pm@fixture.invalid'], knownThreadIds: ['t1'], since: PM_NOW, approvedAt: PM_NOW };
    repo.admitScope(scope, null);
    repo.beginPoll(account.id, 'sub1', 'attempt1');
    repo.applyPage({ ...page(account.id), nextCursor: { ...page(account.id).nextCursor, scopeRevision: 1, scopeFingerprint: mailScopeFingerprint(scope) }, threads: [] }, null, 'attempt1');
    const ready = repo.cursorState(account.id, 'sub1'); expect(ready?.data.poll?.status).toBe('complete');
    repo.beginPoll(account.id, 'sub1', 'attempt2'); repo.failPoll(account.id, 'sub1', 'attempt2');
    expect(repo.cursorState(account.id, 'sub1')?.data.poll?.status).toBe('failed');
    expect(repo.cursorState(account.id, 'sub1')!.rev).toBeGreaterThan(ready!.rev);
    expect(() => repo.applyPage({ ...page(account.id), threads: [] }, page(account.id).nextCursor, 'attempt1')).toThrow('stale_poll_attempt');
  } finally { f.close(); }
});

it('does not persist suppression from a quoted optout footer across encrypted SQL restart', async () => {
  const f = await createPmFixture();
  try {
    const account = f.repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: null });
    new DelegationRepository({ database: f.db, workspaceId: 'ws', clock: { now: () => PM_NOW } }).initializeLocalAuthority(account.id);
    const repo = new SqlThreadIntakeRepository({ database: f.db, workspaceId: 'ws', clock: { now: () => PM_NOW } });
    const incoming = page(account.id); incoming.threads[0]!.messages[0]!.bodyParts[0]!.text = 'Tuesday works.\n> Reply unsubscribe to stop emails.';
    expect(repo.applyPage(incoming, null)[0]?.signals[0]?.kind).toBe('scheduling');
    expect(repo.isSuppressed(account.id)).toBe(false);
    expect(f.db.raw.prepare('SELECT count(*) AS n FROM pm_account_suppression_tombstones').get()).toEqual({ n: 0 });
    closeDatabase(f.db); const reopened = openDatabase({ path: f.db.path, key: createTestWorkspaceKey() });
    try {
      const restored = new SqlThreadIntakeRepository({ database: reopened, workspaceId: 'ws', clock: { now: () => PM_NOW } });
      expect(restored.isSuppressed(account.id)).toBe(false);
      expect(restored.getThread(account.id, 't1')?.thread.messages[0]?.bodyParts[0]?.text).toContain('> Reply unsubscribe');
      expect(restored.checkpoint(account.id, 'sub1')).toEqual(incoming.nextCursor);
    } finally { closeDatabase(reopened); }
  } finally { f.close(); }
});

it('persists admitted full account scope and invalidates old poll across SQL restart', async () => {
  const f = await createPmFixture();
  try {
    const account = f.repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: null });
    new DelegationRepository({ database: f.db, workspaceId: 'ws', clock: { now: () => PM_NOW } }).initializeLocalAuthority(account.id);
    const repo = new SqlThreadIntakeRepository({ database: f.db, workspaceId: 'ws', clock: { now: () => PM_NOW } });
    expect(() => repo.beginPoll(account.id, 'sub1', 'missing')).toThrow('mail_scope_required');
    const scope = { version: 1 as const, accountId: account.id, mailboxSubject: 'sub1', revision: 1, participantAddresses: ['a@fixture.invalid', 'b@fixture.invalid'], knownThreadIds: ['t1'], since: PM_NOW, approvedAt: PM_NOW };
    repo.admitScope(scope, null); repo.beginPoll(account.id, 'sub1', 'old');
    const before = repo.cursorState(account.id, 'sub1')!;
    repo.admitScope({ ...scope, revision: 2, participantAddresses: ['a@fixture.invalid'] }, before.rev);
    expect(() => repo.applyPage(page(account.id), null, 'old')).toThrow();
    expect(() => repo.admitScope({ ...scope, revision: 3 }, before.rev)).toThrow('stale_mail_scope');
    closeDatabase(f.db); const reopened = openDatabase({ path: f.db.path, key: createTestWorkspaceKey() });
    try { expect(new SqlThreadIntakeRepository({ database: reopened, workspaceId: 'ws', clock: { now: () => PM_NOW } }).cursorState(account.id, 'sub1')?.data).toMatchObject({ scope: { revision: 2, participantAddresses: ['a@fixture.invalid'] }, checkpoint: null, poll: null }); }
    finally { closeDatabase(reopened); }
  } finally { f.close(); }
});

it('scope admission rollback cannot erase existing scope or pending crash evidence', async () => {
  const f = await createPmFixture();
  try {
    const account = f.repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: null });
    new DelegationRepository({ database: f.db, workspaceId: 'ws', clock: { now: () => PM_NOW } }).initializeLocalAuthority(account.id);
    const repo = new SqlThreadIntakeRepository({ database: f.db, workspaceId: 'ws', clock: { now: () => PM_NOW } });
    const scope = { version: 1 as const, accountId: account.id, mailboxSubject: 'sub1', revision: 1, participantAddresses: ['a@fixture.invalid'], knownThreadIds: ['t1'], since: PM_NOW, approvedAt: PM_NOW };
    repo.admitScope(scope, null); repo.beginPoll(account.id, 'sub1', 'crashed'); const before = repo.cursorState(account.id, 'sub1')!;
    f.db.raw.exec("CREATE TRIGGER fixture_scope_failure BEFORE UPDATE ON delegated_mail_cursors BEGIN SELECT RAISE(ABORT,'fixture crash'); END");
    expect(() => repo.admitScope({ ...scope, revision: 2, participantAddresses: ['a@fixture.invalid', 'b@fixture.invalid'] }, before.rev)).toThrow('fixture crash');
    expect(repo.cursorState(account.id, 'sub1')).toEqual(before);
    closeDatabase(f.db); const reopened = openDatabase({ path: f.db.path, key: createTestWorkspaceKey() });
    try { expect(new SqlThreadIntakeRepository({ database: reopened, workspaceId: 'ws', clock: { now: () => PM_NOW } }).cursorState(account.id, 'sub1')?.data.poll?.status).toBe('pending'); }
    finally { closeDatabase(reopened); }
  } finally { f.close(); }
});

import { googleScopes } from '../../cloud/lambdas/delegated-worker/src/googleGrantCapabilities';
it.each([
  ['<p>What does <b>unsubscribe</b> mean?</p>', false],
  ['<p>Reply <strong>unsubscribe</strong> to stop emails.</p>', false],
  ['<p>Please <strong>stop emailing me</strong>.</p>', true],
  ['<p>Please stop emailing me</p><p>Thanks,<br>Pat</p>', true],
  ['Please stop emailing me\n\nThanks,\nPat', true],
])('actual HTML intake creates suppression only for attributable authored intent: %s', async (html, suppressed) => {
  const f = await createPmFixture();
  try {
    const account = f.repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: null });
    new DelegationRepository({ database: f.db, workspaceId: 'ws', clock: { now: () => PM_NOW } }).initializeLocalAuthority(account.id);
    const provider = createGmailThreadProvider({ now: () => Date.parse(PM_NOW), grant: { provider: 'google', subject: 'sub1', email: 'founder@fixture.invalid', owner: 'remote', purpose: 'permitted_correspondence', capabilities: ['relevant_read'], grantedScopes: [googleScopes.relevant_read] }, accessToken: 'fixture',
      fetch: (async raw => { const url = new URL(String(raw));
        if (url.pathname.endsWith('/profile')) return Response.json({ historyId: '11' });
        if (url.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'm1' }] });
        return Response.json({ id: 'm1', threadId: 't1', internalDate: String(Date.parse(PM_NOW)), payload: { mimeType: html.startsWith('<') ? 'text/html' : 'text/plain', headers: [{ name: 'From', value: 'pm@fixture.invalid' }, { name: 'To', value: 'founder@fixture.invalid' }, { name: 'Subject', value: 'reply' }], body: { data: Buffer.from(html).toString('base64url') } } });
      }) as typeof fetch });
    const incoming = await provider.readRelevantThreads({ accountId: account.id, knownThreadIds: ['t1'], participantAddresses: ['pm@fixture.invalid'], since: PM_NOW, cursor: null, maxPages: 1, maxBodyBytes: 1000 }, new AbortController().signal);
    const repo = new SqlThreadIntakeRepository({ database: f.db, workspaceId: 'ws', clock: { now: () => PM_NOW } });
    repo.applyPage(incoming, null); expect(repo.isSuppressed(account.id)).toBe(suppressed);
    expect(f.db.raw.prepare('SELECT count(*) AS n FROM pm_account_suppression_tombstones').get()).toEqual({ n: suppressed ? 1 : 0 });
  } finally { f.close(); }
});
it('semantic mail context persists actual evidence across encrypted restart and unchanged polls', async () => {
  const f = await createPmFixture();
  try {
    const account = f.repo.create({ commandId: randomUUID(), name: 'Context PM', domain: null });
    new DelegationRepository({ database: f.db, workspaceId: 'ws', clock: { now: () => PM_NOW } }).initializeLocalAuthority(account.id);
    const repo = new SqlThreadIntakeRepository({ database: f.db, workspaceId: 'ws', clock: { now: () => PM_NOW } });
    const empty = repo.inboundContext(account.id, 'sub1');
    const scope = { version: 1 as const, accountId: account.id, mailboxSubject: 'sub1', revision: 1, participantAddresses: ['pm@fixture.invalid'], knownThreadIds: [] as string[], since: PM_NOW, approvedAt: PM_NOW };
    repo.admitScope(scope, null); repo.beginPoll(account.id, 'sub1', 'semantic1');
    const p = page(account.id); p.nextCursor.scopeRevision = 1; p.nextCursor.scopeFingerprint = mailScopeFingerprint(scope);
    repo.applyPage(p, null, 'semantic1');
    const changed = repo.cursorState(account.id, 'sub1')!.data;
    expect(changed.inboundContextRevision).toBe(2); expect(changed.inboundContextFingerprint).not.toBe(empty);
    repo.beginPoll(account.id, 'sub1', 'semantic2'); repo.applyPage({ ...p, threads: [] }, repo.checkpoint(account.id, 'sub1'), 'semantic2');
    repo.beginPoll(account.id, 'sub1', 'semantic3'); repo.failPoll(account.id, 'sub1', 'semantic3');
    closeDatabase(f.db); const reopened = openDatabase({ path: f.db.path, key: createTestWorkspaceKey() });
    try { const restored = new SqlThreadIntakeRepository({ database: reopened, workspaceId: 'ws', clock: { now: () => PM_NOW } });
      expect(restored.cursorState(account.id, 'sub1')!.data.inboundContextRevision).toBe(2);
      expect(restored.inboundContext(account.id, 'sub1')).toBe(changed.inboundContextFingerprint);
    } finally { closeDatabase(reopened); }
  } finally { f.close(); }
});
