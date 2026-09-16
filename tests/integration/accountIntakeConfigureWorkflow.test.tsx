// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createWorkerHandler } from '../../cloud/lambdas/delegated-worker/src/handler';
import { WorkerAuth } from '../../cloud/lambdas/delegated-worker/src/workerAuth';
import { RemoteGoogleAuthorization } from '../../cloud/lambdas/delegated-worker/src/remoteGoogleAuthorization';
import { createExecutionRepository } from '../../cloud/lambdas/delegated-worker/src/executionRepository';
import { DynamoThreadIntakeRepository, mailCursorKey } from '../../cloud/lambdas/delegated-worker/src/threadIntakeRepository';
import { ConditionalCommandHarness } from '../../cloud/lambdas/delegated-worker/test/sdkHarness';
import { googleScopes } from '../../cloud/lambdas/delegated-worker/src/googleGrantCapabilities';
import { mailScopeFingerprint } from '../../src/main/outreach/providers/gmailThreadProvider';
import type { MailMessage } from '../../src/shared/contracts/mailThreadContract';
import type { AccountRecord } from '../../src/shared/contracts/accountRecordContract';
import { ownerSourceKey, type OwnerCommand, type OwnerSourceConfiguration } from '../../src/shared/contracts/ownerCommandContract';
import type { ConfigureAccountIntake } from '../../src/shared/contracts/accountIntakeConfigureContract';
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

type Seed = 'active-mail' | 'paused-no-mail' | 'no-google-client' | 'no-google-scope';
/** Worker side: fictional Google HTTP only (token and userinfo during the grant). The grant with
 * Gmail read scope, the account record with a permitted-source email route, the intake and the
 * first owner configuration are real worker state. Every provider call is counted. */
