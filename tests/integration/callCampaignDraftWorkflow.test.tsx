// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createCampaignFixture } from '../fixtures/campaignWorkspace';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { createLocalWorkspaceProvider } from '../../src/main/workspace/localWorkspaceProvider';
import { createDelegationRuntime } from '../../src/main/delegation/delegationRuntime';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { openDatabase, closeDatabase } from '../../src/main/db/database';
import { ConditionalCommandHarness } from '../../cloud/lambdas/delegated-worker/test/sdkHarness';
import { WorkerAuth } from '../../cloud/lambdas/delegated-worker/src/workerAuth';
import { createWorkerHandler } from '../../cloud/lambdas/delegated-worker/src/handler';
import { NativeDeskRoute } from '../../src/renderer/features/today/NativeDeskRoute';
import { PresentationRoot } from '../../src/renderer/app/PresentationRoot';
import { nativeDeskFixture } from '../../src/renderer/features/today/nativeDesk.fixture';
import { WorkerCampaignRepository } from '../../cloud/lambdas/delegated-worker/src/workerCampaignRepository';
import { exportSelectedAccountRecord } from '../../src/main/delegation/selectedAccountSnapshot';
import type { AccountRecord } from '../../src/shared/contracts/accountRecordContract';
import { delegationCommandSchema, publicDelegationCommandSchema, type DelegationCommand, type PublicDelegationCommand } from '../../src/shared/contracts/delegationContract';

