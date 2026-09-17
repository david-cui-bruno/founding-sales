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
import { createLinkedInCampaignDraft, describeCallCampaignTemplate, describeLinkedInCampaignTemplate } from '../../src/shared/contracts/callCampaignDraft';
import { publicDelegationCommandSchema, type PublicDelegationCommand } from '../../src/shared/contracts/delegationContract';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
type CampaignCommand = Extract<PublicDelegationCommand, { kind: 'campaign-command' }>;
// A company-level business profile, exactly like the linkedInWorkspace accountLevel case.
// linkedInService rejects /company/ pages, so that is what "company-level" must mean here.
const companyTarget = 'https://www.linkedin.com/in/fictional-campaign-pm';
const offer = 'Discuss a simpler maintenance follow-up workflow.';

// Clean-workspace launch on the real Campaigns route, real SQLite projection and the
// real worker handler. Only the HTTP boundary is a local dispatcher. Nothing is sent.
async function fixture() {
  vi.stubGlobal('fetch', vi.fn(async () => { throw Error('Unexpected external network'); }));
  const f = await createCampaignFixture({ companyLinkedInTarget: companyTarget });
  let disposeRuntime = async (): Promise<void> => undefined;
  try {
  const services = createDomainServices({ database: f.db, clock: f.clock, ids: { next: randomUUID }, expectedWorkspaceId: f.workspaceId });
  const domain = new FounderSalesDomain({ database: f.db, services, clock: f.clock, ids: { next: randomUUID }, timezone: 'America/New_York' });
  domain.transitionWorkflow({ commandId: randomUUID(), expectedMode: 'legacy', manifestId: randomUUID() });
  const auth = new WorkerAuth({ dynamo: new ConditionalCommandHarness(), tableName: 'fictional-linkedin-campaign', workspaceId: f.workspaceId, clock: f.clock });
  const issued = await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 });
  const pairing = { ...await auth.redeemPairing(issued.code, 'fictional-linkedin-device'), endpoint: 'https://linkedin-campaign.example.invalid' };
  const handler = createWorkerHandler({ auth, host: 'linkedin-campaign.example.invalid' });
  const paths: string[] = [], violations: string[] = [];
  const campaignCommands: CampaignCommand[] = [];
  let setup = true;
  const http: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); paths.push(url.pathname);
    if (url.origin !== pairing.endpoint || !['/commands', '/events', '/commands/reconcile'].includes(url.pathname)) throw Error('Unexpected fixture endpoint');
    if (url.pathname === '/commands' && init?.body) {
      const raw = JSON.parse(String(init.body));
      if (!setup && raw.kind !== 'campaign-command') { violations.push(`unexpected-command:${raw.kind}`); throw Error('Unexpected UI command'); }
      if (raw.kind === 'campaign-command') {
        const command = publicDelegationCommandSchema.parse(raw);
        if (command.kind !== 'campaign-command' || !['campaign.version', 'campaign.approve', 'campaign.enroll'].includes(command.payload.kind)) {
          violations.push('unexpected-campaign-action'); throw Error('Campaign flow attempted an unauthorized action');
        }
        campaignCommands.push(command);
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
  const delegateId = randomUUID();
  await runtime.submit({ commandId: delegateId, workspaceId: f.workspaceId, accountId: f.account.id, expectedAuthorityGeneration: authority!.generation, expectedVersion: repository.executionVersion(f.account.id), kind: 'delegate', payload: { delegationId: randomUUID(), approvedAt: f.now } });
  expect(await runtime.sync()).toMatchObject({ ownerFresh: true, gaps: 0 });
  expect(repository.commandStatus(delegateId)).toMatchObject({ status: 'applied' });
  setup = false;
  const ui = nativeDeskFixture(services.daily.get());
  const forbidden = vi.fn((): never => { throw Error('Launch flow attempted contact, provider, LinkedIn or import action'); });
  const refuse = async (): Promise<never> => forbidden();
  const guardMethods = (object: object, allowed: string[] = []) => {
    for (const [name, value] of Object.entries(object)) if (typeof value === 'function' && !allowed.includes(name)) Reflect.set(object, name, refuse);
  };
  // Every LinkedIn bridge method is forbidden: launching must never prepare, open, copy or report.
  for (const namespace of [ui.api.delegation, ui.api.linkedin, ui.api.leads, ui.api.leadDetail]) guardMethods(namespace);
  const local = createLocalWorkspaceProvider({ withDatabase: async op => op(f.db), withDomain: async op => op(domain) });
  guardMethods(local, ['get', 'getCommitments']);
  const api = { ...ui.api, localWorkspace: local,
    daily: { get: async () => services.daily.get() },
    delegation: { ...ui.api.delegation, status: runtime.status, sync: runtime.sync, submit: runtime.submit },
  };
  const mount = (surface: 'campaigns' | 'today' = 'campaigns') => render(<PresentationRoot><NativeDeskRoute surface={surface} firstUse={ui.firstUse} api={api} /></PresentationRoot>);
  return { ...f, services, domain, repository, runtime, api, mount, forbidden, paths, campaignCommands,
    async finish() { cleanup(); await runtime.dispose(); f.close(); expect(violations).toEqual([]); } };
  } catch (error) {
    await disposeRuntime(); f.close(); throw error;
  }
}

