import { mailScopeFingerprint } from '../../../../src/main/outreach/providers/gmailThreadProvider';
import { MeetingCoordinator } from '../src/meetingCoordinator';
import { describe, expect, it } from 'vitest';
import { DynamoMeetingRepository } from '../src/meetingRepository';
import { DynamoStore } from '../src/dynamoStore';
import { WorkerAuth } from '../src/workerAuth';
import { RemoteGoogleAuthorization } from '../src/remoteGoogleAuthorization';
import { googleScopes } from '../src/googleGrantCapabilities';
import { executionAuthorityKey, executionAuthorityFields } from '../src/executionRepository';
import { mailCursorKey, mailThreadKey } from '../src/threadIntakeRepository';
import { ConditionalCommandHarness } from './sdkHarness';
import type { MeetingIntent, SchedulingRules } from '../../../../src/shared/contracts/meetingContract';

async function meetingFixture() {
  let now = '2026-09-14T12:00:00.000Z'; const dynamo = new ConditionalCommandHarness();
  const options = { dynamo, workspaceId: 'ws-fiction', tableName: 'table-fiction', clock: { now: () => now } };
  const store = new DynamoStore(options); const auth = new WorkerAuth(options);
  const authorization = new RemoteGoogleAuthorization({ auth, config: { clientId: 'fictional.apps.googleusercontent.com', clientSecret: 'fictional', redirectUri: 'https://worker.example.test/oauth/callback', encryptionKey: Buffer.alloc(32, 9) }, fetch: async (url) => {
    if (String(url).endsWith('/token')) return Response.json({ access_token: 'fictional-token', refresh_token: 'fictional-refresh', token_type: 'Bearer', expires_in: 3600, scope: `openid email ${googleScopes.availability} ${googleScopes.event_write}` });
    if (String(url).endsWith('/userinfo')) return Response.json({ sub: 'subject-fiction', email: 'founder@example.test', email_verified: true });
    if (String(url).endsWith('/revoke')) return new Response('', { status: 200 });
    throw new Error('unconfigured fictional OAuth');
  } });
  const pair = await auth.redeemPairing((await auth.issuePairing({ scopes: ['google:grant'], expiresInSeconds: 300 })).code, 'fictional-source');
  const calendarId = 'founder@example.test';
  const url = await authorization.beginGoogleGrant(pair.pairingId, ['availability', 'event_write'], { confirmed: true, ownedCalendarId: calendarId, conflictCalendarIds: [calendarId, 'other@example.test'] });
  await authorization.completeGoogleGrant(new URL(url.authorizationUrl).searchParams.get('state')!, 'fictional-code');
  const rules: SchedulingRules = { revision: 1, confirmed: true, timezone: 'America/New_York', weeklyWindows: [{ weekday: 2, start: '09:00', end: '17:00' }], durationMinutes: 30, bufferBeforeMinutes: 10, bufferAfterMinutes: 10, minimumNoticeMinutes: 60, horizonDays: 30, ownedCalendarId: calendarId, conflictCalendarIds: [calendarId, 'other@example.test'], location: { kind: 'text', value: 'Fictional office' }, allowCancel: true, allowReschedule: true };
  const intent: MeetingIntent = { workspaceId: options.workspaceId, accountId: 'acct-fiction', meetingId: 'meeting-fiction', commandId: 'command-fiction', operation: 'create', expectedAuthorityGeneration: 1, expectedVersion: 1, rulesRevision: 1, threadId: 'thread-fiction', threadRevision: 1, contextRevision: 'context-fiction', mailboxSubject: 'subject-fiction', pairingId: pair.pairingId, start: '2026-09-15T14:00:00.000Z', end: '2026-09-15T14:30:00.000Z', localStart: '2026-09-15T10:00:00', offset: '-04:00', timezone: rules.timezone, agreementEvidenceId: 'message-fiction', agreement: { kind: 'explicit_slot', start: '2026-09-15T14:00:00.000Z', end: '2026-09-15T14:30:00.000Z', quote: 'Tuesday at 10 works.' }, mixedReply: false, approvalId: 'base-approval', attendeeEmails: ['prospect@example.test'], inviteAttendees: true, summary: 'Fictional meeting', etag: null };
  const seedAccount = async (accountId: string) => {
    const scope = { version: 1 as const, accountId, mailboxSubject: intent.mailboxSubject, revision: 1, participantAddresses: ['prospect@example.test'], knownThreadIds: [intent.threadId], since: now, approvedAt: now };
    const binding = { scopeRevision: scope.revision, scopeFingerprint: mailScopeFingerprint(scope) };
    const authority = { authority: { accountId, owner: 'worker', state: 'active', generation: 1 }, version: 1 };
    await store.transact([store.put(`DISPATCH_INTAKE#${accountId}`, { accountId, adapters: [{ id: 'gmail-primary', kind: 'gmail', enabled: true, relevant: true, mailboxSubject: intent.mailboxSubject }], manualDependencies: [] }, null), store.put(executionAuthorityKey(accountId), authority, null, executionAuthorityFields(authority as Parameters<typeof executionAuthorityFields>[0])),
      store.put(mailCursorKey(accountId, intent.mailboxSubject), { scope, checkpoint: { ...binding, version: 1, accountId, mailboxSubject: intent.mailboxSubject, mode: 'history', historyId: '100', pageToken: null, since: now }, poll: { ...binding, accountId, mailboxSubject: intent.mailboxSubject, attemptId: 'poll-fiction', status: 'complete', startedAt: now, completedAt: now } }, null),
      store.put(mailThreadKey(accountId, intent.threadId), { thread: { accountId, mailboxSubject: intent.mailboxSubject, provider: 'gmail', providerThreadId: intent.threadId,
        messages: [{ id: 'message-fiction', threadId: intent.threadId, rfcMessageId: null, references: [], from: ['prospect@example.test'], to: ['founder@example.test'], cc: [], date: now, subject: 'Meeting', bodyParts: [{ mimeType: 'text/plain', text: 'Tuesday at 10 works. You may choose any time Tuesday from 10 to noon.', truncated: false }] }] }, revision: 1, contextRevision: intent.contextRevision,
        signals: [{ kind: 'scheduling', requiresApproval: true, evidence: [{ messageId: 'message-fiction', quote: 'Tuesday at 10 works.' }] }] }, null)]);
  };
  await seedAccount(intent.accountId);
  const repository = () => new DynamoMeetingRepository(options, authorization);
  await repository().saveRules({ rules, expectedRevision: null });
  await repository().approveIntent({ intent, calendarId });
  const access = await authorization.authorizedAccess(pair.pairingId, ['availability', 'event_write']);
  return { options, store, dynamo, authorization, auth, pair, rules, intent, calendarId, access, repository, seedAccount, advance: () => { now = '2026-09-14T12:06:00.000Z'; } };
}