async function worker(seed: Seed) {
  vi.stubGlobal('fetch', noNetwork);
  let now = '2026-09-14T12:00:00.000Z';
  const workspaceId = 'intake-configure-workflow', accountId = 'configured-company', mailboxSubject = 'mailbox';
  const grantEmail = 'founder@example.test', calendarId = 'founder@example.test', host = 'intake.example.test', routeEmail = 'team@example.test';
  const dynamo = new ConditionalCommandHarness(), options = { dynamo, workspaceId, tableName: 'fictional', clock: { now: () => now } };
  const auth = new WorkerAuth(options), store = auth.store;
  const providerCalls: string[] = [];
  const provider: typeof fetch = async (resource) => {
    const url = new URL(String(resource)); providerCalls.push(url.pathname);
    if (url.pathname.endsWith('/token')) return Response.json({ access_token: 'fictional', refresh_token: 'fictional-refresh', token_type: 'Bearer', expires_in: 3600, scope: `openid email ${googleScopes.relevant_read} ${googleScopes.availability} ${googleScopes.event_write}` });
    if (url.pathname.endsWith('/userinfo')) return Response.json({ sub: mailboxSubject, email: grantEmail, email_verified: true });
    throw Error('Unexpected provider operation');
  };
  // 'no-google-client' is the deployed shape with no Google client at all: the handler is built without
  // one, so /google/status answers its own bounded code (503 google_unconfigured) rather than any grant state.
  // 'no-google-scope' keeps the Google client but issues this pairing without google:grant, so the real
  // handler refuses the status read (403 worker_scope_denied) before any grant lookup; no grant was ever made.
  const google = seed === 'no-google-client' ? undefined : new RemoteGoogleAuthorization({ auth, fetch: provider, config: { clientId: 'fictional.apps.googleusercontent.com', clientSecret: 'fictional', redirectUri: `https://${host}/oauth/callback`, encryptionKey: Buffer.alloc(32, 8) } });
  const pair = await auth.redeemPairing((await auth.issuePairing({ scopes: seed === 'no-google-scope' ? ['commands:write', 'events:read'] : ['commands:write', 'events:read', 'google:grant'], expiresInSeconds: 300 })).code, 'fictional');
  if (google && seed !== 'no-google-scope') {
    const grant = await google.beginGoogleGrant(pair.pairingId, ['relevant_read', 'availability', 'event_write'], { confirmed: true, ownedCalendarId: calendarId, conflictCalendarIds: [calendarId] });
    await google.completeGoogleGrant(new URL(grant.authorizationUrl).searchParams.get('state')!, 'fictional');
  }
  const grantCalls = providerCalls.length;
  const handler = createWorkerHandler({ auth, host, ...(google ? { google } : {}) });
  const request = (path: string, body?: unknown, bearer = `Bearer ${pair.credential}`) => {
    const url = new URL(path, `https://${host}`);
    return handler({ version: '2.0', rawPath: url.pathname, rawQueryString: url.search.slice(1), headers: { host, 'x-forwarded-proto': 'https', authorization: bearer }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { domainName: host, http: { method: body === undefined ? 'GET' : 'POST', sourceIp: 'fictional' } } });
  };
  const execution = createExecutionRepository(options);
  await execution.seedLocalAuthority(accountId);
  const account: AccountRecord['account'] = { id: accountId, name: 'Configured Fictional PM', version: 1, domain: null };
  // The permitted-source business inbox is what a first mail scope admits as its participant.
  const route: AccountRecord['routes'][number] = { id: 'route-team', accountId, personId: null, channel: 'email', value: routeEmail, purpose: 'business', evidenceIds: ['source-team'], verification: 'published', version: 1 };
  const source: AccountRecord['sources'][number] = { id: 'source-team', url: 'https://example.test/team', fetchedAt: now, sha256: 'a'.repeat(64), excerpt: `Business email: ${routeEmail}`, permitted: true };
  const routes = seed === 'paused-no-mail' ? [route] : [], sources = seed === 'paused-no-mail' ? [source] : [];
  const record: AccountRecord = { account, routes, sources, claims: [], researchRevision: 1, history: [{ at: now, account, routes, claims: [] }] };
  await store.transact([store.put(`ACCOUNT#${accountId}`, record, null)]);
  const delegate: DelegationCommand = { commandId: randomUUID(), workspaceId, accountId, expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'delegate', payload: { delegationId: 'explicit', approvedAt: now } };
  expect((await request('/commands', delegate)).statusCode).toBe(200);
  const message: MailMessage = { id: 'saved', threadId: 'thread1', rfcMessageId: '<saved@example.test>', references: [], from: ['prospect@example.test'], to: [grantEmail], cc: [], date: now, subject: 'Saved correspondence', bodyParts: [{ mimeType: 'text/plain', text: 'Thanks for the note.', truncated: false }] };
  if (seed === 'active-mail') {
    const threads = new DynamoThreadIntakeRepository(options);
    await threads.applyPage({ complete: true, threads: [{ accountId, mailboxSubject, provider: 'gmail', providerThreadId: 'thread1', messages: [message] }], nextCursor: { version: 1, accountId, mailboxSubject, mode: 'history', historyId: '1', pageToken: null, since: now } }, null);
    const scope = { version: 1 as const, accountId, mailboxSubject, revision: 1, participantAddresses: message.from, knownThreadIds: ['thread1'], since: now, approvedAt: now };
    const binding = { scopeRevision: 1, scopeFingerprint: mailScopeFingerprint(scope) };
    const cursor = (await store.get(mailCursorKey(accountId, mailboxSubject)))!;
    await store.transact([store.put(mailCursorKey(accountId, mailboxSubject), { scope, checkpoint: { ...binding, version: 1, accountId, mailboxSubject, mode: 'history', historyId: '1', pageToken: null, since: now }, poll: { ...binding, attemptId: 'initial', accountId, mailboxSubject, status: 'complete', startedAt: now, completedAt: now } }, cursor.rev), store.put(`DISPATCH_INTAKE#${accountId}`, { accountId, adapters: [{ id: 'gmail', kind: 'gmail', enabled: true, relevant: true, mailboxSubject }], manualDependencies: [] }, null)]);
  }
  const configuration: OwnerSourceConfiguration = seed === 'active-mail'
    ? { version: 1, workspaceId, accountId, pairingId: pair.pairingId, revision: 1, state: 'active', mailboxSubject, calendarId, research: null }
    : { version: 1, workspaceId, accountId, pairingId: pair.pairingId, revision: 1, state: 'paused', mailboxSubject: null, calendarId: null, research: null };
  const configureCommand: Extract<OwnerCommand, { kind: 'configure-owner' }> = { commandId: randomUUID(), workspaceId, accountId, expectedAuthorityGeneration: 1, expectedVersion: await execution.currentVersion(accountId), kind: 'configure-owner', payload: { expectedConfigurationRevision: 0, configuration, mailScope: null } };
  expect((await request('/commands', configureCommand)).statusCode).toBe(200);
  return { workspaceId, accountId, mailboxSubject, grantEmail, calendarId, routeEmail, host, pair, request, store, dynamo, options, execution, delegate, configureCommand, message,
    stored: async () => (await store.get<OwnerSourceConfiguration>(ownerSourceKey(accountId)))?.data,
    cursor: () => new DynamoThreadIntakeRepository(options).cursorState(accountId, mailboxSubject),
    providerCallsSinceGrant: () => providerCalls.length - grantCalls,
    advance: (value: string) => { now = value; }, now: () => now };
}
type Worker = Awaited<ReturnType<typeof worker>>;

