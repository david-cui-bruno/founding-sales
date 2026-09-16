// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createWorkerHandler } from '../../cloud/lambdas/delegated-worker/src/handler';
import { WorkerAuth } from '../../cloud/lambdas/delegated-worker/src/workerAuth';
import { RemoteGoogleAuthorization } from '../../cloud/lambdas/delegated-worker/src/remoteGoogleAuthorization';
import { createExecutionRepository } from '../../cloud/lambdas/delegated-worker/src/executionRepository';
import { DynamoThreadIntakeRepository, mailCursorKey } from '../../cloud/lambdas/delegated-worker/src/threadIntakeRepository';
import { meetingWorkKey } from '../../cloud/lambdas/delegated-worker/src/meetingRepository';
import { createSourceCoordinator } from '../../cloud/lambdas/delegated-worker/src/sourceCoordinator';
import { ConditionalCommandHarness } from '../../cloud/lambdas/delegated-worker/test/sdkHarness';
import { googleScopes } from '../../cloud/lambdas/delegated-worker/src/googleGrantCapabilities';
import { mailScopeFingerprint } from '../../src/main/outreach/providers/gmailThreadProvider';
import type { SchedulingRules } from '../../src/shared/contracts/meetingContract';
import type { MailMessage, ThreadProjection } from '../../src/shared/contracts/mailThreadContract';
import type { DailyAnswer } from '../../src/shared/contracts/dailyContract';
import type { AccountPreparation } from '../../src/shared/contracts/accountPreparationContract';
import { DailyAnswerDetail } from '../../src/renderer/features/today/DailyAnswers';
import type { OwnerCommand, OwnerSourceConfiguration } from '../../src/shared/contracts/ownerCommandContract';
import { delegationCommandSchema, eventPageSchema, type DelegationCommand } from '../../src/shared/contracts/delegationContract';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { createDelegationRuntime } from '../../src/main/delegation/delegationRuntime';
import { registerOutreachIpc } from '../../src/main/ipc/registerOutreachIpc';
import { createCallieApi } from '../../src/preload/createCallieApi';
import { openDatabase, closeDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';
import type { RegisteredIpcHandler } from '../fixtures/registeredIpcHandler';
import { PresentationRoot } from '../../src/renderer/app/PresentationRoot';
import { NativeDeskRoute } from '../../src/renderer/features/today/NativeDeskRoute';
import { configuredFixtureStatus, nativeDeskFixture } from '../../src/renderer/features/today/nativeDesk.fixture';

const ipc = vi.hoisted(() => ({ handlers: new Map<string, RegisteredIpcHandler>() }));
vi.mock('electron', () => ({ ipcMain: {
  handle: (channel: string, handler: RegisteredIpcHandler) => { if (ipc.handlers.has(channel)) throw Error('Duplicate IPC'); ipc.handlers.set(channel, handler); },
  removeHandler: (channel: string) => ipc.handlers.delete(channel),
} }));
const noNetwork = vi.fn(async (): Promise<never> => { throw Error('No real network allowed'); });
afterEach(() => { cleanup(); expect(noNetwork).not.toHaveBeenCalled(); expect(ipc.handlers.size).toBe(0); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

/** Worker side: fictional Google HTTP only. Grant, scheduling rules, mail intake and the agreement thread are real worker state. */
async function worker(configureRules = true) {
  vi.stubGlobal('fetch', noNetwork);
  let now = '2026-09-14T12:00:00.000Z';
  const workspaceId = 'meeting-approval-workflow', accountId = 'agreed-company', mailboxSubject = 'mailbox';
  const calendarId = 'founder@example.test', host = 'meeting.example.test';
  const dynamo = new ConditionalCommandHarness(), options = { dynamo, workspaceId, tableName: 'fictional', clock: { now: () => now } };
  const auth = new WorkerAuth(options), store = auth.store;
  const counts = { calendarInserts: 0, emailSends: 0, forbidden: 0 };
  const events = new Map<string, unknown>();
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
        return Response.json(events.get(body.id));
      }
      if (url.pathname.endsWith('/events')) return Response.json({ items: [...events.values()] });
      const event = events.get(url.pathname.split('/').at(-1)!);
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
  const account: { id: string; name: string; version: number; domain: string | null } = { id: accountId, name: 'Agreed Fictional PM', version: 1, domain: null };
  await store.transact([store.put(`ACCOUNT#${accountId}`, { account, routes: [], sources: [], claims: [], researchRevision: 1, history: [{ at: now, account, routes: [], claims: [] }] }, null)]);
  const delegate: DelegationCommand = { commandId: randomUUID(), workspaceId, accountId, expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'delegate', payload: { delegationId: 'explicit', approvedAt: now } };
  expect((await request('/commands', delegate)).statusCode).toBe(200);
  const threads = new DynamoThreadIntakeRepository(options);
  const message: MailMessage = { id: 'agreement', threadId: 'thread1', rfcMessageId: '<agreement@example.test>', references: [], from: ['prospect@example.test'], to: [calendarId], cc: [], date: now, subject: 'Meeting agreement', bodyParts: [{ mimeType: 'text/plain', text: 'Tuesday September 15 at 10 am Eastern works for our 30 minute meeting.', truncated: false }] };
  await threads.applyPage({ complete: true, threads: [{ accountId, mailboxSubject, provider: 'gmail', providerThreadId: 'thread1', messages: [message] }], nextCursor: { version: 1, accountId, mailboxSubject, mode: 'history', historyId: '1', pageToken: null, since: now } }, null);
  const scope = { version: 1 as const, accountId, mailboxSubject, revision: 1, participantAddresses: message.from, knownThreadIds: ['thread1'], since: now, approvedAt: now };
  const binding = { scopeRevision: 1, scopeFingerprint: mailScopeFingerprint(scope) };
  const cursor = (await store.get(mailCursorKey(accountId, mailboxSubject)))!;
  await store.transact([store.put(mailCursorKey(accountId, mailboxSubject), { scope, checkpoint: { ...binding, version: 1, accountId, mailboxSubject, mode: 'history', historyId: '1', pageToken: null, since: now }, poll: { ...binding, attemptId: 'initial', accountId, mailboxSubject, status: 'complete', startedAt: now, completedAt: now } }, cursor.rev), store.put(`DISPATCH_INTAKE#${accountId}`, { accountId, adapters: [{ id: 'gmail', kind: 'gmail', enabled: true, relevant: true, mailboxSubject }], manualDependencies: [] }, null)]);
  const configuration: OwnerSourceConfiguration = { version: 1, workspaceId, accountId, pairingId: pair.pairingId, revision: 1, state: 'active', mailboxSubject, calendarId, research: null };
  const configureCommand: Extract<OwnerCommand, { kind: 'configure-owner' }> = { commandId: randomUUID(), workspaceId, accountId, expectedAuthorityGeneration: 1, expectedVersion: await execution.currentVersion(accountId), kind: 'configure-owner', payload: { expectedConfigurationRevision: 0, configuration, mailScope: null } };
  expect((await request('/commands', configureCommand)).statusCode).toBe(200);
  const rules: SchedulingRules = { revision: 1, confirmed: true, timezone: 'America/New_York', weeklyWindows: [{ weekday: 2, start: '09:00', end: '17:00' }], durationMinutes: 30, bufferBeforeMinutes: 10, bufferAfterMinutes: 10, minimumNoticeMinutes: 60, horizonDays: 30, ownedCalendarId: calendarId, conflictCalendarIds: [calendarId], location: { kind: 'text', value: 'Fictional office' }, allowCancel: false, allowReschedule: false };
  if (configureRules) expect((await request('/policies/configure', { version: 1, requestId: randomUUID(), workspaceId, pairingId: pair.pairingId, mailboxSubject, expectedRevision: null, kind: 'meeting-rules', rules })).statusCode).toBe(200);
  return { workspaceId, accountId, mailboxSubject, calendarId, host, pair, request, counts, events, store, dynamo, options, execution, delegate, configureCommand, message, rules,
    source: () => createSourceCoordinator({ auth, authorization: google, fetch: provider }), advance: (value: string) => { now = value; }, now: () => now };
}
type Worker = Awaited<ReturnType<typeof worker>>;

/** Desktop side: encrypted local SQL, real delegation runtime, real IPC registration, real preload bridge, real route. */
async function desktop(w: Worker) {
  const temp = createTempDatabase(), key = createTestWorkspaceKey();
  const db = openDatabase({ path: temp.path, key });
  await migrateToLatest(db, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
  const clock = w.options.clock, workspaceId = w.workspaceId;
  new AccountRepository({ database: db, clock, ids: { next: () => w.accountId } }).create({ commandId: randomUUID(), name: 'Agreed Fictional PM', domain: null });
  db.raw.prepare("INSERT INTO workspace_workflow_state VALUES(1,'meeting_first',1,?)").run(w.now());
  const owner = new DelegationRepository({ database: db, workspaceId, clock });
  owner.initializeLocalAuthority(w.accountId); owner.queueCommand(w.delegate);
  const initial = eventPageSchema.parse(JSON.parse((await w.request('/events')).body));
  for (const event of initial.events) {
    if (event.kind === 'authority.changed' && event.payload.receipt.commandId === w.configureCommand.commandId) owner.queueCommand(delegationCommandSchema.parse(w.configureCommand));
    expect(owner.applyWorkerEvent(event)).toBe('applied');
  }
  const posted: DelegationCommand[] = [], paths: string[] = [];
  // Offline drops every owner call except the preparation read, so an approval can be
  // queued locally without the owner ever seeing it and then retried explicitly.
  let offline = false;
  const http: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); expect(url.origin).toBe(`https://${w.host}`); paths.push(url.pathname);
    if (offline && url.pathname !== '/accounts/preparation') throw Error('Fictional owner offline');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === '/commands' && body) posted.push(delegationCommandSchema.parse(body));
    const response = await w.request(url.pathname + url.search, body, new Headers(init?.headers).get('authorization') ?? '');
    return new Response(response.body, { status: response.statusCode });
  };
  const runtime = createDelegationRuntime({ databaseGate: { withDatabase: async fn => fn(db) }, pairing: { ...w.pair, endpoint: `https://${w.host}` }, clock, fetch: http });
  const forbidden = vi.fn(async (): Promise<never> => { throw Error('Unrequested outbound operation'); });
  const removeIpc = registerOutreachIpc({ provider: { status: forbidden, configure: forbidden, connectGmail: forbidden, disconnectGmail: forbidden, openDraft: forbidden, saveDraft: forbidden, generateDraft: forbidden, sendDraft: forbidden, inspectLocalAuthority: forbidden }, delegation: runtime, isTrustedRendererUrl: url => url === 'app://meeting' });
  const bridge = createCallieApi({ invoke: async (channel, ...args) => { const registered = ipc.handlers.get(channel); if (!registered) throw Error('Missing IPC'); return registered({ senderFrame: { url: 'app://meeting' } }, ...args); } });
  const services = createDomainServices({ database: db, clock, ids: { next: randomUUID }, expectedWorkspaceId: workspaceId });
  const ui = nativeDeskFixture(services.daily.get());
  ui.setConfiguration({ ...configuredFixtureStatus(), workspaceId });
  ui.api.daily.get = vi.fn(async () => services.daily.get());
  // Only the bridge methods this outcome needs are real. Sync/submit from the UI stay forbidden.
  vi.spyOn(ui.api.delegation, 'sync').mockImplementation(forbidden);
  vi.spyOn(ui.api.delegation, 'submit').mockImplementation(forbidden);
  Object.assign(ui.api.delegation, { getAccountPreparation: bridge.delegation.getAccountPreparation, approveMeeting: bridge.delegation.approveMeeting, getMeetingApproval: bridge.delegation.getMeetingApproval });
  const approveCommands = () => posted.filter(command => command.kind === 'approve-meeting');
  return { ...ui, db, owner, services, runtime, bridge, forbidden, posted, paths, approveCommands, workspaceId,
    setOffline: (value: boolean) => { offline = value; },
    approvalIdentities: () => [...new Set(approveCommands().map(command => command.commandId))],
    meeting: () => db.raw.prepare('SELECT projection_json FROM delegated_meetings WHERE workspace_id=? AND account_id=?').get(workspaceId, w.accountId) as { projection_json: string } | undefined,
    async close() { removeIpc(); await runtime.dispose(); closeDatabase(db); key.bytes.fill(0); temp.cleanup(); } };
}

