import { describe, expect, it, vi } from 'vitest';
import { QueryCommand, TransactWriteItemsCommand, type QueryCommandInput } from '@aws-sdk/client-dynamodb';
import { createSourceCoordinator } from '../src/sourceCoordinator';
import { WorkerAuth } from '../src/workerAuth';
import { RemoteGoogleAuthorization } from '../src/remoteGoogleAuthorization';
import { ConditionalCommandHarness } from './sdkHarness';
import type { DynamoCommand, DynamoResult } from '../src/dynamoStore';
import { ownerSourceKey, ownerSourceConfigurationSchema, ownerCommandSchema, ownerResearchSourceSchema, ownerResearchSourceKey } from '../../../../src/shared/contracts/ownerCommandContract';
const now = '2026-09-14T12:00:00.000Z';
class BoundedSdk extends ConditionalCommandHarness {
  queries: QueryCommandInput[] = [];
  beforeSend?: (command: DynamoCommand) => Promise<void>;
  override async send(command: DynamoCommand): Promise<DynamoResult> {
    await this.beforeSend?.(command);
    const result = await super.send(command);
    if (!(command instanceof QueryCommand)) return result;
    this.queries.push(command.input);
    const after = command.input.ExclusiveStartKey?.sk?.S;
    const all = (result.Items ?? []).filter(item => !after || item.sk!.S! > after);
    const items = all.slice(0, command.input.Limit ?? all.length);
    const last = items.at(-1);
    return { ...result, Items: items, ...(last && items.length < all.length ? { LastEvaluatedKey: { pk: last.pk!, sk: last.sk! } } : {}) };
  }
}
function fixture() {
  const db = new BoundedSdk(); const options = { dynamo: db, tableName: 'fictional-table', workspaceId: 'ws', clock: { now: () => now } };
  const auth = new WorkerAuth(options); let httpCalls = 0;
  const fetch: typeof globalThis.fetch = async () => { httpCalls++; throw new Error('unconfigured fictional HTTP'); };
  const authorization = new RemoteGoogleAuthorization({ auth, fetch });
  return { db, auth, authorization, fetch, calls: () => httpCalls, source: () => createSourceCoordinator({ auth, authorization, fetch }) };
}
describe('actual source coordinator default-deny composition', () => {
  it('constructs inertly and missing persisted configuration never touches providers', async () => {
    const f = fixture(); const source = f.source();
    expect(f.db.transactions).toHaveLength(0); expect(f.db.queries).toHaveLength(0);
    expect(await source.tick(new AbortController().signal)).toMatchObject({ status: 'inactive', dispatches: 0, mailPolls: 0, researchCompleted: 0 });
    expect(f.calls()).toBe(0);
  });
  it('paused actual source configuration cannot activate providers', async () => {
    const f = fixture();
    const config = ownerSourceConfigurationSchema.parse({ version: 1, workspaceId: 'ws', accountId: 'acct', pairingId: '00000000-0000-4000-a000-000000000001',
      revision: 1, state: 'paused', mailboxSubject: 'subject', calendarId: 'calendar@example.test', research: null });
    await f.auth.store.transact([f.auth.store.put(ownerSourceKey('acct'), config, null)]);
    expect(await f.source().tick(new AbortController().signal)).toMatchObject({ status: 'inactive', dispatches: 0, mailPolls: 0 });
    expect(f.calls()).toBe(0);
  });
  it('pre-aborted tick does not read storage or touch providers', async () => {
    const f = fixture();
    expect(await f.source().tick(AbortSignal.abort())).toMatchObject({ status: 'aborted' });
    expect(f.db.queries).toHaveLength(0); expect(f.calls()).toBe(0);
  });
});