/** Desktop side: encrypted local SQL, real delegation runtime, real IPC registration, real preload bridge, real route. */
async function desktop(w: Worker) {
  const temp = createTempDatabase(), key = createTestWorkspaceKey();
  const db = openDatabase({ path: temp.path, key });
  await migrateToLatest(db, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
  const clock = w.options.clock, workspaceId = w.workspaceId;
  new AccountRepository({ database: db, clock, ids: { next: () => w.accountId } }).create({ commandId: randomUUID(), name: 'Configured Fictional PM', domain: null });
  db.raw.prepare("INSERT INTO workspace_workflow_state VALUES(1,'meeting_first',1,?)").run(w.now());
  const owner = new DelegationRepository({ database: db, workspaceId, clock });
  owner.initializeLocalAuthority(w.accountId); owner.queueCommand(w.delegate);
  const initial = eventPageSchema.parse(JSON.parse((await w.request('/events')).body));
  for (const event of initial.events) {
    if (event.kind === 'authority.changed' && event.payload.receipt.commandId === w.configureCommand.commandId) owner.queueCommand(delegationCommandSchema.parse(w.configureCommand));
    expect(owner.applyWorkerEvent(event)).toBe('applied');
  }
  const posted: DelegationCommand[] = [], paths: string[] = [];
  // Offline drops every owner call except the preparation read, so a change can be queued
  // locally without the owner ever seeing it and then retried explicitly.
  let offline = false, googleOutage = false;
  const http: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); expect(url.origin).toBe(`https://${w.host}`); paths.push(url.pathname);
    if (offline && url.pathname !== '/accounts/preparation') throw Error('Fictional owner offline');
    // A gateway 5xx with no worker body: the grant read failed for a reason nobody can name, unlike a worker code.
    if (googleOutage && url.pathname === '/google/status') return new Response('<html>Service Unavailable</html>', { status: 503 });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === '/commands' && body) posted.push(delegationCommandSchema.parse(body));
    const response = await w.request(url.pathname + url.search, body, new Headers(init?.headers).get('authorization') ?? '');
    return new Response(response.body, { status: response.statusCode });
  };
  const runtime = createDelegationRuntime({ databaseGate: { withDatabase: async fn => fn(db) }, pairing: { ...w.pair, endpoint: `https://${w.host}` }, clock, fetch: http });
  const forbidden = vi.fn(async (): Promise<never> => { throw Error('Unrequested outbound operation'); });
  const removeIpc = registerOutreachIpc({ provider: { status: forbidden, configure: forbidden, connectGmail: forbidden, disconnectGmail: forbidden, openDraft: forbidden, saveDraft: forbidden, generateDraft: forbidden, sendDraft: forbidden, inspectLocalAuthority: forbidden }, delegation: runtime, isTrustedRendererUrl: url => url === 'app://intake' });
  const bridge = createCallieApi({ invoke: async (channel, ...args) => { const registered = ipc.handlers.get(channel); if (!registered) throw Error('Missing IPC'); return registered({ senderFrame: { url: 'app://intake' } }, ...args); } });
  const services = createDomainServices({ database: db, clock, ids: { next: randomUUID }, expectedWorkspaceId: workspaceId });
  const ui = nativeDeskFixture(services.daily.get());
  ui.setConfiguration({ ...configuredFixtureStatus(), workspaceId });
  ui.api.daily.get = vi.fn(async () => services.daily.get());
  // Only the bridge methods this outcome needs are real. Sync/submit from the UI stay forbidden.
  vi.spyOn(ui.api.delegation, 'sync').mockImplementation(forbidden);
  vi.spyOn(ui.api.delegation, 'submit').mockImplementation(forbidden);
  Object.assign(ui.api.delegation, { getAccountPreparation: bridge.delegation.getAccountPreparation, configureIntake: bridge.delegation.configureIntake, googleConnections: bridge.delegation.googleConnections });
  const configureCommands = () => posted.filter((command): command is Extract<DelegationCommand, { kind: 'configure-owner' }> => command.kind === 'configure-owner');
  return { ...ui, db, owner, services, runtime, bridge, forbidden, posted, paths, configureCommands, workspaceId,
    setOffline: (value: boolean) => { offline = value; },
    setGoogleOutage: (value: boolean) => { googleOutage = value; },
    identities: () => [...new Set(configureCommands().map(command => command.commandId))],
    async close() { removeIpc(); await runtime.dispose(); closeDatabase(db); key.bytes.fill(0); temp.cleanup(); } };
}
type Desktop = Awaited<ReturnType<typeof desktop>>;

