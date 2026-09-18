// @vitest-environment jsdom
const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: electron }));
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPmFixture } from '../fixtures/pmAccounts';
import { createTestWorkspaceKey } from '../fixtures/tempDatabase';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';
import { openDatabase, closeDatabase } from '../../src/main/db/database';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { AccountRoutePolicyStore, type RoutePolicyReceipt } from '../../src/main/delegation/accountRoutePolicyStore';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { ExecutionClient } from '../../src/main/delegation/executionClient';
import { SqlDelegationTransport } from '../../src/main/delegation/delegationSync';
import { exportSelectedAccountRecord } from '../../src/main/delegation/selectedAccountSnapshot';
import { createDelegationRuntime } from '../../src/main/delegation/delegationRuntime';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { LegacyWorkflowTransition } from '../../src/main/domain/workspace/legacyWorkflowTransition';
import { createPhoneHandoffLauncher } from '../../src/main/communications/phoneHandoffLauncher';
import { createLocalWorkspaceProvider } from '../../src/main/workspace/localWorkspaceProvider';
import { registerLocalWorkspaceIpc } from '../../src/main/workspace/registerLocalWorkspaceIpc';
import { registerDailyIpc } from '../../src/main/today/registerDailyIpc';
import { registerPhoneSetupIpc } from '../../src/main/communications/registerPhoneSetupIpc';
import { registerOutreachIpc } from '../../src/main/ipc/registerOutreachIpc';
import { AccountCallbackRepository } from '../../src/main/domain/callbacks/accountCallbackRepository';
import { AccountNeverCallRepository } from '../../src/main/domain/callbacks/accountNeverCall';
import { createCallieApi } from '../../src/preload/createCallieApi';
import { ConditionalCommandHarness } from '../../cloud/lambdas/delegated-worker/test/sdkHarness';
import { WorkerAuth } from '../../cloud/lambdas/delegated-worker/src/workerAuth';
import { RemoteGoogleAuthorization } from '../../cloud/lambdas/delegated-worker/src/remoteGoogleAuthorization';
import { googleScopes } from '../../cloud/lambdas/delegated-worker/src/googleGrantCapabilities';
import { createWorkerHandler } from '../../cloud/lambdas/delegated-worker/src/handler';
import { DynamoExecutionRepository } from '../../cloud/lambdas/delegated-worker/src/executionRepository';
import { DynamoStore, fingerprint } from '../../cloud/lambdas/delegated-worker/src/dynamoStore';
import { delegationCommandSchema, type DelegationCommand } from '../../src/shared/contracts/delegationContract';
import { listDelegatedActualCallAccountIds } from '../../src/main/domain/today/todayActualCallEvidence';
import { resolveLocalDayInterval } from '../../src/main/domain/today/todayOrdering';
import { prepareManualCommandSchema } from '../../src/shared/contracts/ownerCommandContract';
import { createCallCampaignDraft } from '../../src/shared/contracts/callCampaignDraft';
import type { OutreachApi } from '../../src/shared/contracts/outreachContract';
import type { PhoneSetupApi } from '../../src/shared/contracts/phoneSetupContract';
import { NativeDeskRoute } from '../../src/renderer/features/today/NativeDeskRoute';
import { PresentationRoot } from '../../src/renderer/app/PresentationRoot';
import { firstUseFixture } from '../../src/renderer/features/today/nativeDesk.fixture';