import { randomUUID } from 'node:crypto';
import { googleScopes } from '../src/googleGrantCapabilities';
import { createExecutionRepository } from '../src/executionRepository';
import { DynamoDispatchRepository } from '../src/dispatchRepository';
import { DynamoThreadIntakeRepository, mailCursorKey, mailThreadKey } from '../src/threadIntakeRepository';
import { intakeRegistryKey } from '../src/intakeBarrier';
import { fingerprint } from '../src/dynamoStore';
import { mailScopeFingerprint } from '../../../../src/main/outreach/providers/gmailThreadProvider';
import { OwnerCommandCoordinator } from '../src/ownerCommandCoordinator';
import type { AccountReplyDraft, MailMessage } from '../../../../src/shared/contracts/mailThreadContract';
async function mailFixture(meeting = false) {
  const db = new BoundedSdk(); const options = { dynamo: db, tableName: 'fictional-table', workspaceId: 'ws', clock: { now: () => now } };
  const auth = new WorkerAuth(options); const urls: string[] = []; let sends = 0; let sentLookups = 0; let uncertain = false;
  let incoming = false; let calendarUnknown = false; let inserts = 0; const events: Record<string, unknown> = {};
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input); urls.push(url);
    if (url.endsWith('/token')) return Response.json({ access_token: 'fictional', refresh_token: 'fictional-refresh', token_type: 'Bearer', expires_in: 3600,
      scope: `openid email ${googleScopes.send} ${googleScopes.relevant_read}${meeting ? ` ${googleScopes.availability} ${googleScopes.event_write}` : ''}` });
    if (url.endsWith('/userinfo')) return Response.json({ sub: 'mailbox', email: 'sender@example.test', email_verified: true });
    if (url.includes('/history?')) return Response.json({ historyId: incoming ? '3' : '2', history: incoming ? [{ messagesAdded: [{ message: { id: 'accepted-reply' } }] }] : [] });
    if (url.endsWith('/messages/accepted-reply') || url.includes('/messages/accepted-reply?')) return Response.json({ id: 'accepted-reply', threadId: 'thread1', internalDate: String(Date.parse(now)), payload: { mimeType: 'text/plain',
      headers: [{ name: 'From', value: 'recipient@example.test' }, { name: 'To', value: 'sender@example.test' }, { name: 'Subject', value: 'Meeting offer' }, { name: 'Message-ID', value: '<accepted@example.test>' }, { name: 'In-Reply-To', value: `<${intentId}@callie.invalid>` }],
      body: { data: Buffer.from('That works!').toString('base64url') } } });
    if (url.endsWith('/freeBusy')) return Response.json({ calendars: { 'sender@example.test': { busy: [] } } });
    if (url.includes('/calendars/')) {
      const path = new URL(url).pathname; const method = init?.method ?? 'GET';
      if (method === 'POST' && path.endsWith('/events')) { inserts++; const body = JSON.parse(String(init?.body));
        const event = { id: body.id, status: 'confirmed', etag: 'fictional-etag', start: body.start, end: body.end, attendees: body.attendees.map((a: {email:string}) => ({ ...a, responseStatus: 'needsAction' })) };
        if (calendarUnknown) throw new Error('fictional uncertain insert'); events[body.id] = event; return Response.json(event); }
      if (path.endsWith('/events')) return Response.json({ items: Object.values(events) });
      const id = path.split('/').at(-1)!; return events[id] ? Response.json(events[id]) : new Response('', { status: 404 });
    }
    if (url.endsWith('/messages/send') && init?.method === 'POST') { sends++; if (uncertain) throw new Error('fictional lost response'); return Response.json({ id: 'sent1', threadId: 'thread1' }); }
    if (url.includes('/messages?') && new URL(url).searchParams.get('q')?.startsWith('in:sent')) { sentLookups++; return Response.json({ messages: [] }); }
    throw new Error('unconfigured fictional HTTP');
  };
  const authorization = new RemoteGoogleAuthorization({ auth, fetch, config: { clientId: 'fictional.apps.googleusercontent.com', clientSecret: 'fictional',
    redirectUri: 'https://worker.example.test/oauth/callback', encryptionKey: Buffer.alloc(32, 8) } });
  const pair = await auth.redeemPairing((await auth.issuePairing({ scopes: ['commands:write', 'google:grant'], expiresInSeconds: 300 })).code, 'fictional');
  const grant = await authorization.beginGoogleGrant(pair.pairingId, meeting ? ['send', 'relevant_read', 'availability', 'event_write'] : ['send', 'relevant_read'],
    meeting ? { confirmed: true, ownedCalendarId: 'sender@example.test', conflictCalendarIds: ['sender@example.test'] } : undefined);
  await authorization.completeGoogleGrant(new URL(grant.authorizationUrl).searchParams.get('state')!, 'fictional');
  const store = auth.store; const accountId = 'acct';
  const policy = new DynamoDispatchRepository(options, authorization);
  const execution = createExecutionRepository({ ...options, dispatchPolicy: policy });
  await execution.seedLocalAuthority(accountId);
  await execution.applyCommand({ commandId: 'delegate', workspaceId: 'ws', accountId, expectedAuthorityGeneration: 0, expectedVersion: 0,
    kind: 'delegate', payload: { delegationId: 'approved', approvedAt: now } });
  const account = { id: accountId, name: 'Fictional PM', domain: null, version: 1 };
  const message: MailMessage = { id: 'inbound1', threadId: 'thread1', rfcMessageId: '<request@example.test>', references: [], from: ['recipient@example.test'], to: ['sender@example.test'],
    cc: [], date: '2026-09-14T11:59:00.000Z', subject: 'Requested details', bodyParts: [{ mimeType: 'text/plain', text: 'Please send details.', truncated: false }] };
  const scope = { version: 1 as const, accountId, mailboxSubject: 'mailbox', revision: 1, participantAddresses: ['colleague@example.test', 'recipient@example.test'], knownThreadIds: ['thread1'], since: now, approvedAt: now };
  const binding = { scopeRevision: 1, scopeFingerprint: mailScopeFingerprint(scope) };
  const draft: AccountReplyDraft = { id: 'draft', accountId, threadId: 'thread1', mailboxSubject: 'mailbox', threadRevision: 1, contextRevision: 'context', revision: 1,
    sender: 'sender@example.test', recipient: 'recipient@example.test', subject: 'Requested details', body: meeting ? 'Tuesday, September 15, 2026 at 10:00 AM to 10:30 AM (America/New_York)' : 'Exact approved details.', evidenceIds: ['inbound1'], generation: 'edited', updatedAt: now };
  await store.transact([store.put('ACCOUNT#acct', { account, sources: [], claims: [], routes: [], researchRevision: 1, history: [{ at: now, account, claims: [], routes: [] }] }, null),
    store.put(mailThreadKey(accountId, 'thread1'), { thread: { accountId, mailboxSubject: 'mailbox', provider: 'gmail', providerThreadId: 'thread1', messages: [message, { ...message, id: 'colleague-message', from: ['colleague@example.test'], rfcMessageId: '<colleague@example.test>' }] }, revision: 1, contextRevision: 'context', signals: [] }, null),
    store.put('MAIL_DRAFT#acct#draft', draft, null),
    store.put(mailCursorKey(accountId, 'mailbox'), { scope, checkpoint: { ...binding, version: 1, accountId, mailboxSubject: 'mailbox', mode: 'history', historyId: '1', pageToken: null, since: now },
      poll: { ...binding, attemptId: 'initial', accountId, mailboxSubject: 'mailbox', status: 'complete', startedAt: now, completedAt: now } }, null),
    store.put(intakeRegistryKey(accountId), { accountId, adapters: [{ id: 'gmail', kind: 'gmail', relevant: true, enabled: true, mailboxSubject: 'mailbox' }], manualDependencies: [] }, null)]);
  const owner = new OwnerCommandCoordinator({ auth, authorization });
  const config = ownerSourceConfigurationSchema.parse({ version: 1, workspaceId: 'ws', accountId, pairingId: pair.pairingId, revision: 1, state: 'active', mailboxSubject: 'mailbox', calendarId: meeting ? 'sender@example.test' : null, research: null });
  await owner.apply({ commandId: randomUUID(), workspaceId: 'ws', accountId, expectedAuthorityGeneration: 1, expectedVersion: 1, kind: 'configure-owner',
    payload: { expectedConfigurationRevision: 0, configuration: config, mailScope: null } }, `Bearer ${pair.credential}`);
  const intentId = randomUUID();
  const frozenMessage = { commandId: intentId, from: draft.sender, to: draft.recipient, subject: draft.subject, body: draft.body, threadId: draft.threadId, inReplyTo: message.rfcMessageId!, references: [message.rfcMessageId!] };
  const intent = { commandId: intentId, kind: 'standalone_reply' as const, action: { workspaceId: 'ws', accountId, actionId: 'action', expectedAuthorityGeneration: 1, approvalId: 'approval',
    contentHash: fingerprint(frozenMessage), targetHash: fingerprint({ sender: draft.sender, recipient: draft.recipient, threadId: draft.threadId }) }, draftId: draft.id, draftRevision: 1,
    pairingId: pair.pairingId, mailboxSubject: 'mailbox', frozenMessage, binding: { kind: 'thread_participant' as const, threadId: draft.threadId, sourceMessageId: message.id, sourceMessageHash: fingerprint(message) } };
  const offer = { id: 'accepted-offer', revision: 1, accountId, threadId: 'thread1', mailboxSubject: 'mailbox', sendCommandId: intentId,
    meeting: { summary: 'Callie meeting' as const, inviteAttendees: true }, expiresAt: '2026-09-15T00:00:00.000Z', slots: [{ id: 'offered-slot', start: '2026-09-15T14:00:00.000Z', end: '2026-09-15T14:30:00.000Z', timezone: 'America/New_York' }] };
  if (meeting) {
    await owner.apply({ commandId: randomUUID(), workspaceId: 'ws', accountId, expectedAuthorityGeneration: 1, expectedVersion: 2, kind: 'approve-reply', payload: {
      draft, expectedRemoteDraftRevision: 1, approvalId: 'approval', actionId: 'action', intentCommandId: intentId, binding: intent.binding, expiresAt: offer.expiresAt,
      permission: { id: 'permission', sourceMessageId: message.id, sourceMessageHash: fingerprint(message), basis: 'requested_followup', expiresAt: offer.expiresAt }, schedulingOffer: { offer, expectedRevision: null },
    } }, `Bearer ${pair.credential}`);
  } else {
    await policy.admitPermission({ id: 'permission', accountId, recipient: draft.recipient, sender: draft.sender, threadId: draft.threadId, sourceMessageId: message.id, sourceMessageHash: fingerprint(message), basis: 'requested_followup', recordedAt: now, expiresAt: '2026-09-15T00:00:00.000Z' });
    await policy.admitApproval({ id: 'approval', commandId: intentId, intentHash: fingerprint(intent), draft, permissionEvidenceId: 'permission', approvedAt: now, expiresAt: '2026-09-15T00:00:00.000Z' });
    await policy.admitIntent(intent); await execution.prepareAction({ ...intent.action, expectedVersion: 2 });
  }
  await policy.configureCaps({ sender: draft.sender, dailyLimit: 5 }, null);
  const submit = ownerCommandSchema.parse({ commandId: randomUUID(), workspaceId: 'ws', accountId, expectedAuthorityGeneration: 1, expectedVersion: meeting ? 3 : 2,
    kind: 'submit-approved-reply', payload: { intentCommandId: intentId } });
  return { db, options, auth, authorization, fetch, owner, pair, execution, policy, submit, config, intent, scope, urls, sends: () => sends, sentLookups: () => sentLookups,
    unknownCalendar: () => { calendarUnknown = true; }, incoming: () => { incoming = true; }, inserts: () => inserts, uncertain: () => { uncertain = true; }, source: () => createSourceCoordinator({ auth, authorization, fetch }) };
}
it('selects actual applied owner command and performs one exact C4 dispatch while retaining the full C3 scope', async () => {
  const f = await mailFixture(); await f.owner.apply(f.submit, `Bearer ${f.pair.credential}`);
  const result = await f.source().tick(new AbortController().signal);
  expect(result).toMatchObject({ mailPolls: 1, dispatches: 1 }); expect(f.sends()).toBe(1);
  expect(await new DynamoThreadIntakeRepository(f.options).scope('acct', 'mailbox')).toEqual(f.scope);
  await f.source().tick(new AbortController().signal); expect(f.sends()).toBe(1);
});
it('unsubmitted approved intent is not a source of automatic sends', async () => {
  const f = await mailFixture();
  expect(await f.source().tick(new AbortController().signal)).toMatchObject({ dispatches: 0 }); expect(f.sends()).toBe(0);
});
it('unknown submitted send resumes actual Sent reconciliation without another send after restart', async () => {
  const f = await mailFixture(); await f.owner.apply(f.submit, `Bearer ${f.pair.credential}`); f.uncertain();
  await f.source().tick(new AbortController().signal); expect(f.sends()).toBe(1);
  const result = await f.source().tick(new AbortController().signal);
  expect(result.sendReconciliations).toBe(1); expect(f.sentLookups()).toBe(1); expect(f.sends()).toBe(1);
});
it('uses bounded strongly consistent pages and resumes past paused configurations after restart', async () => {
  const f = fixture();
  for (let i = 0; i < 26; i++) {
    const accountId = `acct-${String(i).padStart(2, '0')}`;
    await f.auth.store.transact([f.auth.store.put(ownerSourceKey(accountId), ownerSourceConfigurationSchema.parse({ version: 1, workspaceId: 'ws', accountId,
      pairingId: '00000000-0000-4000-a000-000000000001', revision: 1, state: 'paused', mailboxSubject: null, calendarId: null, research: null }), null)]);
  }
  await f.source().tick(new AbortController().signal);
  await f.source().tick(new AbortController().signal);
  const queries = f.db.queries.filter(q => q.ExpressionAttributeValues?.[':prefix']?.S === 'OWNER_SOURCE#');
  expect(queries).toHaveLength(2);
  expect(queries.every(q => q.Limit === 25 && q.ConsistentRead === true)).toBe(true);
  expect(queries[1]!.ExclusiveStartKey?.sk?.S).toBe(ownerSourceKey('acct-24'));
  expect(f.calls()).toBe(0);
});
it('pausing persisted configuration after submission prevents any provider work', async () => {
  const f = await mailFixture(); await f.owner.apply(f.submit, `Bearer ${f.pair.credential}`);
  const row = await f.auth.store.get(ownerSourceKey('acct'));
  await f.auth.store.transact([f.auth.store.put(ownerSourceKey('acct'), { ...f.config, revision: 2, state: 'paused' }, row!.rev)]);
  const before = f.urls.length;
  expect(await f.source().tick(new AbortController().signal)).toMatchObject({ status: 'inactive', dispatches: 0, mailPolls: 0 });
  expect(f.urls).toHaveLength(before);
});