const replyRow = () => screen.findByRole('button', { name: /^Reply · Agreed Fictional PM$/ });

it('approves an explicit slot from the saved scheduling reply through the real bridge, queues exactly one owner command and writes no calendar event from the desktop', async () => {
  const w = await worker(), d = await desktop(w);
  try {
    render(<PresentationRoot><NativeDeskRoute api={d.api} firstUse={d.firstUse} surface="today" onOpenLead={vi.fn()} onOpenImport={vi.fn()} /></PresentationRoot>);
    fireEvent.click(await replyRow());
    const panel = within(await screen.findByRole('region', { name: 'Meeting approval' }));
    // The quoted evidence and the attendee come from the saved projection, never from a guessed contact.
    expect(panel.getByText(w.message.bodyParts[0]!.text, { selector: 'blockquote' })).toBeTruthy();
    expect(panel.getByText(/^Attendee: prospect@example\.test \(sender of the quoted message\)/)).toBeTruthy();
    expect(d.paths).toEqual([]);
    fireEvent.click(panel.getByRole('button', { name: 'Check calendar and scheduling rules' }));
    await panel.findByText(/Calendar: founder@example\.test · Time zone: America\/New_York · Duration: 30 minutes · Rules revision 1\./);
    expect(d.paths).toEqual(['/accounts/preparation']);
    const approve = panel.getByRole<HTMLButtonElement>('button', { name: 'Approve meeting' });
    expect(approve.disabled).toBe(true);
    fireEvent.change(panel.getByLabelText('Meeting start'), { target: { value: '2026-09-15T10:00' } });
    fireEvent.click(panel.getByLabelText(/I confirm this slot matches the quoted reply/));
    await waitFor(() => expect(approve.disabled).toBe(false));
    expect(d.approveCommands()).toEqual([]); expect(await w.store.list('MEETING_INTENT#')).toEqual([]);
    fireEvent.click(approve);
    await panel.findByText('Meeting approval receipt: applied.');
    // Submit posts once and the following sync flush re-posts the same still-pending identity;
    // the worker answers idempotently. Exactly one command identity and one admitted work item exist.
    const commands = d.approveCommands(); expect(commands.length).toBeGreaterThanOrEqual(1);
    expect(new Set(commands.map(value => JSON.stringify(value))).size).toBe(1);
    expect(await w.store.list('MEETING_INTENT#')).toHaveLength(1);
    const command = commands[0]!; if (command.kind !== 'approve-meeting') throw Error('Wrong command kind');
    expect(command.payload).toMatchObject({ calendarId: w.calendarId, intent: { operation: 'create', etag: null, approvalId: command.commandId, commandId: command.commandId,
      agreementEvidenceId: w.message.id, attendeeEmails: w.message.from, rulesRevision: 1, threadId: 'thread1', mailboxSubject: w.mailboxSubject, pairingId: w.pair.pairingId,
      start: '2026-09-15T14:00:00.000Z', end: '2026-09-15T14:30:00.000Z', localStart: '2026-09-15T10:00:00', timezone: 'America/New_York',
      agreement: { kind: 'explicit_slot', start: '2026-09-15T14:00:00.000Z', end: '2026-09-15T14:30:00.000Z', quote: w.message.bodyParts[0]!.text },
      expectedVersion: command.expectedVersion + 1, expectedAuthorityGeneration: command.expectedAuthorityGeneration } });
    expect(d.owner.commandStatus(command.commandId)).toMatchObject({ status: 'applied' });
    expect((await w.store.get<{ input: unknown }>(meetingWorkKey(w.accountId, command.commandId)))?.data.input).toEqual(command.payload);
    // Desktop approval reserved nothing. The worker's existing poller books afterwards.
    expect(w.counts).toEqual({ calendarInserts: 0, emailSends: 0, forbidden: 0 }); expect(d.meeting()).toBeUndefined();
    await w.source().tick(new AbortController().signal);
    expect(w.counts).toEqual({ calendarInserts: 1, emailSends: 0, forbidden: 0 });
    expect(d.forbidden).not.toHaveBeenCalled();
  } finally { cleanup(); await d.close(); }
});

