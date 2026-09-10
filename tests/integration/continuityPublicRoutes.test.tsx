// @vitest-environment jsdom
// Stage0 construction plus bounded Stage1 actual-App company acceptance.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react/pure';
import { App } from '../../src/renderer/App';
import type { CalliePreloadApi } from '../../src/shared/preload';
import { localCompanyCreateRequestSchema, localCompanyCreateResultSchema, localCompanyCreateStatusSchema, localCompanyReviewSchema } from '../../src/shared/contracts/localCompanyIntakeContract';

import { appHealthSchema } from '../../src/shared/healthContract';
import { fridayReportSchema } from '../../src/shared/contracts/fridayContract';
import { localCommitmentsSnapshotSchema, localWorkspaceSnapshotSchema, localWorkflowReceiptSchema } from '../../src/shared/contracts/localWorkspaceContract';
import {
  RETAINED_T, RETAINED_O, RETAINED_DISCOVERY,
  CONTINUITY_NOW, CONTINUITY_READ_CHANNELS, CONTINUITY_REGISTERED_CHANNELS, CONTINUITY_URL,
  createContinuityDomainFixture, CONTINUITY_UI_CHANNELS, CONTINUITY_UI_REGISTERED_CHANNELS,
} from '../fixtures/continuityDomainFixture';
import type { RegisteredIpcHandler } from '../fixtures/registeredIpcHandler';

// Only Electron's registration/invoke transport is replaced. No native DB,
// runtime, health result, domain service, readiness gate or provider is mocked.
const transport = vi.hoisted(() => ({
  handlers: new Map<string, RegisteredIpcHandler>(),
  registrations: [] as string[], removals: [] as string[],
}));
vi.mock('electron', () => ({ ipcMain: {
  handle: (channel: string, handler: RegisteredIpcHandler) => {
    if (transport.handlers.has(channel)) throw new Error(`Duplicate handler: ${channel}`);
    transport.registrations.push(channel);
    transport.handlers.set(channel, handler);
  },
  removeHandler: (channel: string) => {
    transport.removals.push(channel);
    transport.handlers.delete(channel);
  },
} }));

type Fixture = Awaited<ReturnType<typeof createContinuityDomainFixture>>;
const fixtures: Fixture[] = [];
let restoreUi: (() => void) | undefined;
async function fixture() {
  const value = await createContinuityDomainFixture(transport.handlers);
  fixtures.push(value);
  return value;
}
async function expectCleaned(value: Fixture) {
  const first = value.dispose();
  expect(value.dispose()).toBe(first);
  expect(await first).toEqual({
    databaseClosed: true, keysZeroed: true, directoryRemoved: true,
    registrationsRemaining: 0, pendingInvocations: 0,
    cleanupRuns: 1, runtimeShutdowns: 1, domainShutdowns: 1, databaseCloses: 1,
    pollerStops: 1, pollerIdleWaits: 1,
  });
  expect(transport.handlers.size).toBe(0);
  expect([...transport.registrations].sort()).toEqual([...CONTINUITY_REGISTERED_CHANNELS].sort());
  expect([...transport.removals].sort()).toEqual([...CONTINUITY_REGISTERED_CHANNELS].sort());
  expect(transport.registrations).toHaveLength(12);
  expect(transport.removals).toHaveLength(12);
  expect(value.counts()).toMatchObject({ credentialLoads: 0, inboxCreations: 0, pollSchedules: 0 });
}
beforeEach(() => {
  expect(transport.handlers.size).toBe(0);
  transport.registrations.length = 0;
  transport.removals.length = 0;
  // Fix time only, matching the accepted construction reference. Native/IPC
  // scheduling remains real. No renderer deadline or poll transitions in Stage0.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(CONTINUITY_NOW));
});
afterEach(async () => {
  const hadUi = !!restoreUi;
  try {
    if (restoreUi) {
      // /pure prevents automatic RTL cleanup from preceding owned cancellation.
      try {
        await act(async () => {
          for (const value of fixtures) value.cancelDelivery();
          for (const value of fixtures) await value.drainInvocations();
        });
      } finally {
        try { cleanup(); } finally { restoreUi(); restoreUi = undefined; vi.useRealTimers(); }
      }
    }
  } finally {
    try {
      for (const value of fixtures.splice(0)) {
        const result = await value.dispose();
        if (hadUi) {
          expect(result).toEqual({ databaseClosed: true, keysZeroed: true, directoryRemoved: true,
            registrationsRemaining: 0, pendingInvocations: 0, cleanupRuns: 1, runtimeShutdowns: 1,
            domainShutdowns: 1, databaseCloses: 1, pollerStops: 1, pollerIdleWaits: 1 });
          expect([...transport.removals].sort()).toEqual([...CONTINUITY_UI_REGISTERED_CHANNELS].sort());
          expect(value.counts()).toMatchObject({ credentialLoads: 0, inboxCreations: 0, pollSchedules: 0 });
        }
      }
    } finally { vi.useRealTimers(); }
  }
});