// The controls belong to one read: the parent hides its result while a new read is in flight, so the
// nested section unmounts and remounts per read. Always re-acquire it.
const panel = () => within(screen.getByRole('region', { name: 'Intake configuration' }));
const button = (name: string) => panel().getByRole('button', { name }) as HTMLButtonElement;
/** The Campaigns surface, one company reviewed, then the explicit intake read. */
async function openIntake(w: Worker, d: Desktop) {
  render(<PresentationRoot><NativeDeskRoute api={d.api} firstUse={d.firstUse} surface="campaigns" onOpenLead={vi.fn()} onOpenImport={vi.fn()} /></PresentationRoot>);
  fireEvent.click(await screen.findByRole('button', { name: 'New call campaign' }));
  fireEvent.change(screen.getByLabelText('Company'), { target: { value: w.accountId } });
  fireEvent.click(screen.getByRole('button', { name: 'Review worker preparation' }));
  const read = screen.getByRole<HTMLButtonElement>('button', { name: 'Read intake configuration' });
  await waitFor(() => expect(read.disabled).toBe(false));
  expect(d.paths).toEqual([]);
  fireEvent.click(read);
  await screen.findByText('Intake configuration exists.');
  await screen.findByRole('region', { name: 'Intake configuration' });
  return { read };
}
async function reread(read: HTMLButtonElement, expected: string) {
  fireEvent.click(read);
  await screen.findByText(expected);
  await screen.findByRole('region', { name: 'Intake configuration' });
}

it('offers pause, relevant mail and calendar controls only after the explicit intake read, reading the grant and nothing else', async () => {
  const w = await worker('paused-no-mail'), d = await desktop(w);
  try {
    await openIntake(w, d);
    expect(screen.getByText('Configuration revision: 1. State: paused.')).toBeTruthy();
    // The grant is read from the owner (stored record, no provider call) so the mail control can be offered honestly.
    await panel().findByText(`Mailbox: ${w.grantEmail}.`, { exact: false });
    expect(d.paths).toEqual(['/accounts/preparation', '/google/status']);
    expect(button('Set intake active').disabled).toBe(false);
    // Relevant mail needs an explicit start date; a future date is never accepted.
    const mail = button('Switch on relevant mail');
    expect(mail.disabled).toBe(true);
    fireEvent.change(panel().getByLabelText('Read relevant mail since'), { target: { value: '2999-01-01' } });
    expect(mail.disabled).toBe(true);
    fireEvent.change(panel().getByLabelText('Read relevant mail since'), { target: { value: '2026-09-01' } });
    expect(mail.disabled).toBe(false);
    expect(button(`Use calendar ${w.calendarId}`).disabled).toBe(true);
    expect(panel().getByText('A configured mailbox is required before a calendar can be used.')).toBeTruthy();
    expect(panel().getByText(/Configuration is not readiness; a configured mailbox is not permission to send\./)).toBeTruthy();
    expect(d.configureCommands()).toEqual([]);
    expect(w.providerCallsSinceGrant()).toBe(0);
    expect(d.forbidden).not.toHaveBeenCalled();
  } finally { cleanup(); await d.close(); }
});