async function openApproval(w: Worker, d: Awaited<ReturnType<typeof desktop>>) {
  render(<PresentationRoot><NativeDeskRoute api={d.api} firstUse={d.firstUse} surface="today" onOpenLead={vi.fn()} onOpenImport={vi.fn()} /></PresentationRoot>);
  fireEvent.click(await replyRow());
  const panel = within(await screen.findByRole('region', { name: 'Meeting approval' }));
  fireEvent.click(panel.getByRole('button', { name: 'Check calendar and scheduling rules' }));
  await panel.findByText(/Rules revision 1\./);
  fireEvent.change(panel.getByLabelText('Meeting start'), { target: { value: '2026-09-15T10:00' } });
  fireEvent.click(panel.getByLabelText(/I confirm this slot matches the quoted reply/));
  const approve = panel.getByRole<HTMLButtonElement>('button', { name: 'Approve meeting' });
  await waitFor(() => expect(approve.disabled).toBe(false));
  expect(w.counts.calendarInserts).toBe(0);
  return { panel, approve };
}

it('retries the same approval after a lost owner response without issuing a second command identity', async () => {
  const w = await worker(), d = await desktop(w);
  try {
    const { panel, approve } = await openApproval(w, d);
    d.setOffline(true);
    fireEvent.click(approve);
    // The owner never answered: the local outbox holds one pending command and the receipt is honestly pending.
    await panel.findByText('Meeting approval receipt: pending.');
    const pending = d.owner.pendingCommands().filter(command => command.kind === 'approve-meeting');
    expect(pending).toHaveLength(1);
    expect(d.approveCommands()).toEqual([]); expect(await w.store.list('MEETING_INTENT#')).toEqual([]);
    expect(approve.disabled).toBe(true);
    d.setOffline(false);
    fireEvent.click(panel.getByRole('button', { name: 'Retry same approval' }));
    await panel.findByText('Meeting approval receipt: applied.');
    expect(d.approvalIdentities()).toEqual([pending[0]!.commandId]);
    expect(d.owner.getCommand(pending[0]!.commandId)).toEqual(pending[0]);
    expect(await w.store.list('MEETING_INTENT#')).toHaveLength(1);
    expect(panel.queryByRole('button', { name: 'Retry same approval' })).toBeNull();
    expect(w.counts).toEqual({ calendarInserts: 0, emailSends: 0, forbidden: 0 });
  } finally { cleanup(); await d.close(); }
});

