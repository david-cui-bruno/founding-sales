// @vitest-environment jsdom
// Stage0 construction plus bounded Stage1 actual-App company acceptance.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react/pure';
import { App } from '../../src/renderer/App';
import type { CalliePreloadApi } from '../../src/shared/preload';
import { localCompanyCreateRequestSchema, localCompanyCreateResultSchema, localCompanyCreateStatusSchema, localCompanyReviewSchema } from '../../src/shared/contracts/localCompanyIntakeContract';

import { appHealthSchema } from '../../src/shared/healthContract';
import { dailySnapshotSchema } from '../../src/shared/contracts/dailyContract';
import { localDelegationStatusSchema } from '../../src/shared/contracts/ownerCommandContract';
import { localCommitmentsSnapshotSchema, localWorkspaceSnapshotSchema, localWorkflowReceiptSchema } from '../../src/shared/contracts/localWorkspaceContract';
import {
  HEALTH_ORPHAN_ID, RETAINED_T, RETAINED_O, RETAINED_DISCOVERY, RETAINED_UI_REGISTERED_CHANNELS, SYNTHETIC_WORKER_IDS,
  CONTINUITY_NOW, CONTINUITY_READ_CHANNELS, CONTINUITY_REGISTERED_CHANNELS, CONTINUITY_URL,
  createContinuityDomainFixture, CONTINUITY_UI_CHANNELS, CONTINUITY_UI_REGISTERED_CHANNELS,
} from '../fixtures/continuityDomainFixture';