describe('continuity public boundary construction', () => {
  it('S0.1 constructs one real foundation and serves exact readonly public projections without reinitialization', async () => {
    const value = await fixture();
    // Initialization deliberately writes builtins/settings. Readonly comparison
    // starts after real bootstrap, never against an empty pre-migration file.
    const baseline = await value.evidence();
    expect(baseline.changes).toBeGreaterThan(0);
    expect(baseline).toMatchObject({ accounts: [], accountCommands: [], jobs: [], workflowStates: [], keysZeroed: true });
    expect(value.counts()).toMatchObject({
      keyLoads: 1, preparations: 1, databaseOpens: 1, migrations: 1,
      domainConstructions: 1, domainBootstraps: 1, healthConstructions: 1,
      healthReads: 0, domainEntries: 0, databaseEntries: 0,
    });

    const health = appHealthSchema.parse(await value.api.health.get());
    expect(health).toMatchObject({
      appVersion: 'continuity-stage0', databaseEncrypted: true, fts5Available: true,
      domainStatus: 'ready', domainReady: true, domainBlockingViolationCount: 0,
      domainStartupEvaluatedAt: CONTINUITY_NOW, operationalStatus: 'ready',
    });
    // An unstarted/unprovisioned real poller is honestly healthy with no success
    // yet. This does not prove polling, provider pairing or worker availability.
    expect(health.sourcing).toEqual({
      status: 'healthy', reasons: [], lastSuccessAgeMs: null,
      state: { state: 'idle', pollId: null, startedAt: null, lastCompletedAt: null,
        consecutiveFailures: 0, lastFailureAt: null, lastFailureCode: null, backlogCount: null },
    });
    const overview = localWorkspaceSnapshotSchema.parse(await value.api.localWorkspace.get());
    expect(overview).toEqual({ scope: 'local_database', generatedAt: CONTINUITY_NOW,
      workflowMode: 'legacy', transitionReceipt: null, accounts: { state: 'available', snapshots: [] } });
    const commitments = localCommitmentsSnapshotSchema.parse(await value.api.localWorkspace.getCommitments());
    expect(commitments).toEqual({ scope: 'local_database', generatedAt: CONTINUITY_NOW,
      revision: baseline.changes, reviewErrorCount: 0, items: [] });
    const friday = fridayReportSchema.parse(await value.api.friday.getCurrent());
    expect(friday).toMatchObject({ asOf: CONTINUITY_NOW, jobs: [], revision: baseline.changes });
    expect(friday.metrics.find(metric => metric.id === 'jobs_requested')?.numericValue).toBe(0);
    expect(friday.metrics.find(metric => metric.id === 'jobs_filled')?.numericValue).toBe(0);
    expect(friday.metrics.find(metric => metric.id === 'fill_rate')).toMatchObject({ numericValue: null, numerator: 0, denominator: 0 });
    expect(fridayReportSchema.parse(await value.api.friday.getCurrent({ weekOffset: 0 }))).toEqual(friday);
    expect(appHealthSchema.parse(await value.api.health.get())).toEqual(health);

    expect(value.trace().map(({ channel, args }) => ({ channel, args }))).toEqual([
      { channel: 'health:get', args: [] },
      { channel: 'local-workspace:get', args: [] },
      { channel: 'local-workspace:get-commitments', args: [] },
      { channel: 'friday:get', args: [] },
      { channel: 'friday:get', args: [{ weekOffset: 0 }] },
      { channel: 'health:get', args: [] },
    ]);
    expect(value.trace().every(entry => entry.handlerStarted && entry.outcome === 'resolved')).toBe(true);
    expect(await value.evidence()).toEqual(baseline);
    expect(value.counts()).toEqual({
      keyLoads: 1, preparations: 1, databaseOpens: 1, migrations: 1,
      domainConstructions: 1, domainBootstraps: 1, healthConstructions: 1,
      healthReads: 2, domainEntries: 3, databaseEntries: 1, evidenceReads: 2,
      databaseCloses: 0, domainShutdowns: 0, runtimeShutdowns: 0,
      credentialLoads: 0, inboxCreations: 0, pollSchedules: 0,
      pollerStops: 0, pollerIdleWaits: 0, cleanupRuns: 0,
    });
    await expectCleaned(value);
  });

  it('S0.2 refuses malformed and untrusted reads before provider entry and disposes each resource once', async () => {
    const value = await fixture();
    const baseline = await value.evidence();
    const before = value.counts();
    // The preload rejects this typed-but-invalid value before transport.
    await expect(value.api.friday.getCurrent({ weekOffset: 1 })).rejects.toThrow();
    expect(value.trace()).toHaveLength(0);
    const malformed: { channel: string; args: unknown[] }[] = [
      { channel: 'health:get', args: [undefined] },
      { channel: 'local-workspace:get', args: [undefined] },
      { channel: 'local-workspace:get-commitments', args: [undefined] },
      { channel: 'friday:get', args: [undefined] },
      { channel: 'friday:get', args: [{ weekOffset: 0, extra: true }] },
      { channel: 'friday:get', args: [{ weekOffset: 0 }, { weekOffset: 0 }] },
    ];
    for (const { channel, args } of malformed) {
      await expect(value.invokeFrom(CONTINUITY_URL, channel, ...args)).rejects.toThrow();
    }
    for (const channel of CONTINUITY_READ_CHANNELS) {
      await expect(value.invokeFrom('https://untrusted.invalid/', channel)).rejects.toThrow();
    }
    expect(value.trace()).toHaveLength(10);
    expect(value.trace().every(entry => entry.handlerStarted && entry.outcome === 'rejected')).toBe(true);
    await expect(value.invokeFrom(CONTINUITY_URL, 'stage0:unsupported')).rejects.toThrow('four readonly channels');
    expect(value.trace().at(-1)).toMatchObject({ handlerStarted: false, outcome: 'rejected' });
    expect(value.counts()).toEqual(before);
    expect(before).toMatchObject({ healthReads: 0, databaseEntries: 0, domainEntries: 0,
      keyLoads: 1, preparations: 1, databaseOpens: 1, migrations: 1,
      domainConstructions: 1, domainBootstraps: 1, healthConstructions: 1 });
    expect(await value.evidence()).toEqual(baseline);
    await expectCleaned(value);
    await expect(value.api.localWorkspace.get()).rejects.toThrow('disposed');
    expect(value.counts()).toMatchObject({ healthReads: 0, databaseEntries: 0, domainEntries: 0,
      databaseCloses: 1, domainShutdowns: 1, runtimeShutdowns: 1, cleanupRuns: 1 });
  });
});