it('shows a durable rejection from the owner and never re-issues the approval implicitly', async () => {
  const w = await worker(), d = await desktop(w);
  try {
    const { panel, approve } = await openApproval(w, d);
    d.setOffline(true);
    fireEvent.click(approve);
    await panel.findByText('Meeting approval receipt: pending.');
    const pending = d.owner.pendingCommands().find(command => command.kind === 'approve-meeting')!;
    // The owner moves on without this command: an explicit pause advances the version it expected.
    expect((await w.request('/commands', { commandId: randomUUID(), workspaceId: w.workspaceId, accountId: w.accountId, expectedAuthorityGeneration: pending.expectedAuthorityGeneration, expectedVersion: pending.expectedVersion, kind: 'pause', payload: { reason: 'fictional owner pause' } })).statusCode).toBe(200);
    d.setOffline(false);
    fireEvent.click(panel.getByRole('button', { name: 'Retry same approval' }));
    await panel.findByText('Meeting approval receipt: rejected.');
    expect(panel.getByText(/Stale owner command; explicit fresh action required/)).toBeTruthy();
    expect(d.owner.commandStatus(pending.commandId)).toMatchObject({ status: 'rejected' });
    expect(d.approvalIdentities()).toEqual([pending.commandId]);
    expect(await w.store.list('MEETING_INTENT#')).toEqual([]);
    // Nothing is re-issued: the approval control is closed until an explicit fresh read and confirmation.
    expect(panel.getByRole<HTMLButtonElement>('button', { name: 'Approve meeting' }).disabled).toBe(true);
    expect(panel.queryByRole('button', { name: 'Retry same approval' })).toBeNull();
    expect(panel.getByText('Check the calendar and scheduling rules before approving.')).toBeTruthy();
    expect(w.counts).toEqual({ calendarInserts: 0, emailSends: 0, forbidden: 0 });
  } finally { cleanup(); await d.close(); }
});