const now = '2026-09-08T14:00:00.000Z';
const target = '+14015550100';
const offer = 'Review a fictional company property-management workflow.';
const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(now)); vi.stubGlobal('fetch', vi.fn(async () => { throw Error('Real network forbidden'); })); });
afterEach(async () => { cleanup(); for (const close of cleanups.splice(0).reverse()) await close(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function fixture(options: { policy?: boolean; native?: boolean; inbound?: boolean; lostReply?: boolean; lostReport?: boolean; setupReady?: boolean } = {}) {
  const local = await createPmFixture();
  let database = local.db;
  cleanups.push(() => { if (database !== local.db) closeDatabase(database); local.close(); });
  const clock = { now: () => new Date().toISOString() };
  const workspaceId = randomUUID();
  const repo = new AccountRepository({ database, clock, ids: { next: randomUUID }, sourcePolicy: { attest: source => source.url === 'https://example.invalid/team' } });
  const account = repo.create({ commandId: randomUUID(), name: 'Fictional Phone PM', domain: null });
  repo.admitEvidence({ commandId: randomUUID(), accountId: account.id, expectedVersion: 1,
    claims: [{ key: 'residential_scope', kind: 'fact', value: 'Residential property management', evidenceIds: ['source'] }, { key: 'operating_footprint', kind: 'fact', value: 'Regional operator', evidenceIds: ['source'] }],
    sources: [{ id: 'source', url: 'https://example.invalid/team', fetchedAt: now, sha256: 'a'.repeat(64), excerpt: `Business switchboard: ${target}. Fictional residential operator and separate compliance evidence.`, permitted: true }],
    routes: [{ id: 'route', accountId: account.id, personId: null, channel: 'phone', value: target, purpose: 'business', evidenceIds: ['source'], verification: 'published' }, { id: 'later-route', accountId: account.id, personId: null, channel: 'phone', value: '+14015550101', purpose: 'business', evidenceIds: ['source'], verification: 'published' }] });
  const savedAccount = repo.snapshot(account.id, now);
  const policy: RoutePolicyReceipt = { id: randomUUID(), accountId: account.id, routeId: 'route', routeVersion: 1, canonicalTarget: target, evidenceFingerprint: savedAccount.fingerprint,
    revision: 1, evidenceRef: 'source', evidenceIds: ['source'], provenance: 'fictional-compliance-attestor', observedAt: now, effectiveAt: now, expiresAt: '2026-09-09T14:00:00.000Z',
    policy: { contact: { kind: 'phone', normalizedValue: target, validationState: 'valid', evidence: { federalStatus: 'verified_clear', tcpaFlag: false, coveredAreaCode: '401', source: 'ftc_download', scrubbedAt: now, expiresAt: '2026-10-01T00:00:00.000Z' } }, jurisdiction: { regionCode: 'RI', timezone: 'America/New_York', reviewAt: null }, clearance: { decision: 'allowed', registrationConfirmed: true, stateDncSubscriptionConfirmed: true, consentRuleConfirmed: true, effectiveAt: now, expiresAt: '2026-10-01T00:00:00.000Z' } } };
  if (options.policy !== false) new AccountRoutePolicyStore({ database, clock, admission: { attest: value => value.provenance === policy.provenance && value.evidenceRef === 'source' } }).admit(policy);
  const workerOptions = { dynamo: new ConditionalCommandHarness(), tableName: 'fictional-phone-ui', workspaceId, clock };
  const auth = new WorkerAuth(workerOptions);
  const issued = await auth.issuePairing({ scopes: ['commands:write', 'events:read', 'google:grant'], expiresInSeconds: 300 });
  const pairing = await auth.redeemPairing(issued.code, 'fictional-ui-device');
  const store = new DynamoStore(workerOptions);
  await store.transact([store.put(`ACCOUNT#${account.id}`, exportSelectedAccountRecord({ database, workspaceId, accountId: account.id, asOf: now, researchRevision: 1 }), null)]);
  await new DynamoExecutionRepository(workerOptions).seedLocalAuthority(account.id);
  const repository = new DelegationRepository({ database, workspaceId, clock }); repository.initializeLocalAuthority(account.id);
  const authorization = new RemoteGoogleAuthorization({ auth, config: { clientId: 'fictional.apps.googleusercontent.com', clientSecret: 'fictional', redirectUri: 'https://phone.example.invalid/oauth/callback', encryptionKey: Buffer.alloc(32, 7) }, fetch: async url => {
    if (String(url) === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fictional', refresh_token: 'fictional-refresh', token_type: 'Bearer', expires_in: 3600, scope: `openid email ${googleScopes.relevant_read} ${googleScopes.send}` });
    if (String(url) === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ sub: 'mailbox', email: 'sender@example.invalid', email_verified: true });
    throw Error('Unconfigured fictional Google boundary');
  } });
  const handler = createWorkerHandler({ auth, google: authorization, host: 'phone.example.invalid' });
  const paths: string[] = []; let offline = false;
  const http: typeof fetch = async (input, init) => {
    if (offline) throw Error('Controlled owner offline');
    const url = new URL(String(input)); paths.push(url.pathname);
    const response = await handler({ version: '2.0', rawPath: url.pathname, rawQueryString: url.search.slice(1), headers: { host: url.host, 'x-forwarded-proto': 'https', authorization: new Headers(init?.headers).get('authorization') ?? '' }, requestContext: { domainName: url.host, http: { method: init?.method ?? 'GET', sourceIp: 'fictional' } }, ...(init?.body ? { body: String(init.body) } : {}) });
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  };
  const client = new ExecutionClient({ repository, transport: new SqlDelegationTransport({ database, workspaceId, pairingId: pairing.pairingId, clock }), pairing: { endpoint: 'https://phone.example.invalid', workspaceId, credential: pairing.credential }, fetch: http });
  const apply = async (kind: string, payload: unknown) => {
    const command = delegationCommandSchema.parse({ commandId: randomUUID(), workspaceId, accountId: account.id, expectedAuthorityGeneration: repository.authority(account.id)!.generation, expectedVersion: repository.executionVersion(account.id), kind, payload });
    await client.submit(command); expect((await client.sync(new AbortController().signal)).ownerFresh).toBe(true); expect(repository.commandStatus(command.commandId)?.status).toBe('applied');
  };
  await apply('delegate', { delegationId: randomUUID(), approvedAt: now });
  await apply('configure-owner', { expectedConfigurationRevision: 0, configuration: { version: 1, workspaceId, accountId: account.id, pairingId: pairing.pairingId, revision: 1, state: 'active', mailboxSubject: null, calendarId: null, research: null }, mailScope: null });
  const version = createCallCampaignDraft({ campaignId: 'campaign', versionId: 'campaign-version', stepId: 'call-step', accountId: account.id, offer });
  await apply('campaign-command', { kind: 'campaign.version', version });
  await apply('campaign-command', { kind: 'campaign.approve', campaignVersionId: version.id, snapshotHash: fingerprint(version), approvedAt: now });
  await apply('campaign-command', { kind: 'campaign.enroll', enrollmentId: 'enrollment', campaignVersionId: version.id, selectedRouteId: 'route', executionContextId: 'context', contextRevision: 1 });
  let services = createDomainServices({ database, clock, ids: { next: randomUUID }, expectedWorkspaceId: workspaceId });
  new LegacyWorkflowTransition({ database, unitOfWork: services.unitOfWork, clock, ids: { next: randomUUID } }).transitionWorkflow({ commandId: randomUUID(), manifestId: randomUUID(), expectedMode: 'legacy' });
  const settings = services.workspaceSettings.readMeetingFirstAccountCallSettings();
  services.unitOfWork.immediate(() => services.workspaceSettings.updateMeetingFirstAccountCallSettingsCas({ expectedRevision: settings.revision, newCallSlots: 1, totalCallCapacity: 5, updatedAt: now }));
  let domain = new FounderSalesDomain({ database, services, clock, ids: { next: randomUUID } });
  const nativeUris: string[] = [];
  let capability = options.native !== false;
  const phone = createPhoneHandoffLauncher({ isExcludedNumber: number => number !== target, driver: {
    inspectVerifiedHandler: async () => capability ? 'phone_continuity_verified' : null, isVerifiedHandlerCurrent: () => capability,
    openTelUri: async uri => { expect(database.raw.inTransaction).toBe(false); expect(database.raw.prepare('SELECT consumed_at FROM delegated_manual_handoffs').get()).toEqual({ consumed_at: clock.now() }); nativeUris.push(uri); },
  } });
  const setup: PhoneSetupApi = { status: vi.fn<PhoneSetupApi['status']>(async () => (options.setupReady ?? capability) ? { state: 'configured', candidateFingerprint: 'fictional-helper', confirmedAt: now } : { state: 'unavailable', candidateFingerprint: null, confirmedAt: null }), confirm: async () => { throw Error('No setup mutation'); }, clear: async () => { throw Error('No setup mutation'); } };
  const invocations: { channel: string; args: unknown[] }[] = [];
  const results: { channel: string; result: unknown }[] = [];
  let loseReply = options.lostReply === true;
  let loseReport = options.lostReport === true;
  let corruptHistory = false;
  let runtime: ReturnType<typeof createDelegationRuntime>;
  let unregister: (() => void)[] = [];
  const openPublic = async (initialize = false) => {
    electron.handle.mockClear();
    runtime = createDelegationRuntime({ databaseGate: { withDatabase: async fn => fn(database) }, pairing: { ...pairing, endpoint: 'https://phone.example.invalid' }, clock, fetch: http, phone,
      inboundRegistry: { snapshot: () => ({ initialized: options.inbound !== false, revision: 1, adapters: [runtime.adapter] }) } });
    if (initialize) await runtime.configure({ expectedRevision: 0, configuration: { version: 1, state: 'active', research: null } });
    const forbidden = async (): Promise<never> => { throw Error('Unrelated public effect forbidden'); };
    const outreach: OutreachApi = { status: forbidden, configure: forbidden, connectGmail: forbidden, disconnectGmail: forbidden, openDraft: forbidden, saveDraft: forbidden, generateDraft: forbidden, sendDraft: forbidden, inspectLocalAuthority: forbidden };
    const localProvider = createLocalWorkspaceProvider({ withDatabase: async fn => fn(database), withDomain: async fn => fn(domain) });
    // The real local callback and never-call repositories, exactly as the host wires them.
    const callbackRepository = new AccountCallbackRepository({ database, clock });
    const neverCallRepository = new AccountNeverCallRepository({ database, clock });
    const callbacks = {
      list: async (request: { accountIds: readonly string[] }) => callbackRepository.listOpen(request.accountIds),
      save: async (request: Parameters<AccountCallbackRepository['save']>[0]) => callbackRepository.save(request),
      close: async (request: Parameters<AccountCallbackRepository['close']>[0]) => callbackRepository.close(request),
      neverCall: async (request: Parameters<AccountNeverCallRepository['suppress']>[0]) => neverCallRepository.suppress(request),
    };
    unregister = [registerOutreachIpc({ provider: outreach, delegation: runtime, callbacks }), registerDailyIpc({ get: async () => services.daily.get() }), registerLocalWorkspaceIpc(localProvider), registerPhoneSetupIpc({ provider: setup })];
    return createCallieApi({ invoke: async (channel, ...args) => {
      invocations.push({ channel, args: structuredClone(args) });
      const result = await registeredIpcHandler(electron.handle, channel)({ senderFrame: { url: 'callie://app/index.html' } }, ...args);
      results.push({ channel, result: structuredClone(result) });
      if (channel === 'outreach:delegation-begin-phone' && loseReply) { loseReply = false; throw Error('Lost renderer response after actual consume'); }
      if (channel === 'outreach:delegation-submit' && loseReport) { loseReport = false; throw Error('Lost report response after durable queue'); }
      if (channel === 'outreach:delegation-get-phone-handoff-state' && corruptHistory) {
        if (typeof result !== 'object' || result === null) throw Error('Expected actual phone history object before corruption');
        return { ...result, accountId: 'foreign' };
      }
      return result;
    } });
  };
  const api = await openPublic(true);
  cleanups.push(async () => { unregister.splice(0).reverse().forEach(fn => fn()); await runtime.dispose(); });
  const request = { accountId: account.id, enrollmentId: 'enrollment', stepId: 'call-step' };
  const tables = () => ['persons', 'person_contact_methods', 'sales_cycles'].map(table => database.raw.prepare(`SELECT * FROM ${table}`).all());
  const initialTables = tables();
  expect(readFileSync(database.path).subarray(0, 16).toString()).not.toBe('SQLite format 3\0');
  const beforeUiPaths = paths.length;
  const actualIds = () => {
    const interval = resolveLocalDayInterval({ generatedAt: clock.now(), timezone: services.workspaceSettings.read().timezone });
    return listDelegatedActualCallAccountIds(database, { accountIds: [account.id], from: interval.localDayStartAt, to: interval.localDayEndAt, generatedAt: clock.now() });
  };
  let requestedRouteConfigured = false;
  return { api, firstUse: firstUseFixture(), account, clock, workspaceId, savedAccount, request, paths, beforeUiPaths, nativeUris, invocations, results, initialTables, tables, setup, repository, apply, actualIds,
    store,
    async configureRequestedMailbox(routeOnly = false) {
      // Fixture context uses the real account evidence owner and exporter. The
      // requested-draft UI itself must never create a route or a person.
      if (!requestedRouteConfigured) {
      repo.admitEvidence({ commandId: randomUUID(), accountId: account.id, expectedVersion: 2, sources: [], claims: [],
        routes: [{ id: 'email', accountId: account.id, personId: null, channel: 'email', value: 'published@example.invalid', purpose: 'business', evidenceIds: ['source'], verification: 'published' }] });
      const previous = (await store.get(`ACCOUNT#${account.id}`))!;
      await store.transact([store.put(`ACCOUNT#${account.id}`, exportSelectedAccountRecord({ database, workspaceId, accountId: account.id, asOf: now, researchRevision: 1 }), previous.rev)]);
      requestedRouteConfigured = true;
      }
      if (routeOnly) return;
      const grant = await authorization.beginGoogleGrant(pairing.pairingId, ['send', 'relevant_read']);
      await authorization.completeGoogleGrant(new URL(grant.authorizationUrl).searchParams.get('state')!, 'fictional-code');
      await apply('configure-owner', { expectedConfigurationRevision: 1, configuration: { version: 1, workspaceId, accountId: account.id, pairingId: pairing.pairingId, revision: 2, state: 'active', mailboxSubject: 'mailbox', calendarId: null, research: null }, mailScope: { expectedEnvelopeRevision: null, since: now } });
    },
    db: () => database, runtime: () => runtime, daily: () => services.daily.get(), setOffline(value: boolean) { offline = value; }, setCapability(value: boolean) { capability = value; },
    corruptHistoryReply(value: boolean) { corruptHistory = value; },
    async reopen() {
      unregister.splice(0).reverse().forEach(fn => fn()); await runtime.dispose(); closeDatabase(database);
      const key = createTestWorkspaceKey(); database = openDatabase({ path: local.db.path, key }); key.bytes.fill(0);
      services = createDomainServices({ database, clock, ids: { next: randomUUID }, expectedWorkspaceId: workspaceId });
      domain = new FounderSalesDomain({ database, services, clock, ids: { next: randomUUID } });
      return openPublic();
    },
  };
}
function mount(f: Awaited<ReturnType<typeof fixture>>, api = f.api, surface: 'today' | 'accounts' = 'today') {
  return render(<NativeDeskRoute api={api} firstUse={f.firstUse} surface={surface} />, { wrapper: PresentationRoot });
}
async function selectCall(f: Awaited<ReturnType<typeof fixture>>) {
  fireEvent.click(await screen.findByRole('button', { name: `Call · ${f.account.name}` }));
  await screen.findByRole('button', { name: 'Check owner and review call' });
}
async function reviewAndBegin(f: Awaited<ReturnType<typeof fixture>>) {
  const review = screen.getByRole('button', { name: 'Check owner and review call' });
  await waitFor(() => expect((review as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(review);
  const confirmation = await screen.findByRole('checkbox', { name: 'I confirm the displayed destination and call purpose' });
  await waitFor(() => expect((confirmation as HTMLInputElement).disabled).toBe(false));
  fireEvent.click(confirmation);
  const begin = screen.getByRole('button', { name: 'Call with Phone.app' });
  await waitFor(() => expect((begin as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(begin); fireEvent.click(begin);
  await waitFor(() => expect(f.invocations.filter(call => call.channel === 'outreach:delegation-begin-phone')).toHaveLength(1));
}

it('public UI performs one company-only handoff, preserves exact request and encrypted consumed recovery without person creation', async () => {
  const f = await fixture(); const view = mount(f);
  await selectCall(f);
  const passive = f.invocations.filter(call => /delegation-(begin-phone|submit|sync)$/.test(call.channel));
  expect(passive).toEqual([]); expect(f.paths.length).toBe(f.beforeUiPaths); expect(f.nativeUris).toEqual([]); expect(f.setup.status).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh phone history' })); fireEvent.focus(window);
  await waitFor(() => expect(f.invocations.filter(call => call.channel === 'daily:get').length).toBeGreaterThan(1));
  expect(f.nativeUris).toEqual([]); expect(f.invocations.filter(call => /delegation-(begin-phone|submit|sync)$/.test(call.channel))).toEqual([]);
  await reviewAndBegin(f);
  await waitFor(() => expect(f.nativeUris).toEqual([`tel:${target}`]));
  const begin = f.invocations.find(call => call.channel === 'outreach:delegation-begin-phone')!.args[0] as { command: DelegationCommand; expectedEvidenceFingerprint: string };
  expect(begin).toMatchObject({ expectedEvidenceFingerprint: f.savedAccount.fingerprint, command: { workspaceId: f.workspaceId, accountId: f.account.id, expectedAuthorityGeneration: 1, kind: 'prepare-manual', payload: { channel: 'call', routeId: 'route', routeVersion: 1, targetHash: createHash('sha256').update(target).digest('hex'), contentHash: createHash('sha256').update(offer).digest('hex'), contextRevision: 'context', campaign: { campaignId: 'campaign', campaignRevision: 1, enrollmentId: 'enrollment', enrollmentRevision: 1, stepId: 'call-step' } } } });
  expect(f.tables()).toEqual(f.initialTables);
  expect(f.db().raw.prepare('SELECT * FROM campaign_step_receipts').all()).toEqual([]);
  const history = await f.api.delegation.getPhoneHandoffState(f.request);
  expect(history.attempts[0].handoff?.consumedAt).toBe(now); expect(history.completions).toEqual([]);
  view.unmount(); const api = await f.reopen(); mount(f, api);
  await selectCall(f);
  await waitFor(() => expect(screen.queryByRole('button', { name: /Retry call/i })).toBeNull());
  expect((await api.delegation.getPhoneHandoffState(f.request)).attempts).toEqual(history.attempts);
  expect(f.nativeUris).toHaveLength(1); expect(f.tables()).toEqual(f.initialTables);
});

async function reportObserved(outcome: string) {
  const choice = await screen.findByRole('combobox', { name: 'Observed phone outcome' });
  await waitFor(() => expect((choice as HTMLSelectElement).disabled || choice.closest('fieldset')?.disabled).toBe(false));
  expect((choice as HTMLSelectElement).value).toBe('');
  fireEvent.change(choice, { target: { value: outcome } });
  const local = new Date(Date.parse(now) - new Date(now).getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
  fireEvent.change(screen.getByLabelText('Observed at (local time)'), { target: { value: local } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'I confirm this observed outcome and time' }));
  const button = screen.getByRole('button', { name: 'Record phone outcome' });
  if (outcome === 'opt_out') {
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'I confirm the explicit opt-out and immediate account suppression' }));
  }
  expect((button as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(button); fireEvent.click(button);
}
async function reconcile() {
  const button = screen.getByRole('button', { name: 'Reconcile phone history' });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
}

it('public applied connected report creates one unsent requested draft and resumes the existing editor', async () => {
  const f = await fixture(); const view = mount(f);
  await selectCall(f); await reviewAndBegin(f);
  await waitFor(() => expect(f.nativeUris).toHaveLength(1));
  f.setOffline(true); await reportObserved('connected');
  await waitFor(async () => expect((await f.api.delegation.getPhoneHandoffState(f.request)).completions).toHaveLength(1));
  expect(screen.queryByRole('button', { name: 'Create unsent requested draft' })).toBeNull();
  f.setOffline(false); await reconcile();
  await waitFor(async () => expect((await f.api.delegation.getPhoneHandoffState(f.request)).completions[0].receipt.status).toBe('applied'));
  const create = await screen.findByRole('button', { name: 'Create unsent requested draft' });
  expect((create as HTMLButtonElement).disabled).toBe(true);
  await f.configureRequestedMailbox();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Recipient email' }), { target: { value: 'requested@example.invalid' } });
  await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(create); fireEvent.click(create);
  await screen.findByText(/Draft saved for requested@example.invalid/);
  expect(f.invocations.filter(c => c.channel === 'outreach:requested-followup-prepare')).toHaveLength(1);
  const prepared = (await f.api.daily.get()).answers.find(a => a.kind === 'requested_followup');
  if (prepared?.kind !== 'requested_followup') throw Error('Missing saved requested draft');
  const ref = prepared.draft.originalCall;
  const command = f.db().raw.prepare('SELECT command_json,fingerprint FROM delegated_commands WHERE command_id=?').get(ref.commandId) as { command_json: string; fingerprint: string };
  const event = f.db().raw.prepare('SELECT event_json,fingerprint FROM delegated_applied_events WHERE id=?').get(ref.outcomeEventId) as { event_json: string; fingerprint: string };
  expect(ref.commandFingerprint).toBe(command.fingerprint); expect(ref.commandFingerprint).toBe(fingerprint(JSON.parse(command.command_json)));
  expect(ref.outcomeEventHash).toBe(event.fingerprint); expect(ref.outcomeEventHash).toBe(fingerprint(JSON.parse(event.event_json)));
  expect(prepared.draft).toMatchObject({ recipient: 'requested@example.invalid', recipientBinding: { kind: 'owner_supplied', originalCall: ref }, generation: 'edited', subject: '', body: '' });
  fireEvent.click(await screen.findByRole('button', { name: `Email · ${f.account.name}` }));
  fireEvent.change(screen.getByLabelText('Email subject'), { target: { value: 'Requested information' } });
  fireEvent.change(screen.getByLabelText('Email body'), { target: { value: 'Exact unsent note after our call.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save edits' }));
  await waitFor(() => expect(f.db().raw.prepare('SELECT revision FROM delegated_requested_followup_drafts').get()).toEqual({ revision: 2 }));
  expect(screen.queryByText(/Save unavailable/)).toBeNull();
  expect((screen.getByRole('button', { name: 'Approve email' }) as HTMLButtonElement).disabled).toBe(true);
  view.unmount(); const api = await f.reopen(); mount(f, api);
  fireEvent.click(await screen.findByRole('button', { name: `Email · ${f.account.name}` }));
  expect((screen.getByLabelText('Email subject') as HTMLInputElement).value).toBe('Requested information');
  expect((screen.getByLabelText('Email body') as HTMLTextAreaElement).value).toBe('Exact unsent note after our call.');
  expect(f.nativeUris).toHaveLength(1); expect(f.tables()).toEqual(f.initialTables);
  for (const prefix of ['REQUESTED_APPROVAL#', 'DISPATCH_PERMISSION#', 'MAIL_THREAD#']) expect(await f.store.list(prefix)).toEqual([]);
  expect(f.invocations.filter(c => /requested-followup-approve|generate|send/.test(c.channel))).toEqual([]);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it.each(['no_answer', 'unknown', 'not_called', 'opt_out'] as const)('public observed %s report stays pending offline until owner evidence applies', async outcome => {
  const f = await fixture(); mount(f); await selectCall(f); await reviewAndBegin(f);
  await waitFor(() => expect(f.nativeUris).toHaveLength(1));
  f.setOffline(true); await reportObserved(outcome);
  await waitFor(async () => expect((await f.api.delegation.getPhoneHandoffState(f.request)).completions).toHaveLength(1));
  const pending = await f.api.delegation.getPhoneHandoffState(f.request);
  expect(pending.completions[0]).toMatchObject({ receipt: { status: 'pending' }, applied: null });
  const original = pending.attempts[0].handoff!.value;
  const command = pending.completions[0].command;
  expect(command).toMatchObject({ accountId: f.account.id, workspaceId: f.workspaceId, kind: 'complete-manual', payload: { handoffId: original.handoffId, targetHash: original.targetHash, outcome: { actionId: original.actionId, channel: 'call', outcome, observedAt: now, evidenceRef: command.commandId, replyText: null } } });
  expect(f.invocations.filter(call => call.channel === 'outreach:delegation-submit')).toHaveLength(1);
  expect(f.db().raw.prepare('SELECT * FROM campaign_step_receipts').all()).toEqual([]);
  expect(f.actualIds()).toEqual([]);
  if (outcome === 'opt_out') expect(f.db().raw.prepare('SELECT account_id FROM pm_account_suppression_tombstones WHERE account_id=?').all(f.account.id)).toEqual([{ account_id: f.account.id }]);
  f.setOffline(false); await reconcile();
  await waitFor(async () => expect((await f.api.delegation.getPhoneHandoffState(f.request)).completions[0].receipt.status).toBe('applied'));
  const applied = await f.api.delegation.getPhoneHandoffState(f.request);
  expect(applied.completions[0]).toMatchObject({ command, applied: { outcome: { outcome }, evidence: { routeId: 'route', executionContextId: 'context', contextRevision: 1 } } });
  expect(applied.completions[0].receiptEvent).not.toBeNull();
  expect(f.actualIds()).toEqual(outcome === 'no_answer' ? [f.account.id] : []);

  expect(f.nativeUris).toHaveLength(1); expect(f.tables()).toEqual(f.initialTables);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  if (outcome === 'opt_out') {
    cleanup(); await f.reopen();
    expect(f.db().raw.prepare('SELECT account_id FROM pm_account_suppression_tombstones WHERE account_id=?').all(f.account.id)).toEqual([{ account_id: f.account.id }]);
  }
});

it.each(['pause', 'revoke'] as const)('Worker account history reports original consumed binding after %s and changed stopped enrollment', async stop => {
  const f = await fixture(); const view = mount(f); await selectCall(f); await reviewAndBegin(f);
  await waitFor(() => expect(f.nativeUris).toHaveLength(1));
  await waitFor(async () => expect((await f.api.delegation.getPhoneHandoffState(f.request)).attempts[0].handoff?.consumedAt).toBe(now));
  view.unmount();
  await f.apply('campaign-command', { kind: 'campaign.route', enrollmentId: 'enrollment', expectedEnrollmentVersion: 1, selectedRouteId: 'later-route', contextRevision: 2, executionContextId: 'later-context' });
  await f.apply('campaign-command', { kind: 'campaign.state', enrollmentId: 'enrollment', expectedEnrollmentVersion: 2, state: 'stopped', reason: 'Fictional historical stop' });
  await f.apply(stop, { reason: 'Fictional authority change' });
  await f.api.delegation.configure({ expectedRevision: 1, configuration: { version: 1, state: 'paused', research: null } });
  f.setCapability(false);
  mount(f, f.api, 'accounts');
  const heading = await screen.findByRole('heading', { name: /Worker accounts/ });
  fireEvent.click(within(heading.closest('section')!).getByRole('button', { name: /Fictional Phone PM/ }));
  await reportObserved('no_answer');
  await waitFor(async () => expect((await f.api.delegation.getPhoneHandoffState(f.request)).completions).toHaveLength(1));
  await reconcile();
  await waitFor(async () => expect((await f.api.delegation.getPhoneHandoffState(f.request)).completions[0].receipt.status).toBe('applied'));
  const result = await f.api.delegation.getPhoneHandoffState(f.request);
  expect(result.completions[0].command.expectedAuthorityGeneration).toBe(stop === 'revoke' ? 2 : 1);
  expect(result.completions[0].applied?.evidence).toMatchObject({ routeId: 'route', executionContextId: 'context', contextRevision: 1 });
  expect(f.nativeUris).toHaveLength(1);
});

it.each([{ policy: false }, { inbound: false }, { native: false, setupReady: true }])('real public final handoff holds without native effects for %j', async options => {
  const f = await fixture(options); mount(f); await selectCall(f); await reviewAndBegin(f);
  await waitFor(() => expect(f.results.some(value => value.channel === 'outreach:delegation-begin-phone')).toBe(true));
  expect(f.results.find(value => value.channel === 'outreach:delegation-begin-phone')?.result).toMatchObject({ status: 'held' });
  expect(f.nativeUris).toEqual([]);
  expect(f.db().raw.prepare('SELECT consumed_at FROM delegated_manual_handoffs WHERE consumed_at IS NOT NULL').all()).toEqual([]);
});

it('lost consumed begin reply recovers original history after real encrypted reopen without replacement begin', async () => {
  const f = await fixture({ lostReply: true }); const view = mount(f); await selectCall(f); await reviewAndBegin(f);
  await screen.findByText('Handoff result unknown. Do not redial. Refresh saved phone history.');
  expect(f.nativeUris).toHaveLength(1);
  const original = await f.api.delegation.getPhoneHandoffState(f.request);
  view.unmount(); const api = await f.reopen(); mount(f, api); await selectCall(f);
  await screen.findByText(/One-shot handoff consumed/);
  expect((screen.getByRole('button', { name: 'Check owner and review call' }) as HTMLButtonElement).disabled).toBe(true);
  expect((await api.delegation.getPhoneHandoffState(f.request)).attempts).toEqual(original.attempts);
  expect(f.invocations.filter(call => call.channel === 'outreach:delegation-begin-phone')).toHaveLength(1);
});

it('lost offline human-report reply retains the exact durable command across encrypted reopen and reconciles without replacement', async () => {
  const f = await fixture({ lostReport: true }); const view = mount(f); await selectCall(f); await reviewAndBegin(f);
  await waitFor(() => expect(f.nativeUris).toHaveLength(1)); f.setOffline(true); await reportObserved('no_answer');
  await screen.findByText('Human report result unknown. Its exact command is retained. Reconcile phone history, do not submit a replacement.');
  const pending = await f.api.delegation.getPhoneHandoffState(f.request); expect(pending.completions).toHaveLength(1);
  const command = pending.completions[0].command;
  expect(pending.completions[0].receipt.status).toBe('pending');
  view.unmount(); const api = await f.reopen(); mount(f, api); await selectCall(f);
  await screen.findByText(/Human report queued, awaiting owner-applied evidence/);
  expect((screen.getByRole('button', { name: 'Record phone outcome' }) as HTMLButtonElement).disabled).toBe(true);
  f.setOffline(false); await reconcile();
  await waitFor(async () => expect((await api.delegation.getPhoneHandoffState(f.request)).completions[0].receipt.status).toBe('applied'));
  expect((await api.delegation.getPhoneHandoffState(f.request)).completions[0].command).toEqual(command);
  expect(f.invocations.filter(call => call.channel === 'outreach:delegation-submit')).toHaveLength(1);
  expect(f.nativeUris).toHaveLength(1); expect(f.actualIds()).toEqual([f.account.id]);
});

it('actual preload rejects malformed selectors and crossed history replies without setup, owner sync, or handoff', async () => {
  const f = await fixture(); mount(f); await selectCall(f);
  await screen.findByText(/No saved handoff attempt in this complete local history/);
  const before = f.invocations.length;
  await expect(f.api.delegation.getPhoneHandoffState({ ...f.request, extra: true } as typeof f.request)).rejects.toThrow();
  expect(f.invocations).toHaveLength(before);
  f.corruptHistoryReply(true);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh phone history' }));
  await screen.findByText(/HOLD: last-known phone history is stale/);
  expect(f.invocations.filter(call => /delegation-(begin-phone|submit|sync)$/.test(call.channel))).toEqual([]);
  expect(f.setup.status).not.toHaveBeenCalled(); expect(f.nativeUris).toEqual([]);
});

it('prepared unconsumed expired owner permission stays unresolved with no reporting retry or native action', async () => {
  const f = await fixture();
  const command = prepareManualCommandSchema.parse({ commandId: randomUUID(), workspaceId: f.workspaceId, accountId: f.account.id, expectedAuthorityGeneration: f.repository.authority(f.account.id)!.generation, expectedVersion: f.repository.executionVersion(f.account.id), kind: 'prepare-manual', payload: { actionId: randomUUID(), channel: 'call', routeId: 'route', routeVersion: 1, targetHash: createHash('sha256').update(target).digest('hex'), contentHash: createHash('sha256').update(offer).digest('hex'), contextRevision: 'context', campaign: { campaignId: 'campaign', campaignRevision: 1, enrollmentId: 'enrollment', enrollmentRevision: 1, stepId: 'call-step' } } });
  await f.api.delegation.submit(command); await f.api.delegation.sync();
  const history = await f.api.delegation.getPhoneHandoffState(f.request);
  expect(history.attempts[0].handoff?.consumedAt).toBeNull();
  vi.setSystemTime(new Date(Date.parse(history.attempts[0].handoff!.value.expiresAt) + 1000));
  const before = f.invocations.length; mount(f); await selectCall(f);
  await screen.findByText(/HOLD: prepared handoff expired without a supported local consumption record/);
  expect((screen.getByRole('button', { name: 'Check owner and review call' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Record phone outcome' })).toBeNull();
  expect(screen.queryByRole('button', { name: /retry|reset/i })).toBeNull();
  expect(f.invocations.slice(before).filter(call => /delegation-(begin-phone|submit|sync)$/.test(call.channel))).toEqual([]);
  expect(f.nativeUris).toEqual([]); expect(f.actualIds()).toEqual([]);
});

it('public prewrite zero-row failure retries exactly the retained UUID after mailbox repair', async () => {
  const f = await fixture(); mount(f); await selectCall(f); await reviewAndBegin(f);
  await waitFor(() => expect(f.nativeUris).toHaveLength(1));
  await reportObserved('connected');
  await waitFor(async () => expect((await f.api.delegation.getPhoneHandoffState(f.request)).completions).toHaveLength(1));
  await reconcile();
  await waitFor(async () => expect((await f.api.delegation.getPhoneHandoffState(f.request)).completions[0]?.receipt.status).toBe('applied'));
  await f.configureRequestedMailbox(true); fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  const create = await screen.findByRole('button', { name: 'Create unsent requested draft' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Recipient email' }), { target: { value: 'requested@example.invalid' } });
  await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(create);
  await screen.findByRole('button', { name: 'Refresh saved requested drafts' });
  await waitFor(() => expect(f.invocations.filter(c => c.channel === 'outreach:requested-followup-prepare')).toHaveLength(1));
  expect(f.db().raw.prepare('SELECT count(*) n FROM delegated_requested_followup_drafts').get()).toEqual({ n: 0 });
  const first = f.invocations.find(c => c.channel === 'outreach:requested-followup-prepare')!.args[0] as { draftId?: string };
  await f.configureRequestedMailbox(); fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  const recover = screen.getByRole('button', { name: 'Refresh saved requested drafts' });
  await waitFor(() => expect((recover as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(recover);
  await waitFor(() => expect(f.invocations.filter(c => c.channel === 'outreach:requested-followup-prepare')).toHaveLength(2));
  expect(first.draftId).toMatch(/^[a-f0-9-]{36}$/);
  await screen.findByText(/Draft saved for requested@example.invalid/);
  const calls = f.invocations.filter(c => c.channel === 'outreach:requested-followup-prepare');
  expect(calls).toHaveLength(2); expect(calls[1].args[0]).toEqual(first);
  expect(first.draftId).toMatch(/^[a-f0-9-]{36}$/);
  expect(f.db().raw.prepare('SELECT id,revision FROM delegated_requested_followup_drafts').all()).toEqual([{ id: first.draftId, revision: 1 }]);
  expect(f.invocations.filter(c => /requested-followup-approve|generate|send/.test(c.channel))).toEqual([]);
  expect(f.tables()).toEqual(f.initialTables); expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('the report form names the three connected results in plain words and carries the note into the exact command', async () => {
  const f = await fixture(); mount(f);
  await selectCall(f); await reviewAndBegin(f);
  await waitFor(() => expect(f.nativeUris).toHaveLength(1));
  f.setOffline(true);
  const choice = await screen.findByRole('combobox', { name: 'Observed phone outcome' });
  await waitFor(() => expect((choice as HTMLSelectElement).disabled || choice.closest('fieldset')?.disabled).toBe(false));
  expect([...(choice as HTMLSelectElement).options].map(option => option.textContent)).toEqual([
    'Choose observed outcome', 'Connected', 'No answer', 'Voicemail', 'Busy', 'Wrong number',
    'Connected, interested', 'Connected, not interested', 'Gatekeeper, did not reach them',
    'Cancelled before dialing', 'Not called', 'Unknown', 'Explicit opt-out',
  ]);
  fireEvent.change(choice, { target: { value: 'gatekeeper' } });
  const local = new Date(Date.parse(now) - new Date(now).getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
  fireEvent.change(screen.getByLabelText('Observed at (local time)'), { target: { value: local } });
  fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Front desk took a message for the owner.' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'I confirm this observed outcome and time' }));
  fireEvent.click(screen.getByRole('button', { name: 'Record phone outcome' }));
  await waitFor(async () => expect((await f.api.delegation.getPhoneHandoffState(f.request)).completions).toHaveLength(1));
  const submitted = f.invocations.filter(call => call.channel === 'outreach:delegation-submit');
  expect(submitted).toHaveLength(1);
  expect(submitted[0].args[0]).toMatchObject({ kind: 'complete-manual', payload: { outcome: { channel: 'call', outcome: 'gatekeeper', replyText: 'Front desk took a message for the owner.' } } });
  expect(f.invocations.filter(call => call.channel === 'outreach:callback-save')).toEqual([]);
  expect(f.db().raw.prepare('SELECT count(*) n FROM pm_account_callbacks').get()).toEqual({ n: 0 });
});

it('a promised call-back date is saved locally against the exact report and never dials, sends or books', async () => {
  const f = await fixture(); mount(f);
  await selectCall(f); await reviewAndBegin(f);
  await waitFor(() => expect(f.nativeUris).toHaveLength(1));
  f.setOffline(true);
  const choice = await screen.findByRole('combobox', { name: 'Observed phone outcome' });
  await waitFor(() => expect((choice as HTMLSelectElement).disabled || choice.closest('fieldset')?.disabled).toBe(false));
  fireEvent.change(choice, { target: { value: 'interested' } });
  const local = new Date(Date.parse(now) - new Date(now).getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
  fireEvent.change(screen.getByLabelText('Observed at (local time)'), { target: { value: local } });
  fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Asked me to ring back Monday morning.' } });
  fireEvent.change(screen.getByLabelText('Call back on'), { target: { value: '2026-09-21' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'I confirm this observed outcome and time' }));
  fireEvent.click(screen.getByRole('button', { name: 'Record phone outcome' }));
  await screen.findByText(/Callback saved for 2026-09-21/);
  const saves = f.invocations.filter(call => call.channel === 'outreach:callback-save');
  expect(saves).toHaveLength(1);
  const submitted = f.invocations.find(call => call.channel === 'outreach:delegation-submit')!.args[0] as { commandId: string };
  expect(saves[0].args[0]).toEqual({ accountId: f.account.id, dueOn: '2026-09-21', note: 'Asked me to ring back Monday morning.', sourceCommandId: submitted.commandId });
  expect(f.db().raw.prepare('SELECT account_id,due_on,note,state,revision,source_command_id FROM pm_account_callbacks').all())
    .toEqual([{ account_id: f.account.id, due_on: '2026-09-21', note: 'Asked me to ring back Monday morning.', state: 'open', revision: 1, source_command_id: submitted.commandId }]);
  // One dial, one report, no second handoff and no suppression.
  expect(f.nativeUris).toHaveLength(1);
  expect(f.db().raw.prepare('SELECT count(*) n FROM pm_account_suppression_tombstones').get()).toEqual({ n: 0 });
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('never call writes the account tombstone only after two confirmations and never issues a handoff', async () => {
  const f = await fixture(); mount(f);
  await selectCall(f);
  const reason = await screen.findByLabelText('Why this firm should never be called');
  const button = screen.getByRole('button', { name: 'Never call this firm' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(reason, { target: { value: 'They told me in writing not to contact them again.' } });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  const first = screen.getByRole('checkbox', { name: 'I have read the reason above and it is about this firm' });
  const second = screen.getByRole('checkbox', { name: 'I confirm permanent suppression of this firm' });
  expect((second as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(first);
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(second);
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  expect(f.db().raw.prepare('SELECT count(*) n FROM pm_account_suppression_tombstones').get()).toEqual({ n: 0 });
  fireEvent.click(button);
  await screen.findByText(/Never call recorded at/);
  expect(f.db().raw.prepare('SELECT account_id,source FROM pm_account_suppression_tombstones').all())
    .toEqual([{ account_id: f.account.id, source: 'manual_never_call' }]);
  // Not an outcome and not a call: no handoff was prepared, no number dialed, no owner command queued.
  expect(f.nativeUris).toEqual([]);
  expect(f.invocations.filter(call => /begin-phone|delegation-submit/.test(call.channel))).toEqual([]);
  expect(f.db().raw.prepare('SELECT count(*) n FROM delegated_manual_handoffs').get()).toEqual({ n: 0 });
  expect(f.tables()).toEqual(f.initialTables);
});
