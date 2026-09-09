import { ownerCommandSchema } from '../../src/shared/contracts/ownerCommandContract';
import { OwnerCommandCoordinator } from '../../cloud/lambdas/delegated-worker/src/ownerCommandCoordinator';
import { DynamoMeetingRepository } from '../../cloud/lambdas/delegated-worker/src/meetingRepository';
import { DynamoStore } from '../../cloud/lambdas/delegated-worker/src/dynamoStore';
import { WorkerAuth } from '../../cloud/lambdas/delegated-worker/src/workerAuth';
import { RemoteGoogleAuthorization } from '../../cloud/lambdas/delegated-worker/src/remoteGoogleAuthorization';
import { googleScopes } from '../../cloud/lambdas/delegated-worker/src/googleGrantCapabilities';
import { executionAuthorityKey, executionAuthorityFields } from '../../cloud/lambdas/delegated-worker/src/executionRepository';
import { mailCursorKey, mailThreadKey } from '../../cloud/lambdas/delegated-worker/src/threadIntakeRepository';
import { ConditionalCommandHarness } from '../../cloud/lambdas/delegated-worker/test/sdkHarness';
import { mailScopeFingerprint } from '../../src/main/outreach/providers/gmailThreadProvider';
import type { MeetingOutcome, MeetingIntent, SchedulingRules } from '../../src/shared/contracts/meetingContract';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { openDatabase, closeDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';
import { workerEventSchema } from '../../src/shared/contracts/delegationContract';
const now = '2026-09-14T12:00:00.000Z';
async function fixture() {
  const temp = createTempDatabase(); const key = createTestWorkspaceKey(); let db = openDatabase({ path: temp.path, key });
  await migrateToLatest(db, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
  const account = new AccountRepository({ database: db, clock: { now: () => now }, ids: { next: randomUUID } }).create({ commandId: randomUUID(), name: 'Fictional Calendar PM', domain: null });
  const repository = () => new DelegationRepository({ database: db, workspaceId: 'ws-fiction', clock: { now: () => now } });
  repository().initializeLocalAuthority(account.id);
  const command = { commandId: randomUUID(), workspaceId: 'ws-fiction', accountId: account.id, expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'delegate' as const, payload: { delegationId: 'delegation-fiction', approvedAt: now } };
  repository().queueCommand(command);
  repository().applyWorkerEvent({ id: randomUUID(), workspaceId: 'ws-fiction', accountId: account.id, authorityGeneration: 1, aggregateVersion: 1, kind: 'authority.changed', payload: {
    authority: { accountId: account.id, owner: 'worker', generation: 1, state: 'active' }, receipt: { commandId: command.commandId, status: 'applied', authorityGeneration: 1, aggregateVersion: 1, reason: null },
  } });
  const identity = { meetingId: 'meeting-fiction', calendarId: 'founder@example.test', providerEventId: 'a'.repeat(64) };
  const booked: MeetingOutcome = { ...identity, status: 'booked', reason: null, event: { ...identity, status: 'confirmed', etag: '"v1"', start: '2026-09-15T14:00:00.000Z', end: '2026-09-15T14:30:00.000Z', attendees: [{ email: 'prospect@example.test', responseStatus: 'needsAction' }], meetUrl: null } };
  const event = (version: number, outcome = booked) => workerEventSchema.parse({ id: `event-fiction-${version}`, workspaceId: 'ws-fiction', accountId: account.id, authorityGeneration: 1, aggregateVersion: version, kind: 'meeting.outcome', payload: { commandId: 'command-fiction', outcome, observedAt: now } });
  return { repository, account, booked, event, row: () => db.raw.prepare('SELECT * FROM delegated_meetings').get() as { state: string; revision: number; projection_json: string; provider_event_id: string } | undefined,
    reopen: () => { closeDatabase(db); db = openDatabase({ path: temp.path, key }); }, close: () => { closeDatabase(db); key.bytes.fill(0); temp.cleanup(); } };
}
async function remoteFixture(accountId: string) {
  let now = '2026-09-14T12:00:00.000Z'; const dynamo = new ConditionalCommandHarness();
  const options = { dynamo, workspaceId: 'ws-fiction', tableName: 'table-fiction', clock: { now: () => now } };
  const store = new DynamoStore(options); const auth = new WorkerAuth(options);
  const authorization = new RemoteGoogleAuthorization({ auth, config: { clientId: 'fictional.apps.googleusercontent.com', clientSecret: 'fictional', redirectUri: 'https://worker.example.test/oauth/callback', encryptionKey: Buffer.alloc(32, 9) }, fetch: async (url) => {
    if (String(url).endsWith('/token')) return Response.json({ access_token: 'fictional-token', refresh_token: 'fictional-refresh', token_type: 'Bearer', expires_in: 3600, scope: `openid email ${googleScopes.availability} ${googleScopes.event_write} ${googleScopes.relevant_read}` });
    if (String(url).endsWith('/userinfo')) return Response.json({ sub: 'subject-fiction', email: 'founder@example.test', email_verified: true });
    if (String(url).endsWith('/revoke')) return new Response('', { status: 200 });
    throw new Error('unconfigured fictional OAuth');
  } });
  const pair = await auth.redeemPairing((await auth.issuePairing({ scopes: ['google:grant', 'commands:write'], expiresInSeconds: 300 })).code, 'fictional-source');
  const calendarId = 'founder@example.test';
  const url = await authorization.beginGoogleGrant(pair.pairingId, ['availability', 'event_write', 'relevant_read'], { confirmed: true, ownedCalendarId: calendarId, conflictCalendarIds: [calendarId, 'other@example.test'] });
  await authorization.completeGoogleGrant(new URL(url.authorizationUrl).searchParams.get('state')!, 'fictional-code');
  const rules: SchedulingRules = { revision: 1, confirmed: true, timezone: 'America/New_York', weeklyWindows: [{ weekday: 2, start: '09:00', end: '17:00' }], durationMinutes: 30, bufferBeforeMinutes: 10, bufferAfterMinutes: 10, minimumNoticeMinutes: 60, horizonDays: 30, ownedCalendarId: calendarId, conflictCalendarIds: [calendarId, 'other@example.test'], location: { kind: 'text', value: 'Fictional office' }, allowCancel: true, allowReschedule: true };
  const intent: MeetingIntent = { workspaceId: options.workspaceId, accountId, meetingId: 'meeting-fiction', commandId: 'command-fiction', operation: 'create', expectedAuthorityGeneration: 1, expectedVersion: 2, rulesRevision: 1, threadId: 'thread-fiction', threadRevision: 1, contextRevision: 'context-fiction', mailboxSubject: 'subject-fiction', pairingId: pair.pairingId, start: '2026-09-15T14:00:00.000Z', end: '2026-09-15T14:30:00.000Z', localStart: '2026-09-15T10:00:00', offset: '-04:00', timezone: rules.timezone, agreementEvidenceId: 'message-fiction', agreement: { kind: 'explicit_slot', start: '2026-09-15T14:00:00.000Z', end: '2026-09-15T14:30:00.000Z', quote: 'Tuesday at 10 works.' }, mixedReply: false, approvalId: 'base-approval', attendeeEmails: ['prospect@example.test'], inviteAttendees: true, summary: 'Fictional meeting', etag: null };
  const configurationCommands: ReturnType<typeof ownerCommandSchema.parse>[] = [];
  const seedAccount = async (accountId: string) => {
    const scope = { version: 1 as const, accountId, mailboxSubject: intent.mailboxSubject, revision: 1, participantAddresses: ['prospect@example.test'], knownThreadIds: [intent.threadId], since: now, approvedAt: now };
    const binding = { scopeRevision: scope.revision, scopeFingerprint: mailScopeFingerprint(scope) };
    const authority = { authority: { accountId, owner: 'worker', state: 'active', generation: 1 }, version: 1 };
    await store.transact([store.put(`DISPATCH_INTAKE#${accountId}`, { accountId, adapters: [{ id: 'gmail-primary', kind: 'gmail', enabled: true, relevant: true, mailboxSubject: intent.mailboxSubject }], manualDependencies: [] }, null), store.put(executionAuthorityKey(accountId), authority, null, executionAuthorityFields(authority as Parameters<typeof executionAuthorityFields>[0])),
      store.put(mailCursorKey(accountId, intent.mailboxSubject), { scope, checkpoint: { ...binding, version: 1, accountId, mailboxSubject: intent.mailboxSubject, mode: 'history', historyId: '100', pageToken: null, since: now }, poll: { ...binding, accountId, mailboxSubject: intent.mailboxSubject, attemptId: 'poll-fiction', status: 'complete', startedAt: now, completedAt: now } }, null),
      store.put(mailThreadKey(accountId, intent.threadId), { thread: { accountId, mailboxSubject: intent.mailboxSubject, provider: 'gmail', providerThreadId: intent.threadId,
        messages: [{ id: 'message-fiction', threadId: intent.threadId, rfcMessageId: null, references: [], from: ['prospect@example.test'], to: ['founder@example.test'], cc: [], date: now, subject: 'Meeting', bodyParts: [{ mimeType: 'text/plain', text: 'Tuesday at 10 works.', truncated: false }] }] }, revision: 1, contextRevision: intent.contextRevision,
        signals: [{ kind: 'scheduling', requiresApproval: true, evidence: [{ messageId: 'message-fiction', quote: 'Tuesday at 10 works.' }] }] }, null)]);
    const account = { id: accountId, name: 'Fictional configured PM', domain: null as string | null, version: 1 };
    await store.transact([store.put(`ACCOUNT#${accountId}`, { account, sources: [], claims: [], routes: [], researchRevision: 1, history: [{ at: now, account, claims: [], routes: [] }] }, null)]);
    const command = ownerCommandSchema.parse({ commandId: randomUUID(), workspaceId: options.workspaceId, accountId, expectedAuthorityGeneration: 1, expectedVersion: 1,
      kind: 'configure-owner', payload: { expectedConfigurationRevision: 0, configuration: { version: 1, workspaceId: options.workspaceId, accountId, pairingId: pair.pairingId, revision: 1,
        state: 'active', mailboxSubject: intent.mailboxSubject, calendarId, research: null }, mailScope: null } });
    await new OwnerCommandCoordinator({ auth, authorization }).apply(command, `Bearer ${pair.credential}`);
    configurationCommands.push(command);
  };
  await seedAccount(intent.accountId);
  const repository = () => new DynamoMeetingRepository(options, authorization);
  await repository().saveRules({ rules, expectedRevision: null });
  await repository().approveIntent({ intent, calendarId });
  const access = await authorization.authorizedAccess(pair.pairingId, ['availability', 'event_write']);
  return { configurationCommands, options, store, dynamo, authorization, auth, pair, rules, intent, calendarId, access, repository, seedAccount, advance: () => { now = '2026-09-14T12:06:00.000Z'; } };
}

describe('real encrypted delegated_meetings event projection', () => {
  it.each(['lookup_timeout', 'attendee_reversion'] as const)('replays actual committed transition IDs across %s and encrypted reopen', async variant => {
    const local = await fixture(); try {
      const remote = await remoteFixture(local.account.id);
      local.repository().queueCommand(remote.configurationCommands[0]!);
      const reserved = await remote.repository().reserve({ intent: remote.intent, calendarId: remote.calendarId }, remote.access.accessEvidence);
      const a = { ...local.booked, ...reserved.record.identity, event: { ...local.booked.event!, ...reserved.record.identity } };
      const b: MeetingOutcome = variant === 'lookup_timeout' ? { ...a, status: 'unknown', reason: 'lookup_timeout', event: null }
        : { ...a, event: { ...a.event!, attendees: [{ email: 'prospect@example.test', responseStatus: 'accepted' }] } };
      for (const outcome of [a, b, a]) await remote.repository().recordOutcome(remote.intent.commandId, outcome);
      const page = await remote.store.eventsAfter(null);
      expect(page.events).toHaveLength(5);
      for (const event of page.events) {
        expect(local.repository().applyWorkerEvent(event)).toBe('applied');
        local.reopen();
        expect(local.repository().applyWorkerEvent(event)).toBe('duplicate');
      }
      expect(local.row()).toMatchObject({ state: 'created', revision: 4 });
      expect(JSON.parse(local.row()!.projection_json).outcome.event.attendees[0].responseStatus).toBe('needsAction');
      await remote.repository().recordOutcome(remote.intent.commandId, a);
      expect((await remote.store.eventsAfter(null)).events).toEqual(page.events);
    } finally { local.close(); }
  });

  it('persists actual provider identity and invitation response through close/reopen and duplicate replay', async () => {
    const f = await fixture(); try {
      expect(f.repository().applyWorkerEvent(f.event(2))).toBe('applied');
      f.reopen();
      expect(f.row()).toMatchObject({ state: 'created', revision: 1, provider_event_id: 'a'.repeat(64) });
      expect(JSON.parse(f.row()!.projection_json)).toMatchObject({ outcome: { status: 'booked', event: { attendees: [{ responseStatus: 'needsAction' }] } } });
      expect(f.repository().applyWorkerEvent(f.event(2))).toBe('duplicate');
      expect(f.row()!.revision).toBe(1);
    } finally { f.close(); }
  });
  it('keeps cancellation terminal against late booked evidence and rejects identity replacement', async () => {
    const f = await fixture(); try {
      f.repository().applyWorkerEvent(f.event(2));
      f.repository().applyWorkerEvent(f.event(3, { ...f.booked, status: 'cancelled', event: { ...f.booked.event!, status: 'cancelled', etag: '"v2"' } }));
      f.repository().applyWorkerEvent(f.event(4));
      expect(f.row()!.state).toBe('cancelled');
      expect(() => f.repository().applyWorkerEvent(f.event(5, { ...f.booked, providerEventId: 'b'.repeat(64), event: { ...f.booked.event!, providerEventId: 'b'.repeat(64) } }))).toThrow();
      expect(f.row()!.provider_event_id).toBe('a'.repeat(64));
    } finally { f.close(); }
  });
  it('projects an original-generation cancellation after revocation only for the exact previously reserved identity', async () => {
    const f = await fixture(); try {
      f.repository().applyWorkerEvent(f.event(2, { ...f.booked, status: 'unknown', reason: 'reservation_pending', event: null }));
      const command = { commandId: randomUUID(), workspaceId: 'ws-fiction', accountId: f.account.id, expectedAuthorityGeneration: 1, expectedVersion: 2, kind: 'revoke' as const, payload: { reason: 'Fictional revoke' } };
      f.repository().queueCommand(command);
      f.repository().applyWorkerEvent({ id: randomUUID(), workspaceId: 'ws-fiction', accountId: f.account.id, authorityGeneration: 2, aggregateVersion: 3, kind: 'authority.changed', payload: {
        authority: { accountId: f.account.id, owner: 'worker', generation: 2, state: 'revoked' }, receipt: { commandId: command.commandId, status: 'applied', authorityGeneration: 2, aggregateVersion: 3, reason: null },
      } });
      expect(f.repository().applyWorkerEvent(f.event(4, { ...f.booked, status: 'cancelled', event: { ...f.booked.event!, status: 'cancelled' } }))).toBe('applied');
      expect(f.row()!.state).toBe('cancelled');
      expect(f.repository().authority(f.account.id)).toMatchObject({ generation: 2, state: 'revoked' });
    } finally { f.close(); }
  });
  it('rejects booked-without-provider and cross-event identity forgery at the wire boundary', async () => {
    const f = await fixture(); try {
      expect(() => f.event(2, { ...f.booked, event: null })).toThrow();
      expect(() => f.event(2, { ...f.booked, event: { ...f.booked.event!, providerEventId: 'b'.repeat(64) } })).toThrow();
    } finally { f.close(); }
  });
  it('does not project a gap or a future observation', async () => {
    const f = await fixture(); try {
      expect(f.repository().applyWorkerEvent(f.event(3))).toBe('gap'); expect(f.row()).toBeUndefined();
      const event = f.event(2); if (event.kind !== 'meeting.outcome') throw new Error();
      expect(() => f.repository().applyWorkerEvent({ ...event, payload: { ...event.payload, observedAt: '2026-09-16T00:00:00.000Z' } })).toThrow();
      expect(f.row()).toBeUndefined();
    } finally { f.close(); }
  });
});