const COMPANY = { name: 'Continuity Fictional Company', domain: 'continuity-fictional.example' };
const companyCalls = (value: Fixture) => value.trace().filter(entry => [
  'local-workspace:review-company', 'local-workspace:create-company', 'local-workspace:company-create-status',
].includes(entry.channel));

async function renderCompanyApp() {
  // The inherited beforeEach fakes Date only. Native construction has no fake
  // scheduling. C2 opts into renderer setTimeout only AFTER construction/review.
  const value = await createContinuityDomainFixture(transport.handlers, 'company-ui');
  fixtures.push(value);
  const previousApi = Object.getOwnPropertyDescriptor(window, 'callie');
  const previousUrl = window.location.href;
  const storage = Object.entries(window.localStorage);
  const sessionStorage = Object.entries(window.sessionStorage);
  const actEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  const previousFocus = document.activeElement;
  const theme = document.documentElement.getAttribute('data-theme');
  const density = document.documentElement.getAttribute('data-density');
  restoreUi = () => {
    if (previousApi) Object.defineProperty(window, 'callie', previousApi);
    else Reflect.deleteProperty(window, 'callie');
    window.history.replaceState(null, '', previousUrl);
    if (actEnvironment) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', actEnvironment);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    window.sessionStorage.clear();
    for (const [key, text] of sessionStorage) window.sessionStorage.setItem(key, text);
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    window.localStorage.clear();
    for (const [key, text] of storage) window.localStorage.setItem(key, text);
    for (const [name, text] of [['data-theme', theme], ['data-density', density]]) {
      if (text === null) document.documentElement.removeAttribute(name!);
      else document.documentElement.setAttribute(name!, text!);
    }
  };
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  const deniedAppleCall = async (): Promise<never> => { throw new Error('Stage1 denies Apple spike access'); };
  const completeApi: CalliePreloadApi = { ...value.api, appleSpike: {
    getStatus: deniedAppleCall, probeCapabilities: deniedAppleCall, requestContacts: deniedAppleCall,
    promptAccessibility: deniedAppleCall, scanRecentNotes: deniedAppleCall, scanTestMessages: deniedAppleCall,
    startCallObservation: deniedAppleCall, stopCallObservation: deniedAppleCall, sendTestMessage: deniedAppleCall,
    subscribeObservationEvidence: deniedAppleCall,
  } };
  Object.defineProperty(window, 'callie', { configurable: true, value: completeApi });
  window.history.replaceState(null, '', '#/accounts');
  render(<App />);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Add company' }) as HTMLButtonElement).disabled).toBe(false));
  await act(async () => { await value.drainReads(); });
  expect(screen.getByRole('heading', { name: 'Accounts' })).not.toBeNull();
  expect(value.trace().find(entry => entry.channel === 'health:get')?.result).toMatchObject({ domainReady: true, domainStatus: 'ready' });
  return value;
}
async function navigateCompany(value: Fixture, name: 'Accounts' | 'Campaigns' | 'Leads') {
  const navigation = within(screen.getByRole('navigation', { name: 'Primary' }));
  if (name === 'Leads' && navigation.getByRole('button', { name: 'More workspaces' }).getAttribute('aria-expanded') === 'false') {
    fireEvent.click(navigation.getByRole('button', { name: 'More workspaces' }));
  }
  await act(async () => { fireEvent.click(navigation.getByRole('link', { name })); });
  await act(async () => { await value.drainReads(); });
  expect(window.location.hash).toBe(`#/${name.toLowerCase()}`);
  expect(screen.getByRole(name === 'Leads' ? 'region' : 'heading', { name })).not.toBeNull();
  expect(navigation.getByRole('link', { name }).getAttribute('aria-current')).toBe('page');
}
async function editCompany(value: Fixture) {
  fireEvent.click(screen.getByRole('button', { name: 'Add company' }));
  const name = screen.getByRole('textbox', { name: 'Company name' });
  const domain = screen.getByRole('textbox', { name: 'Company domain (optional)' });
  fireEvent.change(name, { target: { value: COMPANY.name } });
  fireEvent.change(domain, { target: { value: COMPANY.domain } });
  expect(screen.getByRole('textbox', { name: 'Company name' })).toBe(name);
  expect(screen.getByRole('textbox', { name: 'Company domain (optional)' })).toBe(domain);
  expect(companyCalls(value)).toEqual([]);
}
async function reviewCompany(value: Fixture) {
  const name = screen.getByRole('textbox', { name: 'Company name' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Review company' })); await value.drainReads(); });
  expect(screen.getByRole('textbox', { name: 'Company name' })).toBe(name);
  expect((screen.getByRole('button', { name: 'Create company' }) as HTMLButtonElement).disabled).toBe(false);
  const calls = companyCalls(value);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ channel: 'local-workspace:review-company', args: [COMPANY], handlerStarted: true, outcome: 'resolved' });
  expect(localCompanyReviewSchema.parse(calls[0]!.result)).toEqual({ scope: 'local_database', input: COMPANY, candidates: [], complete: true });
}
async function assertCommitted(value: Fixture, request: ReturnType<typeof localCompanyCreateRequestSchema.parse>, result: ReturnType<typeof localCompanyCreateResultSchema.parse>) {
  expect(request).toEqual({ ...COMPANY, commandId: expect.any(String) });
  expect(result.status).toBe('saved');
  if (result.status !== 'saved') throw new Error('Expected real saved company');
  const evidence = await value.companyEvidence(request.commandId);
  expect(evidence.joined).toEqual({ command_id: request.commandId, account_id: result.account.id,
    name: COMPANY.name, domain: COMPANY.domain, version: 1, account_version: 1,
    result_json: JSON.stringify(result.account),
    // Independent canonical object order, not the production fingerprint helper.
    fingerprint: createHash('sha256').update(JSON.stringify({ commandId: request.commandId, domain: COMPANY.domain, kind: 'create', name: COMPANY.name })).digest('hex'),
  });
  expect(evidence.accounts).toEqual([{ id: result.account.id, ...COMPANY, version: 1 }]);
  expect(evidence.commands).toEqual([{ command_id: request.commandId, account_id: result.account.id }]);
  expect(evidence.jobs).toEqual([]);
  return evidence;
}
function assertUiInventory(value: Fixture, expected: Record<string, number>) {
  const actual: Record<string, number> = {};
  for (const entry of value.trace()) actual[entry.channel] = (actual[entry.channel] ?? 0) + 1;
  expect(actual).toEqual(expected);
  for (const entry of value.trace()) {
    if (entry.channel === 'review:list') expect(entry.args).toEqual([{ kinds: [], cursor: null, limit: 1 }]);
    else if (entry.channel === 'leads:list') expect(entry.args).toEqual([{ query: '', stages: [], priorities: [], sort: 'priority', cursor: null, limit: 200 }]);
    else if (entry.channel === 'lead-detail:outbound-capabilities') expect(entry.args).toEqual([{}]);
    else if (!entry.channel.includes('company')) expect(entry.args).toEqual([]);
  }
  expect([...transport.registrations].sort()).toEqual([...CONTINUITY_UI_REGISTERED_CHANNELS].sort());
  expect(value.trace().every(entry => (CONTINUITY_UI_CHANNELS as readonly string[]).includes(entry.channel))).toBe(true);
  expect(value.trace().filter(entry => entry.synthetic).every(entry => entry.channel === 'outreach:delegation-status' && !entry.handlerStarted)).toBe(true);
  expect(value.counts()).toMatchObject({ keyLoads: 1, preparations: 1, databaseOpens: 1, migrations: 1,
    domainConstructions: 1, domainBootstraps: 1, healthConstructions: 1,
    credentialLoads: 0, inboxCreations: 0, pollSchedules: 0 });
  for (const channel of ['health:get', 'local-workspace:get', 'local-workspace:get-commitments', 'daily:get', 'review:list', 'lead-detail:outbound-capabilities']) {
    expect(value.trace().some(entry => entry.channel === channel && entry.handlerStarted && entry.outcome === 'resolved')).toBe(true);
  }
}