it.each([
  ['no-google-client', 'Mail and calendar are not configured on this worker. Call campaigns do not need them.'],
  ['no-google-scope', 'This Mac\'s pairing does not include Google access. Mail and calendar are not available from this app.'],
] as const)('offers no mail or calendar control and no retry when the real worker refuses the status read (%s), saying why once', async (seed, honest) => {
  const w = await worker(seed), d = await desktop(w);
  try {
    await openIntake(w, d);
    expect(screen.getByText('Configuration revision: 1. State: paused.')).toBeTruthy();
    // The real handler answers the status read with its own bounded code (no Google client, or a pairing without
    // google:grant). The panel names that fact once, offers nothing that needs Google, and suggests no retry.
    await panel().findByText(honest);
    expect(d.paths).toEqual(['/accounts/preparation', '/google/status']);
    expect(button('Set intake active').disabled).toBe(false);
    for (const absent of [/could not be read/, /Read intake configuration again/, /Relevant mail is not offered/, /A configured mailbox is required/, /google_unconfigured/, /worker_scope_denied/]) expect(panel().queryByText(absent)).toBeNull();
    expect(panel().queryByRole('button', { name: /Use calendar/ })).toBeNull();
    expect(panel().queryByRole('button', { name: 'Switch on relevant mail' })).toBeNull();
    expect(panel().queryByLabelText('Read relevant mail since')).toBeNull();
    expect(panel().getByText(/Configuration is not readiness; a configured mailbox is not permission to send\./)).toBeTruthy();
    expect(d.configureCommands()).toEqual([]);
    expect(w.providerCallsSinceGrant()).toBe(0);
    expect(d.forbidden).not.toHaveBeenCalled();
  } finally { cleanup(); await d.close(); }
});

it('keeps the retry line for a gateway 5xx without a worker code: a failed status read is not an unconfigured worker', async () => {
  const w = await worker('paused-no-mail'), d = await desktop(w);
  try {
    d.setGoogleOutage(true);
    await openIntake(w, d);
    await panel().findByText('The connected grant could not be read. Read intake configuration again to retry. Relevant mail is not offered.');
    expect(panel().queryByText(/not configured on this worker/)).toBeNull();
    expect(d.paths).toEqual(['/accounts/preparation', '/google/status']);
    expect(button('Set intake active').disabled).toBe(false);
    expect(d.configureCommands()).toEqual([]);
    expect(w.providerCallsSinceGrant()).toBe(0);
  } finally { cleanup(); await d.close(); }
});

it('pauses and resumes intake through one configure-owner command each, preserving mailbox, calendar and research with the revision read bound', async () => {
  const w = await worker('active-mail'), d = await desktop(w);
  try {
    const { read } = await openIntake(w, d);
    expect(screen.getByText('Configuration revision: 1. State: active.')).toBeTruthy();
    await panel().findByText(`This calendar is already configured: ${w.calendarId}.`);
    expect(panel().queryByRole('button', { name: 'Switch on relevant mail' })).toBeNull();
    expect(button(`Use calendar ${w.calendarId}`).disabled).toBe(true);
    const pause = button('Pause intake');
    expect(pause.disabled).toBe(false);
    fireEvent.click(pause);
    await panel().findByText('Intake configuration receipt: applied.');
    // Submit posts once and the following sync flush may re-post the same still-pending identity; the
    // worker answers idempotently. Exactly one command identity exists.
    expect(d.identities()).toHaveLength(1);
    const command = d.configureCommands()[0]!;
    expect(command.payload).toEqual({ expectedConfigurationRevision: 1, mailScope: null, configuration: { version: 1, workspaceId: w.workspaceId, accountId: w.accountId,
      pairingId: w.pair.pairingId, revision: 2, state: 'paused', mailboxSubject: w.mailboxSubject, calendarId: w.calendarId, research: null } });
    expect(command).toMatchObject({ expectedAuthorityGeneration: 1, expectedVersion: w.configureCommand.expectedVersion + 1 });
    expect(await w.stored()).toEqual(command.payload.configuration);
    expect(d.owner.commandStatus(command.commandId)).toMatchObject({ status: 'applied' });
    expect(panel().getByText(/The worker applied revision 2\./)).toBeTruthy();
    // Settled: the next change starts from a fresh explicit read.
    expect(pause.disabled).toBe(true);
    await reread(read, 'Configuration revision: 2. State: paused.');
    const resume = button('Set intake active');
    expect(resume.disabled).toBe(false);
    expect(panel().queryByText('Intake configuration receipt: applied.')).toBeNull();
    fireEvent.click(resume);
    await panel().findByText(/The worker applied revision 3\./);
    expect(d.identities()).toHaveLength(2);
    const second = d.configureCommands().at(-1)!;
    expect(second.payload).toEqual({ expectedConfigurationRevision: 2, mailScope: null, configuration: { ...command.payload.configuration, revision: 3, state: 'active' } });
    expect(await w.stored()).toEqual(second.payload.configuration);
    await reread(read, 'Configuration revision: 3. State: active.');
    expect(w.providerCallsSinceGrant()).toBe(0);
    expect(d.forbidden).not.toHaveBeenCalled();
  } finally { cleanup(); await d.close(); }
});