it('reads the stored rules revision through the preparation bridge, fences it, and holds the runtime when rules are absent', async () => {
  const configured = await worker(), c = await desktop(configured);
  try {
    const read = await c.bridge.delegation.getAccountPreparation({ accountId: configured.accountId });
    expect(read.meetingRules).toEqual({ calendarId: configured.calendarId, revision: 1, timezone: 'America/New_York', durationMinutes: 30 });
    const fence = configured.dynamo.transactions.at(-1)!.TransactItems!.map(item => item.ConditionCheck?.Key?.sk?.S);
    expect(fence).toContain(`MEETING_RULES#${encodeURIComponent(configured.calendarId)}`);
  } finally { await c.close(); }
  const unconfigured = await worker(false), u = await desktop(unconfigured);
  try {
    const read = await u.bridge.delegation.getAccountPreparation({ accountId: unconfigured.accountId });
    expect(read.configuration?.calendarId).toBe(unconfigured.calendarId); expect(read.meetingRules).toBeNull();
    const request = { accountId: unconfigured.accountId, threadId: 'thread1', expectedThreadRevision: 1, expectedContextRevision: u.owner.getThread(unconfigured.accountId, 'thread1')!.contextRevision,
      agreementEvidenceId: unconfigured.message.id, attendeeEmail: unconfigured.message.from[0]!, quote: unconfigured.message.bodyParts[0]!.text, calendarId: unconfigured.calendarId, rulesRevision: 1,
      timezone: 'America/New_York', durationMinutes: 30, localStart: '2026-09-15T10:00:00', summary: 'Callie meeting', inviteAttendees: true };
    await expect(u.runtime.approveMeeting(request)).rejects.toThrow('meeting_rules_unconfigured');
    // A guessed attendee, a foreign quote or a stale thread is refused before any authority is read.
    await expect(u.runtime.approveMeeting({ ...request, attendeeEmail: 'guessed@example.test' })).rejects.toThrow('agreement_evidence_mismatch');
    await expect(u.runtime.approveMeeting({ ...request, quote: 'Invented agreement text' })).rejects.toThrow('agreement_evidence_mismatch');
    await expect(u.runtime.approveMeeting({ ...request, expectedThreadRevision: 2 })).rejects.toThrow('stale_thread');
    expect(u.owner.pendingCommands()).toEqual([]); expect(u.approveCommands()).toEqual([]);
    expect(await u.bridge.delegation.getMeetingApproval({ accountId: unconfigured.accountId, threadId: 'thread1' })).toBeNull();
  } finally { await u.close(); }
});

