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
import { publicDelegationCommandSchema } from '../../src/shared/contracts/delegationContract';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function fixture() {
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
  let holdCampaign = false, setup = true;
  const http: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); paths.push(url.pathname);
    if (url.origin !== pairing.endpoint || !['/commands', '/events', '/commands/reconcile'].includes(url.pathname)) throw Error('Unexpected fixture endpoint');
    if (url.pathname === '/commands' && init?.body) {
      const raw = JSON.parse(String(init.body));
      if (!setup && raw.kind !== 'campaign-command') { violations.push('unexpected-command'); throw Error('Unexpected UI command'); }
      if (raw.kind === 'campaign-command') {
        const command = publicDelegationCommandSchema.parse(raw);
        if (command.kind !== 'campaign-command' || command.payload.kind !== 'campaign.version') { violations.push('not-draft-version'); throw Error('Draft flow attempted approval, enrollment or outreach'); }
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
    delegation: { ...ui.api.delegation, status: runtime.status, sync: runtime.sync, submit: runtime.submit },
  };
  const mount = () => render(<PresentationRoot><NativeDeskRoute surface="campaigns" firstUse={ui.firstUse} api={api} onOpenLead={forbidden} onOpenImport={forbidden} /></PresentationRoot>);
  return { ...f, services, repository, runtime, api, mount, forbidden, paths, campaignAttempts, hold: (value: boolean) => { holdCampaign = value; },
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
    expect(detail.queryByRole('button', { name: /Approve|Enroll|Activate/ })).toBeNull();
    const disk = openDatabase({ path: f.path, key: f.key });
    try {
      const fresh = createDomainServices({ database: disk, clock: f.clock, ids: { next: randomUUID }, expectedWorkspaceId: f.workspaceId }).daily.get();
      expect(fresh.campaigns.find(c => c.version.id === campaign.version.id)).toEqual(campaign);
    } finally { closeDatabase(disk); }
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.paths.every(path => ['/commands', '/events', '/commands/reconcile'].includes(path))).toBe(true);
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