// The real exporter runs unchanged. One test deliberately hands the runtime a record whose route
// lost its source, which the exporter itself can never produce, to see the worker's exact refusal.
const snapshotModule = vi.hoisted(() => ({ actual: null as typeof import('../../src/main/delegation/selectedAccountSnapshot') | null }));
vi.mock('../../src/main/delegation/selectedAccountSnapshot', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/main/delegation/selectedAccountSnapshot')>();
  snapshotModule.actual = actual;
  return { ...actual, exportSelectedAccountRecord: vi.fn(actual.exportSelectedAccountRecord) };
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
type CampaignCommand = Extract<PublicDelegationCommand, { kind: 'campaign-command' }>;
type RefreshCommand = Extract<DelegationCommand, { kind: 'refresh-selected-account-record' }>;

async function fixture(review = false) {
  vi.stubGlobal('fetch', vi.fn(async () => { throw Error('Unexpected external network'); }));
  const f = await createCampaignFixture();
  let disposeRuntime = async (): Promise<void> => undefined;
  try {
  const services = createDomainServices({ database: f.db, clock: f.clock, ids: { next: randomUUID }, expectedWorkspaceId: f.workspaceId });
  const domain = new FounderSalesDomain({ database: f.db, services, clock: f.clock, ids: { next: randomUUID }, timezone: 'America/New_York' });
  domain.transitionWorkflow({ commandId: randomUUID(), expectedMode: 'legacy', manifestId: randomUUID() });
  const auth = new WorkerAuth({ dynamo: new ConditionalCommandHarness(), tableName: 'fictional-call-campaign', workspaceId: f.workspaceId, clock: f.clock });
  const issued = await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 });
  const pairing = { ...await auth.redeemPairing(issued.code, 'fictional-campaign-device'), endpoint: 'https://campaign.example.invalid' };
  const handler = createWorkerHandler({ auth, host: 'campaign.example.invalid' });
  const paths: string[] = [], campaignAttempts: string[] = [], violations: string[] = [];
  const campaignCommands: CampaignCommand[] = [], refreshCommands: RefreshCommand[] = [];
  let holdCampaign = false, holdRefresh = false, setup = true;
  const http: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); paths.push(url.pathname);
    if (url.origin !== pairing.endpoint || !['/commands', '/events', '/commands/reconcile'].includes(url.pathname)) throw Error('Unexpected fixture endpoint');
    if (url.pathname === '/commands' && init?.body) {
      const raw = JSON.parse(String(init.body));
      if (!setup && raw.kind !== 'campaign-command' && raw.kind !== 'refresh-selected-account-record') { violations.push('unexpected-command'); throw Error('Unexpected UI command'); }
      if (raw.kind === 'refresh-selected-account-record') {
        const command = delegationCommandSchema.parse(raw);
        if (command.kind !== 'refresh-selected-account-record') throw Error('Unexpected record send shape');
        refreshCommands.push(command);
        if (holdRefresh) throw Error('Fictional owner unavailable');
      }
      if (raw.kind === 'campaign-command') {
        const command = publicDelegationCommandSchema.parse(raw);
        const allowed = ['campaign.version', ...(review ? ['campaign.approve', 'campaign.enroll'] : [])];
        if (command.kind !== 'campaign-command' || !allowed.includes(command.payload.kind)) { violations.push('unexpected-campaign-action'); throw Error('Campaign flow attempted an unauthorized action'); }
        campaignCommands.push(command);
        campaignAttempts.push(command.commandId);
        if (holdCampaign) throw Error('Fictional owner unavailable');
      }
    }
    const response = await handler({ version: '2.0', rawPath: url.pathname, rawQueryString: url.search.slice(1), headers: { host: url.host, 'x-forwarded-proto': 'https', authorization: new Headers(init?.headers).get('authorization') ?? '' }, requestContext: { domainName: url.host, http: { method: init?.method ?? 'GET', sourceIp: 'fictional' } }, ...(init?.body ? { body: String(init.body) } : {}) });
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  };
  const runtime = createDelegationRuntime({ databaseGate: { withDatabase: async op => op(f.db) }, pairing, clock: f.clock, fetch: http });
  disposeRuntime = () => runtime.dispose();
  const repository = new DelegationRepository({ database: f.db, workspaceId: f.workspaceId, clock: f.clock });
  await runtime.configure({ expectedRevision: 0, configuration: { version: 1, state: 'active', research: null } });
  expect(await runtime.bootstrap({ commandId: randomUUID(), accountId: f.account.id })).toMatchObject({ status: 'applied' });
  const authority = repository.authority(f.account.id);
  expect(authority).toMatchObject({ owner: 'local', state: 'local' });
  const delegateId = randomUUID();
  await runtime.submit({ commandId: delegateId, workspaceId: f.workspaceId, accountId: f.account.id, expectedAuthorityGeneration: authority!.generation, expectedVersion: repository.executionVersion(f.account.id), kind: 'delegate', payload: { delegationId: randomUUID(), approvedAt: f.now } });
  expect(await runtime.sync()).toMatchObject({ ownerFresh: true, gaps: 0 });
  expect(repository.commandStatus(delegateId)).toMatchObject({ status: 'applied' });
  setup = false;
  const ui = nativeDeskFixture(services.daily.get());
  const forbidden = vi.fn((): never => { throw Error('Draft flow attempted contact, provider or import action'); });
  const refuse = async (): Promise<never> => forbidden();
  const guardMethods = (object: object, allowed: string[] = []) => {
    for (const [name, value] of Object.entries(object)) if (typeof value === 'function' && !allowed.includes(name)) Reflect.set(object, name, refuse);
  };
  for (const namespace of [ui.api.delegation, ui.api.linkedin, ui.api.leads, ui.api.leadDetail]) guardMethods(namespace);
  const local = createLocalWorkspaceProvider({ withDatabase: async op => op(f.db), withDomain: async op => op(domain) });
  guardMethods(local, ['get', 'getCommitments']);
  const api = { ...ui.api, localWorkspace: local,
    daily: { get: async () => services.daily.get() },
    delegation: { ...ui.api.delegation, status: runtime.status, sync: runtime.sync, submit: runtime.submit,
      refreshSelectedAccount: runtime.refreshSelectedAccount, getSelectedAccountFreshness: runtime.getSelectedAccountFreshness },
  };
  const mount = (surface: 'campaigns' | 'today' = 'campaigns') => render(<PresentationRoot><NativeDeskRoute surface={surface} firstUse={ui.firstUse} api={api} /></PresentationRoot>);
  return { ...f, services, domain, repository, runtime, api, auth, mount, forbidden, paths, campaignAttempts, campaignCommands, refreshCommands,
    hold: (value: boolean) => { holdCampaign = value; }, holdRefresh: (value: boolean) => { holdRefresh = value; },
    async finish() { cleanup(); await runtime.dispose(); f.close(); expect(violations).toEqual([]); } };
  } catch (error) {
    await disposeRuntime(); f.close(); throw error;
  }
}