function calendarHttp(f: Awaited<ReturnType<typeof meetingFixture>>) {
  const events: Record<string, ReturnType<typeof rawEvent>> = {};
  const calls: { url: URL; method: string; body: Record<string, unknown> | null }[] = [];
  let onLookup: (() => Promise<void>) | null = null;
  let dropInsert = false; let timeoutInsert = false; let unknownLookup = false; let externalConflict = false;
  function rawEvent(id: string, start = f.intent.start, end = f.intent.end) { return { id, status: 'confirmed', etag: '"v1"', start: { dateTime: start }, end: { dateTime: end }, attendees: [{ email: 'prospect@example.test', responseStatus: 'needsAction' }] }; }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); const method = init?.method ?? 'GET'; const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    if (url.pathname.endsWith('/freeBusy')) return Response.json({ calendars: Object.fromEntries(body.items.map((i: { id: string }) => [i.id, { busy: [] as { start: string; end: string }[] }])) });
    if (url.pathname.endsWith('/events') && method === 'GET') return Response.json({ items: [...Object.values(events), ...(externalConflict ? [rawEvent('external')] : [])] });
    const id = url.pathname.split('/').at(-1)!;
    if (method === 'GET') { if (onLookup) { const run = onLookup; onLookup = null; await run(); } if (unknownLookup) throw new Error('fictional offline'); return events[id] ? Response.json(events[id]) : new Response('', { status: 404 }); }
    if (method === 'POST' && url.pathname.endsWith('/events')) {
      const stored = await f.repository().command(f.intent.commandId);
      expect(stored?.identity.providerEventId).toBe(body.id); // identity was DURABLY written before HTTP
      events[body.id] = rawEvent(body.id, body.start.dateTime, body.end.dateTime);
      if (dropInsert) delete events[body.id];
      if (timeoutInsert) throw new Error('fictional timeout after provider accepted');
      return Response.json(events[body.id]);
    }
    if (method === 'PATCH' && events[id]) {
      if (new Headers(init?.headers).get('If-Match') !== events[id]!.etag) return new Response('', { status: 412 });
      events[id] = { ...events[id]!, ...body, attendees: events[id]!.attendees, etag: '"v2"' };
      return Response.json(events[id]);
    }
    throw new Error('unconfigured fictional Calendar HTTP');
  };
  const coordinator = () => new MeetingCoordinator({ repository: f.repository(), authorization: f.authorization, calendarId: f.calendarId, fetch });
  return { calls, events, coordinator, beforeLookup: (run: () => Promise<void>) => { onLookup = run; }, timeout: () => { timeoutInsert = true; }, uncertain: () => { timeoutInsert = true; dropInsert = true; }, offline: () => { unknownLookup = true; }, conflict: () => { externalConflict = true; } };
}
describe('meeting coordinator with real repository, authorization and injected HTTP adapter', () => {
  it('interest without agreed slot cannot reach Calendar HTTP', async () => {
    const f = await meetingFixture(); const h = calendarHttp(f);
    expect(await h.coordinator().coordinateMeeting({ ...f.intent, agreementEvidenceId: null })).toMatchObject({ status: 'held', reason: 'slot_not_agreed' });
    expect(h.calls).toHaveLength(0);
    expect((await f.store.eventsAfter(null)).events).toMatchObject([{ kind: 'meeting.outcome', payload: { outcome: { status: 'held', reason: 'slot_not_agreed' } } }]);
  });
  it('books once, reconciles timeout by deterministic ID and replays across coordinator restart', async () => {
    const f = await meetingFixture(); const h = calendarHttp(f); h.timeout();
    const first = await h.coordinator().coordinateMeeting(f.intent);
    expect(first.status).toBe('booked');
    expect(await h.coordinator().coordinateMeeting(f.intent)).toMatchObject({ status: 'booked', providerEventId: first.providerEventId });
    expect(h.calls.filter(c => c.method === 'POST' && c.url.pathname.endsWith('/events'))).toHaveLength(1);
    expect((await f.repository().command(f.intent.commandId))?.outcome?.event?.attendees[0]?.responseStatus).toBe('needsAction');
  });
  it('unknown inserts never retry even when deterministic lookup is later absent', async () => {
    const f = await meetingFixture(); const h = calendarHttp(f); h.uncertain();
    expect(await h.coordinator().coordinateMeeting(f.intent)).toMatchObject({ status: 'unknown' });
    expect(await h.coordinator().coordinateMeeting(f.intent)).toMatchObject({ status: 'unknown' });
    expect(h.calls.filter(c => c.method === 'POST' && c.url.pathname.endsWith('/events'))).toHaveLength(1);
  });
  it('treats a lost reservation commit acknowledgement as unknown, never as a fresh dispatch', async () => {
    const f = await meetingFixture(); const h = calendarHttp(f);
    f.dynamo.afterCommit = () => { f.dynamo.afterCommit = undefined; throw new Error('fictional lost reservation acknowledgement'); };
    expect(await h.coordinator().coordinateMeeting(f.intent)).toMatchObject({ status: 'unknown' });
    expect(await h.coordinator().coordinateMeeting(f.intent)).toMatchObject({ status: 'unknown' });
    expect(h.calls.filter(c => c.method === 'POST' && c.url.pathname.endsWith('/events'))).toHaveLength(0);
  });
  it('detects external post-create conflicts rather than claiming atomic freebusy', async () => {
    const f = await meetingFixture(); const h = calendarHttp(f); h.conflict();
    expect(await h.coordinator().coordinateMeeting(f.intent)).toMatchObject({ status: 'held', reason: 'external_calendar_conflict', event: { status: 'confirmed' } });
  });
  it('reschedules and cancels the same identity with real ETags and never resurrects cancellation', async () => {
    const f = await meetingFixture(); const h = calendarHttp(f); const first = await h.coordinator().coordinateMeeting(f.intent);
    const update: MeetingIntent = { ...f.intent, commandId: 'update-fiction', operation: 'update', expectedVersion: 3, start: '2026-09-15T15:00:00.000Z', end: '2026-09-15T15:30:00.000Z', localStart: '2026-09-15T11:00:00', etag: '"v1"', agreement: { kind: 'delegated_choice', notBefore: '2026-09-15T14:00:00.000Z', notAfter: '2026-09-15T16:00:00.000Z', quote: 'You may choose any time Tuesday from 10 to noon.' } };
    update.approvalId = 'update-approval'; await f.repository().approveIntent({ intent: update, calendarId: f.calendarId });
    const changed = await h.coordinator().coordinateMeeting(update);
    expect(changed).toMatchObject({ status: 'booked', providerEventId: first.providerEventId, event: { start: update.start, etag: '"v2"' } });
    const threadKey = mailThreadKey(f.intent.accountId, f.intent.threadId);
    const thread = await f.store.get<{ thread: { messages: { bodyParts: { text: string }[] }[] } }>(threadKey);
    thread!.data.thread.messages[0]!.bodyParts[0]!.text += ' Please cancel this meeting.';
    await f.store.transact([f.store.put(threadKey, thread!.data, thread!.rev)]);
    const cancellation: MeetingIntent = { ...update, commandId: 'cancel-fiction', operation: 'cancel', expectedVersion: 5, etag: '"v2"', agreement: { kind: 'cancellation', quote: 'Please cancel this meeting.' }, approvalId: 'cancel-approval' };
    await f.repository().approveIntent({ intent: cancellation, calendarId: f.calendarId });
    const cancelled = await h.coordinator().coordinateMeeting(cancellation);
    expect(cancelled).toMatchObject({ status: 'cancelled', providerEventId: first.providerEventId });
    expect(await h.coordinator().coordinateMeeting(f.intent)).toMatchObject({ status: 'cancelled' });
    expect(h.calls.filter(c => c.method === 'POST' && c.url.pathname.endsWith('/events'))).toHaveLength(1);
  });
  it('fences a pause arriving during the final provider lookup before insert', async () => {
    const f = await meetingFixture(); const h = calendarHttp(f);
    h.beforeLookup(async () => {
      const key = executionAuthorityKey(f.intent.accountId); const row = await f.store.get<{ authority: { state: string }; version: number }>(key);
      row!.data.authority.state = 'paused';
      await f.store.transact([f.store.put(key, row!.data, row!.rev, { accountId: f.intent.accountId, generation: 1, version: row!.data.version, owner: 'worker', state: 'paused' })]);
    });
    expect(await h.coordinator().coordinateMeeting(f.intent)).toMatchObject({ status: 'held', reason: 'stale_authority' });
    expect(h.calls.filter(c => c.method === 'POST' && c.url.pathname.endsWith('/events'))).toHaveLength(0);
  });
  it('holds revoked grant and stale polling before creating any event', async () => {
    const f = await meetingFixture(); const h = calendarHttp(f); f.advance();
    expect(await h.coordinator().coordinateMeeting(f.intent)).toMatchObject({ status: 'held', reason: 'intake_stale' });
    expect(h.calls.filter(c => c.method === 'POST' && c.url.pathname.endsWith('/events'))).toHaveLength(0);
    await f.authorization.revokeGoogleGrant(f.pair.pairingId);
    expect(await h.coordinator().coordinateMeeting(f.intent)).toMatchObject({ status: 'held' });
  });
});
