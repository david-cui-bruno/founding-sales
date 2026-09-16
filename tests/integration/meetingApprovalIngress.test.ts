import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createWorkerHandler } from '../../cloud/lambdas/delegated-worker/src/handler';
import { WorkerAuth } from '../../cloud/lambdas/delegated-worker/src/workerAuth';
import { RemoteGoogleAuthorization } from '../../cloud/lambdas/delegated-worker/src/remoteGoogleAuthorization';
import { createExecutionRepository, authorityRecordSchema, executionAuthorityFields, executionAuthorityKey } from '../../cloud/lambdas/delegated-worker/src/executionRepository';
import { DynamoThreadIntakeRepository, mailCursorKey } from '../../cloud/lambdas/delegated-worker/src/threadIntakeRepository';
import { DynamoMeetingRepository, meetingWorkKey } from '../../cloud/lambdas/delegated-worker/src/meetingRepository';
import { createSourceCoordinator } from '../../cloud/lambdas/delegated-worker/src/sourceCoordinator';
import { ConditionalCommandHarness } from '../../cloud/lambdas/delegated-worker/test/sdkHarness';
import { googleScopes } from '../../cloud/lambdas/delegated-worker/src/googleGrantCapabilities';
import { mailScopeFingerprint } from '../../src/main/outreach/providers/gmailThreadProvider';
import type { MeetingIntent, SchedulingRules } from '../../src/shared/contracts/meetingContract';
import type { AccountPreparation } from '../../src/shared/contracts/accountPreparationContract';
import type { MailMessage } from '../../src/shared/contracts/mailThreadContract';
import { ExecutionClient } from '../../src/main/delegation/executionClient';
import { SqlDelegationTransport } from '../../src/main/delegation/delegationSync';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { openDatabase, closeDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';
import { delegationCommandSchema, eventPageSchema } from '../../src/shared/contracts/delegationContract';
import { fingerprint } from '../../cloud/lambdas/delegated-worker/src/dynamoStore';
import { ownerSourceKey, type OwnerCommand, type OwnerSourceConfiguration } from '../../src/shared/contracts/ownerCommandContract';

const noNetwork = vi.fn(async (): Promise<never> => { throw Error('No real network allowed'); });
afterEach(() => { expect(noNetwork).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });
async function fixture(configureRules = true) {
  vi.stubGlobal('fetch', noNetwork);
  let now = '2026-09-14T12:00:00.000Z';
  const workspaceId = 'meeting-ingress', accountId = 'prepared-company', mailboxSubject = 'mailbox';
  const calendarId = 'founder@example.test', host = 'meeting.example.test';
  const dynamo = new ConditionalCommandHarness(), options = { dynamo, workspaceId, tableName: 'fictional', clock: { now: () => now } };
  const auth = new WorkerAuth(options), store = auth.store;
  const counts = { calendarInserts: 0, emailSends: 0, forbidden: 0 };
  const events = new Map<string, unknown>();
  let uncertainInsert = false, hideEvent = false;
  const provider: typeof fetch = async (resource, init) => {
    const url = new URL(String(resource)), method = init?.method ?? 'GET';
    if (url.pathname.endsWith('/token')) return Response.json({ access_token: 'fictional', refresh_token: 'fictional-refresh', token_type: 'Bearer', expires_in: 3600, scope: `openid email ${googleScopes.relevant_read} ${googleScopes.availability} ${googleScopes.event_write}` });
    if (url.pathname.endsWith('/userinfo')) return Response.json({ sub: mailboxSubject, email: calendarId, email_verified: true });
    if (url.pathname.endsWith('/history')) return Response.json({ historyId: '1', history: [] });
    if (url.pathname.endsWith('/freeBusy')) return Response.json({ calendars: { [calendarId]: { busy: [] } } });
    if (url.pathname.includes('/calendars/')) {
      if (method === 'POST' && url.pathname.endsWith('/events')) {
        counts.calendarInserts++;
        const body = JSON.parse(String(init?.body));
        events.set(body.id, { ...body, status: 'confirmed', etag: 'fictional-etag', attendees: body.attendees.map((a: { email: string }) => ({ ...a, responseStatus: 'needsAction' })) });
        if (uncertainInsert) throw Error('Fictional lost insert response');
        return Response.json(events.get(body.id));
      }
      if (url.pathname.endsWith('/events')) return Response.json({ items: [...events.values()] });
      const event = events.get(url.pathname.split('/').at(-1)!);
      if (hideEvent && event) throw Error('Fictional lookup unavailable');
      return event ? Response.json(event) : new Response('', { status: 404 });
    }
    if (url.pathname.endsWith('/messages/send')) counts.emailSends++;
    counts.forbidden++; throw Error('Unexpected provider operation');
  };
  const google = new RemoteGoogleAuthorization({ auth, fetch: provider, config: { clientId: 'fictional.apps.googleusercontent.com', clientSecret: 'fictional', redirectUri: `https://${host}/oauth/callback`, encryptionKey: Buffer.alloc(32, 8) } });
  const pair = await auth.redeemPairing((await auth.issuePairing({ scopes: ['commands:write', 'events:read', 'google:grant'], expiresInSeconds: 300 })).code, 'fictional');
  const grant = await google.beginGoogleGrant(pair.pairingId, ['relevant_read', 'availability', 'event_write'], { confirmed: true, ownedCalendarId: calendarId, conflictCalendarIds: [calendarId] });
  await google.completeGoogleGrant(new URL(grant.authorizationUrl).searchParams.get('state')!, 'fictional');
  const handler = createWorkerHandler({ auth, host, google });
  const request = (path: string, body?: unknown, bearer = `Bearer ${pair.credential}`) => {
    const url = new URL(path, `https://${host}`);
    return handler({ version: '2.0', rawPath: url.pathname, rawQueryString: url.search.slice(1), headers: { host, 'x-forwarded-proto': 'https', authorization: bearer }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { domainName: host, http: { method: body === undefined ? 'GET' : 'POST', sourceIp: 'fictional' } } });
  };
  const execution = createExecutionRepository(options);
  await execution.seedLocalAuthority(accountId);
  const account: { id: string; name: string; version: number; domain: string | null } = { id: accountId, name: 'Already prepared PM', version: 1, domain: null };
  await store.transact([store.put(`ACCOUNT#${accountId}`, { account, routes: [], sources: [], claims: [], researchRevision: 1, history: [{ at: now, account, routes: [], claims: [] }] }, null)]);
  const delegate = { commandId: randomUUID(), workspaceId, accountId, expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'delegate' as const, payload: { delegationId: 'explicit', approvedAt: now } };
  expect((await request('/commands', delegate)).statusCode).toBe(200);
  const threads = new DynamoThreadIntakeRepository(options);
  const message: MailMessage = { id: 'agreement', threadId: 'thread1', rfcMessageId: '<agreement@example.test>', references: [], from: ['prospect@example.test'], to: [calendarId], cc: [], date: now, subject: 'Meeting agreement', bodyParts: [{ mimeType: 'text/plain' as const, text: 'Tuesday September 15 at 10 am Eastern works for our 30 minute meeting.', truncated: false }] };
  await threads.applyPage({ complete: true, threads: [{ accountId, mailboxSubject, provider: 'gmail', providerThreadId: 'thread1', messages: [message] }], nextCursor: { version: 1, accountId, mailboxSubject, mode: 'history', historyId: '1', pageToken: null, since: now } }, null);
  const projection = (await threads.getThread(accountId, 'thread1'))!;
  const scope = { version: 1 as const, accountId, mailboxSubject, revision: 1, participantAddresses: message.from, knownThreadIds: ['thread1'], since: now, approvedAt: now };
  const binding = { scopeRevision: 1, scopeFingerprint: mailScopeFingerprint(scope) };
  const cursor = (await store.get(mailCursorKey(accountId, mailboxSubject)))!;
  await store.transact([store.put(mailCursorKey(accountId, mailboxSubject), { scope, checkpoint: { ...binding, version: 1, accountId, mailboxSubject, mode: 'history', historyId: '1', pageToken: null, since: now }, poll: { ...binding, attemptId: 'initial', accountId, mailboxSubject, status: 'complete', startedAt: now, completedAt: now } }, cursor.rev), store.put(`DISPATCH_INTAKE#${accountId}`, { accountId, adapters: [{ id: 'gmail', kind: 'gmail', enabled: true, relevant: true, mailboxSubject }], manualDependencies: [] }, null)]);
  const configuration: OwnerSourceConfiguration = { version: 1, workspaceId, accountId, pairingId: pair.pairingId, revision: 1, state: 'active', mailboxSubject, calendarId, research: null };
  const configureCommand: Extract<OwnerCommand, { kind: 'configure-owner' }> = { commandId: randomUUID(), workspaceId, accountId, expectedAuthorityGeneration: 1, expectedVersion: await execution.currentVersion(accountId), kind: 'configure-owner', payload: { expectedConfigurationRevision: 0, configuration, mailScope: null } };
  expect((await request('/commands', configureCommand)).statusCode).toBe(200);
  const rules: SchedulingRules = { revision: 1, confirmed: true, timezone: 'America/New_York', weeklyWindows: [{ weekday: 2, start: '09:00', end: '17:00' }], durationMinutes: 30, bufferBeforeMinutes: 10, bufferAfterMinutes: 10, minimumNoticeMinutes: 60, horizonDays: 30, ownedCalendarId: calendarId, conflictCalendarIds: [calendarId], location: { kind: 'text', value: 'Fictional office' }, allowCancel: false, allowReschedule: false };
  if (configureRules) expect((await request('/policies/configure', { version: 1, requestId: randomUUID(), workspaceId, pairingId: pair.pairingId, mailboxSubject, expectedRevision: null, kind: 'meeting-rules', rules })).statusCode).toBe(200);
  const read = await request('/accounts/preparation', { workspaceId, accountId }); expect(read.statusCode).toBe(200);
  const preparation: AccountPreparation = JSON.parse(read.body), commandId = randomUUID();
  const intent: MeetingIntent = { workspaceId, accountId, commandId, meetingId: 'agreed-meeting', operation: 'create', expectedAuthorityGeneration: preparation.authority.generation, expectedVersion: preparation.executionVersion + 1, rulesRevision: 1, threadId: 'thread1', threadRevision: projection.revision, contextRevision: projection.contextRevision, mailboxSubject, pairingId: pair.pairingId, start: '2026-09-15T14:00:00.000Z', end: '2026-09-15T14:30:00.000Z', localStart: '2026-09-15T10:00:00', offset: '-04:00', timezone: rules.timezone, agreementEvidenceId: message.id, agreement: { kind: 'explicit_slot', start: '2026-09-15T14:00:00.000Z', end: '2026-09-15T14:30:00.000Z', quote: message.bodyParts[0]!.text }, mixedReply: false, approvalId: commandId, attendeeEmails: message.from, inviteAttendees: true, summary: 'Agreed Callie meeting', etag: null };
  const command = { commandId, workspaceId, accountId, expectedAuthorityGeneration: preparation.authority.generation, expectedVersion: preparation.executionVersion, kind: 'approve-meeting' as const, payload: { intent, calendarId } };
  return { command, request, counts, events, auth, store, dynamo, options, google, pair, host, delegate, configureCommand, threads, projection, preparation, rules, provider, execution,
    repository: () => new DynamoMeetingRepository(options, google), source: () => createSourceCoordinator({ auth, authorization: google, fetch: provider }),
    advance: (value: string) => { now = value; }, uncertain: (value: boolean, hidden = false) => { uncertainInsert = value; hideEvent = hidden; } };
}

it('admits a frozen explicit meeting through the public owner command without a calendar mutation', async () => {
  const f = await fixture();
  expect(await f.store.get(meetingWorkKey(f.command.accountId, f.command.commandId))).toBeNull();
  const response = await f.request('/commands', f.command);
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toMatchObject({ commandId: f.command.commandId, status: 'applied', aggregateVersion: f.command.expectedVersion + 1 });
  expect((await f.store.get<{ input: unknown }>(meetingWorkKey(f.command.accountId, f.command.commandId)))?.data.input).toEqual(f.command.payload);
  expect(f.counts).toEqual({ calendarInserts: 0, emailSends: 0, forbidden: 0 });
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function localClient(f: Fixture) {
  const temp = createTempDatabase(), key = createTestWorkspaceKey();
  let db = openDatabase({ path: temp.path, key });
  await migrateToLatest(db, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
  const clock = f.options.clock, workspaceId = f.command.workspaceId;
  new AccountRepository({ database: db, clock, ids: { next: () => f.command.accountId } }).create({ commandId: randomUUID(), name: 'Already prepared PM', domain: null });
  const repository = () => new DelegationRepository({ database: db, workspaceId, clock });
  repository().initializeLocalAuthority(f.command.accountId); repository().queueCommand(f.delegate);
  const initial = eventPageSchema.parse(JSON.parse((await f.request('/events')).body));
  for (const event of initial.events) {
    if (event.kind === 'authority.changed' && event.payload.receipt.commandId === f.configureCommand.commandId) repository().queueCommand(delegationCommandSchema.parse(f.configureCommand));
    expect(repository().applyWorkerEvent(event)).toBe('applied');
  }
  let loseResponse = false;
  const http: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); expect(url.origin).toBe(`https://${f.host}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const response = await f.request(url.pathname + url.search, body, new Headers(init?.headers).get('authorization') ?? '');
    if (loseResponse && body?.kind === 'approve-meeting') { loseResponse = false; throw Error('Fictional owner response lost'); }
    return new Response(response.body, { status: response.statusCode });
  };
  const client = () => new ExecutionClient({ repository: repository(), transport: new SqlDelegationTransport({ database: db, workspaceId, pairingId: f.pair.pairingId, clock }), pairing: { workspaceId, endpoint: `https://${f.host}`, credential: f.pair.credential }, fetch: http });
  return { client, repository, lose: () => { loseResponse = true; },
    meeting: () => db.raw.prepare('SELECT projection_json FROM delegated_meetings WHERE workspace_id=? AND account_id=?').get(workspaceId, f.command.accountId) as { projection_json: string } | undefined,
    reopen: () => { closeDatabase(db); db = openDatabase({ path: temp.path, key }); },
    close: () => { closeDatabase(db); key.bytes.fill(0); temp.cleanup(); } };
}

it.each([false, true])('public client -> atomic owner -> existing poller -> SQL booked survives reopen (lost owner reply: %s)', async lost => {
  const f = await fixture(), local = await localClient(f);
  try {
    if (lost) local.lose();
    const command = delegationCommandSchema.parse(f.command);
    expect((await local.client().submit(command)).status).toBe('pending');
    expect(local.repository().commandStatus(command.commandId)?.status).toBe('pending');
    expect(f.counts.calendarInserts).toBe(0); expect(local.meeting()).toBeUndefined();
    expect((await local.client().sync(new AbortController().signal)).ownerFresh).toBe(true);
    expect(local.repository().commandStatus(command.commandId)?.status).toBe('applied');
    const admission = f.dynamo.transactions.filter(t => t.TransactItems?.some(i => i.Put?.Item?.sk?.S === meetingWorkKey(command.accountId, command.commandId)));
    expect(admission).toHaveLength(1);
    const keys = admission[0]!.TransactItems!.map(i => (i.Put?.Item ?? i.ConditionCheck?.Key)?.sk?.S);
    expect(keys).toEqual(expect.arrayContaining([`COMMAND#${command.commandId}`, `MEETING_APPROVAL#${command.commandId}`, `AUTH#${command.accountId}`]));
    const proof = await f.store.get<{ input: unknown; fingerprint: string }>(`MEETING_APPROVAL#${command.commandId}`);
    expect(proof?.data).toEqual({ input: f.command.payload, fingerprint: fingerprint(f.command.payload) });
    await f.source().tick(new AbortController().signal);
    expect(f.counts).toEqual({ calendarInserts: 1, emailSends: 0, forbidden: 0 });
    expect((await local.client().sync(new AbortController().signal)).ownerFresh).toBe(true);
    expect(JSON.parse(local.meeting()!.projection_json).outcome.status).toBe('booked');
    local.reopen(); expect((await local.client().submit(command)).status).toBe('applied');
    await f.source().tick(new AbortController().signal); await local.client().sync(new AbortController().signal);
    expect(f.events.size).toBe(1); expect(f.counts.calendarInserts).toBe(1);
    expect((await f.request('/commands', f.command)).statusCode).toBe(200);
    expect((await f.request('/commands', { ...f.command, payload: { ...f.command.payload, intent: { ...f.command.payload.intent, summary: 'Changed bytes' } } })).statusCode).toBe(400);
    expect(JSON.parse(local.meeting()!.projection_json).outcome.event.attendees[0].responseStatus).toBe('needsAction');
  } finally { local.close(); }
});

it('uncertain calendar mutation reconciles the original reservation after coordinator reconstruction without another insert', async () => {
  const f = await fixture(); expect((await f.request('/commands', f.command)).statusCode).toBe(200);
  f.uncertain(true, true); await f.source().tick(new AbortController().signal);
  expect(f.counts.calendarInserts).toBe(1);
  expect((await f.repository().command(f.command.commandId))?.outcome?.status).toBe('unknown');
  f.uncertain(false); await f.source().tick(new AbortController().signal);
  expect((await f.repository().command(f.command.commandId))?.outcome?.status).toBe('booked');
  expect(f.counts).toEqual({ calendarInserts: 1, emailSends: 0, forbidden: 0 });
});

async function absentAdmission(f: Fixture) {
  for (const key of [`COMMAND#${f.command.commandId}`, `MEETING_APPROVAL#${f.command.commandId}`, meetingWorkKey(f.command.accountId, f.command.commandId)]) expect(await f.store.get(key)).toBeNull();
  expect(f.counts).toEqual({ calendarInserts: 0, emailSends: 0, forbidden: 0 });
}
it.each(['workspace', 'account', 'generation', 'version', 'command', 'approval', 'pairing', 'calendar', 'attendee', 'operation', 'agreement', 'etag', 'override'] as const)('rejects public %s mismatch without executable partial work', async defect => {
  const f = await fixture(), c = structuredClone(f.command), i = c.payload.intent;
  if (defect === 'workspace') i.workspaceId = 'other';
  if (defect === 'account') i.accountId = 'other';
  if (defect === 'generation') i.expectedAuthorityGeneration++;
  if (defect === 'version') i.expectedVersion = c.expectedVersion;
  if (defect === 'command') i.commandId = randomUUID();
  if (defect === 'approval') i.approvalId = randomUUID();
  if (defect === 'pairing') i.pairingId = randomUUID();
  if (defect === 'calendar') c.payload.calendarId = 'other@example.test';
  if (defect === 'attendee') i.attendeeEmails = ['other@example.test'];
  if (defect === 'operation') i.operation = 'update';
  if (defect === 'agreement') i.agreement = { kind: 'delegated_choice', notBefore: i.start, notAfter: i.end, quote: 'Choose a time.' };
  if (defect === 'etag') i.etag = 'invented';
  if (defect === 'override') Object.assign(c.payload, { expectedAuthorityVersion: c.expectedVersion });
  expect((await f.request('/commands', c)).statusCode).toBe(400); await absentAdmission(f);
});

it.each(['missing_rules', 'changed_rules', 'expired_intake', 'incomplete_intake', 'stale_owner', 'stale_thread', 'superseded', 'tied_latest', 'negated', 'truncated'] as const)('holds %s at the public admission boundary', async defect => {
  const f = await fixture(defect !== 'missing_rules');
  if (defect === 'changed_rules') f.command.payload.intent.rulesRevision++;
  if (defect === 'expired_intake') f.advance('2026-09-14T12:06:00.000Z');
  if (defect === 'stale_owner') { f.command.expectedVersion++; f.command.payload.intent.expectedVersion++; }
  if (defect === 'incomplete_intake') {
    const row = (await f.threads.cursorState(f.command.accountId, 'mailbox'))!;
    await f.store.transact([f.store.put(mailCursorKey(f.command.accountId, 'mailbox'), { ...row.data, poll: { ...row.data.poll!, status: 'pending', completedAt: null } }, row.rev)]);
  }
  if (defect === 'stale_thread') f.command.payload.intent.threadRevision++;
  if (['superseded', 'tied_latest', 'negated', 'truncated'].includes(defect)) {
    const key = `MAIL_THREAD#${f.command.accountId}#thread1`, row = (await f.store.get<typeof f.projection>(key))!, p = structuredClone(row.data);
    if (defect === 'negated') p.thread.messages[0]!.bodyParts[0]!.text += ' Actually no, do not book.';
    if (defect === 'truncated') p.thread.messages[0]!.bodyParts[0]!.truncated = true;
    if (defect === 'superseded' || defect === 'tied_latest') p.thread.messages.push({ ...p.thread.messages[0]!, id: 'newer', date: defect === 'superseded' ? '2026-09-14T12:00:01.000Z' : p.thread.messages[0]!.date });
    await f.store.transact([f.store.put(key, p, row.rev)]);
  }
  expect((await f.request('/commands', f.command)).statusCode).toBe(400); await absentAdmission(f);
});

it.each(['authority', 'source', 'thread', 'poll', 'rules', 'suppression', 'pairing', 'token', 'grant', 'claim'] as const)('fences the final %s race with no partial approval/work/receipt', async target => {
  const f = await fixture(), original = f.dynamo.send.bind(f.dynamo);
  const principal = await f.auth.authenticate(`Bearer ${f.pair.credential}`, ['commands:write']);
  let raced = false;
  f.dynamo.send = async command => {
    if (!raced && 'TransactItems' in command.input && command.input.TransactItems?.some(i => i.Put?.Item?.sk?.S === meetingWorkKey(f.command.accountId, f.command.commandId))) {
      raced = true;
      expect(await f.store.get(meetingWorkKey(f.command.accountId, f.command.commandId))).toBeNull();
      expect(await f.store.get(`COMMAND#${f.command.commandId}`)).toBeNull();
      if (target === 'pairing') await f.auth.revokePairing(f.pair.pairingId);
      else {
        const key = target === 'authority' ? executionAuthorityKey(f.command.accountId)
          : target === 'source' ? ownerSourceKey(f.command.accountId)
          : target === 'thread' ? `MAIL_THREAD#${f.command.accountId}#thread1`
          : target === 'poll' ? mailCursorKey(f.command.accountId, 'mailbox')
          : target === 'rules' ? `MEETING_RULES#${encodeURIComponent(f.command.payload.calendarId)}`
          : target === 'token' ? `TOKEN#${principal.credentialHash}`
          : target === 'grant' ? `GOOGLE_GRANT#${f.pair.pairingId}`
          : target === 'claim' ? `OWNER_COMMAND_CLAIM#${f.command.commandId}` : `MAIL_SUPPRESSION#${f.command.accountId}`;
        const row = await f.store.get<Record<string, unknown>>(key);
        const data = target === 'source' ? { ...row!.data, state: 'paused' } : row?.data ?? { accountId: f.command.accountId };
        await f.store.transact([f.store.put(key, data, row?.rev ?? null, target === 'authority' ? executionAuthorityFields(authorityRecordSchema.parse(data)) : {})]);
      }
    }
    return original(command);
  };
  expect((await f.request('/commands', f.command)).statusCode).toBe(400);
  expect(raced).toBe(true); await absentAdmission(f);
});

it('rechecks intake expiry after event planning and before the final owner transaction', async () => {
  const f = await fixture(), original = f.dynamo.send.bind(f.dynamo);
  let expired = false;
  f.dynamo.send = async command => {
    const result = await original(command);
    if (!expired && 'Key' in command.input && command.input.Key?.sk?.S === 'EVENT_HEAD') {
      expired = true; f.advance('2026-09-14T12:06:00.000Z');
    }
    return result;
  };
  expect((await f.request('/commands', f.command)).statusCode).toBe(400);
  expect(expired).toBe(true); await absentAdmission(f);
});

it('rejects a changed captured authority row instead of using a permissive pre-AUTH override', async () => {
  const f = await fixture(), original = DynamoMeetingRepository.prototype.planOwnerApproval;
  vi.spyOn(DynamoMeetingRepository.prototype, 'planOwnerApproval').mockImplementation(async function (this: DynamoMeetingRepository, raw, captured) {
    await f.store.transact([f.store.put(executionAuthorityKey(f.command.accountId), captured.data, captured.rev, executionAuthorityFields(captured.data))]);
    return original.call(this, raw, captured);
  });
  expect((await f.request('/commands', f.command)).statusCode).toBe(400); await absentAdmission(f);
});

it('recovers an ambiguous atomic owner commit from the same command without rematerializing work', async () => {
  const f = await fixture(), original = f.dynamo.send.bind(f.dynamo);
  let lost = false;
  f.dynamo.send = async command => {
    const result = await original(command);
    if (!lost && 'TransactItems' in command.input && command.input.TransactItems?.some(i => i.Put?.Item?.sk?.S === meetingWorkKey(f.command.accountId, f.command.commandId))) {
      lost = true; throw Error('Fictional ambiguous owner commit');
    }
    return result;
  };
  expect((await f.request('/commands', f.command)).statusCode).toBe(400);
  expect(lost).toBe(true);
  expect((await f.request('/commands', f.command)).statusCode).toBe(200);
  expect(f.dynamo.transactions.filter(t => t.TransactItems?.some(i => i.Put?.Item?.sk?.S === meetingWorkKey(f.command.accountId, f.command.commandId)))).toHaveLength(1);
  await f.source().tick(new AbortController().signal); expect(f.counts.calendarInserts).toBe(1);
  expect((await f.repository().command(f.command.commandId))?.outcome?.status).toBe('booked');
});

it('rejects public approval when a ready grant is revoked before the fenced grant row read', async () => {
  const f = await fixture(), status = f.google.status.bind(f.google), grantKey = `GOOGLE_GRANT#${f.pair.pairingId}`;
  const head = await f.store.get('EVENT_HEAD');
  let revoked = false;
  vi.spyOn(f.google, 'status').mockImplementation(async (...args) => {
    const ready = await status(...args);
    if (!revoked) {
      expect(ready.state).toBe('ready');
      const row = (await f.store.get<Record<string, unknown>>(grantKey))!;
      await f.store.transact([f.store.put(grantKey, { ...row.data, revoked: true }, row.rev)]);
      revoked = true;
    }
    return ready;
  });
  const response = await f.request('/commands', f.command);
  expect(revoked).toBe(true);
  expect((await f.store.get<{ revoked: boolean }>(grantKey))?.data.revoked).toBe(true);
  expect.soft(response.statusCode).toBe(400);
  expect.soft(await f.execution.currentVersion(f.command.accountId)).toBe(f.command.expectedVersion);
  expect.soft(await f.store.get('EVENT_HEAD')).toEqual(head);
  await absentAdmission(f);
});

it('rejects public approval when intake expires during the final token and pairing reads', async () => {
  const f = await fixture(), original = f.dynamo.send.bind(f.dynamo), head = await f.store.get('EVENT_HEAD');
  const finalReads: string[] = [];
  let eventPlanned = false, expired = false;
  f.dynamo.send = async command => {
    const result = await original(command);
    const key = 'Key' in command.input ? command.input.Key?.sk?.S : undefined;
    if (key === 'EVENT_HEAD') eventPlanned = true;
    else if (eventPlanned && !expired && key?.startsWith('TOKEN#')) finalReads.push('token');
    else if (eventPlanned && !expired && key === `PAIRING#${f.pair.pairingId}`) {
      finalReads.push('pairing'); expired = true; f.advance('2026-09-14T12:06:00.000Z');
    }
    return result;
  };
  const response = await f.request('/commands', f.command);
  expect(expired).toBe(true); expect(finalReads).toEqual(['token', 'pairing']);
  expect.soft(response.statusCode).toBe(400);
  expect.soft(await f.execution.currentVersion(f.command.accountId)).toBe(f.command.expectedVersion);
  expect.soft(await f.store.get('EVENT_HEAD')).toEqual(head);
  await absentAdmission(f);
});