async function enterDraft(companyId: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'New call campaign' }));
  fireEvent.change(screen.getByLabelText('Company'), { target: { value: companyId } });
  fireEvent.change(screen.getByLabelText('Meeting offer'), { target: { value: 'Discuss a simpler maintenance follow-up workflow.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save call campaign draft' }));
}

it('creates a real unapproved owner-applied draft from the Campaigns route and reopens its exact company audience without enrollment', async () => {
  const f = await fixture();
  try {
    const originalIds = new Set(f.services.daily.get().campaigns.map(c => c.version.id));
    const view = f.mount();
    await enterDraft(f.account.id);
    await screen.findByText('Campaign draft saved. Not approved or enrolled.');
    const saved = f.services.daily.get().campaigns.filter(c => !originalIds.has(c.version.id));
    expect(saved).toHaveLength(1);
    const campaign = saved[0]!;
    expect(campaign.version).toMatchObject({ approvedAt: null, cohortAccountIds: [f.account.id], channelCaps: { call: 1, email: 0, linkedin: 0 }, offer: 'Discuss a simpler maintenance follow-up workflow.' });
    expect(campaign.enrollments).toEqual([]);
    expect(campaign.caps).toEqual([]);
    expect(new Set(f.campaignAttempts).size).toBe(1);
    expect(f.repository.commandStatus(f.campaignAttempts[0]!)).toMatchObject({ status: 'applied' });
    expect(f.db.raw.prepare('SELECT COUNT(*) n FROM campaign_enrollments').get()).toEqual({ n: 0 });
    expect(f.db.raw.prepare('SELECT COUNT(*) n FROM delegated_manual_handoffs').get()).toEqual({ n: 0 });
    view.unmount();
    const reopened = f.mount();
    const row = await waitFor(() => {
      const button = reopened.container.querySelector<HTMLButtonElement>(`[data-row-key="campaign:${campaign.version.id}"]`);
      expect(button).toBeTruthy(); return button!;
    });
    fireEvent.click(row);
    const detail = within(reopened.container.querySelector('.native-desk__detail') as HTMLElement);
    expect(detail.getByRole('heading', { name: 'Call campaign draft' })).toBeTruthy();
    expect(detail.getByText(/Explicitly selected company/)).toBeTruthy();
    expect(detail.getByRole<HTMLButtonElement>('button', { name: 'Approve call campaign' }).disabled).toBe(true);
    expect(detail.queryByRole('button', { name: /Enroll|Activate/ })).toBeNull();
    const disk = openDatabase({ path: f.path, key: f.key });
    try {
      const fresh = createDomainServices({ database: disk, clock: f.clock, ids: { next: randomUUID }, expectedWorkspaceId: f.workspaceId }).daily.get();
      expect(fresh.campaigns.find(c => c.version.id === campaign.version.id)).toEqual(campaign);
    } finally { closeDatabase(disk); }
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.paths.every(path => ['/commands', '/events', '/commands/reconcile'].includes(path))).toBe(true);
  } finally { await f.finish(); }
}, 20_000);

async function approveNewDraft(f: Awaited<ReturnType<typeof fixture>>) {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.now));
  f.domain.updateCallSettings({ expectedRevision: 0, newCallSlots: 0, totalCallCapacity: 1 });
  expect(f.services.daily.get().calls.accountIds).toEqual([]);
  const originalIds = new Set(f.services.daily.get().campaigns.map(c => c.version.id));
  const view = f.mount();
  await enterDraft(f.account.id);
  await screen.findByText('Campaign draft saved. Not approved or enrolled.');
  const campaign = f.services.daily.get().campaigns.find(c => !originalIds.has(c.version.id))!;
  fireEvent.click(view.container.querySelector<HTMLButtonElement>(`[data-row-key="campaign:${campaign.version.id}"]`)!);
  const approve = screen.getByRole<HTMLButtonElement>('button', { name: 'Approve call campaign' });
  expect(approve.disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: 'I reviewed this company, offer, call step and lifetime limits' }));
  fireEvent.click(approve);
  await screen.findByText('Call campaign approved. Not enrolled.');
  const approved = f.services.daily.get().campaigns.find(c => c.version.id === campaign.version.id)!;
  expect(approved.version).toEqual({ ...campaign.version, approvedAt: f.now });
  expect(approved.enrollments).toEqual([]);
  expect(f.services.daily.get().calls.accountIds).toEqual([]);
  const commands = [...new Map(f.campaignCommands.map(c => [c.commandId, c])).values()];
  expect(commands.map(c => c.payload.kind)).toEqual(['campaign.version', 'campaign.approve']);
  expect(commands[1].payload).toEqual({ kind: 'campaign.approve', campaignVersionId: campaign.version.id, snapshotHash: campaign.snapshotHash, approvedAt: f.now });
  fireEvent.change(screen.getByRole('combobox', { name: 'Business phone route' }), { target: { value: f.routes[0].id } });
  expect(screen.getByText('Enrollment adds a due manual-call item. It does not dial, send messages, or grant contact permission.')).toBeTruthy();
  const enroll = screen.getByRole<HTMLButtonElement>('button', { name: 'Enroll company for manual call' });
  expect(enroll.disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: 'I want this company added to the manual call queue' }));
  return { view, campaign, enroll };
}