describe('company continuity through actual App and local public boundaries', () => {
  it('C1 retains editing and real reviewed company across Campaigns and Leads without replay', async () => {
    const value = await renderCompanyApp();
    const baseline = await value.evidence();
    await editCompany(value);
    for (const route of ['Campaigns', 'Leads', 'Accounts'] as const) await navigateCompany(value, route);
    expect((screen.getByRole('textbox', { name: 'Company name' }) as HTMLInputElement).value).toBe(COMPANY.name);
    expect((screen.getByRole('textbox', { name: 'Company domain (optional)' }) as HTMLInputElement).value).toBe(COMPANY.domain);
    expect(companyCalls(value)).toEqual([]);
    await reviewCompany(value);
    const reviewed = companyCalls(value);
    for (const route of ['Campaigns', 'Leads', 'Accounts'] as const) await navigateCompany(value, route);
    expect((screen.getByRole('textbox', { name: 'Company name' }) as HTMLInputElement).value).toBe(COMPANY.name);
    expect((screen.getByRole('textbox', { name: 'Company domain (optional)' }) as HTMLInputElement).value).toBe(COMPANY.domain);
    expect(screen.getByText(`Reviewed company: ${COMPANY.name} · ${COMPANY.domain}`)).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Create company' }) as HTMLButtonElement).disabled).toBe(false);
    expect(companyCalls(value)).toEqual(reviewed);
    expect(await value.evidence()).toEqual(baseline);
    expect(value.trace().some(entry => entry.channel === 'leads:list' && entry.outcome === 'resolved')).toBe(true);
    assertUiInventory(value, {
      'health:get': 1, 'lead-detail:outbound-capabilities': 1, 'review:list': 7, 'daily:get': 5, 'outreach:delegation-status': 5,
      'local-workspace:get': 5, 'local-workspace:get-commitments': 5, 'leads:list': 2,
      'local-workspace:review-company': 1,
    });
  });

  it('C2 observes committed held delivery, original deadline and exact status without departed late-result work', async () => {
    const value = await renderCompanyApp();
    await editCompany(value); await reviewCompany(value);
    // Vitest does not reconfigure an already-installed Date-only fake clock.
    // Native construction and review are settled before installing timer fakes.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(CONTINUITY_NOW));
    const hold = value.armCompanyDelivery();
    fireEvent.click(screen.getByRole('button', { name: 'Create company' }));
    const arrival = await hold.arrived;
    expect(arrival).not.toBeNull();
    if (!arrival) throw new Error('Real create did not reach held delivery');
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(arrival.result).toMatchObject({ status: 'saved', replayed: false });
    const committed = await assertCommitted(value, arrival.request, arrival.result);
    expect(screen.getByText('Saving company…')).not.toBeNull();
    expect(screen.queryByText('Company saved.')).toBeNull();
    expect(companyCalls(value)).toHaveLength(2);
    expect(companyCalls(value)[1]).toMatchObject({ channel: 'local-workspace:create-company', args: [arrival.request], handlerStarted: true, outcome: 'pending' });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await navigateCompany(value, 'Campaigns');
    await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
    await navigateCompany(value, 'Accounts');
    expect(screen.getByText('Saving company…')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Check save status' })).toBeNull();
    await navigateCompany(value, 'Campaigns');
    const beforeAwayExpiry = value.trace();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(window.location.hash).toBe('#/campaigns');
    expect(screen.getByRole('heading', { name: 'Campaigns' })).not.toBeNull();
    expect(screen.queryByRole('form', { name: 'Local company intake' })).toBeNull();
    expect(value.trace()).toEqual(beforeAwayExpiry);
    await navigateCompany(value, 'Accounts');
    expect(screen.getByText(/Save outcome unknown/)).not.toBeNull();
    expect((screen.getByRole('textbox', { name: 'Company name' }) as HTMLInputElement).value).toBe(COMPANY.name);
    expect((screen.getByRole('textbox', { name: 'Company domain (optional)' }) as HTMLInputElement).value).toBe(COMPANY.domain);
    expect(companyCalls(value)).toHaveLength(2);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check save status' })); await value.drainReads(); });
    expect(screen.getByText('Company saved.')).not.toBeNull();
    await act(async () => { await value.drainReads(); });
    expect(screen.getByRole('button', { name: `Local account · ${COMPANY.name}` }).getAttribute('aria-current')).toBe('true');
    const status = companyCalls(value)[2]!;
    expect(status).toMatchObject({ channel: 'local-workspace:company-create-status', args: [arrival.request], handlerStarted: true, outcome: 'resolved' });
    expect(localCompanyCreateStatusSchema.parse(status.result)).toEqual({ status: 'saved', commandId: arrival.request.commandId, account: arrival.result.status === 'saved' ? arrival.result.account : null });
    expect(companyCalls(value)[1]!.outcome).toBe('pending'); // Saved status is not delivered create.
    await navigateCompany(value, 'Leads');
    const beforeLate = value.trace().length;
    await act(async () => { hold.release(); await value.drainInvocations(); });
    expect(window.location.hash).toBe('#/leads');
    expect(screen.getByRole('region', { name: 'Leads' })).not.toBeNull();
    expect(screen.queryByRole('form', { name: 'Local company intake' })).toBeNull();
    expect(value.trace()).toHaveLength(beforeLate);
    expect(companyCalls(value).map(entry => ({ channel: entry.channel, args: entry.args }))).toEqual([
      { channel: 'local-workspace:review-company', args: [COMPANY] },
      { channel: 'local-workspace:create-company', args: [arrival.request] },
      { channel: 'local-workspace:company-create-status', args: [arrival.request] },
    ]);
    expect(await value.companyEvidence(arrival.request.commandId)).toEqual(committed);
    assertUiInventory(value, {
      'health:get': 1, 'lead-detail:outbound-capabilities': 1, 'review:list': 6, 'daily:get': 5, 'outreach:delegation-status': 5,
      'local-workspace:get': 6, 'local-workspace:get-commitments': 6, 'leads:list': 1,
      'local-workspace:review-company': 1, 'local-workspace:create-company': 1, 'local-workspace:company-create-status': 1,
    });
  });

  it('C3 retries the exact request after committed delivery rejection and receives the real replay', async () => {
    const value = await renderCompanyApp();
    await editCompany(value); await reviewCompany(value);
    const hold = value.armCompanyDelivery();
    fireEvent.click(screen.getByRole('button', { name: 'Create company' }));
    const arrival = await hold.arrived;
    expect(arrival).not.toBeNull();
    if (!arrival) throw new Error('Real create did not reach held delivery');
    expect(arrival.result).toMatchObject({ status: 'saved', replayed: false });
    const committed = await assertCommitted(value, arrival.request, arrival.result);
    await act(async () => { hold.reject(); await value.drainInvocations(); });
    expect(screen.getByText(/Save outcome unknown/)).not.toBeNull();
    expect((screen.getByRole('textbox', { name: 'Company name' }) as HTMLInputElement).value).toBe(COMPANY.name);
    expect((screen.getByRole('textbox', { name: 'Company domain (optional)' }) as HTMLInputElement).value).toBe(COMPANY.domain);
    expect((screen.getByRole('textbox', { name: 'Company name' }) as HTMLInputElement).disabled).toBe(true);
    expect(companyCalls(value)).toHaveLength(2);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry create' })); await value.drainInvocations(); });
    await act(async () => { await value.drainReads(); });
    expect(screen.getByText('Company saved.')).not.toBeNull();
    expect(screen.getByRole('button', { name: `Local account · ${COMPANY.name}` }).getAttribute('aria-current')).toBe('true');
    const calls = companyCalls(value);
    expect(calls.map(entry => ({ channel: entry.channel, args: entry.args, outcome: entry.outcome }))).toEqual([
      { channel: 'local-workspace:review-company', args: [COMPANY], outcome: 'resolved' },
      { channel: 'local-workspace:create-company', args: [arrival.request], outcome: 'rejected' },
      { channel: 'local-workspace:create-company', args: [arrival.request], outcome: 'resolved' },
    ]);
    expect(localCompanyCreateResultSchema.parse(calls[2]!.result)).toEqual({ ...arrival.result, replayed: true });
    expect(await value.companyEvidence(arrival.request.commandId)).toEqual(committed);
    assertUiInventory(value, {
      'health:get': 1, 'lead-detail:outbound-capabilities': 1, 'review:list': 1, 'daily:get': 1, 'outreach:delegation-status': 1,
      'local-workspace:get': 2, 'local-workspace:get-commitments': 2,
      'local-workspace:review-company': 1, 'local-workspace:create-company': 2,
    });
  });
});


describe('retained lifecycle construction through the genuine public boundary', () => {
  it('R0 constructs six distinct retained owners and preserves exact evidence through public workflow transition', async () => {
    // Date-only control aligns both real SystemClocks. No scheduling is faked.
    vi.setSystemTime(new Date(RETAINED_T));
    const value = await createContinuityDomainFixture(transport.handlers, 'retained-setup');
    fixtures.push(value);
    expect(appHealthSchema.parse(await value.api.health.get())).toMatchObject({ domainReady: true, domainStatus: 'ready' });
    const first = await value.seedRetained('warm-owners');
    expect(first).toHaveLength(5);
    vi.setSystemTime(new Date(RETAINED_DISCOVERY));
    const owners = await value.seedRetained('callback');
    expect(owners).toHaveLength(6);
    for (const field of ['personId', 'prospectId', 'cycleId', 'actionId', 'sourceEventId'] as const) {
      expect(new Set(owners.map(owner => owner[field])).size).toBe(6);
    }
    expect(owners.map(owner => owner.kind).sort()).toEqual([
      'callback', 'founder_resurface', 'inbound_response', 'onboarding', 'post_stage', 'warm_relationship',
    ]);
    vi.setSystemTime(new Date(RETAINED_O));
    const before = await value.retainedEvidence();
    expect(before.audit).toEqual([]); // Fresh actual audit, not immutable startup report.
    const stages = {
      warm_relationship: ['unreviewed'], post_stage: ['unreviewed', 'ready', 'contacted', 'interviewed'],
      onboarding: ['unreviewed', 'ready', 'contacted', 'interviewed', 'offered', 'won'],
      inbound_response: ['contacted'], founder_resurface: ['unreviewed', 'ready'], callback: ['unreviewed', 'ready'],
    };
    for (const record of before.owners) {
      const { owner, action } = record;
      expect(action).toMatchObject({ id: owner.actionId, sales_cycle_id: owner.cycleId, status: 'pending' });
      expect(Date.parse(action!.due_at)).toBeLessThanOrEqual(Date.parse(RETAINED_O));
      expect(record.cycle).toMatchObject({ id: owner.cycleId, person_id: owner.personId, prospect_id: owner.prospectId,
        entry_source_event_id: owner.sourceEventId, current_next_action_id: owner.actionId });
      // Initial intake appends the source before creating its canonical prospect.
      // Later inbound evidence carries the existing prospect directly instead.
      expect(record.source).toMatchObject({ id: owner.sourceEventId, person_id: owner.personId,
        prospect_id: owner.kind === 'inbound_response' ? owner.prospectId : null,
        original_prospect_id: owner.kind === 'inbound_response' ? null : owner.prospectId });
      expect(record.stages).toEqual(stages[owner.kind].map(to_stage => ({ to_stage })));
      expect(record.prospect).toEqual({ id: owner.prospectId, person_id: owner.personId, segment: owner.kind === 'callback' ? 'cold' : 'warm' });
      expect(record.cycle).toMatchObject({ version: { warm_relationship: 1, post_stage: 4, onboarding: 7,
        inbound_response: 1, founder_resurface: 3, callback: 3 }[owner.kind] });
      if (owner.kind === 'inbound_response') {
        expect(record.source).toMatchObject({ channel: 'inbound_demo' });
        expect(owner.evidenceIds).toEqual([owner.sourceEventId]);
        expect(action).toMatchObject({ work_intent: 'inbound_response', inbound_sla_kind: 'inbound_demo_permitted_minutes',
          inbound_sla_source_event_id: owner.sourceEventId });
        expect(Date.parse(action!.inbound_sla_due_at!)).toBeLessThanOrEqual(Date.parse(RETAINED_O));
      } else {
        for (const id of owner.evidenceIds) expect(record.activities).toContainEqual(expect.objectContaining({ id,
          person_id: owner.personId, prospect_id: owner.prospectId, sales_cycle_id: owner.cycleId }));
      }
      if (owner.kind === 'warm_relationship') {
        expect(record.source).toMatchObject({ channel: 'referral' });
        expect(record.cycle).toMatchObject({ stage: 'unreviewed', version: 1 });
        expect(action).toMatchObject({ action_type: 'review_lead', work_intent: 'internal_review', channel: null,
          due_at: RETAINED_T, due_source: 'internal_review', inbound_sla_kind: null });
        expect(record.enrollment).toBeUndefined(); expect(record.activities).toEqual([]);
      }
      if (owner.kind === 'callback') {
        expect(action).toMatchObject({ due_at: RETAINED_O, due_source: 'recorded_callback' });
        expect(record.cycle).toMatchObject({ resurface_at: RETAINED_O, resurface_reason: 'callback' });
        expect(record.activities).toContainEqual(expect.objectContaining({ id: owner.evidenceIds[0], callback_at: RETAINED_O,
          kind: 'call', direction: 'outbound', occurred_at: RETAINED_DISCOVERY }));
      }
      if (owner.kind === 'founder_resurface') {
        expect(action).toMatchObject({ due_at: RETAINED_O, due_source: 'founder_resurface' });
        expect(record.cycle).toMatchObject({ resurface_at: RETAINED_O, resurface_reason: 'snooze' });
        expect(record.activities).toEqual([]);
      }
      if (owner.kind === 'post_stage') expect(record.enrollment).toEqual({ family: 'post_interview' });
      if (owner.kind === 'onboarding') {
        expect(record.enrollment).toEqual({ family: 'onboarding' });
        expect(record.terms).toEqual({ doors_committed: 12, billing_model: 'per_door_monthly', unit_rate_cents: 2500, projected_mrr_cents: 30000 });
      }
    }
    const overview = localWorkspaceSnapshotSchema.parse(await value.api.localWorkspace.get());
    expect(overview).toMatchObject({ workflowMode: 'legacy', transitionReceipt: null });
    const snapshot = localCommitmentsSnapshotSchema.parse(await value.api.localWorkspace.getCommitments());
    const expected = before.owners.map(({ owner, action }) => ({
      key: JSON.stringify(['retained', owner.cycleId, owner.actionId]), kind: owner.kind,
      personId: owner.personId, cycleId: owner.cycleId, actionId: owner.actionId, type: action!.action_type,
      dueAt: action!.due_at,
      channel: owner.kind === 'onboarding' ? 'onboarding' : action!.work_intent === 'internal_review' ? 'review'
        : action!.channel === 'phone' || action!.channel === 'voicemail' ? 'call' : action!.channel,
    })).sort((a, b) => a.key.localeCompare(b.key));
    const project = (input: typeof snapshot) => input.items.map(({ kind, item }) => ({
      key: JSON.stringify(['retained', item.salesCycleId, item.action.id]), kind, personId: item.personId,
      cycleId: item.salesCycleId, actionId: item.action.id, type: item.action.type, dueAt: item.action.dueAt, channel: item.action.channel,
    })).sort((a, b) => a.key.localeCompare(b.key));
    expect(snapshot.generatedAt).toBe(RETAINED_O);
    expect(project(snapshot)).toEqual(expected); // Complete six-row set, not subset matching.
    expect(snapshot.items.find(row => row.kind === 'warm_relationship')?.item).toMatchObject({ stage: 'unreviewed',
      lane: 'due_cadence', action: { label: 'Contact', channel: 'review' } });
    const command = { commandId: randomUUID(), manifestId: randomUUID(), expectedMode: 'legacy' as const };
    const receipt = localWorkflowReceiptSchema.parse(await value.api.localWorkspace.transition(command));
    expect(receipt).toEqual({ commandId: command.commandId, manifestId: command.manifestId, mode: 'meeting_first', revision: 1,
      occurredAt: RETAINED_O, cancelledActionIds: [], stoppedEnrollmentIds: [], preservedActionIds: before.pendingIds,
      parkedPersonIds: [], callbackEvidenceIds: [...owners.find(owner => owner.kind === 'callback')!.evidenceIds],
      unknownDraftIds: [], parkedReviewActions: [], parkedActions: [] });
    const after = await value.retainedEvidence();
    expect(after.audit).toEqual([]);
    expect(after).toEqual(before); // All fixed source/action/stage/activity/due/channel evidence survives.
    const afterOverview = localWorkspaceSnapshotSchema.parse(await value.api.localWorkspace.get());
    expect(afterOverview).toMatchObject({ workflowMode: 'meeting_first', transitionReceipt: receipt });
    const afterSnapshot = localCommitmentsSnapshotSchema.parse(await value.api.localWorkspace.getCommitments());
    expect(project(afterSnapshot)).toEqual(expected);
    expect(afterSnapshot.items).toEqual(snapshot.items);
    // Missing priority projection diagnostics are not silently relabeled ready.
    // Compare their real count, separately from the freshly empty invariant audit.
    expect(afterSnapshot.reviewErrorCount).toBe(snapshot.reviewErrorCount);
    expect(value.trace().map(({ channel, args }) => ({ channel, args }))).toEqual([
      { channel: 'health:get', args: [] }, { channel: 'local-workspace:get', args: [] },
      { channel: 'local-workspace:get-commitments', args: [] }, { channel: 'local-workspace:transition', args: [command] },
      { channel: 'local-workspace:get', args: [] }, { channel: 'local-workspace:get-commitments', args: [] },
    ]);
    expect(value.trace().every(entry => entry.handlerStarted && entry.outcome === 'resolved' && !entry.synthetic)).toBe(true);
    expect(value.counts()).toMatchObject({ keyLoads: 1, databaseOpens: 1, migrations: 1, domainConstructions: 1, domainBootstraps: 1 });
    await expectCleaned(value);
  });
});