function replyItem(signals: ThreadProjection['signals']): Extract<DailyAnswer, { kind: 'reply' }> {
  return { kind: 'reply', accountId: 'a', capability: 'held', reason: 'reply_capability_unverified', stale: false, draft: null,
    thread: { revision: 1, contextRevision: 'context-a', signals, thread: { accountId: 'a', provider: 'gmail', mailboxSubject: 'mailbox', providerThreadId: 'thread-a',
      messages: [{ id: 'message-a', threadId: 'thread-a', rfcMessageId: null, references: [], from: ['prospect@fixture.invalid'], to: ['founder@fixture.invalid'], cc: [],
        date: '2026-09-09T11:30:00.000Z', subject: 'Re: A short conversation', bodyParts: [{ mimeType: 'text/plain', text: 'Tuesday at 10 am Eastern works for a 30 minute call.', truncated: false }] }] } } };
}
const schedulingSignal: ThreadProjection['signals'] = [{ kind: 'scheduling', requiresApproval: true, evidence: [{ messageId: 'message-a', quote: 'Tuesday at 10 am Eastern works for a 30 minute call.' }] }];
function fixturePreparation(overrides: { calendarId: string | null; meetingRules?: AccountPreparation['meetingRules'] }): AccountPreparation {
  const configuration: OwnerSourceConfiguration = { version: 1, workspaceId: 'ws', accountId: 'a', pairingId: 'fixture-pairing', revision: 1, state: 'active', mailboxSubject: 'mailbox', calendarId: overrides.calendarId, research: null };
  return { workspaceId: 'ws', accountId: 'a', pairingId: 'fixture-pairing', checkedAt: '2026-09-09T12:00:00.000Z', authority: { accountId: 'a', owner: 'worker', generation: 1, state: 'active' },
    executionVersion: 1, configuration, mailCursor: { mailboxSubject: 'mailbox', envelopeRevision: null, scope: null }, ...('meetingRules' in overrides ? { meetingRules: overrides.meetingRules } : {}) };
}