it('separately approves a frozen draft and enrolls its selected published phone into the real Today due queue without calling', async () => {
  const f = await fixture(true);
  try {
    const { view, campaign, enroll } = await approveNewDraft(f);
    fireEvent.click(enroll);
    await screen.findByText('Company enrolled for a manual call. No call placed.');
    const saved = f.services.daily.get().campaigns.find(c => c.version.id === campaign.version.id)!;
    expect(saved.enrollments).toHaveLength(1);
    const selectedRoute = f.services.daily.get().accounts.find(a => a.account.id === f.account.id)!.routes.find(r => r.id === f.routes[0].id)!;
    expect(selectedRoute).toMatchObject({ channel: 'phone', purpose: 'business', verification: 'published', version: 1 });
    expect(saved.enrollments[0]).toMatchObject({ accountId: f.account.id, campaignVersionId: campaign.version.id, selectedRouteId: f.routes[0].id, selectedRouteVersion: selectedRoute.version, state: 'active', version: 1, contextRevision: 1, currentStepId: campaign.version.steps[0].id });
    const commands = [...new Map(f.campaignCommands.map(c => [c.commandId, c])).values()];
    expect(commands.map(c => c.payload.kind)).toEqual(['campaign.version', 'campaign.approve', 'campaign.enroll']);
    expect(commands[2].payload).toMatchObject({ enrollmentId: saved.enrollments[0].id, executionContextId: saved.enrollments[0].executionContextId });
    expect(f.services.daily.get().calls.accountIds).toEqual([f.account.id]);
    expect(saved.caps).toHaveLength(3);
    expect(saved.caps.every(c => c.reserved === 0 && c.sent === 0)).toBe(true);
    expect(f.db.raw.prepare('SELECT COUNT(*) n FROM delegated_manual_handoffs').get()).toEqual({ n: 0 });
    view.unmount();
    f.mount('today');
    await screen.findByRole('button', { name: `Call · ${f.account.name}` });
    expect(f.forbidden).not.toHaveBeenCalled();
    const disk = openDatabase({ path: f.path, key: f.key });
    try {
      expect(createDomainServices({ database: disk, clock: f.clock, ids: { next: randomUUID }, expectedWorkspaceId: f.workspaceId }).daily.get().campaigns.find(c => c.version.id === campaign.version.id)?.enrollments).toEqual(saved.enrollments);
    } finally { closeDatabase(disk); }
  } finally { await f.finish(); }
}, 20_000);

it('reconciles a pending enrollment after route closure with the original identity and no duplicate active enrollment', async () => {
  const f = await fixture(true);
  try {
    const { view, campaign, enroll } = await approveNewDraft(f);
    f.hold(true);
    fireEvent.click(enroll);
    await waitFor(() => expect(f.repository.pendingCommands().filter(c => c.kind === 'campaign-command')).toHaveLength(1));
    expect(f.services.daily.get().campaigns.find(c => c.version.id === campaign.version.id)?.enrollments).toEqual([]);
    const queued = f.campaignCommands.find(c => c.payload.kind === 'campaign.enroll')!;
    view.unmount();
    f.hold(false);
    f.mount();
    fireEvent.click(await screen.findByText('Worker freshness unknown'));
    fireEvent.click(await screen.findByRole('button', { name: 'Reconcile queued commands' }));
    await waitFor(() => expect(f.services.daily.get().campaigns.find(c => c.version.id === campaign.version.id)?.enrollments).toHaveLength(1));
    expect(new Set(f.campaignCommands.filter(c => c.payload.kind === 'campaign.enroll').map(c => c.commandId))).toEqual(new Set([queued.commandId]));
    expect(f.repository.pendingCommands()).toEqual([]);
    expect(f.db.raw.prepare('SELECT COUNT(*) n FROM campaign_enrollments').get()).toEqual({ n: 1 });
    expect(f.db.raw.prepare('SELECT COUNT(*) n FROM delegated_manual_handoffs').get()).toEqual({ n: 0 });
    expect(f.forbidden).not.toHaveBeenCalled();
  } finally { await f.finish(); }
}, 20_000);