import { createWorkerAccountRepository } from '../src/workerAccountRepository';
import { createDiscoveryReservationStore } from '../src/discoveryReservationStore';
import { rankAccount } from '../../../../src/shared/accounts/accountRanking';
async function researchFixture() {
  const f = fixture(); let modelCalls = 0; let pageCalls = 0; let credentialCalls = 0; let uncertain = false; let credentialHook: (() => Promise<void>) | undefined;
  const pair = await f.auth.redeemPairing((await f.auth.issuePairing({ scopes: ['commands:write'], expiresInSeconds: 300 })).code, 'fictional');
  const limits = { maxCompanies: 1, maxPages: 1, maxBytes: 10000, maxCostMicros: 100 };
  const config = ownerResearchSourceSchema.parse({ version: 1, workspaceId: 'ws', pairingId: pair.pairingId, revision: 1, state: 'active', research: {
    workspaceId: 'ws', budgetId: 'approved-budget', audience: { residential: true, regions: ['Fictional region'], terms: ['property management'] }, audienceRevision: 1,
    sourceRevision: 1, budgetRevision: 1, discoveryLimits: limits, researchLimits: limits, capability: { model: 'fixture', webSearch: true, searchCostMicros: 40, modelCostMicros: 40 },
    maxAccountBudgetMicros: 100, permittedSources: ['https://fictional.example/'], preparationCommandId: randomUUID(),
  } });
  await new OwnerCommandCoordinator({ auth: f.auth, authorization: f.authorization }).configureResearch({ commandId: randomUUID(), workspaceId: 'ws', pairingId: pair.pairingId,
    expectedRevision: 0, configuration: config }, `Bearer ${pair.credential}`);
  const fetch: typeof globalThis.fetch = async () => { modelCalls++; if (uncertain) throw new Error('lost fictional response'); return Response.json({ status: 'completed', model: 'fixture', output: [
    { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url: 'https://fictional.example/' }] } },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ companies: [{ name: 'Fictional PM', domain: 'fictional.example', sourceUrl: 'https://fictional.example/' }] }), annotations: [{ type: 'url_citation', url: 'https://fictional.example/' }] }] },
  ] }); };
  const research = { loadCredentials: async () => { credentialCalls++; await credentialHook?.(); return { apiKey: 'fictional', model: 'fixture' }; }, resolve: async () => ['93.184.216.34'],
    pageHttp: async () => { pageCalls++; return new Response('<p>We manage 240 residential units.</p>', { headers: { 'content-type': 'text/html' } }); } };
  const accounts = createWorkerAccountRepository(f.auth.options); const reservations = createDiscoveryReservationStore(f.auth.options);
  return { ...f, pair, config, accounts, reservations, source: () => createSourceCoordinator({ auth: f.auth, authorization: f.authorization, fetch, research }),
    approve: async () => { await reservations.approveBudget({ budgetId: 'approved-budget', limitMicros: 80 }); await accounts.approveResearchBudget(100); },
    onCredentials: (hook: () => Promise<void>) => { credentialHook = hook; }, counts: () => ({ modelCalls, pageCalls, credentialCalls }), uncertain: () => { uncertain = true; } };
}
it('composes actual empty-workspace discovery and research with durable budgets and no outbound authority', async () => {
  const f = await researchFixture(); await f.approve();
  expect(await f.source().tick(new AbortController().signal)).toMatchObject({ researchPrepared: 1, researchCompleted: 1 });
  expect(f.counts()).toEqual({ modelCalls: 1, pageCalls: 1, credentialCalls: 1 });
  expect(await f.auth.store.list('AUTH#')).toEqual([]);
  expect(await f.auth.store.list('ACCOUNT#')).toHaveLength(1);
  const candidates = await f.accounts.listCandidates(now);
  expect(candidates[0]!.snapshot.portfolio).toMatchObject([{ count: 240, scope: 'managed', measure: 'units' }]);
  expect(candidates[0]!.rank).toEqual(rankAccount(candidates[0]!.snapshot, now));
  await f.source().tick(new AbortController().signal);
  expect(f.counts()).toEqual({ modelCalls: 1, pageCalls: 1, credentialCalls: 1 });
});
it('does not turn workspace configuration into a budget approval', async () => {
  const f = await researchFixture(); await f.source().tick(new AbortController().signal);
  expect(f.counts()).toEqual({ modelCalls: 0, pageCalls: 0, credentialCalls: 0 });
  expect(await f.auth.store.list('ACCOUNT#')).toEqual([]);
});
it('retains uncertain pre-account spend across coordinator restart without repeating provider HTTP', async () => {
  const f = await researchFixture(); await f.approve(); f.uncertain();
  await f.source().tick(new AbortController().signal); await f.source().tick(new AbortController().signal);
  expect(f.counts()).toEqual({ modelCalls: 1, pageCalls: 0, credentialCalls: 1 });
  expect(await f.auth.store.list('ACCOUNT#')).toEqual([]);
  expect((await f.auth.store.get<{spent:number}>('BUDGET#discovery#approved-budget'))?.data.spent).toBe(80);
});

