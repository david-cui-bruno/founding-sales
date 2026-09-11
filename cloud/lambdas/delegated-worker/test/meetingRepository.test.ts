import { QueryCommand } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'node:crypto';
import { OwnerCommandCoordinator } from '../src/ownerCommandCoordinator';
import { describe, expect, it, vi } from 'vitest';
import { ownerCommandSchema, ownerSourceKey, ownerSourceConfigurationSchema } from '../../../../src/shared/contracts/ownerCommandContract';
import { mailScopeFingerprint } from '../../../../src/main/outreach/providers/gmailThreadProvider';
import { createDispatchService } from '../src/dispatchService';
import { createMailPoller } from '../src/mailPoller';
import type { AccountReplyDraft } from '../../../../src/shared/contracts/mailThreadContract';
import { MeetingCoordinator } from '../src/meetingCoordinator';
import { DynamoMeetingRepository } from '../src/meetingRepository';
import { DynamoStore, fingerprint } from '../src/dynamoStore';
import { WorkerAuth } from '../src/workerAuth';
import { RemoteGoogleAuthorization } from '../src/remoteGoogleAuthorization';
import { DynamoDispatchRepository, dispatchIntentSchema, phoneRequestedFollowupIntentSchema } from '../src/dispatchRepository';
import { googleScopes } from '../src/googleGrantCapabilities';
import { createExecutionRepository, executionAuthorityKey, executionAuthorityFields } from '../src/executionRepository';
import { DynamoThreadIntakeRepository, mailCursorKey, mailThreadKey, mailSuppressionKey } from '../src/threadIntakeRepository';
import { ConditionalCommandHarness } from './sdkHarness';
import type { MeetingIntent, SchedulingRules, MeetingOutcome } from '../../../../src/shared/contracts/meetingContract';