it('retains a durable pending draft across route closure and uses existing owner reconciliation without generating a duplicate', async () => {
  const f = await fixture();
  try {
    const originalCount = f.services.daily.get().campaigns.length;
    f.hold(true);
    const first = f.mount();
    await enterDraft(f.account.id);
    await waitFor(() => expect(f.repository.pendingCommands().filter(c => c.kind === 'campaign-command')).toHaveLength(1));
    expect(f.services.daily.get().campaigns).toHaveLength(originalCount);
    expect(screen.queryByText('Campaign draft saved. Not approved or enrolled.')).toBeNull();
    first.unmount();
    f.hold(false);
    f.mount();
    fireEvent.click(await screen.findByText('Worker freshness unknown'));
    fireEvent.click(await screen.findByRole('button', { name: 'Reconcile queued commands' }));
    await waitFor(() => expect(f.services.daily.get().campaigns).toHaveLength(originalCount + 1));
    expect(new Set(f.campaignAttempts).size).toBe(1);
    expect(f.repository.pendingCommands()).toEqual([]);
    expect(f.db.raw.prepare('SELECT COUNT(*) n FROM campaign_enrollments').get()).toEqual({ n: 0 });
    expect(f.forbidden).not.toHaveBeenCalled();
  } finally { await f.finish(); }
}, 20_000);

// Sending the updated saved record: the worker's copy is written once at bootstrap; a route admitted
// locally afterwards never reaches it until the founder explicitly resubmits the current record.
const staleLine = 'The saved record changed since it was sent to the worker.';
const currentLine = 'Worker holds the current saved record.';
const recheckLabel = 'Check worker copy again';
const sendLabel = 'Send updated saved record to worker';
const retrySendLabel = 'Retry same record send';
type RefreshFixture = Awaited<ReturnType<typeof fixture>>;
const workerRecord = async (f: RefreshFixture) => (await f.auth.store.get<AccountRecord>(`ACCOUNT#${f.account.id}`))!.data;
const workerRouteIds = async (f: RefreshFixture) => (await workerRecord(f)).routes.map(route => route.id);
// The transport may POST one queued command more than once (submit, then the outbox flush before events land);
// identity, not attempt count, is what must stay singular.
const sentRecordIds = (f: RefreshFixture) => [...new Set(f.refreshCommands.map(command => command.commandId))];
async function openReview(f: RefreshFixture) {
  const view = f.mount();
  fireEvent.click(await screen.findByRole('button', { name: 'New call campaign' }));
  fireEvent.change(screen.getByLabelText('Company'), { target: { value: f.account.id } });
  const http = f.paths.length;
  fireEvent.click(screen.getByRole('button', { name: 'Review worker preparation' }));
  // The worker-copy line is read locally the moment the panel opens: no click, no HTTP.
  await screen.findByText(staleLine);
  expect(f.paths).toHaveLength(http);
  return view;
}