import { DynamoMeetingRepository } from '../src/meetingRepository';
it.each(['confirmed', 'unknown'] as const)('processes actual accepted offer and C3 reply into one durable C5 meeting: %s', async status => {
  const f = await mailFixture(true);
  const repository = new DynamoMeetingRepository(f.options, f.authorization);
  await repository.saveRules({ expectedRevision: null, rules: { revision: 1, confirmed: true, timezone: 'America/New_York', weeklyWindows: [{ weekday: 2, start: '09:00', end: '17:00' }],
    durationMinutes: 30, bufferBeforeMinutes: 10, bufferAfterMinutes: 10, minimumNoticeMinutes: 60, horizonDays: 30, ownedCalendarId: 'sender@example.test', conflictCalendarIds: ['sender@example.test'],
    location: { kind: 'text', value: 'Fictional office' }, allowCancel: true, allowReschedule: true } });
  await f.owner.apply(f.submit, `Bearer ${f.pair.credential}`);
  await f.source().tick(new AbortController().signal); expect(f.sends()).toBe(1); expect(f.inserts()).toBe(0);
  await f.source().tick(new AbortController().signal);
  expect((await repository.listAcceptedOffers('acct')).offers).toHaveLength(1);
  if (status === 'unknown') f.unknownCalendar();
  f.incoming(); const result = await f.source().tick(new AbortController().signal);
  expect(result).toMatchObject({ mailPolls: 1, meetings: 1 }); expect(f.inserts()).toBe(1);
  expect((await repository.listReservations('acct')).records).toMatchObject([{ outcome: { status: status === 'confirmed' ? 'booked' : 'unknown' } }]);
  await f.source().tick(new AbortController().signal); expect(f.inserts()).toBe(1); expect(f.sends()).toBe(1);
});