it('switches relevant mail on once with a start date, planning one scope from the permitted business inbox, then uses the grant calendar without re-scoping', async () => {
  const w = await worker('paused-no-mail'), d = await desktop(w);
  try {
    const { read } = await openIntake(w, d);
    await panel().findByText(`Mailbox: ${w.grantEmail}.`, { exact: false });
    fireEvent.change(panel().getByLabelText('Read relevant mail since'), { target: { value: '2026-09-01' } });
    const mail = button('Switch on relevant mail');
    expect(mail.disabled).toBe(false);
    expect(await w.cursor()).toBeNull();
    fireEvent.click(mail);
    await panel().findByText(/The worker applied revision 2\./);
    expect(d.identities()).toHaveLength(1);
    const first = d.configureCommands()[0]!;
    expect(first.payload).toEqual({ expectedConfigurationRevision: 1, mailScope: { expectedEnvelopeRevision: null, since: '2026-09-01T00:00:00.000Z' }, configuration: { version: 1, workspaceId: w.workspaceId,
      accountId: w.accountId, pairingId: w.pair.pairingId, revision: 2, state: 'active', mailboxSubject: w.mailboxSubject, calendarId: null, research: null } });
    expect(await w.stored()).toEqual(first.payload.configuration);
    // The worker planned exactly one scope from the permitted-source business inbox; the desktop typed none of it.
    const cursor = await w.cursor();
    expect(cursor?.data.scope).toMatchObject({ revision: 1, accountId: w.accountId, mailboxSubject: w.mailboxSubject, participantAddresses: [w.routeEmail], knownThreadIds: [], since: '2026-09-01T00:00:00.000Z' });
    await reread(read, 'Configuration revision: 2. State: active.');
    expect(screen.getByText('Mail: configured. Research: not configured. Calendar: not configured.')).toBeTruthy();
    expect(panel().getByText(/Relevant mail is already on for this company/)).toBeTruthy();
    expect(panel().queryByRole('button', { name: 'Switch on relevant mail' })).toBeNull();
    const calendar = await panel().findByRole('button', { name: `Use calendar ${w.calendarId}` }) as HTMLButtonElement;
    await waitFor(() => expect(calendar.disabled).toBe(false));
    fireEvent.click(calendar);
    await panel().findByText(/The worker applied revision 3\./);
    expect(d.identities()).toHaveLength(2);
    const second = d.configureCommands().at(-1)!;
    expect(second.payload).toEqual({ expectedConfigurationRevision: 2, mailScope: null, configuration: { ...first.payload.configuration, revision: 3, calendarId: w.calendarId } });
    expect(await w.stored()).toEqual(second.payload.configuration);
    expect((await w.cursor())?.data.scope).toEqual(cursor?.data.scope);
    await reread(read, 'Mail: configured. Research: not configured. Calendar: configured.');
    expect(w.providerCallsSinceGrant()).toBe(0);
    expect(d.forbidden).not.toHaveBeenCalled();
  } finally { cleanup(); await d.close(); }
});