/** Exact registrar inventories after the legacy route removal. */
const CONSTRUCTION_CHANNEL_COUNT = 24;
const COMPANY_UI_CHANNEL_COUNT = 27;
const RETAINED_UI_CHANNEL_COUNT = 69;
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
  });
  expect(transport.handlers.size).toBe(0);
  expect([...transport.registrations].sort()).toEqual([...CONTINUITY_REGISTERED_CHANNELS].sort());
  expect([...transport.removals].sort()).toEqual([...CONTINUITY_REGISTERED_CHANNELS].sort());
  expect(transport.registrations).toHaveLength(CONSTRUCTION_CHANNEL_COUNT);
  expect(transport.removals).toHaveLength(CONSTRUCTION_CHANNEL_COUNT);
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
            domainShutdowns: 1, databaseCloses: 1 });
          expect([...transport.removals].sort()).toEqual([...(value.isRetainedUi ? RETAINED_UI_REGISTERED_CHANNELS : value.isBlockedUi ? CONTINUITY_REGISTERED_CHANNELS : CONTINUITY_UI_REGISTERED_CHANNELS)].sort());
          if (value.isRetainedUi) expect(value.uiCounters()).toEqual({ network: 0, forbidden: 0, delegationDisposals: 1 });
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
      domainStartupEvaluatedAt: CONTINUITY_NOW,
    });
    // The health contract is the retained startup report alone. No sourcing
    // overlay or whole-product readiness claim rides along with it.
    expect(health).not.toHaveProperty('operationalStatus');
    expect(health).not.toHaveProperty('sourcing');
    const overview = localWorkspaceSnapshotSchema.parse(await value.api.localWorkspace.get());
    expect(overview).toEqual({ scope: 'local_database', generatedAt: CONTINUITY_NOW,
      workflowMode: 'legacy', transitionReceipt: null, accounts: { state: 'available', snapshots: [] } });
    const commitments = localCommitmentsSnapshotSchema.parse(await value.api.localWorkspace.getCommitments());
    expect(commitments).toEqual({ scope: 'local_database', generatedAt: CONTINUITY_NOW,
      revision: baseline.changes, reviewErrorCount: 0, items: [] });
    expect(appHealthSchema.parse(await value.api.health.get())).toEqual(health);

    expect(value.trace().map(({ channel, args }) => ({ channel, args }))).toEqual([
      { channel: 'health:get', args: [] },
      { channel: 'local-workspace:get', args: [] },
      { channel: 'local-workspace:get-commitments', args: [] },
      { channel: 'health:get', args: [] },
    ]);
    expect(value.trace().every(entry => entry.handlerStarted && entry.outcome === 'resolved')).toBe(true);
    expect(await value.evidence()).toEqual(baseline);
    expect(value.counts()).toEqual({
      keyLoads: 1, preparations: 1, databaseOpens: 1, migrations: 1,
      domainConstructions: 1, domainBootstraps: 1, healthConstructions: 1,
      healthReads: 2, domainEntries: 1, databaseEntries: 1, evidenceReads: 2,
      databaseCloses: 0, domainShutdowns: 0, runtimeShutdowns: 0,
      cleanupRuns: 0,
    });
    await expectCleaned(value);
  });

  it('S0.2 refuses malformed and untrusted reads before provider entry and disposes each resource once', async () => {
    const value = await fixture();
    const baseline = await value.evidence();
    const before = value.counts();
    expect(value.trace()).toHaveLength(0);
    const malformed: { channel: string; args: unknown[] }[] = [
      { channel: 'health:get', args: [undefined] },
      { channel: 'local-workspace:get', args: [undefined] },
      { channel: 'local-workspace:get-commitments', args: [undefined] },
      { channel: 'local-workspace:get-commitments', args: [{}] },
    ];
    for (const { channel, args } of malformed) {
      await expect(value.invokeFrom(CONTINUITY_URL, channel, ...args)).rejects.toThrow();
    }
    for (const channel of CONTINUITY_READ_CHANNELS) {
      await expect(value.invokeFrom('https://untrusted.invalid/', channel)).rejects.toThrow();
    }
    expect(value.trace()).toHaveLength(7);
    expect(value.trace().every(entry => entry.handlerStarted && entry.outcome === 'rejected')).toBe(true);
    for (const removed of ['friday:get', 'review:list', 'today:get', 'lead-detail:outbound-capabilities', 'discovery:get', 'sourcing:status']) {
      await expect(value.invokeFrom(CONTINUITY_URL, removed)).rejects.toThrow('three readonly channels');
    }
    await expect(value.invokeFrom(CONTINUITY_URL, 'stage0:unsupported')).rejects.toThrow('three readonly channels');
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
  mountContinuityApp(value, 'accounts');
  await waitFor(() => expect((screen.getByRole('button', { name: 'Add company' }) as HTMLButtonElement).disabled).toBe(false));
  await act(async () => { await value.drainReads(); });
  expect(screen.getByRole('heading', { name: 'Accounts' })).not.toBeNull();
  expect(value.trace().find(entry => entry.channel === 'health:get')?.result).toMatchObject({ domainReady: true, domainStatus: 'ready' });
  return value;
}
async function navigateCompany(value: Fixture, name: 'Accounts' | 'Campaigns' | 'Today') {
  const navigation = within(screen.getByRole('navigation', { name: 'Primary' }));
  expect(navigation.queryByRole('button', { name: 'More workspaces' })).toBeNull();
  expect(navigation.queryByRole('link', { name: 'Leads' })).toBeNull();
  await act(async () => { fireEvent.click(navigation.getByRole('link', { name })); });
  await act(async () => { await value.drainReads(); });
  expect(window.location.hash).toBe(`#/${name.toLowerCase()}`);
  expect(screen.getByRole('heading', { level: 1, name })).not.toBeNull();
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
    if (entry.channel === 'local-workspace:get-company-research-settings') {
      expect(entry.args).toEqual([]);
      expect(entry).toMatchObject({ handlerStarted: true, outcome: 'resolved', result: { revision: 0, configuration: null } });
    } else if (!entry.channel.includes('company')) expect(entry.args).toEqual([]);
  }
  expect([...transport.registrations].sort()).toEqual([...CONTINUITY_UI_REGISTERED_CHANNELS].sort());
  expect(transport.registrations).toHaveLength(COMPANY_UI_CHANNEL_COUNT);
  expect(value.trace().every(entry => (CONTINUITY_UI_CHANNELS as readonly string[]).includes(entry.channel))).toBe(true);
  expect(value.trace().filter(entry => entry.synthetic).every(entry => entry.channel === 'outreach:delegation-status' && !entry.handlerStarted)).toBe(true);
  expect(value.counts()).toMatchObject({ keyLoads: 1, preparations: 1, databaseOpens: 1, migrations: 1,
    domainConstructions: 1, domainBootstraps: 1, healthConstructions: 1 });
  for (const channel of ['health:get', 'local-workspace:get', 'local-workspace:get-commitments', 'daily:get']) {
    expect(value.trace().some(entry => entry.channel === channel && entry.handlerStarted && entry.outcome === 'resolved')).toBe(true);
  }
  // No person-command, review, Friday, sourcing or discovery channel is registered, let alone read.
  for (const removed of ['review:list', 'lead-detail:outbound-capabilities', 'leads:update-field', 'friday:get', 'today:get', 'sourcing:status', 'discovery:get']) {
    expect(transport.registrations).not.toContain(removed);
    expect(value.trace().some(entry => entry.channel === removed)).toBe(false);
  }
}