async function pauseResearch(f: Awaited<ReturnType<typeof researchFixture>>) {
  await new OwnerCommandCoordinator({ auth: f.auth, authorization: f.authorization }).configureResearch({ commandId: randomUUID(), workspaceId: 'ws', pairingId: f.pair.pairingId,
    expectedRevision: 1, configuration: { ...f.config, revision: 2, state: 'paused' } }, `Bearer ${f.pair.credential}`);
}
it('fences authenticated workspace pause against the actual discovery budget transaction', async () => {
  const f = await researchFixture(); await f.approve();
  f.db.beforeSend = async command => {
    if (!(command instanceof TransactWriteItemsCommand) || !command.input.TransactItems?.some(item => item.Put?.Item?.sk?.S?.startsWith('DISCOVERY#'))) return;
    f.db.beforeSend = undefined; await pauseResearch(f);
  };
  await f.source().tick(new AbortController().signal);
  expect(f.counts()).toEqual({ modelCalls: 0, pageCalls: 0, credentialCalls: 0 });
  expect((await f.auth.store.get<{spent:number}>('BUDGET#discovery#approved-budget'))?.data.spent).toBe(0);
  expect(await f.auth.store.list('DISCOVERY#')).toEqual([]);
  const attempt = f.db.transactions.find(tx => tx.TransactItems?.some(item => item.Put?.Item?.sk?.S?.startsWith('DISCOVERY#')))!;
  expect(attempt.TransactItems?.some(item => item.ConditionCheck?.Key?.sk?.S === ownerResearchSourceKey())).toBe(true);
  expect(attempt.TransactItems?.some(item => item.ConditionCheck?.Key?.sk?.S?.startsWith('PAIRING#'))).toBe(true);
});
it('rechecks workspace pause after credential loading before model HTTP and retains reserved spend', async () => {
  const f = await researchFixture(); await f.approve(); f.onCredentials(() => pauseResearch(f));
  await f.source().tick(new AbortController().signal); await f.source().tick(new AbortController().signal);
  expect(f.counts()).toEqual({ modelCalls: 0, pageCalls: 0, credentialCalls: 1 });
  expect((await f.auth.store.get<{spent:number}>('BUDGET#discovery#approved-budget'))?.data.spent).toBe(80);
  expect(await f.auth.store.list('ACCOUNT#')).toEqual([]);
});
it('two simultaneous real coordinators share one cumulative discovery reservation and one provider request', async () => {
  const f = await researchFixture(); await f.approve();
  await Promise.all([f.source().tick(new AbortController().signal), f.source().tick(new AbortController().signal)]);
  expect(f.counts().modelCalls).toBe(1); expect(f.counts().pageCalls).toBeLessThanOrEqual(1);
  expect(await f.auth.store.list('ACCOUNT#')).toHaveLength(1);
});
it('retries only committed outbox publication after a crash, without replaying the mutation', async () => {
  const db = new BoundedSdk(); let available = false; let publications = 0;
  const auth = new WorkerAuth({ dynamo: db, tableName: 'fictional-table', workspaceId: 'ws', clock: { now: () => now }, publish: async () => { publications++; if (!available) throw new Error('fictional publication unavailable'); } });
  const fetch: typeof globalThis.fetch = async () => { throw new Error('unexpected provider'); };
  const authorization = new RemoteGoogleAuthorization({ auth, fetch });
  const execution = createExecutionRepository(auth.options); await execution.seedLocalAuthority('acct');
  await expect(execution.applyCommand({ commandId: 'delegate-outbox', workspaceId: 'ws', accountId: 'acct', expectedAuthorityGeneration: 0, expectedVersion: 0,
    kind: 'delegate', payload: { delegationId: 'approved', approvedAt: now } })).rejects.toThrow('fictional publication unavailable');
  const before = await execution.currentVersion('acct'); available = true;
  await createSourceCoordinator({ auth, authorization, fetch }).tick(new AbortController().signal);
  expect(publications).toBe(2); expect(await execution.currentVersion('acct')).toBe(before);
  expect((await auth.store.eventsAfter(null)).events).toHaveLength(1);
});