it('retries the same change after a lost owner response without a second command identity, and refuses a different change against the pending one', async () => {
  const w = await worker('active-mail'), d = await desktop(w);
  try {
    await openIntake(w, d);
    const pause = button('Pause intake');
    await waitFor(() => expect(pause.disabled).toBe(false));
    d.setOffline(true);
    fireEvent.click(pause);
    // The owner never answered: the local outbox holds one pending command and the receipt is honestly pending.
    await panel().findByText('Intake configuration receipt: pending.');
    const pending = d.owner.pendingCommands().filter(command => command.kind === 'configure-owner');
    expect(pending).toHaveLength(1);
    expect(d.configureCommands()).toEqual([]);
    expect(await w.stored()).toEqual(w.configureCommand.payload.configuration);
    expect(pause.disabled).toBe(true);
    // A different change against the live pending one is refused, never re-issued.
    expect(await d.runtime.configureIntake({ accountId: w.accountId, expectedConfigurationRevision: 1, state: 'active', mailboxSubject: w.mailboxSubject, calendarId: null, mailSince: null }))
      .toEqual({ status: 'held', accountId: w.accountId, expectedConfigurationRevision: 1, reason: 'intake_configuration_conflict' });
    expect(d.owner.pendingCommands().filter(command => command.kind === 'configure-owner')).toEqual(pending);
    d.setOffline(false);
    fireEvent.click(button('Retry same change'));
    await panel().findByText('Intake configuration receipt: applied.');
    expect(d.identities()).toEqual([pending[0]!.commandId]);
    expect(d.owner.getCommand(pending[0]!.commandId)).toEqual(pending[0]);
    expect(await w.stored()).toMatchObject({ revision: 2, state: 'paused', mailboxSubject: w.mailboxSubject, calendarId: w.calendarId });
    expect(panel().queryByRole('button', { name: 'Retry same change' })).toBeNull();
    expect(w.providerCallsSinceGrant()).toBe(0);
  } finally { cleanup(); await d.close(); }
});

it('holds a change whose revision the worker has already moved past, with the worker code verbatim, nothing queued and a fresh read required', async () => {
  const w = await worker('active-mail'), d = await desktop(w);
  try {
    const { read } = await openIntake(w, d);
    const pause = button('Pause intake');
    await waitFor(() => expect(pause.disabled).toBe(false));
    // Between the read and the write this workspace applies revision 2 elsewhere (the calendar is dropped).
    const elsewhere: Extract<OwnerCommand, { kind: 'configure-owner' }> = { commandId: randomUUID(), workspaceId: w.workspaceId, accountId: w.accountId, expectedAuthorityGeneration: 1,
      expectedVersion: d.owner.executionVersion(w.accountId)!, kind: 'configure-owner', payload: { expectedConfigurationRevision: 1, configuration: { ...w.configureCommand.payload.configuration, revision: 2, calendarId: null }, mailScope: null } };
    expect(await d.bridge.delegation.submit(elsewhere)).toMatchObject({ status: 'pending' });
    expect(await d.bridge.delegation.sync()).toMatchObject({ ownerFresh: true });
    expect(d.owner.commandStatus(elsewhere.commandId)).toMatchObject({ status: 'applied' });
    // The founder's pause still binds revision 1 as read: the worker's own rule holds it before anything is queued.
    fireEvent.click(pause);
    await panel().findByText('Intake change held: stale_source_configuration.');
    expect(panel().getByText(/The worker holds a different configuration revision than the one you read\. Nothing was queued\. Read intake configuration again before another change\./)).toBeTruthy();
    expect(d.identities()).toEqual([elsewhere.commandId]);
    expect(d.owner.pendingCommands()).toEqual([]);
    expect(await w.stored()).toEqual(elsewhere.payload.configuration);
    expect(pause.disabled).toBe(true);
    await reread(read, 'Configuration revision: 2. State: active.');
    expect(screen.getByText('Mail: configured. Research: not configured. Calendar: not configured.')).toBeTruthy();
    expect(button('Pause intake').disabled).toBe(false);
    expect(panel().queryByText(/Intake change held/)).toBeNull();
    expect(w.providerCallsSinceGrant()).toBe(0);
  } finally { cleanup(); await d.close(); }
});

