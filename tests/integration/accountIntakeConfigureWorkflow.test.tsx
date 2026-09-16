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

type Seed = 'active-mail' | 'paused-no-mail';
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
  const google = new RemoteGoogleAuthorization({ auth, fetch: provider, config: { clientId: 'fictional.apps.googleusercontent.com', clientSecret: 'fictional', redirectUri: `https://${host}/oauth/callback`, encryptionKey: Buffer.alloc(32, 8) } });
  const pair = await auth.redeemPairing((await auth.issuePairing({ scopes: ['commands:write', 'events:read', 'google:grant'], expiresInSeconds: 300 })).code, 'fictional');
  const grant = await google.beginGoogleGrant(pair.pairingId, ['relevant_read', 'availability', 'event_write'], { confirmed: true, ownedCalendarId: calendarId, conflictCalendarIds: [calendarId] });
  await google.completeGoogleGrant(new URL(grant.authorizationUrl).searchParams.get('state')!, 'fictional');
  const grantCalls = providerCalls.length;
  const handler = createWorkerHandler({ auth, host, google });
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
    identities: () => [...new Set(configureCommands().map(command => command.commandId))],
    async close() { removeIpc(); await runtime.dispose(); closeDatabase(db); key.bytes.fill(0); temp.cleanup(); } };
}
type Desktop = Awaited<ReturnType<typeof desktop>>;

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
  const panel = within(await screen.findByRole('region', { name: 'Intake configuration' }));
  return { read, panel };
}

it('offers pause, relevant mail and calendar controls only after the explicit intake read, reading the grant and nothing else', async () => {
  const w = await worker('paused-no-mail'), d = await desktop(w);
  try {
    const { panel } = await openIntake(w, d);
    expect(screen.getByText('Configuration revision: 1. State: paused.')).toBeTruthy();
    // The grant is read from the owner (stored record, no provider call) so the mail control can be offered honestly.
    await panel.findByText(`Mailbox: ${w.grantEmail}.`, { exact: false });
    expect(d.paths).toEqual(['/accounts/preparation', '/google/status']);
    expect(panel.getByRole<HTMLButtonElement>('button', { name: 'Set intake active' }).disabled).toBe(false);
    // Relevant mail needs an explicit start date; a future date is never accepted.
    const mail = panel.getByRole<HTMLButtonElement>('button', { name: 'Switch on relevant mail' });
    expect(mail.disabled).toBe(true);
    fireEvent.change(panel.getByLabelText('Read relevant mail since'), { target: { value: '2999-01-01' } });
    expect(mail.disabled).toBe(true);
    fireEvent.change(panel.getByLabelText('Read relevant mail since'), { target: { value: '2026-09-01' } });
    expect(mail.disabled).toBe(false);
    const calendar = panel.getByRole<HTMLButtonElement>('button', { name: `Use calendar ${w.calendarId}` });
    expect(calendar.disabled).toBe(true);
    expect(panel.getByText('A configured mailbox is required before a calendar can be used.')).toBeTruthy();
    expect(panel.getByText(/Configuration is not readiness; a configured mailbox is not permission to send\./)).toBeTruthy();
    expect(d.configureCommands()).toEqual([]);
    expect(w.providerCallsSinceGrant()).toBe(0);
    expect(d.forbidden).not.toHaveBeenCalled();
  } finally { cleanup(); await d.close(); }
});