describe('company continuity through actual App and local public boundaries', () => {
  it('C1 retains editing and real reviewed company across Campaigns and Today without replay', async () => {
    const value = await renderCompanyApp();
    const baseline = await value.evidence();
    await editCompany(value);
    for (const route of ['Campaigns', 'Today', 'Accounts'] as const) await navigateCompany(value, route);
    expect((screen.getByRole('textbox', { name: 'Company name' }) as HTMLInputElement).value).toBe(COMPANY.name);
    expect((screen.getByRole('textbox', { name: 'Company domain (optional)' }) as HTMLInputElement).value).toBe(COMPANY.domain);
    expect(companyCalls(value)).toEqual([]);
    await reviewCompany(value);
    const reviewed = companyCalls(value);
    for (const route of ['Campaigns', 'Today', 'Accounts'] as const) await navigateCompany(value, route);
    expect((screen.getByRole('textbox', { name: 'Company name' }) as HTMLInputElement).value).toBe(COMPANY.name);
    expect((screen.getByRole('textbox', { name: 'Company domain (optional)' }) as HTMLInputElement).value).toBe(COMPANY.domain);
    expect(screen.getByText(`Reviewed company: ${COMPANY.name} · ${COMPANY.domain}`)).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Create company' }) as HTMLButtonElement).disabled).toBe(false);
    expect(companyCalls(value)).toEqual(reviewed);
    expect(await value.evidence()).toEqual(baseline);
    // Every company-model surface reads the same four local projections; none reads people.
    expect(value.trace().some(entry => entry.channel === 'leads:list')).toBe(false);
    assertUiInventory(value, {
      'health:get': 1, 'daily:get': 7, 'outreach:delegation-status': 7,
      'local-workspace:get': 7, 'local-workspace:get-commitments': 7,
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
    await navigateCompany(value, 'Today');
    const beforeLate = value.trace().length;
    await act(async () => { hold.release(); await value.drainInvocations(); });
    expect(window.location.hash).toBe('#/today');
    expect(screen.getByRole('heading', { level: 1, name: 'Today' })).not.toBeNull();
    expect(screen.queryByRole('form', { name: 'Local company intake' })).toBeNull();
    expect(value.trace()).toHaveLength(beforeLate);
    expect(companyCalls(value).map(entry => ({ channel: entry.channel, args: entry.args }))).toEqual([
      { channel: 'local-workspace:review-company', args: [COMPANY] },
      { channel: 'local-workspace:create-company', args: [arrival.request] },
      { channel: 'local-workspace:company-create-status', args: [arrival.request] },
    ]);
    expect(await value.companyEvidence(arrival.request.commandId)).toEqual(committed);
    expect(value.trace().filter(entry => entry.channel === 'local-workspace:get-company').map(entry => ({ args: entry.args, outcome: entry.outcome, handlerStarted: entry.handlerStarted }))).toEqual([
      { args: [{ accountId: arrival.result.status === 'saved' ? arrival.result.account.id : null }], outcome: 'resolved', handlerStarted: true },
    ]);
    assertUiInventory(value, {
      'health:get': 1, 'daily:get': 6, 'outreach:delegation-status': 6,
      'local-workspace:get': 7, 'local-workspace:get-commitments': 7,
      'local-workspace:review-company': 1, 'local-workspace:create-company': 1, 'local-workspace:company-create-status': 1, 'local-workspace:get-company': 1, 'local-workspace:get-company-research-settings': 1,
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
    expect(value.trace().filter(entry => entry.channel === 'local-workspace:get-company').map(entry => ({ args: entry.args, outcome: entry.outcome, handlerStarted: entry.handlerStarted }))).toEqual([
      { args: [{ accountId: arrival.result.status === 'saved' ? arrival.result.account.id : null }], outcome: 'resolved', handlerStarted: true },
    ]);
    assertUiInventory(value, {
      'health:get': 1, 'daily:get': 1, 'outreach:delegation-status': 1,
      'local-workspace:get': 2, 'local-workspace:get-commitments': 2,
      'local-workspace:review-company': 1, 'local-workspace:create-company': 2, 'local-workspace:get-company': 1, 'local-workspace:get-company-research-settings': 1,
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

function mountContinuityApp(value: Fixture, route: 'accounts' | 'today') {
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
  window.history.replaceState(null, '', `#/${route}`);
  render(<App />);
}


type RetainedUi = Awaited<ReturnType<typeof renderRetainedApp>>;
async function renderRetainedApp(synthetic = false, localMetadata: 'genuine' | 'complete' = 'genuine') {
  vi.setSystemTime(new Date(RETAINED_T));
  const value = await createContinuityDomainFixture(transport.handlers, synthetic ? 'retained-synthetic' : 'retained-ui');
  fixtures.push(value);
  await value.seedRetained('warm-owners');
  vi.setSystemTime(new Date(RETAINED_DISCOVERY));
  const owners = await value.seedRetained('callback');
  vi.setSystemTime(new Date(RETAINED_O));
  const command = { commandId: randomUUID(), manifestId: randomUUID(), expectedMode: 'legacy' as const };
  const receipt = await value.api.localWorkspace.transition(command);
  const evidence = await value.retainedEvidence();
  expect(evidence.audit).toEqual([]);
  const snapshot = localCommitmentsSnapshotSchema.parse(await value.api.localWorkspace.getCommitments());
  expect(snapshot.items).toHaveLength(6);
  expect(new Set(snapshot.items.map(row => JSON.stringify(['retained', row.item.salesCycleId, row.item.action.id])))).toEqual(
    new Set(owners.map(owner => JSON.stringify(['retained', owner.cycleId, owner.actionId]))));
  if (localMetadata === 'complete') value.completeRetained();
  mountContinuityApp(value, 'today');
  await waitFor(() => expect(retainedButtons()).toHaveLength(6));
  await act(async () => { await value.drainReads(); });
  expect(window.location.hash).toBe('#/today');
  expect([...transport.registrations].sort()).toEqual([...RETAINED_UI_REGISTERED_CHANNELS].sort());
  expect(transport.registrations).toHaveLength(RETAINED_UI_CHANNEL_COUNT);
  const status = value.trace().find(entry => entry.channel === 'outreach:delegation-status')!;
  expect(status).toMatchObject({ handlerStarted: true, outcome: 'resolved' });
  expect(status.synthetic).toBeUndefined();
  expect(localDelegationStatusSchema.parse(status.result)).toEqual({ state: 'unconfigured', workspaceId: null, endpoint: null, configuration: null });
  return { value, owners, evidence, snapshot, command, receipt };
}
function retainedButtons() {
  const region = screen.queryByRole('region', { name: 'Local commitments' });
  return region ? Array.from(region.querySelectorAll<HTMLButtonElement>('button[data-row-key]')) : [];
}
function laneCount(name: 'Local commitments' | 'Calls') {
  return screen.getByRole('region', { name }).querySelector('.native-desk__count')?.textContent;
}
function assertRetainedRows(context: RetainedUi) {
  const { snapshot, evidence } = context;
  expect(retainedButtons().map(row => row.dataset.rowKey).sort()).toEqual(snapshot.items.map(({ item }) =>
    JSON.stringify(['retained', item.salesCycleId, item.action.id])).sort());
  for (const { item, kind } of snapshot.items) {
    const record = evidence.owners.find(record => record.owner.cycleId === item.salesCycleId)!;
    expect(record.owner.actionId).toBe(item.action.id);
    expect(item.action.dueAt).toBe(record.action!.due_at);
    const channel = kind === 'onboarding' ? 'onboarding' : record.action!.work_intent === 'internal_review' ? 'review'
      : record.action!.channel === 'phone' || record.action!.channel === 'voicemail' ? 'call' : record.action!.channel;
    expect(item.action.channel).toBe(channel);
    const row = retainedButtons().find(row => row.dataset.rowKey === JSON.stringify(['retained', item.salesCycleId, item.action.id]))!;
    expect(row.textContent).toContain(item.personName);
    expect(row.textContent).toContain(item.action.label);
    expect(row.querySelector('time')?.dateTime).toBe(record.action!.due_at);
  }
}
function assertRetainedInventory(context: RetainedUi, refreshes: number) {
  const { value, command } = context;
  const counts: Record<string, number> = {};
  for (const entry of value.trace()) {
    counts[entry.channel] = (counts[entry.channel] ?? 0) + 1;
    if (entry.channel === 'local-workspace:transition') expect(entry.args).toEqual([command]);
    else expect(entry.args).toEqual([]);
    expect(entry.handlerStarted).toBe(true);
  }
  // Retained work is local evidence only: no person detail, review or discovery read ever leaves Today.
  expect(counts).toEqual({
    'local-workspace:transition': 1, 'local-workspace:get-commitments': 2 + refreshes,
    'health:get': 1,
    'daily:get': 1 + refreshes, 'outreach:delegation-status': 1 + refreshes, 'local-workspace:get': 1 + refreshes,
  });
  expect(value.uiCounters()).toEqual({ network: 0, forbidden: 0, delegationDisposals: 0 });
  expect(value.counts()).toMatchObject({ keyLoads: 1, preparations: 1, databaseOpens: 1, migrations: 1,
    domainConstructions: 1, domainBootstraps: 1, healthConstructions: 1 });
}
async function refreshRetained(value: Fixture) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); });
  await act(async () => { await value.drainReads(); });
}

describe('actual Today retained work and separately labeled synthetic worker presentation', () => {
  it('B1 shows all six genuine retained owners with unpaired worker scope and selects each without any person read', async () => {
    const context = await renderRetainedApp();
    const { value, snapshot } = context;
    assertRetainedRows(context); assertRetainedInventory(context, 0);
    expect(laneCount('Calls')).toBe('Unavailable');
    expect(laneCount('Local commitments')).toBe(snapshot.reviewErrorCount ? '6+ · partial' : '6');
    const daily = dailySnapshotSchema.parse(value.trace().find(entry => entry.channel === 'daily:get')!.result);
    expect(daily).toMatchObject({ workspaceId: null, workflowMode: 'meeting_first', calls: { accountIds: [] }, ownerStatus: [] });
    expect(value.trace().some(entry => entry.synthetic)).toBe(false);
    for (const entry of value.trace().filter(entry => entry.channel === 'local-workspace:get-commitments')) {
      expect(localCommitmentsSnapshotSchema.parse(entry.result).reviewErrorCount).toBe(snapshot.reviewErrorCount);
    }
    for (const { item } of snapshot.items) {
      const key = JSON.stringify(['retained', item.salesCycleId, item.action.id]);
      const row = retainedButtons().find(row => row.dataset.rowKey === key)!;
      const before = value.trace().length;
      fireEvent.click(row);
      const detail = screen.getByRole('region', { name: 'Retained work detail' });
      expect(detail.textContent).toContain(item.personName);
      expect(detail.textContent).toContain(item.reason);
      expect(detail.textContent).toContain(`Action type: ${item.action.type} · Channel: ${item.action.channel} · Lane: ${item.lane}`);
      expect(detail.querySelector('time')?.dateTime).toBe(item.action.dueAt);
      expect(detail.textContent).toContain('Stored local work. Nothing here calls, sends or books.');
      // The contact workspace is gone with the legacy routes: the detail is pure local presentation.
      expect(within(detail).queryByRole('button')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Open contact workspace' })).toBeNull();
      expect(screen.queryByRole('article', { name: `${item.personName} full page` })).toBeNull();
      await act(async () => { await value.drainReads(); });
      expect(value.trace()).toHaveLength(before);
      expect(window.location.hash).toBe('#/today');
      expect(retainedButtons().find(row => row.dataset.rowKey === key)?.getAttribute('aria-current')).toBe('true');
      assertRetainedRows(context); assertRetainedInventory(context, 0);
    }
    expect(value.trace().some(entry => ['lead-detail:get', 'leads:list', 'discovery:get-brief', 'review:list'].includes(entry.channel))).toBe(false);
    expect(value.trace().every(entry => entry.outcome === 'resolved' && !entry.synthetic)).toBe(true);
    expect(await value.retainedEvidence()).toEqual(context.evidence);
  });

  it('B2 keeps synthetic complete and partial worker Calls counts separate from six real local owners', async () => {
    const context = await renderRetainedApp(true);
    const { value } = context;
    assertRetainedRows(context); assertRetainedInventory(context, 0);
    const localCount = laneCount('Local commitments');
    expect(laneCount('Calls')).toBe('2');
    const ids = new Set(context.owners.flatMap(owner => [owner.personId, owner.prospectId, owner.cycleId, owner.actionId]));
    for (const id of SYNTHETIC_WORKER_IDS) expect(ids.has(id)).toBe(false);
    const workerRows = screen.getByRole('region', { name: 'Calls' }).querySelectorAll<HTMLButtonElement>('button[data-row-key]');
    expect(Array.from(workerRows, row => row.dataset.rowKey)).toEqual(SYNTHETIC_WORKER_IDS.map(id => `call:${id}`));
    const beforeSelection = value.trace().length;
    fireEvent.click(workerRows[0]!);
    expect(screen.getByText(/Call handoff unavailable in this account view/)).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Open contact workspace' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reconcile queued commands' })).toBeNull();
    expect(value.trace()).toHaveLength(beforeSelection);
    const first = value.trace().find(entry => entry.channel === 'daily:get')!;
    expect(first.synthetic).toBe(true);
    expect(dailySnapshotSchema.parse(first.actualResult).workspaceId).toBeNull();
    expect(dailySnapshotSchema.parse(first.result)).toMatchObject({ ownerStatus: [], freshness: { kind: 'local_snapshot' } });
    value.partialWorker();
    await refreshRetained(value);
    expect(laneCount('Calls')).toBe('2+ · partial');
    expect(laneCount('Local commitments')).toBe(localCount);
    assertRetainedRows(context); assertRetainedInventory(context, 1);
    expect(value.trace().filter(entry => entry.synthetic).every(entry => entry.channel === 'daily:get')).toBe(true);
    expect(value.trace().every(entry => entry.outcome === 'resolved')).toBe(true);
    expect(await value.retainedEvidence()).toEqual(context.evidence);
  });

  it('B3 retains six keys through bounded checking stale and partial reads without conferring worker authority', async () => {
    const context = await renderRetainedApp(true, 'complete');
    const { value } = context;
    // Fixed synthetic complete/partial metadata only. Genuine diagnostics remain captured.
    expect(laneCount('Local commitments')).toBe('6');
    const selected = retainedButtons()[0]!;
    const key = selected.dataset.rowKey;
    const selectedItem = context.snapshot.items.find(({ item }) => JSON.stringify(['retained', item.salesCycleId, item.action.id]) === key)!.item;
    const assertSelection = () => {
      expect(retainedButtons().filter(row => row.getAttribute('aria-current') === 'true').map(row => row.dataset.rowKey)).toEqual([key]);
      const detail = screen.getByRole('region', { name: 'Retained work detail' });
      expect(within(detail).getByRole('heading', { name: selectedItem.personName }).textContent).toBe(selectedItem.personName);
      expect(detail.textContent).toContain(selectedItem.reason);
      expect(detail.querySelector('time')?.dateTime).toBe(selectedItem.action.dueAt);
    };
    fireEvent.click(selected);
    assertSelection();
    // No contact workspace remains to open; the detail stays a read-only local presentation throughout.
    const noOpenControl = () => {
      expect(screen.queryByRole('button', { name: 'Open contact workspace' })).toBeNull();
      expect(within(screen.getByRole('region', { name: 'Retained work detail' })).queryByRole('button')).toBeNull();
    };
    noOpenControl();
    const first = value.holdRetainedRead();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => { expect(await first.arrival).not.toBeNull(); });
    expect(laneCount('Local commitments')).toBe('6 · checking');
    assertSelection(); noOpenControl();
    assertRetainedRows(context);
    await act(async () => { first.reject(); await value.drainReads(); });
    expect(laneCount('Local commitments')).toBe('6 · last known');
    assertSelection();
    expect(screen.getByText('Retained work is stale. Refresh to check it again.')).not.toBeNull();
    noOpenControl();
    expect(retainedButtons().find(row => row.dataset.rowKey === key)?.getAttribute('aria-current')).toBe('true');
    await refreshRetained(value);
    expect(laneCount('Local commitments')).toBe('6');
    expect(screen.queryByText(/Retained work is stale/)).toBeNull();
    assertSelection();
    value.partialRetained(); await refreshRetained(value);
    assertSelection();
    expect(laneCount('Local commitments')).toBe('6+ · partial');
    expect(screen.getByText('Some retained work could not be read. This local snapshot is incomplete.')).not.toBeNull();
    const second = value.holdRetainedRead();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => { expect(await second.arrival).not.toBeNull(); });
    expect(laneCount('Local commitments')).toBe('6+ · partial'); noOpenControl();
    assertSelection();
    assertRetainedRows(context);
    await act(async () => { second.release(); await value.drainReads(); });
    assertSelection(); noOpenControl();
    value.rejectNextDaily(); await refreshRetained(value);
    assertSelection();
    expect(laneCount('Calls')).toBe('2 · last known');
    expect(laneCount('Local commitments')).toBe('6+ · partial');
    assertRetainedRows(context); assertRetainedInventory(context, 5);
    expect(value.trace().filter(entry => entry.outcome === 'rejected').map(entry => entry.channel)).toEqual([
      'local-workspace:get-commitments', 'daily:get',
    ]);
    for (const entry of value.trace().filter(entry => entry.synthetic && entry.channel === 'local-workspace:get-commitments')) {
      const real = localCommitmentsSnapshotSchema.parse(entry.actualResult), presented = localCommitmentsSnapshotSchema.parse(entry.result);
      expect(presented.items).toEqual(real.items);
      expect(real.reviewErrorCount).toBe(context.snapshot.reviewErrorCount);
      expect(['retained-complete', 'retained-partial']).toContain(entry.presentationVariant);
      expect(presented.reviewErrorCount).toBe(entry.presentationVariant === 'retained-complete' ? 0 : 1);
      expect({ ...presented, reviewErrorCount: real.reviewErrorCount }).toEqual(real);
    }
    expect(await value.retainedEvidence()).toEqual(context.evidence);
  });
});


function assertOneHealthGraph(value: Fixture) {
  expect(value.counts()).toMatchObject({ keyLoads: 1, preparations: 1, databaseOpens: 1, migrations: 1,
    domainConstructions: 1, domainBootstraps: 1, healthConstructions: 1 });
}
function healthObservation() {
  return screen.getByRole('region', { name: 'Diagnostic observation' });
}
function healthObservedAt() { return healthObservation().querySelector('time')?.dateTime; }

describe('actual health observation and initialized blocked admission', () => {
  it('H1 serves the retained startup report twice without repeating bootstrap, domain work or any sourcing overlay', async () => {
    const value = await createContinuityDomainFixture(transport.handlers, 'construction'); fixtures.push(value);
    const baseline = await value.evidence();
    const before = appHealthSchema.parse(await value.api.health.get());
    expect(before).toMatchObject({ domainReady: true, domainStatus: 'ready', domainStartupEvaluatedAt: CONTINUITY_NOW });
    expect(before).not.toHaveProperty('operationalStatus'); expect(before).not.toHaveProperty('sourcing');
    assertOneHealthGraph(value);
    vi.setSystemTime(new Date('2026-09-10T15:01:00.000Z'));
    const after = appHealthSchema.parse(await value.api.health.get());
    expect(after).toEqual(before); // The immutable startup report, not a re-run audit or a live poll.
    expect(await value.evidence()).toEqual(baseline);
    assertOneHealthGraph(value);
    expect(value.counts()).toMatchObject({ domainEntries: 0, healthReads: 2 });
    expect(value.trace().map(({ channel, args, handlerStarted, outcome }) => ({ channel, args, handlerStarted, outcome }))).toEqual([
      { channel: 'health:get', args: [], handlerStarted: true, outcome: 'resolved' },
      { channel: 'health:get', args: [], handlerStarted: true, outcome: 'resolved' },
    ]);
    expect(transport.registrations).toHaveLength(CONSTRUCTION_CHANNEL_COUNT);
    await expectCleaned(value);
  });

  it('H2 retains the actual company editor through rejected timed-out and superseded diagnostic observations', async () => {
    const value = await createContinuityDomainFixture(transport.handlers, 'health-ui'); fixtures.push(value);
    mountContinuityApp(value, 'accounts');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add company' }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { await value.drainReads(); });
    await editCompany(value);
    const baseline = await value.evidence(), report = await value.healthEvidence();
    const editor = screen.getByRole('textbox', { name: 'Company name' }) as HTMLInputElement;
    fireEvent.change(editor, { target: { value: '  Unsubmitted health company  ' } });
    editor.focus(); editor.setSelectionRange(3, 11, 'forward');
    const raw = editor.value;
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    const assertEditor = () => {
      expect(screen.getByRole('textbox', { name: 'Company name' })).toBe(editor);
      expect(editor.value).toBe(raw); expect(editor.selectionStart).toBe(3); expect(editor.selectionEnd).toBe(11);
      expect(editor.selectionDirection).toBe('forward'); expect(document.activeElement).toBe(editor);
      expect(window.location.hash).toBe('#/accounts'); expect(companyCalls(value)).toEqual([]);
    };
    // Shipped focus listeners refresh diagnostics and five bounded workspace reads without moving DOM focus.
    // Programmatic focus/event proof only, not a native pointer-click claim.
    const trigger = () => window.dispatchEvent(new Event('focus'));
    try {
      expect(healthObservedAt()).toBe(CONTINUITY_NOW); assertEditor();
      assertOneHealthGraph(value);
      assertUiInventory(value, { 'health:get': 1, 'daily:get': 1,
        'outreach:delegation-status': 1, 'local-workspace:get': 1, 'local-workspace:get-commitments': 1 });
      vi.useRealTimers(); vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      vi.setSystemTime(new Date('2026-09-10T15:00:01.000Z'));
      const rejected = value.holdHealthRead();
      await act(async () => { trigger(); expect(await rejected.arrival).not.toBeNull(); });
      expect(within(healthObservation()).getByText('Refreshing diagnostics…')).not.toBeNull(); assertEditor();
      await act(async () => { rejected.reject(); await expect(value.drainLatestHealth()).rejects.toThrow('Health delivery rejected'); });
      expect(within(healthObservation()).getByRole('alert')).not.toBeNull();
      expect(healthObservedAt()).toBe(CONTINUITY_NOW); assertEditor();
      vi.setSystemTime(new Date('2026-09-10T15:00:02.000Z'));
      const expired = value.holdHealthRead();
      await act(async () => { trigger(); expect(await expired.arrival).not.toBeNull(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(14_999); });
      expect(within(healthObservation()).getByText('Refreshing diagnostics…')).not.toBeNull(); assertEditor();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(within(healthObservation()).queryByText('Refreshing diagnostics…')).toBeNull();
      expect(within(healthObservation()).getByRole('alert')).not.toBeNull();
      expect(healthObservedAt()).toBe(CONTINUITY_NOW); assertEditor();
      const healthReads = () => value.trace().filter(entry => entry.channel === 'health:get');
      expect(healthReads().map(entry => entry.outcome)).toEqual(['resolved', 'rejected', 'pending']);
      assertUiInventory(value, { 'health:get': 3, 'daily:get': 3,
        'outreach:delegation-status': 3, 'local-workspace:get': 3, 'local-workspace:get-commitments': 3 });
      vi.setSystemTime(new Date('2026-09-10T15:00:30.000Z'));
      await act(async () => { trigger(); await value.drainLatestHealth(); });
      expect(healthObservedAt()).toBe('2026-09-10T15:00:30.000Z');
      expect(within(healthObservation()).queryByRole('alert')).toBeNull(); assertEditor();
      expect(healthReads().map(entry => entry.outcome)).toEqual(['resolved', 'rejected', 'pending', 'resolved']);
      vi.setSystemTime(new Date('2026-09-10T15:00:31.000Z'));
      await act(async () => { expired.release(); await value.drainReads(); });
      expect(healthObservedAt()).toBe('2026-09-10T15:00:30.000Z'); assertEditor();
      vi.setSystemTime(new Date('2026-09-10T15:00:32.000Z'));
      await act(async () => { trigger(); await value.drainLatestHealth(); });
      expect(healthObservedAt()).toBe('2026-09-10T15:00:32.000Z'); assertEditor();
      expect(healthReads().map(entry => entry.outcome)).toEqual(['resolved', 'rejected', 'resolved', 'resolved', 'resolved']);
      for (const entry of healthReads()) {
        expect(entry.handlerStarted).toBe(true); expect(entry.synthetic).toBeUndefined(); expect(entry.args).toEqual([]);
        expect(appHealthSchema.parse(entry.result).domainStartupEvaluatedAt).toBe(CONTINUITY_NOW);
      }
      expect(await value.evidence()).toEqual(baseline); expect(await value.healthEvidence()).toEqual(report);
      assertOneHealthGraph(value);
      expect(value.counts().healthReads).toBe(5);
      assertUiInventory(value, { 'health:get': 5, 'daily:get': 5,
        'outreach:delegation-status': 5, 'local-workspace:get': 5, 'local-workspace:get-commitments': 5 });
    } finally {
      await act(async () => { value.cancelDelivery(); await value.drainInvocations(); });
      if (visibility) Object.defineProperty(document, 'visibilityState', visibility); else Reflect.deleteProperty(document, 'visibilityState');
    }
  });

  it('H3 exposes real blocked startup diagnostics while refusing public domain reads and a valid company mutation', async () => {
    const value = await createContinuityDomainFixture(transport.handlers, 'health-blocked'); fixtures.push(value);
    const baseline = await value.evidence(), report = await value.healthEvidence();
    expect(report).toMatchObject({ report: { status: 'blocked', evaluatedAt: CONTINUITY_NOW }, reportFrozen: true });
    const violation = { kind: 'canonical_prospect_cardinality', recordId: HEALTH_ORPHAN_ID };
    expect(report.report.violations).toEqual(expect.arrayContaining([expect.objectContaining(violation)]));
    expect(report.audit).toEqual(expect.arrayContaining([expect.objectContaining(violation)]));
    expect(report.report.blockingViolationCount).toBeGreaterThan(0);
    const initial = appHealthSchema.parse(await value.api.health.get());
    expect(initial).toMatchObject({ domainReady: false, domainStatus: 'blocked', domainStartupEvaluatedAt: CONTINUITY_NOW,
      domainBlockingViolationCount: report.report.blockingViolationCount });
    expect(initial).not.toHaveProperty('operationalStatus'); expect(initial).not.toHaveProperty('sourcing');
    mountContinuityApp(value, 'accounts');
    await screen.findByText(/The startup audit is blocked or inconsistent/);
    await act(async () => { await value.drainReads(); });
    expect(screen.getByRole('region', { name: 'Foundation health' })).not.toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Accounts' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add company' })).toBeNull();
    expect(screen.queryByText('The diagnostic read could not be completed')).toBeNull();
    const request = localCompanyCreateRequestSchema.parse({ ...COMPANY, commandId: randomUUID() });
    await expect(value.api.localWorkspace.getCommitments()).rejects.toThrow();
    await expect(value.api.localWorkspace.createCompany(request)).rejects.toThrow();
    expect(appHealthSchema.parse(await value.api.health.get())).toEqual(initial);
    expect(value.counts()).toMatchObject({ domainEntries: 0, healthReads: 3 });
    assertOneHealthGraph(value);
    expect(await value.evidence()).toEqual(baseline); expect(await value.healthEvidence()).toEqual(report);
    expect(value.trace().map(({ channel, args, handlerStarted, outcome }) => ({ channel, args, handlerStarted, outcome }))).toEqual([
      { channel: 'health:get', args: [], handlerStarted: true, outcome: 'resolved' },
      { channel: 'health:get', args: [], handlerStarted: true, outcome: 'resolved' },
      { channel: 'local-workspace:get-commitments', args: [], handlerStarted: true, outcome: 'rejected' },
      { channel: 'local-workspace:create-company', args: [request], handlerStarted: true, outcome: 'rejected' },
      { channel: 'health:get', args: [], handlerStarted: true, outcome: 'resolved' },
    ]);
    expect([...transport.registrations].sort()).toEqual([...CONTINUITY_REGISTERED_CHANNELS].sort());
    expect(transport.registrations).toHaveLength(CONSTRUCTION_CHANNEL_COUNT);
  });
});