it('shows the owner rejection as is when the owner moved on before the retry, re-issues nothing and closes until a fresh read', async () => {
  const w = await worker('active-mail'), d = await desktop(w);
  try {
    await openIntake(w, d);
    const pause = button('Pause intake');
    await waitFor(() => expect(pause.disabled).toBe(false));
    d.setOffline(true);
    fireEvent.click(pause);
    await panel().findByText('Intake configuration receipt: pending.');
    const pending = d.owner.pendingCommands().find(command => command.kind === 'configure-owner')!;
    // The owner moves on without this command: an explicit pause advances the version it expected.
    expect((await w.request('/commands', { commandId: randomUUID(), workspaceId: w.workspaceId, accountId: w.accountId, expectedAuthorityGeneration: pending.expectedAuthorityGeneration, expectedVersion: pending.expectedVersion, kind: 'pause', payload: { reason: 'fictional owner pause' } })).statusCode).toBe(200);
    d.setOffline(false);
    fireEvent.click(button('Retry same change'));
    await panel().findByText('Intake configuration receipt: rejected.');
    expect(panel().getByText('Stale owner command; explicit fresh action required')).toBeTruthy();
    expect(panel().getByText(/This change was rejected\. Nothing changed locally\. Read intake configuration again before another change; nothing is re-issued automatically\./)).toBeTruthy();
    expect(d.owner.commandStatus(pending.commandId)).toMatchObject({ status: 'rejected' });
    expect(d.identities()).toEqual([pending.commandId]);
    // The founder's pause never applied to the configuration; the owner holds revision 1 unchanged.
    expect(await w.stored()).toEqual(w.configureCommand.payload.configuration);
    expect(button('Pause intake').disabled).toBe(true);
    expect(panel().queryByRole('button', { name: 'Retry same change' })).toBeNull();
    expect(w.providerCallsSinceGrant()).toBe(0);
  } finally { cleanup(); await d.close(); }
});

it('holds honestly before queueing when the revision read, the mailbox, the grant, the scope or the calendar would be refused by the worker', async () => {
  const w = await worker('active-mail'), d = await desktop(w);
  try {
    const base: ConfigureAccountIntake = { accountId: w.accountId, expectedConfigurationRevision: 1, state: 'active', mailboxSubject: w.mailboxSubject, calendarId: w.calendarId, mailSince: null };
    const held = (reason: string, expectedConfigurationRevision = 1) => ({ status: 'held', accountId: w.accountId, expectedConfigurationRevision, reason });
    expect(await d.runtime.configureIntake({ ...base, expectedConfigurationRevision: 0, state: 'paused' })).toEqual(held('stale_source_configuration', 0));
    expect(await d.runtime.configureIntake({ ...base, mailboxSubject: 'another-mailbox' })).toEqual(held('intake_mailbox_mismatch'));
    expect(await d.runtime.configureIntake({ ...base, mailSince: '2026-09-01T00:00:00.000Z' })).toEqual(held('intake_mailbox_mismatch'));
    expect(await d.runtime.configureIntake({ ...base, calendarId: 'other@example.test' })).toEqual(held('intake_calendar_unavailable'));
    expect(d.owner.pendingCommands()).toEqual([]); expect(d.configureCommands()).toEqual([]);
    expect(await w.stored()).toEqual(w.configureCommand.payload.configuration);
    expect(w.providerCallsSinceGrant()).toBe(0);
  } finally { await d.close(); }
  const p = await worker('paused-no-mail'), e = await desktop(p);
  try {
    const base: Omit<ConfigureAccountIntake, 'state'> = { accountId: p.accountId, expectedConfigurationRevision: 1, mailboxSubject: null, calendarId: null, mailSince: null };
    const held = (reason: string) => ({ status: 'held', accountId: p.accountId, expectedConfigurationRevision: 1, reason });
    expect(await e.runtime.configureIntake({ ...base, state: 'active', calendarId: p.calendarId })).toEqual(held('no_mail_configuration_conflict'));
    expect(await e.runtime.configureIntake({ ...base, state: 'paused', mailboxSubject: p.mailboxSubject, mailSince: '2026-09-01T00:00:00.000Z' })).toEqual(held('inactive_scope_change'));
    expect(await e.runtime.configureIntake({ ...base, state: 'active', mailboxSubject: 'not-the-grant-subject', mailSince: '2026-09-01T00:00:00.000Z' })).toEqual(held('source_grant_unavailable'));
    expect(await e.runtime.configureIntake({ ...base, state: 'active', mailboxSubject: p.mailboxSubject })).toEqual(held('selected_scope_incomplete'));
    expect(e.owner.pendingCommands()).toEqual([]); expect(e.configureCommands()).toEqual([]);
    expect(await p.stored()).toEqual(p.configureCommand.payload.configuration);
    expect(p.providerCallsSinceGrant()).toBe(0);
  } finally { await e.close(); }
});