it('sends the updated saved record to the worker so a locally admitted phone route becomes enrollable', async () => {
  const f = await fixture(true);
  try {
    f.advanceClock(60_000);
    const third = f.admitPhoneRoute('+12025550103');
    // The real seam before any send: the worker's copy stops at bootstrap, so enrollment validation cannot see the new route.
    expect(await workerRouteIds(f)).toEqual(f.routes.map(route => route.id));
    await expect(new WorkerCampaignRepository(f.auth.options).accountRoute(f.account.id, third.id)).rejects.toThrow('campaign_route_mismatch');
    const { campaign } = await approveNewDraft(f);
    const http = f.paths.length;
    fireEvent.click(screen.getByRole('button', { name: 'Review worker preparation' }));
    // The stale line comes from the automatic local read alone: no click, no worker call.
    await screen.findByText(staleLine);
    expect(f.paths).toHaveLength(http);
    expect(screen.queryByText('Worker copy freshness unknown.')).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: recheckLabel }).disabled).toBe(false);
    expect(screen.getByText('Reconcile queued preparation asks the worker what it already holds for queued commands and applies the answer.')).toBeTruthy();
    const send = screen.getByRole<HTMLButtonElement>('button', { name: sendLabel });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await screen.findByText(currentLine);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: sendLabel }).disabled).toBe(true);
    expect(sentRecordIds(f)).toHaveLength(1);
    const sent = f.refreshCommands[0]!;
    expect(sent).toMatchObject({ workspaceId: f.workspaceId, accountId: f.account.id, expectedAuthorityGeneration: 1, payload: { expectedResearchRevision: 1 } });
    expect(sent.expectedVersion).toBeGreaterThan(0);
    expect(sent.payload.record.routes.map(route => route.id)).toEqual([...f.routes.map(route => route.id), third.id]);
    expect(f.repository.commandStatus(sent.commandId)).toMatchObject({ status: 'applied', authorityGeneration: 1, aggregateVersion: sent.expectedVersion + 1 });
    expect(await workerRouteIds(f)).toEqual([...f.routes.map(route => route.id), third.id]);
    expect(await workerRecord(f)).toMatchObject({ researchRevision: 1, account: { version: 3 } });
    // Nothing else changed: ownership, the research cursor and the campaigns are as they were.
    expect(f.repository.authority(f.account.id)).toMatchObject({ owner: 'worker', state: 'active', generation: 1 });
    expect(f.db.raw.prepare("SELECT aggregate_version FROM delegated_event_cursors WHERE account_id=? AND stream='research'").get(f.account.id)).toEqual({ aggregate_version: 1 });
    expect(f.services.daily.get().campaigns.find(c => c.version.id === campaign.version.id)?.enrollments).toEqual([]);
    // The approved campaign can now enroll the third route: the worker validates it against its refreshed copy.
    const dropdown = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Business phone route' });
    expect(Array.from(dropdown.options).map(option => option.value)).toContain(third.id);
    fireEvent.change(dropdown, { target: { value: third.id } });
    const request = screen.getByRole<HTMLInputElement>('checkbox', { name: 'I want this company added to the manual call queue' });
    if (!request.checked) fireEvent.click(request);
    fireEvent.click(screen.getByRole('button', { name: 'Enroll company for manual call' }));
    await screen.findByText('Company enrolled for a manual call. No call placed.');
    const saved = f.services.daily.get().campaigns.find(c => c.version.id === campaign.version.id)!;
    expect(saved.enrollments).toHaveLength(1);
    expect(saved.enrollments[0]).toMatchObject({ accountId: f.account.id, selectedRouteId: third.id, selectedRouteVersion: 1, state: 'active', version: 1 });
    expect(sentRecordIds(f)).toHaveLength(1);
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.paths.every(path => ['/commands', '/events', '/commands/reconcile'].includes(path))).toBe(true);
  } finally { await f.finish(); }
}, 20_000);

it('shows the worker\'s exact route_evidence_missing refusal when a resubmitted route lacks its permitted source, changing nothing', async () => {
  const f = await fixture(true);
  try {
    f.advanceClock(60_000);
    const third = f.admitPhoneRoute('+12025550103');
    const before = await workerRecord(f);
    await openReview(f);
    vi.mocked(exportSelectedAccountRecord).mockImplementationOnce(input => {
      const record = snapshotModule.actual!.exportSelectedAccountRecord(input);
      return { ...record, sources: record.sources.filter(source => source.id !== third.source.id) };
    });
    fireEvent.click(screen.getByRole('button', { name: sendLabel }));
    const rejected = await screen.findByText('route_evidence_missing');
    expect(rejected.closest('[role="status"]')).toBeTruthy();
    expect(sentRecordIds(f)).toHaveLength(1);
    expect(f.refreshCommands[0]!.payload.record.sources.map(source => source.id)).not.toContain(third.source.id);
    expect(f.repository.commandStatus(f.refreshCommands[0]!.commandId)).toEqual({ commandId: f.refreshCommands[0]!.commandId, status: 'rejected', authorityGeneration: 1, aggregateVersion: f.refreshCommands[0]!.expectedVersion + 1, reason: 'route_evidence_missing' });
    expect(await workerRecord(f)).toEqual(before);
    expect(f.repository.pendingCommands()).toEqual([]);
    expect(f.repository.authority(f.account.id)).toMatchObject({ owner: 'worker', state: 'active', generation: 1 });
    // The founder can send again; the honest freshness after a refusal is still stale.
    expect(screen.getByText(staleLine)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: sendLabel }).disabled).toBe(false);
    expect(screen.queryByText(/Record send command:/)).toBeNull();
    expect(f.forbidden).not.toHaveBeenCalled();
  } finally { await f.finish(); }
}, 20_000);