function detail(container: HTMLElement) { return within(container.querySelector('.native-desk__detail') as HTMLElement); }
function distinct(f: Awaited<ReturnType<typeof fixture>>) { return [...new Map(f.campaignCommands.map(c => [c.commandId, c])).values()]; }
function counts(f: Awaited<ReturnType<typeof fixture>>) {
  return { enrollments: f.db.raw.prepare('SELECT COUNT(*) n FROM campaign_enrollments').get(), handoffs: f.db.raw.prepare('SELECT COUNT(*) n FROM delegated_manual_handoffs').get(),
    drafts: f.db.raw.prepare('SELECT COUNT(*) n FROM manual_linkedin_drafts').get() };
}

it('launches a one-company LinkedIn campaign from a clean workspace: save, approve, enroll a company-level route, then only preparation is offered', async () => {
  const f = await fixture();
  try {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.now));
    const originalIds = new Set(f.services.daily.get().campaigns.map(c => c.version.id));
    expect(f.services.daily.get().calls.accountIds).toEqual([]);
    const view = f.mount();
    const channel = within(await screen.findByRole('group', { name: 'Channel' }));
    fireEvent.click(channel.getByRole('button', { name: 'New LinkedIn campaign' }));
    expect(channel.getByRole('button', { name: 'New call campaign' }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: f.account.id } });
    fireEvent.change(screen.getByLabelText('Meeting offer'), { target: { value: offer } });
    expect(screen.queryByRole('button', { name: 'Save call campaign draft' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save LinkedIn campaign draft' }));
    await screen.findByText('Campaign draft saved. Not approved or enrolled.');

    // Saved: the exact LinkedIn template, unapproved, owner-applied, no enrollment, no caps.
    const saved = f.services.daily.get().campaigns.filter(c => !originalIds.has(c.version.id));
    expect(saved).toHaveLength(1);
    const campaign = saved[0]!;
    expect(campaign.version).toEqual(createLinkedInCampaignDraft({ campaignId: campaign.version.campaignId, versionId: campaign.version.id, stepId: campaign.version.steps[0]!.id, accountId: f.account.id, offer }));
    expect(campaign.version).toMatchObject({ approvedAt: null, channelCaps: { call: 0, email: 0, linkedin: 1 }, steps: [{ channel: 'linkedin', condition: 'initial', delayHours: 0 }] });
    expect(describeLinkedInCampaignTemplate(campaign.version)?.accountId).toBe(f.account.id);
    expect(describeCallCampaignTemplate(campaign.version)).toBeNull();
    expect(campaign.enrollments).toEqual([]);
    expect(campaign.caps).toEqual([]);
    expect(f.repository.commandStatus(distinct(f)[0]!.commandId)).toMatchObject({ status: 'applied' });

    // Review and explicit approval through the real route.
    fireEvent.click(view.container.querySelector<HTMLButtonElement>(`[data-row-key="campaign:${campaign.version.id}"]`)!);
    const panel = detail(view.container);
    expect(panel.getByRole('heading', { name: 'LinkedIn campaign draft' })).toBeTruthy();
    expect(panel.getByText(/manual-LinkedIn template/)).toBeTruthy();
    expect(panel.getByText('Explicitly selected company: Fictional Campaign PM (' + f.account.id + ').')).toBeTruthy();
    expect(panel.getByText('No active LinkedIn enrollment is available. Creating or enrolling a LinkedIn campaign is not available here.')).toBeTruthy();
    expect(panel.queryByRole('button', { name: 'Approve call campaign' })).toBeNull();
    expect(panel.queryByRole('button', { name: /Prepare LinkedIn note|Open saved LinkedIn note/ })).toBeNull();
    const approve = panel.getByRole<HTMLButtonElement>('button', { name: 'Approve LinkedIn campaign' });
    expect(approve.disabled).toBe(true);
    fireEvent.click(panel.getByRole('checkbox', { name: 'I reviewed this company, offer, LinkedIn step and lifetime limits' }));
    fireEvent.click(approve);
    await screen.findByText('LinkedIn campaign approved. Not enrolled.');
    const approved = f.services.daily.get().campaigns.find(c => c.version.id === campaign.version.id)!;
    expect(approved.version).toEqual({ ...campaign.version, approvedAt: f.now });
    expect(approved.enrollments).toEqual([]);
    expect(panel.getByRole('heading', { name: 'Reviewed LinkedIn campaign' })).toBeTruthy();
    expect(distinct(f).map(c => c.payload.kind)).toEqual(['campaign.version', 'campaign.approve']);
    expect(distinct(f)[1]!.payload).toEqual({ kind: 'campaign.approve', campaignVersionId: campaign.version.id, snapshotHash: campaign.snapshotHash, approvedAt: f.now });

    // Only the company-level LinkedIn route is offered. Neither published phone route is.
    expect(panel.queryByRole('combobox', { name: 'Business phone route' })).toBeNull();
    const routeSelect = panel.getByRole<HTMLSelectElement>('combobox', { name: 'Business LinkedIn route' });
    expect([...routeSelect.options].map(option => option.value)).toEqual(['', f.linkedInRoute!.id]);
    expect(routeSelect.options[1]!.text).toBe(`${companyTarget} (published)`);
    expect(panel.getByText('Enrollment adds a due manual LinkedIn preparation item. It does not send a message, connect, or grant contact permission.')).toBeTruthy();
    fireEvent.change(routeSelect, { target: { value: f.linkedInRoute!.id } });
    const enroll = panel.getByRole<HTMLButtonElement>('button', { name: 'Enroll company for manual LinkedIn note' });
    expect(enroll.disabled).toBe(true);
    fireEvent.click(panel.getByRole('checkbox', { name: 'I want this company added to the manual LinkedIn queue' }));
    fireEvent.click(enroll);
    await screen.findByText('Company enrolled for a manual LinkedIn note. No message sent.');

    // Daily snapshot: one active enrollment at the linkedin step, bound to the company-level route.
    const enrolled = f.services.daily.get().campaigns.find(c => c.version.id === campaign.version.id)!;
    expect(enrolled.enrollments).toHaveLength(1);
    const selectedRoute = f.services.daily.get().accounts.find(a => a.account.id === f.account.id)!.routes.find(r => r.id === f.linkedInRoute!.id)!;
    expect(selectedRoute).toMatchObject({ channel: 'linkedin', personId: null, purpose: 'business', verification: 'published', value: companyTarget });
    expect(enrolled.enrollments[0]).toMatchObject({ accountId: f.account.id, campaignVersionId: campaign.version.id, selectedRouteId: f.linkedInRoute!.id, selectedRouteVersion: selectedRoute.version,
      personId: null, state: 'active', version: 1, contextRevision: 1, currentStepId: campaign.version.steps[0]!.id });
    expect(enrolled.version.steps.find(s => s.id === enrolled.enrollments[0]!.currentStepId)?.channel).toBe('linkedin');
    expect(distinct(f).map(c => c.payload.kind)).toEqual(['campaign.version', 'campaign.approve', 'campaign.enroll']);
    expect(distinct(f)[2]!.payload).toMatchObject({ kind: 'campaign.enroll', selectedRouteId: f.linkedInRoute!.id, enrollmentId: enrolled.enrollments[0]!.id, executionContextId: enrolled.enrollments[0]!.executionContextId });
    // Nothing reserved, nothing sent, no phone handoff, no call due, no note generated.
    expect(enrolled.caps).toHaveLength(3);
    expect(enrolled.caps.every(c => c.reserved === 0 && c.sent === 0)).toBe(true);
    expect(f.services.daily.get().calls.accountIds).toEqual([]);
    expect(counts(f)).toEqual({ enrollments: { n: 1 }, handoffs: { n: 0 }, drafts: { n: 0 } });

    // The existing PR #57 preparation flow now offers this enrollment. It has not been invoked.
    const preparation = within(panel.getByRole('region', { name: 'Manual LinkedIn preparation' }));
    await waitFor(() => expect(preparation.getByRole<HTMLButtonElement>('button', { name: 'Prepare LinkedIn note' }).disabled).toBe(false));
    expect(preparation.getByText('Fictional Campaign PM')).toBeTruthy();
    expect(preparation.queryByText(/No active LinkedIn enrollment is available/)).toBeNull();
    expect(panel.queryByText('The exact business LinkedIn route or enrollment is unavailable.')).toBeNull();
    expect(panel.getByRole<HTMLButtonElement>('button', { name: 'Enroll company for manual LinkedIn note' }).disabled).toBe(true);
    expect(f.forbidden).not.toHaveBeenCalled();

    view.unmount();
    f.mount('today');
    await screen.findByTestId('native-desk');
    expect(screen.queryByRole('button', { name: `Call · ${f.account.name}` })).toBeNull();
    const disk = openDatabase({ path: f.path, key: f.key });
    try {
      const fresh = createDomainServices({ database: disk, clock: f.clock, ids: { next: randomUUID }, expectedWorkspaceId: f.workspaceId }).daily.get();
      expect(fresh.campaigns.find(c => c.version.id === campaign.version.id)).toEqual(enrolled);
    } finally { closeDatabase(disk); }
    expect(f.paths.every(path => ['/commands', '/events', '/commands/reconcile'].includes(path))).toBe(true);
  } finally { await f.finish(); }
}, 30_000);