it('a new configuration run UUID cannot reset cumulative workspace discovery spending', async () => {
  const f = await researchFixture(); await f.approve(); await f.source().tick(new AbortController().signal);
  await new OwnerCommandCoordinator({ auth: f.auth, authorization: f.authorization }).configureResearch({ commandId: randomUUID(), workspaceId: 'ws', pairingId: f.pair.pairingId,
    expectedRevision: 1, configuration: { ...f.config, revision: 2, research: { ...f.config.research!, preparationCommandId: randomUUID() } } }, `Bearer ${f.pair.credential}`);
  await f.source().tick(new AbortController().signal);
  expect(f.counts()).toEqual({ modelCalls: 1, pageCalls: 1, credentialCalls: 1 });
  expect(await f.auth.store.list('DISCOVERY#')).toHaveLength(1);
});
it('paused and reactivated selector with the same research run cannot retry uncertain discovery', async () => {
  const f = await researchFixture(); await f.approve(); f.uncertain(); await f.source().tick(new AbortController().signal); await pauseResearch(f);
  await new OwnerCommandCoordinator({ auth: f.auth, authorization: f.authorization }).configureResearch({ commandId: randomUUID(), workspaceId: 'ws', pairingId: f.pair.pairingId,
    expectedRevision: 2, configuration: { ...f.config, revision: 3 } }, `Bearer ${f.pair.credential}`);
  await f.source().tick(new AbortController().signal);
  expect(f.counts()).toEqual({ modelCalls: 1, pageCalls: 0, credentialCalls: 1 });
});
it('unknown mail offer is never promoted into accepted scheduling work', async () => {
  const f = await mailFixture(true); f.uncertain(); await f.owner.apply(f.submit, `Bearer ${f.pair.credential}`);
  await f.source().tick(new AbortController().signal); await f.source().tick(new AbortController().signal);
  expect(f.sends()).toBe(1); expect(f.inserts()).toBe(0);
  expect(await f.auth.store.list('MEETING_OFFER#')).toEqual([]);
  expect(await f.auth.store.list('MEETING_INTENT#')).toEqual([]);
});
it('rejects a command payload changed independently of its durable receipt fingerprint', async () => {
  const f = await mailFixture(); await f.owner.apply(f.submit, `Bearer ${f.pair.credential}`);
  const key = `COMMAND#${f.submit.commandId}`; const row = (await f.auth.store.get<{command:unknown}>(key))!;
  await f.auth.store.transact([f.auth.store.put(key, { ...row.data, command: { ...f.submit, accountId: 'other-account' } }, row.rev)]);
  await f.source().tick(new AbortController().signal); expect(f.sends()).toBe(0);
});
it('books two independently accepted offers for the same account without freezing the same authority version', async () => {
  const f = await mailFixture(true); const store = f.auth.store;
  const firstApproval = (await store.list<{ command: ReturnType<typeof ownerCommandSchema.parse> }>('COMMAND#')).find(row => row.stored.data.command?.kind === 'approve-reply')!.stored.data.command;
  if (firstApproval.kind !== 'approve-reply') throw new Error('fixture approval missing');
  const secondId = randomUUID(); const body = 'Tuesday, September 15, 2026 at 11:00 AM to 11:30 AM (America/New_York)';
  const threads = new DynamoThreadIntakeRepository(f.options); const first = (await threads.getThread('acct', 'thread1'))!;
  const message = { ...first.thread.messages[0]!, id: 'inbound2', threadId: 'thread2', rfcMessageId: '<request2@example.test>' };
  await store.transact([store.put(mailThreadKey('acct', 'thread2'), { ...first, thread: { ...first.thread, providerThreadId: 'thread2', messages: [message] } }, null)]);
  await f.owner.apply({ commandId: randomUUID(), workspaceId: 'ws', accountId: 'acct', expectedAuthorityGeneration: 1, expectedVersion: await f.execution.currentVersion('acct'), kind: 'configure-owner',
    payload: { expectedConfigurationRevision: 1, configuration: { ...f.config, revision: 2 }, mailScope: { expectedEnvelopeRevision: 1, since: now } } }, `Bearer ${f.pair.credential}`);
  const draft = { ...firstApproval.payload.draft, id: 'draft2', threadId: 'thread2', body, evidenceIds: ['inbound2'] };
  await threads.saveReplyDraft(draft, null);
  const approval = ownerCommandSchema.parse({ ...firstApproval, commandId: randomUUID(), expectedVersion: await f.execution.currentVersion('acct'), payload: {
    ...firstApproval.payload, draft, actionId: 'action2', approvalId: 'approval2', intentCommandId: secondId,
    permission: { ...firstApproval.payload.permission, id: 'permission2', sourceMessageId: message.id, sourceMessageHash: fingerprint(message) },
    binding: { kind: 'thread_participant', threadId: 'thread2', sourceMessageId: message.id, sourceMessageHash: fingerprint(message) },
    schedulingOffer: { expectedRevision: null, offer: { ...firstApproval.payload.schedulingOffer!.offer, id: 'offer2', threadId: 'thread2', sendCommandId: secondId,
      slots: [{ id: 'slot2', start: '2026-09-15T15:00:00.000Z', end: '2026-09-15T15:30:00.000Z', timezone: 'America/New_York' }] } },
  } });
  await f.owner.apply(approval, `Bearer ${f.pair.credential}`);
  await f.owner.apply({ ...f.submit, expectedVersion: await f.execution.currentVersion('acct') }, `Bearer ${f.pair.credential}`);
  await f.owner.apply({ ...f.submit, commandId: randomUUID(), expectedVersion: await f.execution.currentVersion('acct'), payload: { intentCommandId: secondId } }, `Bearer ${f.pair.credential}`);
  let incoming = false;
  const fetch: typeof globalThis.fetch = async (resource, init) => {
    const url = String(resource);
    if (url.endsWith('/profile')) return Response.json({ historyId: '2' });
    if (url.includes('/messages?')) return Response.json({ messages: [] });
    if (url.includes('/history?')) return Response.json({ historyId: incoming ? '4' : '2', history: incoming ? [{ messagesAdded: [{ message: { id: 'accepted-reply' } }, { message: { id: 'accepted2' } }] }] : [] });
    if (url.includes('/messages/accepted2')) return Response.json({ id: 'accepted2', threadId: 'thread2', internalDate: String(Date.parse(now)), payload: { mimeType: 'text/plain', headers: [
      { name: 'From', value: 'recipient@example.test' }, { name: 'To', value: 'sender@example.test' }, { name: 'Subject', value: 'Meeting offer' }, { name: 'Message-ID', value: '<accepted2@example.test>' }, { name: 'In-Reply-To', value: `<${secondId}@callie.invalid>` }], body: { data: Buffer.from('That works!').toString('base64url') } } });
    if (url.endsWith('/messages/send') && JSON.parse(String(init?.body)).threadId === 'thread2') {
      await f.fetch(resource, init); return Response.json({ id: 'sent2', threadId: 'thread2' });
    }
    return f.fetch(resource, init);
  };
  const repository = new DynamoMeetingRepository(f.options, f.authorization);
  await repository.saveRules({ expectedRevision: null, rules: { revision: 1, confirmed: true, timezone: 'America/New_York', weeklyWindows: [{ weekday: 2, start: '09:00', end: '17:00' }], durationMinutes: 30,
    bufferBeforeMinutes: 10, bufferAfterMinutes: 10, minimumNoticeMinutes: 60, horizonDays: 30, ownedCalendarId: 'sender@example.test', conflictCalendarIds: ['sender@example.test'], location: { kind: 'text', value: 'Fictional office' }, allowCancel: true, allowReschedule: true } });
  const source = () => createSourceCoordinator({ auth: f.auth, authorization: f.authorization, fetch });
  await source().tick(new AbortController().signal); await source().tick(new AbortController().signal);
  expect(f.sends()).toBe(2); expect((await repository.listAcceptedOffers('acct')).offers).toHaveLength(2);
  incoming = true; f.incoming(); await source().tick(new AbortController().signal);
  expect(f.inserts()).toBe(2);
  expect((await repository.listReservations('acct')).records.map(record => record.outcome?.status)).toEqual(['booked', 'booked']);
});
it.each(['caller', 'phase'] as const)('resumes later accounts, commands and publication after cooperative slow-first interruption: %s', async cancellation => {
  const f = await mailFixture(); const store = f.auth.store; const slow = 'aaa-slow';
  await f.owner.apply(f.submit, `Bearer ${f.pair.credential}`);
  await f.execution.seedLocalAuthority(slow); await f.execution.applyCommand({ commandId: 'delegate-slow', workspaceId: 'ws', accountId: slow, expectedAuthorityGeneration: 0, expectedVersion: 0,
    kind: 'delegate', payload: { delegationId: 'approved', approvedAt: now } });
  const account = { id: slow, name: 'Fictional slow account', domain: null, version: 1 };
  const scope = { ...f.scope, accountId: slow }; const binding = { scopeRevision: scope.revision, scopeFingerprint: mailScopeFingerprint(scope) };
  await store.transact([store.put(`ACCOUNT#${slow}`, { account, sources: [], claims: [], routes: [], researchRevision: 1, history: [{ at: now, account, claims: [], routes: [] }] }, null),
    store.put(mailCursorKey(slow, 'mailbox'), { scope, checkpoint: { ...binding, version: 1, accountId: slow, mailboxSubject: 'mailbox', mode: 'history', historyId: '10', pageToken: null, since: now },
      poll: { ...binding, attemptId: 'slow-initial', accountId: slow, mailboxSubject: 'mailbox', status: 'complete', startedAt: now, completedAt: now } }, null)]);
  const projection = (await new DynamoThreadIntakeRepository(f.options).getThread('acct','thread1'))!;
  await store.transact([store.put(mailThreadKey(slow,'thread1'), { ...projection, thread: { ...projection.thread, accountId: slow } }, null)]);
  await f.owner.apply({ commandId: randomUUID(), workspaceId: 'ws', accountId: slow, expectedAuthorityGeneration: 1, expectedVersion: 1, kind: 'configure-owner',
    payload: { expectedConfigurationRevision: 0, configuration: { ...f.config, accountId: slow }, mailScope: null } }, `Bearer ${f.pair.credential}`);
  let slowCalls = 0; let laterPolls = 0; let publications = 0; let controller = new AbortController();
  f.auth.options.publish = async () => { publications++; };
  const fetch: typeof globalThis.fetch = async (resource, init) => {
    const url = String(resource);
    if (url.includes('/history?') && new URL(url).searchParams.get('startHistoryId') === '10') {
      slowCalls++;
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error('fictional cooperative timeout')), { once: true });
        if (cancellation === 'caller') setTimeout(() => controller.abort(), 1);
      });
    }
    if (url.includes('/history?')) laterPolls++;
    return f.fetch(resource, init);
  };
  if (cancellation === 'phase') vi.useFakeTimers();
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      controller = new AbortController();
      const tick = createSourceCoordinator({ auth: f.auth, authorization: f.authorization, fetch }).tick(controller.signal);
      if (cancellation === 'phase') await vi.advanceTimersByTimeAsync(10001);
      await tick;
    }
  } finally { if (cancellation === 'phase') vi.useRealTimers(); }
  expect(slowCalls).toBeGreaterThanOrEqual(2); expect(laterPolls).toBeGreaterThan(0);
  expect(f.sends()).toBe(1); expect(publications).toBeGreaterThan(0);
});
it.each(['dispatch', 'reconcile'] as const)('propagates tick cancellation into expired OAuth refresh during %s', async mode => {
  const f = await mailFixture(); await f.owner.apply(f.submit, `Bearer ${f.pair.credential}`);
  if (mode === 'reconcile') { f.uncertain(); await f.source().tick(new AbortController().signal); }
  f.auth.options.clock.now = () => '2026-09-14T14:00:00.000Z';
  const row = await f.auth.store.get('SOURCE_PHASE_CURSOR');
  await f.auth.store.transact([f.auth.store.put('SOURCE_PHASE_CURSOR', { next: 2 }, row?.rev ?? null)]);
  const controller = new AbortController(); let refreshes = 0; let refreshAborted = false;
  f.authorization.input.fetch = async (resource, init) => {
    if (String(resource).endsWith('/token')) {
      refreshes++; controller.abort(); refreshAborted = init?.signal?.aborted === true;
      if (refreshAborted) throw new Error('fictional cooperative OAuth cancellation');
    }
    return f.fetch(resource, init);
  };
  const fetch: typeof globalThis.fetch = async (resource, init) => { init?.signal?.throwIfAborted(); return f.fetch(resource, init); };
  const before = await f.execution.readDispatch('acct', 'action');
  const result = await createSourceCoordinator({ auth: f.auth, authorization: f.authorization, fetch }).tick(controller.signal);
  expect(result.status).toBe('aborted'); expect(refreshes).toBe(1); expect(refreshAborted).toBe(true);
  expect(await f.execution.readDispatch('acct','action')).toEqual(before);
  expect(f.sends()).toBe(mode === 'dispatch' ? 0 : 1); expect(f.sentLookups()).toBe(0);
});