it('shows record_research_stale verbatim when the worker\'s research revision no longer matches the saved record', async () => {
  const f = await fixture(true);
  try {
    f.advanceClock(60_000);
    f.admitPhoneRoute('+12025550103');
    // The worker's copy carries a research revision the desktop has not seen.
    const key = `ACCOUNT#${f.account.id}`; const row = (await f.auth.store.get<AccountRecord>(key))!;
    const drifted = { ...row.data, researchRevision: 2 };
    await f.auth.store.transact([f.auth.store.put(key, drifted, row.rev, { accountId: f.account.id, version: row.data.account.version })]);
    await openReview(f);
    fireEvent.click(screen.getByRole('button', { name: sendLabel }));
    expect((await screen.findByText('record_research_stale')).closest('[role="status"]')).toBeTruthy();
    expect(sentRecordIds(f)).toHaveLength(1);
    expect(f.repository.commandStatus(f.refreshCommands[0]!.commandId)).toMatchObject({ status: 'rejected', reason: 'record_research_stale' });
    expect(await workerRecord(f)).toEqual(drifted);
    expect(f.repository.authority(f.account.id)).toMatchObject({ owner: 'worker', state: 'active', generation: 1 });
    expect(f.repository.pendingCommands()).toEqual([]);
    expect(f.forbidden).not.toHaveBeenCalled();
  } finally { await f.finish(); }
}, 20_000);

it('keeps one command identity across a lost response and resends the exact same record send on explicit retry', async () => {
  const f = await fixture(true);
  try {
    f.advanceClock(60_000);
    const third = f.admitPhoneRoute('+12025550103');
    await openReview(f);
    f.holdRefresh(true);
    fireEvent.click(screen.getByRole('button', { name: sendLabel }));
    await screen.findByText(/Record send command:/);
    const queued = f.repository.pendingCommands().filter(command => command.kind === 'refresh-selected-account-record');
    expect(queued).toHaveLength(1);
    const commandId = queued[0]!.commandId;
    expect(screen.getByText(`Record send command: ${commandId}`)).toBeTruthy();
    expect(f.refreshCommands.length).toBeGreaterThanOrEqual(1);
    expect(f.refreshCommands.every(command => command.commandId === commandId)).toBe(true);
    expect(await workerRouteIds(f)).toEqual(f.routes.map(route => route.id));
    // While the command is pending no new send is offered, only the same one.
    expect(screen.queryByRole<HTMLButtonElement>('button', { name: sendLabel })?.disabled ?? true).toBe(true);
    f.holdRefresh(false);
    fireEvent.click(screen.getByRole('button', { name: retrySendLabel }));
    await screen.findByText(currentLine);
    expect(new Set(f.refreshCommands.map(command => command.commandId))).toEqual(new Set([commandId]));
    expect(f.refreshCommands.length).toBeGreaterThanOrEqual(2);
    expect(f.refreshCommands.every(command => JSON.stringify(command) === JSON.stringify(f.refreshCommands[0]))).toBe(true);
    expect(f.repository.commandStatus(commandId)).toMatchObject({ status: 'applied' });
    expect(f.repository.pendingCommands()).toEqual([]);
    expect(await workerRouteIds(f)).toEqual([...f.routes.map(route => route.id), third.id]);
    expect(screen.queryByText(/Record send command:/)).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: sendLabel }).disabled).toBe(true);
    expect(f.forbidden).not.toHaveBeenCalled();
  } finally { await f.finish(); }
}, 20_000);