it('does not offer the company-level LinkedIn route for a call campaign enrollment on the same account', async () => {
  const f = await fixture();
  try {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.now));
    const originalIds = new Set(f.services.daily.get().campaigns.map(c => c.version.id));
    const view = f.mount();
    fireEvent.click(await screen.findByRole('button', { name: 'New call campaign' }));
    expect(screen.getByRole('button', { name: 'New LinkedIn campaign' }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: f.account.id } });
    fireEvent.change(screen.getByLabelText('Meeting offer'), { target: { value: offer } });
    fireEvent.click(screen.getByRole('button', { name: 'Save call campaign draft' }));
    await screen.findByText('Campaign draft saved. Not approved or enrolled.');
    const campaign = f.services.daily.get().campaigns.find(c => !originalIds.has(c.version.id))!;
    expect(campaign.version.channelCaps).toEqual({ call: 1, email: 0, linkedin: 0 });
    fireEvent.click(view.container.querySelector<HTMLButtonElement>(`[data-row-key="campaign:${campaign.version.id}"]`)!);
    const panel = detail(view.container);
    fireEvent.click(panel.getByRole('checkbox', { name: 'I reviewed this company, offer, call step and lifetime limits' }));
    fireEvent.click(panel.getByRole('button', { name: 'Approve call campaign' }));
    await screen.findByText('Call campaign approved. Not enrolled.');
    const routeSelect = panel.getByRole<HTMLSelectElement>('combobox', { name: 'Business phone route' });
    expect([...routeSelect.options].map(option => option.value)).toEqual(['', f.routes[0]!.id, f.routes[1]!.id]);
    expect([...routeSelect.options].some(option => option.value === f.linkedInRoute!.id || option.text.includes('linkedin.com'))).toBe(false);
    expect(panel.queryByRole('combobox', { name: 'Business LinkedIn route' })).toBeNull();
    expect(counts(f)).toEqual({ enrollments: { n: 0 }, handoffs: { n: 0 }, drafts: { n: 0 } });
    expect(f.forbidden).not.toHaveBeenCalled();
  } finally { await f.finish(); }
}, 30_000);