it('offers no meeting approval when the latest saved message carries no scheduling signal', () => {
  const f = nativeDeskFixture();
  render(<PresentationRoot><DailyAnswerDetail item={replyItem([])} workspaceId="ws" api={f.api.delegation} linkedin={f.api.linkedin} company="Account A" /></PresentationRoot>);
  expect(screen.queryByRole('region', { name: 'Meeting approval' })).toBeNull();
  expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  expect(f.calls).toEqual([]);
});

it.each([
  ['no calendar configured', { calendarId: null }, 'No calendar is configured for this company. Approval held.'],
  ['rules unreadable from this app', { calendarId: 'founder@fixture.invalid' }, 'Scheduling rules are not readable from this app yet. Approval held.'],
  ['no confirmed rules stored', { calendarId: 'founder@fixture.invalid', meetingRules: null }, 'No confirmed scheduling rules are stored for this calendar. Approval held.'],
] as const)('holds approval honestly when %s', async (_label, preparation, hold) => {
  const f = nativeDeskFixture(); f.setPreparation(fixturePreparation(preparation));
  render(<PresentationRoot><DailyAnswerDetail item={replyItem(schedulingSignal)} workspaceId="ws" api={f.api.delegation} linkedin={f.api.linkedin} company="Account A" /></PresentationRoot>);
  const panel = within(screen.getByRole('region', { name: 'Meeting approval' }));
  expect(panel.getByText('Tuesday at 10 am Eastern works for a 30 minute call.', { selector: 'blockquote' })).toBeTruthy();
  fireEvent.click(panel.getByRole('button', { name: 'Check calendar and scheduling rules' }));
  await panel.findByText(hold);
  fireEvent.change(panel.getByLabelText('Meeting start'), { target: { value: '2026-09-15T10:00' } });
  fireEvent.click(panel.getByLabelText(/I confirm this slot matches the quoted reply/));
  expect(panel.getByRole<HTMLButtonElement>('button', { name: 'Approve meeting' }).disabled).toBe(true);
  expect(f.calls.map(call => call.method).filter(method => method !== 'getMeetingApproval')).toEqual(['getAccountPreparation']);
});

it('keeps the approval closed under a route action hold and states that mixed replies always require approval', () => {
  const f = nativeDeskFixture(); f.setPreparation(fixturePreparation({ calendarId: 'founder@fixture.invalid', meetingRules: { calendarId: 'founder@fixture.invalid', revision: 3, timezone: 'America/New_York', durationMinutes: 30 } }));
  const mixed: ThreadProjection['signals'] = [{ kind: 'mixed', requiresApproval: true, evidence: [{ messageId: 'message-a', quote: 'Tuesday at 10 am Eastern works' }] }];
  render(<PresentationRoot><DailyAnswerDetail item={replyItem(mixed)} workspaceId="ws" api={f.api.delegation} linkedin={f.api.linkedin} company="Account A"
    actionHold="Owner command pending. Wait for its applied receipt before continuing." /></PresentationRoot>);
  const panel = within(screen.getByRole('region', { name: 'Meeting approval' }));
  expect(panel.getByText(/approval is required and never inferred/)).toBeTruthy();
  expect(panel.getByText('Owner command pending. Wait for its applied receipt before continuing.')).toBeTruthy();
  expect(panel.getByRole<HTMLButtonElement>('button', { name: 'Check calendar and scheduling rules' }).disabled).toBe(true);
  expect(panel.getByRole<HTMLButtonElement>('button', { name: 'Approve meeting' }).disabled).toBe(true);
  expect(f.calls).toEqual([]);
});