export async function meetingFixture(mail = false, configured = true) {
  let now = '2026-09-14T12:00:00.000Z'; const dynamo = new ConditionalCommandHarness();
  const options = { dynamo, workspaceId: 'ws-fiction', tableName: 'table-fiction', clock: { now: () => now } };
  const store = new DynamoStore(options); const auth = new WorkerAuth(options);
  const authorization = new RemoteGoogleAuthorization({ auth, config: { clientId: 'fictional.apps.googleusercontent.com', clientSecret: 'fictional', redirectUri: 'https://worker.example.test/oauth/callback', encryptionKey: Buffer.alloc(32, 9) }, fetch: async (url) => {
    if (String(url).endsWith('/token')) return Response.json({ access_token: 'fictional-token', refresh_token: 'fictional-refresh', token_type: 'Bearer', expires_in: 3600, scope: `openid email ${googleScopes.availability} ${googleScopes.event_write} ${googleScopes.relevant_read}${mail ? ` ${googleScopes.send}` : ''}` });
    if (String(url).endsWith('/userinfo')) return Response.json({ sub: 'subject-fiction', email: 'founder@example.test', email_verified: true });
    if (String(url).endsWith('/revoke')) return new Response('', { status: 200 });
    throw new Error('unconfigured fictional OAuth');
  } });
  const pair = await auth.redeemPairing((await auth.issuePairing({ scopes: ['google:grant', 'commands:write'], expiresInSeconds: 300 })).code, 'fictional-source');
  const calendarId = 'founder@example.test';
  const url = await authorization.beginGoogleGrant(pair.pairingId, mail ? ['availability', 'event_write', 'send', 'relevant_read'] : ['availability', 'event_write', 'relevant_read'], { confirmed: true, ownedCalendarId: calendarId, conflictCalendarIds: [calendarId, 'other@example.test'] });
  await authorization.completeGoogleGrant(new URL(url.authorizationUrl).searchParams.get('state')!, 'fictional-code');
  const rules: SchedulingRules = { revision: 1, confirmed: true, timezone: 'America/New_York', weeklyWindows: [{ weekday: 2, start: '09:00', end: '17:00' }], durationMinutes: 30, bufferBeforeMinutes: 10, bufferAfterMinutes: 10, minimumNoticeMinutes: 60, horizonDays: 30, ownedCalendarId: calendarId, conflictCalendarIds: [calendarId, 'other@example.test'], location: { kind: 'text', value: 'Fictional office' }, allowCancel: true, allowReschedule: true };
  const intent: MeetingIntent = { workspaceId: options.workspaceId, accountId: 'acct-fiction', meetingId: 'meeting-fiction', commandId: 'command-fiction', operation: 'create', expectedAuthorityGeneration: 1, expectedVersion: 2, rulesRevision: 1, threadId: 'thread-fiction', threadRevision: 1, contextRevision: 'context-fiction', mailboxSubject: 'subject-fiction', pairingId: pair.pairingId, start: '2026-09-15T14:00:00.000Z', end: '2026-09-15T14:30:00.000Z', localStart: '2026-09-15T10:00:00', offset: '-04:00', timezone: rules.timezone, agreementEvidenceId: 'message-fiction', agreement: { kind: 'explicit_slot', start: '2026-09-15T14:00:00.000Z', end: '2026-09-15T14:30:00.000Z', quote: 'Tuesday at 10 works.' }, mixedReply: false, approvalId: 'base-approval', attendeeEmails: ['prospect@example.test'], inviteAttendees: true, summary: 'Fictional meeting', etag: null };
  const configurationCommands: ReturnType<typeof ownerCommandSchema.parse>[] = [];
  const seedAccount = async (accountId: string) => {
    const scope = { version: 1 as const, accountId, mailboxSubject: intent.mailboxSubject, revision: 1, participantAddresses: ['prospect@example.test'], knownThreadIds: [intent.threadId], since: now, approvedAt: now };
    const binding = { scopeRevision: scope.revision, scopeFingerprint: mailScopeFingerprint(scope) };
    const authority = { authority: { accountId, owner: 'worker', state: 'active', generation: 1 }, version: 1 };
    await store.transact([store.put(`DISPATCH_INTAKE#${accountId}`, { accountId, adapters: [{ id: 'gmail-primary', kind: 'gmail', enabled: true, relevant: true, mailboxSubject: intent.mailboxSubject }], manualDependencies: [] }, null), store.put(executionAuthorityKey(accountId), authority, null, executionAuthorityFields(authority as Parameters<typeof executionAuthorityFields>[0])),
      store.put(mailCursorKey(accountId, intent.mailboxSubject), { scope, checkpoint: { ...binding, version: 1, accountId, mailboxSubject: intent.mailboxSubject, mode: 'history', historyId: '100', pageToken: null, since: now }, poll: { ...binding, accountId, mailboxSubject: intent.mailboxSubject, attemptId: 'poll-fiction', status: 'complete', startedAt: now, completedAt: now } }, null),
      store.put(mailThreadKey(accountId, intent.threadId), { thread: { accountId, mailboxSubject: intent.mailboxSubject, provider: 'gmail', providerThreadId: intent.threadId,
        messages: [{ id: 'message-fiction', threadId: intent.threadId, rfcMessageId: '<earlier@example.test>', references: [], from: ['prospect@example.test'], to: ['founder@example.test'], cc: [], date: new Date(Date.parse(now) - 1000).toISOString(), subject: 'Meeting', bodyParts: [{ mimeType: 'text/plain', text: 'Tuesday at 10 works.', truncated: false }] }] }, revision: 1, contextRevision: intent.contextRevision,
        signals: [{ kind: 'scheduling', requiresApproval: true, evidence: [{ messageId: 'message-fiction', quote: 'Tuesday at 10 works.' }] }] }, null)]);
    if (configured) {
    const account = { id: accountId, name: 'Fictional configured PM', domain: null as string | null, version: 1 };
    await store.transact([store.put(`ACCOUNT#${accountId}`, { account, sources: [], claims: [], routes: [], researchRevision: 1, history: [{ at: now, account, claims: [], routes: [] }] }, null)]);
    const command = ownerCommandSchema.parse({ commandId: randomUUID(), workspaceId: options.workspaceId, accountId, expectedAuthorityGeneration: 1, expectedVersion: 1,
      kind: 'configure-owner', payload: { expectedConfigurationRevision: 0, configuration: { version: 1, workspaceId: options.workspaceId, accountId, pairingId: pair.pairingId, revision: 1,
        state: 'active', mailboxSubject: intent.mailboxSubject, calendarId, research: null }, mailScope: null } });
    await new OwnerCommandCoordinator({ auth, authorization }).apply(command, `Bearer ${pair.credential}`);
    configurationCommands.push(command);
    }
  };
  await seedAccount(intent.accountId);
  const repository = () => new DynamoMeetingRepository(options, authorization);
  await repository().saveRules({ rules, expectedRevision: null });
  if (configured) await repository().approveIntent({ intent, calendarId });
  const access = await authorization.authorizedAccess(pair.pairingId, ['availability', 'event_write']);
  return { configurationCommands, options, store, dynamo, authorization, auth, pair, rules, intent, calendarId, access, repository, seedAccount, advance: () => { now = '2026-09-14T12:06:00.000Z'; } };
}
export function booked(identity: { meetingId: string; calendarId: string; providerEventId: string }): MeetingOutcome {
  return { ...identity, status: 'booked', reason: null, event: { ...identity, status: 'confirmed', etag: '"v1"', start: '2026-09-15T14:00:00.000Z', end: '2026-09-15T14:30:00.000Z', attendees: [{ email: 'prospect@example.test', responseStatus: 'needsAction' }], meetUrl: null } };
}
describe('durable meeting reservations on actual Dynamo command boundary', () => {
  it('rejects a valid phone-requested first email before reading unavailable thread fields', async () => {
    const f = await meetingFixture(); const commandId = randomUUID();
    const frozenMessage = { commandId, from: 'founder@example.test', to: 'prospect@example.test', subject: 'Requested follow-up', body: 'Tuesday, September 15, 2026 at 10:00 AM to 10:30 AM (America/New_York)' };
    const firstEmail = phoneRequestedFollowupIntentSchema.parse({ kind: 'phone_requested_followup', commandId, requestedApprovalCommandId: randomUUID(), draftId: 'phone-followup-fiction', draftRevision: 1,
      pairingId: f.pair.pairingId, mailboxSubject: f.intent.mailboxSubject, frozenMessage,
      action: { actionId: 'phone-action-fiction', workspaceId: f.intent.workspaceId, accountId: f.intent.accountId, expectedAuthorityGeneration: 1, approvalId: 'phone-approved-fiction', contentHash: fingerprint(frozenMessage), targetHash: fingerprint({ sender: frozenMessage.from, recipient: frozenMessage.to }) } });
    await f.store.transact([f.store.put(`DISPATCH_INTENT#${commandId}`, firstEmail, null)]);
    const offer = { id: 'unsupported-phone-offer', revision: 1, accountId: f.intent.accountId, mailboxSubject: f.intent.mailboxSubject, threadId: f.intent.threadId,
      sendCommandId: commandId, expiresAt: '2026-09-15T00:00:00.000Z', slots: [{ id: 'slot-one', start: f.intent.start, end: f.intent.end, timezone: f.intent.timezone }] };
    const parse = dispatchIntentSchema.parse.bind(dispatchIntentSchema);
    // Keep the real strict parser and real DTO. Instrument only reads of fields
    // absent from this variant, proving the discriminant is checked first.
    const guarded = vi.spyOn(dispatchIntentSchema, 'parse').mockImplementation(raw => {
      const parsed = parse(raw);
      if (parsed.kind === 'phone_requested_followup') for (const field of ['threadId', 'references', 'inReplyTo']) Object.defineProperty(parsed.frozenMessage, field, { get() { throw Error('first_email_thread_field_access'); } });
      return parsed;
    });
    const before = f.dynamo.transactions.length;
    try { await expect(f.repository().saveOffer({ offer, expectedRevision: null })).rejects.toThrow('offer_content_conflict'); }
    finally { guarded.mockRestore(); }
    expect(f.dynamo.transactions.length).toBe(before);
    expect(await f.store.get(`MEETING_OFFER#${f.intent.accountId}#${f.intent.threadId}`)).toBeNull();
    await expect(f.repository().saveOffer({ offer, expectedRevision: null })).rejects.toThrow('offer_content_conflict');
  });

  it('assigns distinct durable transition IDs to booked A -> unknown -> unchanged A but deduplicates exact retries', async () => {
    const f = await meetingFixture(); const r = await f.repository().reserve({ intent: f.intent, calendarId: f.calendarId }, f.access.accessEvidence);
    const a = booked(r.record.identity);
    for (const outcome of [a, { ...a, status: 'unknown' as const, reason: 'lookup_timeout', event: null }, a]) await f.repository().recordOutcome(f.intent.commandId, outcome);
    const events = (await f.store.eventsAfter(null)).events;
    expect(events).toHaveLength(5); expect(new Set(events.map(e => e.id)).size).toBe(5);
    await f.repository().recordOutcome(f.intent.commandId, a);
    expect((await f.store.eventsAfter(null)).events).toEqual(events);
  });
  it('settles a same-meeting pending successor when an older command observes cancellation', async () => {
    const f = await meetingFixture(); const r = await f.repository().reserve({ intent: f.intent, calendarId: f.calendarId }, f.access.accessEvidence);
    const a = booked(r.record.identity); await f.repository().recordOutcome(f.intent.commandId, a);
    const successor = { ...f.intent, operation: 'update' as const, commandId: 'reschedule-b', expectedVersion: f.intent.expectedVersion + 2, approvalId: 'approval-b', etag: a.event!.etag };
    await f.repository().approveIntent({ intent: successor, calendarId: f.calendarId });
    await f.repository().reserve({ intent: successor, calendarId: f.calendarId }, f.access.accessEvidence);
    const cancelled = { ...a, status: 'cancelled' as const, event: { ...a.event!, status: 'cancelled' as const } };
    await f.repository().recordOutcome(f.intent.commandId, cancelled);
    await f.repository().recordOutcome(successor.commandId, cancelled);
    expect((await f.repository().command(successor.commandId))?.outcome?.status).toBe('cancelled');
    expect((await f.store.get<{ activeCommandId: string | null }>(`MEETING_CALENDAR#${encodeURIComponent(f.calendarId)}`))?.data.activeCommandId).toBeNull();
    await f.seedAccount('next-account'); const next = { ...f.intent, accountId: 'next-account', meetingId: 'next-meeting', commandId: 'next-command', approvalId: 'next-approval' };
    await f.repository().approveIntent({ intent: next, calendarId: f.calendarId });
    expect((await f.repository().reserve({ intent: next, calendarId: f.calendarId }, f.access.accessEvidence)).kind).toBe('reserved');
  });
  it('never releases an unrelated meeting lock on repeated late cancellation', async () => {
    const f = await meetingFixture(); const r = await f.repository().reserve({ intent: f.intent, calendarId: f.calendarId }, f.access.accessEvidence);
    const a = booked(r.record.identity); const cancelled = { ...a, status: 'cancelled' as const, event: { ...a.event!, status: 'cancelled' as const } };
    await f.repository().recordOutcome(f.intent.commandId, cancelled);
    await f.seedAccount('unrelated-account');
    const other = { ...f.intent, accountId: 'unrelated-account', commandId: 'unrelated-command', meetingId: 'unrelated-meeting', approvalId: 'unrelated-approval' };
    await f.repository().approveIntent({ intent: other, calendarId: f.calendarId });
    await f.repository().reserve({ intent: other, calendarId: f.calendarId }, f.access.accessEvidence);
    const key = `MEETING_CALENDAR#${encodeURIComponent(f.calendarId)}`; const before = await f.store.get(key);
    await f.repository().recordOutcome(f.intent.commandId, cancelled);
    expect(await f.store.get(key)).toEqual(before);
    expect((await f.repository().command(other.commandId))?.state).toBe('dispatching');
  });
  it('fences successor command races before same-meeting cancellation cleanup', async () => {
    const f = await meetingFixture(); const r = await f.repository().reserve({ intent: f.intent, calendarId: f.calendarId }, f.access.accessEvidence);
    const a = booked(r.record.identity); await f.repository().recordOutcome(f.intent.commandId, a);
    const successor = { ...f.intent, operation: 'update' as const, commandId: 'racing-b', expectedVersion: f.intent.expectedVersion + 2, approvalId: 'racing-approval', etag: a.event!.etag };
    await f.repository().approveIntent({ intent: successor, calendarId: f.calendarId });
    await f.repository().reserve({ intent: successor, calendarId: f.calendarId }, f.access.accessEvidence);
    const key = 'MEETING_COMMAND#racing-b'; const current = (await f.store.get(key))!;
    f.dynamo.beforeTransaction = () => { f.dynamo.beforeTransaction = undefined; void f.store.transact([f.store.put(key, current.data, current.rev)]); };
    await expect(f.repository().recordOutcome(f.intent.commandId, { ...a, status: 'cancelled', event: { ...a.event!, status: 'cancelled' } })).rejects.toThrow();
    expect((await f.store.get<{ activeCommandId: string }>(`MEETING_CALENDAR#${encodeURIComponent(f.calendarId)}`))?.data.activeCommandId).toBe(successor.commandId);
    expect((await f.repository().command(successor.commandId))?.state).toBe('dispatching');
  });
  it.each(['thread', 'attendee'] as const)('requires current %s inside persisted account scope', async (missing) => {
    const f = await meetingFixture();
    const input = { ...f.intent, approvalId: 'scope-approval', ...(missing === 'thread' ? { threadId: 'uncovered-thread' } : { attendeeEmails: [...f.intent.attendeeEmails, 'uncovered@example.test'] }) };
    if (missing === 'thread') {
      const row = await f.store.get<{ thread: { providerThreadId: string; messages: { threadId: string }[] } }>(mailThreadKey(f.intent.accountId, f.intent.threadId));
      row!.data.thread.providerThreadId = input.threadId; row!.data.thread.messages.forEach(m => { m.threadId = input.threadId; });
      await f.store.transact([f.store.put(mailThreadKey(f.intent.accountId, input.threadId), row!.data, null)]);
    }
    await expect(f.repository().approveIntent({ intent: input, calendarId: f.calendarId })).rejects.toThrow('intake_incomplete');
  });
  it('rejects the primary alias of the same physical selected calendar before calls or reservations', async () => {
    const f = await meetingFixture(); await f.seedAccount('alias-account');
    const aliasRules = { ...f.rules, ownedCalendarId: 'primary', conflictCalendarIds: ['primary'] };
    await expect(f.repository().saveRules({ rules: aliasRules, expectedRevision: null })).rejects.toThrow('calendar_resource_id_required');
    // Simulate legacy persisted alias selection, not an admission shortcut for production.
    await f.store.transact([f.store.put('MEETING_RULES#primary', aliasRules, null)]);
    const url = await f.authorization.beginGoogleGrant(f.pair.pairingId, ['availability', 'event_write', 'relevant_read'], { confirmed: true, ownedCalendarId: 'primary', conflictCalendarIds: ['primary'] });
    await f.authorization.completeGoogleGrant(new URL(url.authorizationUrl).searchParams.get('state')!, 'fictional-code');
    const access = await f.authorization.authorizedAccess(f.pair.pairingId, ['availability', 'event_write']);
    const aliasIntent = { ...f.intent, accountId: 'alias-account', commandId: 'alias-command', meetingId: 'alias-meeting' };
    await expect(f.repository().reserve({ intent: aliasIntent, calendarId: 'primary' }, access.accessEvidence)).rejects.toThrow('calendar_resource_id_required');
    let calls = 0;
    const outcome = await new MeetingCoordinator({ repository: f.repository(), authorization: f.authorization, calendarId: 'primary', fetch: async () => { calls++; throw new Error('no alias HTTP'); } }).coordinateMeeting(aliasIntent);
    expect(outcome).toMatchObject({ status: 'held', reason: 'calendar_resource_id_required' });
    expect(calls).toBe(0); expect(await f.repository().command(aliasIntent.commandId)).toBeNull();
  });
  it.each(['ready', 'legacy', 'negated', 'ambiguous', 'mixed', 'source_race', 'lost_prepare_ack'] as const)('uses actual C4 send/C3 References for automatic work: %s', async scenario => {
    const f = await meetingFixture(true); const threads = new DynamoThreadIntakeRepository(f.options);
    const projection = (await threads.getThread(f.intent.accountId, f.intent.threadId))!;
    const source = projection.thread.messages[0]!;
    const commandId = '00000000-0000-4000-8000-000000000020';
    const draft: AccountReplyDraft = { id: 'actual-offer-draft', accountId: f.intent.accountId, threadId: f.intent.threadId, mailboxSubject: f.intent.mailboxSubject,
      threadRevision: projection.revision, contextRevision: projection.contextRevision, revision: 1, sender: 'founder@example.test', recipient: 'prospect@example.test',
      subject: 'Meeting offer', body: 'Tuesday, September 15, 2026 at 10:00 AM to 10:30 AM (America/New_York)', evidenceIds: [source.id], generation: 'edited', updatedAt: f.options.clock.now() };
    if (scenario === 'ambiguous') draft.body += '\nTuesday, September 22, 2026 at 10:00 AM to 10:30 AM (America/New_York)';
    const reply = scenario === 'negated' ? 'That works! Actually do not book.' : scenario === 'mixed' ? 'That works! Can you explain the price?' : 'That works!';
    await threads.saveReplyDraft(draft, null);
    const frozenMessage = { commandId, from: draft.sender, to: draft.recipient, subject: draft.subject, body: draft.body, threadId: draft.threadId,
      inReplyTo: '<earlier@example.test>', references: ['<earlier@example.test>'] };
    const policy = new DynamoDispatchRepository(f.options, f.authorization);
    const action = { actionId: 'actual-offer-action', workspaceId: f.intent.workspaceId, accountId: f.intent.accountId, expectedAuthorityGeneration: 1, approvalId: 'actual-offer-approval',
      contentHash: fingerprint(frozenMessage), targetHash: fingerprint({ sender: draft.sender, recipient: draft.recipient, threadId: draft.threadId }) };
    const outgoing = { kind: 'standalone_reply' as const, commandId, action, draftId: draft.id, draftRevision: 1, pairingId: f.intent.pairingId, mailboxSubject: f.intent.mailboxSubject,
      frozenMessage, binding: { kind: 'thread_participant' as const, threadId: draft.threadId, sourceMessageId: source.id, sourceMessageHash: fingerprint(source) } };
    const permission = { id: 'actual-offer-permission', accountId: f.intent.accountId, recipient: draft.recipient, sender: draft.sender, threadId: draft.threadId,
      sourceMessageId: source.id, sourceMessageHash: fingerprint(source), basis: 'ongoing_correspondence' as const, recordedAt: f.options.clock.now(), expiresAt: '2026-09-15T00:00:00.000Z' };
    await policy.admitPermission(permission);
    await policy.admitApproval({ id: action.approvalId, commandId, intentHash: fingerprint(outgoing), draft, permissionEvidenceId: permission.id, approvedAt: f.options.clock.now(), expiresAt: permission.expiresAt });
    await policy.admitIntent(outgoing); await policy.configureCaps({ sender: draft.sender, dailyLimit: 3 }, null);
    const execution = createExecutionRepository({ ...f.options, dispatchPolicy: policy });
    await execution.prepareAction({ ...action, expectedVersion: f.intent.expectedVersion });
    let sentRfc = ''; let sends = 0; let incoming = false; let httpRequests = 0;
    const fetch: typeof globalThis.fetch = async (url, init) => {
      httpRequests++;
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/messages/send')) {
        sends++; const wire = JSON.parse(String(init?.body)); const mime = Buffer.from(wire.raw, 'base64url').toString();
        sentRfc = /^Message-ID: (.+)$/im.exec(mime)![1]!.trim();
        expect(Buffer.from(mime.split('\r\n\r\n')[1]!.replace(/\s/g, ''), 'base64').toString().replace(/\r\n/g, '\n')).toBe(draft.body);
        return Response.json({ id: 'actual-accepted-message', threadId: draft.threadId });
      }
      if (path.endsWith('/history')) return Response.json({ historyId: incoming ? '102' : '101', history: incoming ? [{ messagesAdded: [{ message: { id: 'actual-reply' } }] }] : [] });
      if (path.endsWith('/messages/actual-reply')) return Response.json({ id: 'actual-reply', threadId: draft.threadId, internalDate: String(Date.parse(f.options.clock.now())),
        payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: draft.recipient }, { name: 'To', value: draft.sender }, { name: 'Subject', value: draft.subject },
          { name: 'Message-ID', value: '<actual-reply@example.test>' }, { name: 'In-Reply-To', value: sentRfc }], body: { data: Buffer.from(reply).toString('base64url') } } });
      throw new Error('unconfigured fictional message HTTP');
    };
    const result = await createDispatchService({ execution, policy, authorization: f.authorization, fetch }).dispatch(commandId);
    expect(result.reason).toBe('provider_accepted');
    expect(result).toMatchObject({ status: 'provider_accepted', providerIdentity: { messageId: 'actual-accepted-message', threadId: draft.threadId } });
    expect(sends).toBe(1); expect(sentRfc).toBe(`<${commandId}@callie.invalid>`);
    expect((await policy.sendEvidence(commandId))[0]).toMatchObject({ state: 'provider_accepted', rfcMessageId: sentRfc });
    incoming = true;
    expect((await createMailPoller({ authorization: f.authorization, store: threads, fetch }).pollOnce({ pairingId: f.intent.pairingId, accountId: f.intent.accountId, mailboxSubject: f.intent.mailboxSubject }, new AbortController().signal)).complete).toBe(true);
    const current = (await threads.getThread(f.intent.accountId, f.intent.threadId))!;
    expect(current.thread.messages.find(m => m.id === 'actual-reply')?.references).toContain(sentRfc);
    const offer: import('../../../../src/shared/contracts/meetingContract').MeetingOffer = { meeting: { summary: 'Callie meeting', inviteAttendees: true }, id: 'actual-offer', revision: 1, accountId: f.intent.accountId, mailboxSubject: f.intent.mailboxSubject, threadId: f.intent.threadId, sendCommandId: commandId,
      expiresAt: '2026-09-15T00:00:00.000Z', slots: [{ id: 'actual-slot', start: f.intent.start, end: f.intent.end, timezone: f.intent.timezone }] };
    if (scenario === 'legacy') delete offer.meeting;
    if (scenario === 'ambiguous') offer.slots.push({ id: 'competing-slot', start: '2026-09-22T14:00:00.000Z', end: '2026-09-22T14:30:00.000Z', timezone: f.intent.timezone });
    await f.repository().saveOffer({ offer, expectedRevision: null });
    const target = { accountId: f.intent.accountId, threadId: f.intent.threadId }; const beforePreparation = httpRequests;
    if (['legacy', 'negated', 'ambiguous', 'mixed'].includes(scenario)) {
      expect(await f.repository().prepareOfferedReply(target)).toBeNull(); expect(httpRequests).toBe(beforePreparation); return;
    }
    if (scenario === 'source_race') {
      const key = ownerSourceKey(f.intent.accountId); const row = (await f.store.get<unknown>(key))!; const config = ownerSourceConfigurationSchema.parse(row.data);
      f.dynamo.beforeTransaction = () => { f.dynamo.beforeTransaction = undefined; void f.store.transact([f.store.put(key, { ...config, state: 'paused' }, row.rev)]); };
      await expect(f.repository().prepareOfferedReply(target)).rejects.toThrow('TransactionCanceledException');
      expect((await f.repository().listPreparedIntents(f.intent.accountId)).work.every(w => w.input.intent.agreement?.kind !== 'offered_slot')).toBe(true); return;
    }
    if (scenario === 'lost_prepare_ack') {
      f.dynamo.afterCommit = () => { f.dynamo.afterCommit = undefined; throw new Error('lost preparation acknowledgement'); };
      await expect(f.repository().prepareOfferedReply(target)).rejects.toThrow('lost preparation acknowledgement');
    }
    const work = await f.repository().prepareOfferedReply(target);
    expect(work).not.toBeNull(); expect(httpRequests).toBe(beforePreparation);
    expect(work!.input.intent).toMatchObject({ agreementEvidenceId: 'actual-reply', approvalId: null, summary: 'Callie meeting', inviteAttendees: true,
      agreement: { kind: 'offered_slot', offerId: offer.id, slotId: 'actual-slot' } });
    expect(await f.repository().prepareOfferedReply({ accountId: f.intent.accountId, threadId: f.intent.threadId })).toEqual(work);
    expect((await f.repository().listAcceptedOffers(f.intent.accountId)).offers).toEqual([offer]);
    expect((await f.repository().reserve(work!.input, (await f.authorization.authorizedAccess(f.pair.pairingId, ['availability', 'event_write'])).accessEvidence)).kind).toBe('reserved');
    expect(await f.repository().prepareOfferedReply(target)).toBeNull();
    expect((await f.repository().listPreparedIntents(f.intent.accountId)).work.some(w => w.input.intent.commandId === work!.input.intent.commandId)).toBe(false);
    expect((await f.repository().reserve(work!.input, (await f.authorization.authorizedAccess(f.pair.pairingId, ['availability', 'event_write'])).accessEvidence)).kind).toBe('existing');
    expect(sends).toBe(1);

  });
  it.each(['missing', 'paused', 'pairing', 'mailbox', 'calendar', 'workspace', 'account'] as const)('holds a %s owner-source configuration before reservation', async defect => {
    const f = await meetingFixture(false, false); f.intent.expectedVersion = 1;
    if (defect !== 'missing') {
      const config: ReturnType<typeof ownerSourceConfigurationSchema.parse> = { version: 1, workspaceId: f.intent.workspaceId, accountId: f.intent.accountId, pairingId: f.intent.pairingId, revision: 1,
        state: defect === 'paused' ? 'paused' : 'active', mailboxSubject: f.intent.mailboxSubject, calendarId: f.calendarId, research: null };
      if (defect === 'pairing') config.pairingId = 'wrong-pairing';
      if (defect === 'mailbox') config.mailboxSubject = 'wrong-mailbox';
      if (defect === 'calendar') config.calendarId = 'wrong@example.test';
      if (defect === 'workspace') config.workspaceId = 'wrong-workspace';
      if (defect === 'account') config.accountId = 'wrong-account';
      await f.store.transact([f.store.put(ownerSourceKey(f.intent.accountId), ownerSourceConfigurationSchema.parse(config), null)]);
    }
    await expect(f.repository().reserve({ intent: f.intent, calendarId: f.calendarId }, f.access.accessEvidence)).rejects.toThrow('meeting_source_inactive');
    expect(await f.repository().command(f.intent.commandId)).toBeNull();
  });
  it.each(['paused', 'pairing', 'mailbox', 'calendar'] as const)('fences a source %s change at the exact final transaction', async change => {
    const f = await meetingFixture(); const key = ownerSourceKey(f.intent.accountId); const row = (await f.store.get<unknown>(key))!;
    const config = ownerSourceConfigurationSchema.parse(row.data);
    const changed = { ...config, revision: config.revision + 1,
      ...(change === 'paused' ? { state: 'paused' as const } : change === 'pairing' ? { pairingId: 'different-pairing' }
        : change === 'mailbox' ? { mailboxSubject: 'different-mailbox' } : { calendarId: 'different@example.test' }) };
    f.dynamo.beforeTransaction = () => { f.dynamo.beforeTransaction = undefined; void f.store.transact([f.store.put(key, changed, row.rev)]); };
    await expect(f.repository().reserve({ intent: f.intent, calendarId: f.calendarId }, f.access.accessEvidence)).rejects.toThrow('TransactionCanceledException');
    const final = f.dynamo.transactions.at(-1)!;
    expect(final.TransactItems?.filter(item => item.ConditionCheck?.Key?.sk?.S === key)).toHaveLength(1);
    expect(await f.repository().command(f.intent.commandId)).toBeNull();
  });
  it('persists full exact approved work, not only an approval fingerprint', async () => {
    const f = await meetingFixture();
    const approval = await f.store.get<{ input: unknown }>('MEETING_APPROVAL#base-approval');
    expect(approval?.data.input).toEqual({ intent: f.intent, calendarId: f.calendarId });
    const page = await f.repository().listPreparedIntents(f.intent.accountId);
    expect(page.work).toHaveLength(1); expect(page.work[0]!.input).toEqual({ intent: f.intent, calendarId: f.calendarId });
    expect(page.work[0]!.fingerprint).toBe(fingerprint(page.work[0]!.input));
  });
  it('rejects fingerprint-only legacy approval and tampered full approval input', async () => {
    const f = await meetingFixture(); const key = 'MEETING_APPROVAL#base-approval'; const row = (await f.store.get<{ input: { intent: MeetingIntent }; fingerprint: string }>(key))!;
    await f.store.transact([f.store.put(key, { fingerprint: row.data.fingerprint }, row.rev)]);
    await expect(f.repository().reserve({ intent: f.intent, calendarId: f.calendarId }, f.access.accessEvidence)).rejects.toThrow('meeting_approval_missing');
    row.data.input.intent.summary = 'Unapproved commitment';
    await f.store.transact([f.store.put(key, row.data, row.rev + 1)]);
    await expect(f.repository().reserve({ intent: f.intent, calendarId: f.calendarId }, f.access.accessEvidence)).rejects.toThrow('meeting_approval_missing');
  });
  it('reads bounded pages and advances past consumed work without starvation', async () => {
    const f = await meetingFixture(); const next = { ...f.intent, commandId: 'command-z', approvalId: 'approval-z' };
    await f.repository().approveIntent({ intent: next, calendarId: f.calendarId });
    await f.repository().reserve({ intent: f.intent, calendarId: f.calendarId }, f.access.accessEvidence);
    const limits: number[] = [];
    const repository = new DynamoMeetingRepository({ ...f.options, dynamo: { async send(command) {
      const response = await f.dynamo.send(command);
      if (!(command instanceof QueryCommand)) return response;
      const limit = command.input.Limit!; limits.push(limit);
      const after = command.input.ExclusiveStartKey?.sk?.S ?? '';
      const rows = (response.Items ?? []).filter(row => row.sk!.S! > after); const selected = rows.slice(0, limit);
      return { ...response, Items: selected, ...(rows.length > limit ? { LastEvaluatedKey: { pk: selected.at(-1)!.pk!, sk: selected.at(-1)!.sk! } } : {}) };
    } } }, f.authorization);
    const first = await repository.listPreparedIntents(f.intent.accountId, null, 1);
    expect(first.work).toEqual([]); expect(first.nextCursor).not.toBeNull();
    const second = await repository.listPreparedIntents(f.intent.accountId, first.nextCursor, 1);
    expect(second.work.map(work => work.input.intent.commandId)).toEqual([next.commandId]); expect(second.nextCursor).toBeNull();
    expect(limits).toEqual([1, 1]);
    await expect(repository.listPreparedIntents('other-account', first.nextCursor, 1)).rejects.toThrow('meeting_cursor_invalid');
    await expect(repository.listPreparedIntents(f.intent.accountId, first.nextCursor, 2)).rejects.toThrow('meeting_cursor_invalid');
    await expect(repository.listPreparedIntents(f.intent.accountId, 'MEETING_INTENT#other#command', 1)).rejects.toThrow('meeting_cursor_invalid');
    await expect(repository.listPreparedIntents(f.intent.accountId, null, 26)).rejects.toThrow();
    const reservations = await repository.listReservations(f.intent.accountId, null, 1);
    expect(reservations.records[0]!.intent).toEqual(f.intent);
    const outcome = booked(reservations.records[0]!.identity);
    await f.repository().recordOutcome(f.intent.commandId, { ...outcome, status: 'cancelled', event: { ...outcome.event!, status: 'cancelled' } });
    await f.seedAccount('other-page-account');
    const other = { ...f.intent, accountId: 'other-page-account', commandId: 'aaa-other-page', meetingId: 'other-page-meeting', approvalId: 'other-page-approval' };
    await f.repository().approveIntent({ intent: other, calendarId: f.calendarId });
    await f.repository().reserve({ intent: other, calendarId: f.calendarId }, f.access.accessEvidence);
    const filtered = await repository.listReservations(f.intent.accountId, null, 1);
    expect(filtered.records).toEqual([]); expect(filtered.nextCursor).not.toBeNull();
    const own = await repository.listReservations(f.intent.accountId, filtered.nextCursor, 1);
    expect(own.records.map(record => record.intent.commandId)).toEqual([f.intent.commandId]);
    await expect(repository.listReservations(other.accountId, filtered.nextCursor, 1)).rejects.toThrow('meeting_cursor_invalid');

  });
  it('persists stable identity before dispatch and never redispatches after restart', async () => {
    const f = await meetingFixture(); const first = await f.repository().reserve({ intent: f.intent, calendarId: f.calendarId }, f.access.accessEvidence);
    expect(first.kind).toBe('reserved'); expect(first.record.identity.providerEventId).toMatch(/^[a-f0-9]{64}$/);
    const again = await f.repository().reserve({ intent: f.intent, calendarId: f.calendarId }, f.access.accessEvidence);
    expect(again.kind).toBe('existing'); expect(again.record.identity).toEqual(first.record.identity);
    await expect(f.repository().reserve({ intent: { ...f.intent, summary: 'changed' }, calendarId: f.calendarId }, f.access.accessEvidence)).rejects.toThrow('command_fingerprint_conflict');
  });
  it('serializes two accounts on the same calendar and retains occupied buffers after booking', async () => {
    const f = await meetingFixture(); await f.seedAccount('acct-other');
    const other = { ...f.intent, accountId: 'acct-other', commandId: 'command-other', meetingId: 'meeting-other', approvalId: 'other-approval' };
    await f.repository().approveIntent({ intent: other, calendarId: f.calendarId });
    const results = await Promise.allSettled([f.repository().reserve({ intent: f.intent, calendarId: f.calendarId }, f.access.accessEvidence), f.repository().reserve({ intent: other, calendarId: f.calendarId }, f.access.accessEvidence)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const winner = results.find(r => r.status === 'fulfilled')!; if (winner.status !== 'fulfilled') throw new Error();
    await f.repository().recordOutcome(winner.value.record.intent.commandId, booked(winner.value.record.identity));
    const loser = winner.value.record.intent.commandId === f.intent.commandId ? other : f.intent;
    await expect(f.repository().reserve({ intent: loser, calendarId: f.calendarId }, f.access.accessEvidence)).rejects.toThrow('calendar_overlap');
  });
  it.each(['authority', 'thread', 'poll', 'suppression', 'grant'] as const)('fences %s races in the actual final transaction', async (change) => {
    const f = await meetingFixture();
    const key = change === 'authority' ? executionAuthorityKey(f.intent.accountId) : change === 'thread' ? mailThreadKey(f.intent.accountId, f.intent.threadId) : change === 'poll' ? mailCursorKey(f.intent.accountId, f.intent.mailboxSubject) : change === 'grant' ? `GOOGLE_GRANT#${f.pair.pairingId}` : mailSuppressionKey(f.intent.accountId);
    const current = await f.store.get(key);
    const mutate = async () => { await f.store.transact([f.store.put(key, current?.data ?? { accountId: f.intent.accountId }, current?.rev ?? null)]); };
    // The harness executes its callback synchronously before transaction conditions.
    f.dynamo.beforeTransaction = () => { f.dynamo.beforeTransaction = undefined; void mutate(); };
    await expect(f.repository().reserve({ intent: f.intent, calendarId: f.calendarId }, f.access.accessEvidence)).rejects.toThrow();
    expect(await f.repository().command(f.intent.commandId)).toBeNull();
  });
  it('does not cherry-pick a positive quote out of a negated full reply', async () => {
    const f = await meetingFixture(); const key = mailThreadKey(f.intent.accountId, f.intent.threadId);
    const thread = await f.store.get<{ thread: { messages: { bodyParts: { text: string }[] }[] } }>(key);
    thread!.data.thread.messages[0]!.bodyParts[0]!.text = 'Tuesday at 10 works. Actually no, do not book it.';
    await f.store.transact([f.store.put(key, thread!.data, thread!.rev)]);
    await expect(f.repository().reserve({ intent: f.intent, calendarId: f.calendarId }, f.access.accessEvidence)).rejects.toThrow('agreement_unclear');
  });
  it('requires explicit owner approval for free-form evidence not bound to an accepted offer', async () => {
    const f = await meetingFixture(); f.intent.approvalId = null;
    await expect(f.repository().reserve({ intent: f.intent, calendarId: f.calendarId }, f.access.accessEvidence)).rejects.toThrow('meeting_approval_missing');
  });
  it.each([['That works!', false], ['Tuesday at 10 am Eastern works for me', false], ['That works!', true]] as const)('binds ordinary reply %s to complete accepted offers (omitted option: %s)', async (reply, omittedOption) => {
    const f = await meetingFixture(); const commandId = '00000000-0000-4000-8000-000000000010';
    const frozenMessage = { commandId, from: 'founder@example.test', to: 'prospect@example.test', subject: 'Meeting offer', body: 'Tuesday, September 15, 2026 at 10:00 AM to 10:30 AM (America/New_York)', threadId: f.intent.threadId, inReplyTo: '<earlier@example.test>', references: ['<earlier@example.test>'] };
    if (omittedOption) frozenMessage.body += '\nTuesday, September 22, 2026 at 10:00 AM to 10:30 AM (America/New_York)';
    const contentHash = fingerprint(frozenMessage); const targetHash = fingerprint({ sender: frozenMessage.from, recipient: frozenMessage.to, threadId: frozenMessage.threadId });
    const action = { actionId: 'offered-action', workspaceId: f.intent.workspaceId, accountId: f.intent.accountId, expectedAuthorityGeneration: 1, approvalId: 'offer-approved', contentHash, targetHash };
    const dispatch = new DynamoDispatchRepository(f.options, f.authorization);
    await dispatch.admitIntent({ kind: 'standalone_reply', commandId, action, draftId: 'draft-offer', draftRevision: 1, pairingId: f.intent.pairingId, mailboxSubject: f.intent.mailboxSubject, frozenMessage, binding: { kind: 'thread_participant', threadId: f.intent.threadId, sourceMessageId: 'message-fiction', sourceMessageHash: 'a'.repeat(64) } });
    const evidence = { commandId, reservation: { actionId: action.actionId, workspaceId: action.workspaceId, accountId: action.accountId, authorityGeneration: 1, contentHash, targetHash, state: 'dispatching' }, state: 'provider_accepted', observedAt: f.options.clock.now(), kind: 'provider_result', reason: 'provider_accepted', rfcMessageId: `<${commandId}@callie.invalid>`, providerIdentity: { messageId: 'offered-provider-message', threadId: f.intent.threadId } };
    await f.store.transact([f.store.put(`ACTION#${f.intent.accountId}#${action.actionId}`, { state: 'provider_accepted' }, null), f.store.put(`DISPATCH_EVIDENCE#${commandId}#${fingerprint(evidence)}`, evidence, null)]);
    const offer = { id: 'offer-one', revision: 1, accountId: f.intent.accountId, mailboxSubject: f.intent.mailboxSubject, threadId: f.intent.threadId, sendCommandId: commandId, expiresAt: '2026-09-15T00:00:00.000Z', slots: [{ id: 'slot-one', start: f.intent.start, end: f.intent.end, timezone: f.intent.timezone }] };
    const originalBody = frozenMessage.body;
    const sentKey = `DISPATCH_INTENT#${commandId}`; const sentRow = await f.store.get<{ frozenMessage: typeof frozenMessage; action: typeof action }>(sentKey);
    sentRow!.data.frozenMessage.body += '\nTuesday, September 22, 2026 at 10:00 AM to 10:30 AM (America/New_York)';
    sentRow!.data.action.contentHash = fingerprint(sentRow!.data.frozenMessage);
    // The old accepted receipt cannot prove a newly altered outgoing offer body.
    await f.store.transact([f.store.put(sentKey, sentRow!.data, sentRow!.rev)]);
    await expect(f.repository().saveOffer({ offer, expectedRevision: null })).rejects.toThrow();
    sentRow!.data.frozenMessage.body = originalBody; sentRow!.data.action.contentHash = contentHash;
    await f.store.transact([f.store.put(sentKey, sentRow!.data, sentRow!.rev + 1)]);
    if (omittedOption) { await expect(f.repository().saveOffer({ offer, expectedRevision: null })).rejects.toThrow('offer_content_conflict'); return; }
    await f.repository().saveOffer({ offer, expectedRevision: null });
    const key = mailThreadKey(f.intent.accountId, f.intent.threadId); const row = await f.store.get<{ thread: { messages: { bodyParts: { text: string }[]; references: string[] }[] }; signals: unknown[] }>(key);
    row!.data.thread.messages[0]!.bodyParts[0]!.text = reply; row!.data.thread.messages[0]!.references = [evidence.rfcMessageId];
    row!.data.signals = [{ kind: 'ambiguous', requiresApproval: true, evidence: [{ messageId: 'message-fiction', quote: reply }] }];
    await f.store.transact([f.store.put(key, row!.data, row!.rev)]);
    const intent = { ...f.intent, agreement: { kind: 'offered_slot' as const, offerId: offer.id, offerRevision: 1, slotId: 'slot-one', quote: reply } };
    expect((await f.repository().reserve({ intent, calendarId: f.calendarId }, f.access.accessEvidence)).kind).toBe('reserved');
  });
  it('atomically appends replayable meeting outcome events and advances current AUTH without changing ownership', async () => {
    const f = await meetingFixture(); const reserved = await f.repository().reserve({ intent: f.intent, calendarId: f.calendarId }, f.access.accessEvidence);
    await f.repository().recordOutcome(f.intent.commandId, booked(reserved.record.identity));
    const events = await f.store.eventsAfter(null);
    expect(events.events).toHaveLength(3);
    expect(events.events[1]).toMatchObject({ kind: 'meeting.outcome', aggregateVersion: 3, payload: { outcome: { status: 'unknown', reason: 'reservation_pending' } } });
    expect(events.events[2]).toMatchObject({ kind: 'meeting.outcome', aggregateVersion: 4, authorityGeneration: 1, payload: { commandId: f.intent.commandId, outcome: { status: 'booked' } } });
    expect((await f.store.get<{ version: number }>(executionAuthorityKey(f.intent.accountId)))?.data.version).toBe(4);
    await f.repository().recordOutcome(f.intent.commandId, booked(reserved.record.identity));
    expect((await f.store.eventsAfter(null)).events).toHaveLength(3);
  });
  it('holds when another configured relevant intake adapter has not completed', async () => {
    const f = await meetingFixture();
    await f.store.transact([f.store.put(`DISPATCH_INTAKE#${f.intent.accountId}`, { accountId: f.intent.accountId, adapters: [
      { id: 'gmail-primary', kind: 'gmail', enabled: true, relevant: true, mailboxSubject: f.intent.mailboxSubject },
      { id: 'gmail-other', kind: 'gmail', enabled: true, relevant: true, mailboxSubject: 'other-subject' },
    ], manualDependencies: [] }, 2)]);
    await expect(f.repository().reserve({ intent: f.intent, calendarId: f.calendarId }, f.access.accessEvidence)).rejects.toThrow('intake_incomplete');
  });
  it('keeps a durably booked outcome when publication fails and replays outbox without a new outcome', async () => {
    const f = await meetingFixture(); let fail = true; const published: string[] = [];
    const options = { ...f.options, publish: async (event: { id: string }) => { if (fail) throw new Error('fictional subscriber down'); published.push(event.id); } };
    const repository = new DynamoMeetingRepository(options, f.authorization);
    const reserved = await repository.reserve({ intent: f.intent, calendarId: f.calendarId }, f.access.accessEvidence);
    expect((await repository.recordOutcome(f.intent.commandId, booked(reserved.record.identity))).status).toBe('booked');
    fail = false; await new DynamoStore(options).retryPublications();
    expect(published).toHaveLength(2); expect((await f.store.eventsAfter(null)).events).toHaveLength(3);
  });
  it('requires complete fresh polling and exact current thread agreement evidence', async () => {
    const f = await meetingFixture(); f.advance();
    await expect(f.repository().reserve({ intent: f.intent, calendarId: f.calendarId }, f.access.accessEvidence)).rejects.toThrow('intake_stale');
    const next = await meetingFixture();
    await expect(next.repository().reserve({ intent: { ...next.intent, agreementEvidenceId: 'invented' }, calendarId: next.calendarId }, next.access.accessEvidence)).rejects.toThrow('agreement_evidence_missing');
  });
  it('requires persisted exact mixed reply approval and keeps cancelled terminal against late booking', async () => {
    const f = await meetingFixture(); const intent = { ...f.intent, commandId: 'mixed-command', mixedReply: true, approvalId: 'approval-fiction' };
    await expect(f.repository().reserve({ intent, calendarId: f.calendarId }, f.access.accessEvidence)).rejects.toThrow('meeting_approval_missing');
    await f.repository().approveIntent({ intent, calendarId: f.calendarId });
    const reservation = await f.repository().reserve({ intent, calendarId: f.calendarId }, f.access.accessEvidence);
    const outcome = booked(reservation.record.identity);
    await f.repository().recordOutcome(intent.commandId, { ...outcome, status: 'cancelled', event: { ...outcome.event!, status: 'cancelled', etag: '"v2"' } });
    expect((await f.repository().recordOutcome(intent.commandId, outcome)).status).toBe('cancelled');
  });
});
