// @vitest-environment jsdom
import { mutationReceiptSchema } from '../../src/shared/contracts/commonContract';
// Stage0 construction plus bounded Stage1 actual-App company acceptance.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react/pure';
import { App } from '../../src/renderer/App';
import type { CalliePreloadApi } from '../../src/shared/preload';
import { localCompanyCreateRequestSchema, localCompanyCreateResultSchema, localCompanyCreateStatusSchema, localCompanyReviewSchema } from '../../src/shared/contracts/localCompanyIntakeContract';

import { appHealthSchema } from '../../src/shared/healthContract';
import { discoveryBriefSchema } from '../../src/shared/contracts/discoveryContract';
import { leadDetailSchema } from '../../src/shared/contracts/leadDetailContract';
import { dailySnapshotSchema } from '../../src/shared/contracts/dailyContract';
import { localDelegationStatusSchema } from '../../src/shared/contracts/ownerCommandContract';
import { createJobRequestSchema, fillJobRequestSchema, cancelJobRequestSchema, type CreateJobRequest, fridayReportSchema } from '../../src/shared/contracts/fridayContract';
import { localCommitmentsSnapshotSchema, localWorkspaceSnapshotSchema, localWorkflowReceiptSchema } from '../../src/shared/contracts/localWorkspaceContract';
import {
  FRIDAY_OWNER_AT, FRIDAY_REQUESTED_AT, HEALTH_ORPHAN_ID, HEALTH_POLL_AT, RETAINED_T, RETAINED_O, RETAINED_DISCOVERY, RETAINED_UI_REGISTERED_CHANNELS, SYNTHETIC_WORKER_IDS,
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
  expect(transport.registrations).toHaveLength(20);
  expect(transport.removals).toHaveLength(20);
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
          expect([...transport.removals].sort()).toEqual([...(value.isRetainedUi ? RETAINED_UI_REGISTERED_CHANNELS : value.isBlockedUi ? CONTINUITY_REGISTERED_CHANNELS : CONTINUITY_UI_REGISTERED_CHANNELS)].sort());
          if (value.isRetainedUi) expect(value.uiCounters()).toEqual({ network: 0, forbidden: 0, delegationDisposals: 1 });
          if (value.isFridayUi) expect(value.uiCounters()).toEqual({ network: 0, forbidden: 0, delegationDisposals: 0 });
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
  mountContinuityApp(value, 'accounts');
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
    else if (entry.channel === 'local-workspace:get-company-research-settings') {
      expect(entry.args).toEqual([]);
      expect(entry).toMatchObject({ handlerStarted: true, outcome: 'resolved', result: { revision: 0, configuration: null } });
    } else if (!entry.channel.includes('company')) expect(entry.args).toEqual([]);
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
    expect(value.trace().filter(entry => entry.channel === 'local-workspace:get-company').map(entry => ({ args: entry.args, outcome: entry.outcome, handlerStarted: entry.handlerStarted }))).toEqual([
      { args: [{ accountId: arrival.result.status === 'saved' ? arrival.result.account.id : null }], outcome: 'resolved', handlerStarted: true },
    ]);
    assertUiInventory(value, {
      'health:get': 1, 'lead-detail:outbound-capabilities': 1, 'review:list': 6, 'daily:get': 5, 'outreach:delegation-status': 5,
      'local-workspace:get': 6, 'local-workspace:get-commitments': 6, 'leads:list': 1,
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
      'health:get': 1, 'lead-detail:outbound-capabilities': 1, 'review:list': 1, 'daily:get': 1, 'outreach:delegation-status': 1,
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

function mountContinuityApp(value: Fixture, route: 'accounts' | 'today' | 'friday') {
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
  expect(transport.registrations).toHaveLength(68);
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
function assertRetainedInventory(context: RetainedUi, refreshes: number, contactIds: string[] = []) {
  const { value, command } = context;
  const counts: Record<string, number> = {};
  for (const entry of value.trace()) {
    counts[entry.channel] = (counts[entry.channel] ?? 0) + 1;
    if (entry.channel === 'local-workspace:transition') expect(entry.args).toEqual([command]);
    else if (entry.channel === 'lead-detail:outbound-capabilities') expect(entry.args).toEqual([{}]);
    else if (entry.channel === 'review:list') expect(entry.args).toEqual([{ kinds: [], cursor: null, limit: 1 }]);
    else if (!['lead-detail:get', 'discovery:get-brief'].includes(entry.channel)) expect(entry.args).toEqual([]);
    expect(entry.handlerStarted).toBe(true);
  }
  expect(counts).toEqual({
    'local-workspace:transition': 1, 'local-workspace:get-commitments': 2 + refreshes,
    'health:get': 1, 'lead-detail:outbound-capabilities': 1, 'review:list': 1,
    'daily:get': 1 + refreshes, 'outreach:delegation-status': 1 + refreshes, 'local-workspace:get': 1 + refreshes,
    ...(contactIds.length ? { 'lead-detail:get': contactIds.length, 'discovery:get-brief': contactIds.length } : {}),
  });
  for (const channel of ['lead-detail:get', 'discovery:get-brief']) {
    expect(value.trace().filter(entry => entry.channel === channel).map(entry => entry.args)).toEqual(contactIds.map(personId => [{ personId }]));
  }
  expect(value.uiCounters()).toEqual({ network: 0, forbidden: 0, delegationDisposals: 0 });
  expect(value.counts()).toMatchObject({ keyLoads: 1, preparations: 1, databaseOpens: 1, migrations: 1,
    domainConstructions: 1, domainBootstraps: 1, healthConstructions: 1, credentialLoads: 0, inboxCreations: 0, pollSchedules: 0 });
}
async function refreshRetained(value: Fixture) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); });
  await act(async () => { await value.drainReads(); });
}

describe('actual Today retained work and separately labeled synthetic worker presentation', () => {
  it('B1 shows all six genuine retained owners with unpaired worker scope and opens contacts only explicitly', async () => {
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
    const opened: string[] = [];
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
      expect(detail.textContent).toContain('Opening the contact workspace is a separate action.');
      expect(value.trace()).toHaveLength(before);
      await act(async () => { fireEvent.click(within(detail).getByRole('button', { name: 'Open contact workspace' })); await value.drainReads(); });
      const page = await screen.findByRole('article', { name: `${item.personName} full page` });
      await act(async () => { await value.drainReads(); });
      const detailRead = value.trace().filter(entry => entry.channel === 'lead-detail:get').at(-1)!;
      const realDetail = leadDetailSchema.parse(detailRead.result);
      expect(realDetail).toMatchObject({ personId: item.personId, salesCycleId: item.salesCycleId });
      // Corrected warm referral is unreviewed but not cloud-linked: no hidden preparation read.
      if (item.stage === 'unreviewed') expect(realDetail.cloudLinked).toBe(false);
      // Discovery evidence is mounted only after the user opens the actual Details disclosure.
      expect(value.trace().filter(entry => entry.channel === 'discovery:get-brief')).toHaveLength(opened.length);
      await act(async () => { fireEvent.click(within(page).getByText('Details', { selector: 'summary', exact: true })); });
      await waitFor(() => expect(value.trace().filter(entry => entry.channel === 'discovery:get-brief')).toHaveLength(opened.length + 1));
      await act(async () => { await value.drainReads(); });
      const briefRead = value.trace().filter(entry => entry.channel === 'discovery:get-brief').at(-1)!;
      expect(discoveryBriefSchema.parse(briefRead.result)).toMatchObject({ personId: item.personId, salesCycleId: item.salesCycleId });
      opened.push(item.personId);
      fireEvent.click(within(page).getByRole('button', { name: 'Close inspector' }));
      expect(screen.queryByRole('article', { name: `${item.personName} full page` })).toBeNull();
      expect(window.location.hash).toBe('#/today');
      expect(retainedButtons().find(row => row.dataset.rowKey === key)?.getAttribute('aria-current')).toBe('true');
      assertRetainedRows(context); assertRetainedInventory(context, 0, opened);
    }
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
    const open = () => screen.getByRole('button', { name: 'Open contact workspace' }) as HTMLButtonElement;
    const first = value.holdRetainedRead();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => { expect(await first.arrival).not.toBeNull(); });
    expect(laneCount('Local commitments')).toBe('6 · checking');
    assertSelection();
    expect(open().disabled).toBe(true);
    fireEvent.click(open());
    assertRetainedRows(context);
    await act(async () => { first.reject(); await value.drainReads(); });
    expect(laneCount('Local commitments')).toBe('6 · last known');
    assertSelection();
    expect(screen.getByText('Retained work is stale. Refresh before opening a contact.')).not.toBeNull();
    expect(open().disabled).toBe(true);
    expect(retainedButtons().find(row => row.dataset.rowKey === key)?.getAttribute('aria-current')).toBe('true');
    await refreshRetained(value);
    expect(laneCount('Local commitments')).toBe('6'); expect(open().disabled).toBe(false);
    assertSelection();
    value.partialRetained(); await refreshRetained(value);
    assertSelection();
    expect(laneCount('Local commitments')).toBe('6+ · partial');
    expect(screen.getByText('Some retained work could not be read. This local snapshot is incomplete.')).not.toBeNull();
    const second = value.holdRetainedRead();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => { expect(await second.arrival).not.toBeNull(); });
    expect(laneCount('Local commitments')).toBe('6+ · partial'); expect(open().disabled).toBe(true);
    assertSelection();
    assertRetainedRows(context);
    await act(async () => { second.release(); await value.drainReads(); });
    assertSelection();
    expect(open().disabled).toBe(false);
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


function assertOneHealthGraph(value: Fixture, expected: { credentialLoads: number; inboxCreations: number }) {
  expect(value.counts()).toMatchObject({ keyLoads: 1, preparations: 1, databaseOpens: 1, migrations: 1,
    domainConstructions: 1, domainBootstraps: 1, healthConstructions: 1, pollSchedules: 0, ...expected });
}
function healthObservation() {
  return screen.getByRole('region', { name: 'Diagnostic observation' });
}
function healthObservedAt() { return healthObservation().querySelector('time')?.dateTime; }

describe('actual health observation and initialized blocked admission', () => {
  it('H1 observes one genuine failed poll without repeating bootstrap or writing domain state', async () => {
    const value = await createContinuityDomainFixture(transport.handlers, 'health-poll'); fixtures.push(value);
    const baseline = await value.evidence(), initialReport = await value.healthEvidence();
    expect(initialReport).toMatchObject({ report: { status: 'ready', evaluatedAt: CONTINUITY_NOW }, reportFrozen: true, audit: [] });
    const before = appHealthSchema.parse(await value.api.health.get());
    expect(before).toMatchObject({ domainReady: true, domainStatus: 'ready', domainStartupEvaluatedAt: CONTINUITY_NOW, operationalStatus: 'ready',
      sourcing: { status: 'healthy', reasons: [], lastSuccessAgeMs: null, state: { state: 'idle', consecutiveFailures: 0, lastFailureAt: null, lastCompletedAt: null } } });
    assertOneHealthGraph(value, { credentialLoads: 0, inboxCreations: 0 });
    vi.setSystemTime(new Date(HEALTH_POLL_AT));
    // Date only is fake. pollNow owns and clears its real unref 14-minute deadline.
    // Synthetic credentials are in-memory metadata; the rejecting factory creates no inbox.
    await value.failSourcingOnce();
    const after = appHealthSchema.parse(await value.api.health.get());
    expect(after.operationalStatus).toBe('degraded');
    expect(after.sourcing).toEqual({ status: 'degraded', reasons: ['CREDENTIALS_WITHOUT_COMPLETED_POLL'], lastSuccessAgeMs: null,
      state: { state: 'idle', pollId: null, startedAt: null, lastCompletedAt: null, consecutiveFailures: 1,
        lastFailureAt: HEALTH_POLL_AT, lastFailureCode: 'POLL_FAILED', backlogCount: null } });
    expect({ ...after, operationalStatus: before.operationalStatus, sourcing: before.sourcing }).toEqual(before);
    expect(await value.healthEvidence()).toEqual(initialReport);
    expect(await value.evidence()).toEqual(baseline);
    assertOneHealthGraph(value, { credentialLoads: 1, inboxCreations: 1 });
    expect(value.counts()).toMatchObject({ domainEntries: 0, healthReads: 2 });
    expect(value.pollDiagnostics()).toEqual([{ level: 'error', eventCode: 'SOURCING_POLL_FAILED', fields: {
      component: 'sourcing-poller', pollId: 'c140fbf0-5b83-4a50-baa2-8fc06f1028fe', backlogCount: undefined, status: 'POLL_FAILED', errorClass: 'Error',
    } }]);
    expect(value.trace().map(({ channel, args, handlerStarted, outcome }) => ({ channel, args, handlerStarted, outcome }))).toEqual([
      { channel: 'health:get', args: [], handlerStarted: true, outcome: 'resolved' },
      { channel: 'health:get', args: [], handlerStarted: true, outcome: 'resolved' },
    ]);
    expect(transport.registrations).toHaveLength(20);
    const disposal = value.dispose(); expect(value.dispose()).toBe(disposal);
    expect(await disposal).toEqual({ databaseClosed: true, keysZeroed: true, directoryRemoved: true, registrationsRemaining: 0,
      pendingInvocations: 0, cleanupRuns: 1, runtimeShutdowns: 1, domainShutdowns: 1, databaseCloses: 1, pollerStops: 1, pollerIdleWaits: 1 });
    expect([...transport.removals].sort()).toEqual([...CONTINUITY_REGISTERED_CHANNELS].sort());
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
      assertOneHealthGraph(value, { credentialLoads: 0, inboxCreations: 0 });
      assertUiInventory(value, { 'health:get': 1, 'lead-detail:outbound-capabilities': 1, 'review:list': 1, 'daily:get': 1,
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
      assertUiInventory(value, { 'health:get': 3, 'lead-detail:outbound-capabilities': 1, 'review:list': 3, 'daily:get': 3,
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
      assertOneHealthGraph(value, { credentialLoads: 0, inboxCreations: 0 });
      expect(value.counts().healthReads).toBe(5);
      assertUiInventory(value, { 'health:get': 5, 'lead-detail:outbound-capabilities': 1, 'review:list': 5, 'daily:get': 5,
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
      domainBlockingViolationCount: report.report.blockingViolationCount, operationalStatus: 'ready', sourcing: { status: 'healthy', reasons: [] } });
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
    await expect(value.api.friday.getCurrent()).rejects.toThrow();
    await expect(value.api.localWorkspace.createCompany(request)).rejects.toThrow();
    expect(appHealthSchema.parse(await value.api.health.get())).toEqual(initial);
    expect(value.counts()).toMatchObject({ domainEntries: 0, healthReads: 3 });
    assertOneHealthGraph(value, { credentialLoads: 0, inboxCreations: 0 });
    expect(await value.evidence()).toEqual(baseline); expect(await value.healthEvidence()).toEqual(report);
    expect(value.trace().map(({ channel, args, handlerStarted, outcome }) => ({ channel, args, handlerStarted, outcome }))).toEqual([
      { channel: 'health:get', args: [], handlerStarted: true, outcome: 'resolved' },
      { channel: 'health:get', args: [], handlerStarted: true, outcome: 'resolved' },
      { channel: 'local-workspace:get-commitments', args: [], handlerStarted: true, outcome: 'rejected' },
      { channel: 'friday:get', args: [], handlerStarted: true, outcome: 'rejected' },
      { channel: 'local-workspace:create-company', args: [request], handlerStarted: true, outcome: 'rejected' },
      { channel: 'health:get', args: [], handlerStarted: true, outcome: 'resolved' },
    ]);
    expect([...transport.registrations].sort()).toEqual([...CONTINUITY_REGISTERED_CHANNELS].sort());
    expect(transport.registrations).toHaveLength(20);
  });
});


type FridayContext = Awaited<ReturnType<typeof renderFridayApp>>;
async function renderFridayApp() {
  const value = await createContinuityDomainFixture(transport.handlers, 'friday-ui'); fixtures.push(value);
  const owner = await value.seedFridayOwner();
  const evidence = await value.fridayEvidence();
  expect(evidence.audit).toEqual([]); expect(evidence.jobs).toEqual([]);
  expect(evidence.owner.person).toEqual({ id: owner.personId, display_name: 'Friday fictional Won owner' });
  expect(evidence.owner.source).toEqual({ id: owner.sourceEventId, person_id: owner.personId, prospect_id: null,
    channel: 'referral', original_prospect_id: owner.prospectId });
  expect(evidence.owner.prospect).toEqual({ id: owner.prospectId, person_id: owner.personId, original_source_event_id: owner.sourceEventId, segment: 'warm' });
  expect(evidence.owner.cycle).toEqual({ id: owner.cycleId, person_id: owner.personId, prospect_id: owner.prospectId,
    entry_source_event_id: owner.sourceEventId, stage: 'won', workflow_status: 'onboarding', current_next_action_id: owner.actionId, version: 7 });
  expect(evidence.owner.stages).toEqual(['unreviewed', 'ready', 'contacted', 'interviewed', 'offered', 'won'].map(to_stage => ({ to_stage })));
  expect(evidence.owner.terms).toEqual({ doors_committed: 12, billing_model: 'per_door_monthly', unit_rate_cents: 2500, projected_mrr_cents: 30000 });
  expect(evidence.owner.activities.map(row => row.id).sort()).toEqual([...owner.evidenceIds].sort());
  for (const activity of evidence.owner.activities) expect(activity).toMatchObject({ person_id: owner.personId, prospect_id: owner.prospectId,
    sales_cycle_id: owner.cycleId, occurred_at: FRIDAY_OWNER_AT });
  mountContinuityApp(value, 'friday');
  await screen.findByRole('heading', { name: 'Friday scoreboard' });
  await settleFriday(value);
  const health = value.trace().find(entry => entry.channel === 'health:get')!;
  expect(appHealthSchema.parse(health.result)).toMatchObject({ domainReady: true, domainStatus: 'ready', domainStartupEvaluatedAt: CONTINUITY_NOW });
  expect(window.location.hash).toBe('#/friday');
  const context = { value, owner, evidence };
  assertFridayInventory(context, 1, []);
  return context;
}
async function settleFriday(value: Fixture) {
  await act(async () => { await value.drainInvocations(); });
  await act(async () => { await value.drainReads(); });
}
function localFields(iso: string) {
  const value = new Date(iso), two = (n: number) => String(n).padStart(2, '0');
  return { date: `${value.getFullYear()}-${two(value.getMonth() + 1)}-${two(value.getDate())}`, time: `${two(value.getHours())}:${two(value.getMinutes())}` };
}
function fridayInput(label: string) { return screen.getByLabelText(label) as HTMLInputElement; }
function setFridayRequest(context: FridayContext) {
  const fields = localFields(FRIDAY_REQUESTED_AT);
  fireEvent.change(fridayInput('Requested date'), { target: { value: fields.date } });
  fireEvent.change(fridayInput('Requested time'), { target: { value: fields.time } });
  fireEvent.change(fridayInput('Won sales cycle (optional)'), { target: { value: context.owner.cycleId } });
  return fields;
}
function setFridayFill(jobId: string) {
  fireEvent.click(screen.getByRole('button', { name: `Fill ${jobId}` }));
  const fields = localFields(CONTINUITY_NOW);
  fireEvent.change(fridayInput('Accepted date'), { target: { value: fields.date } });
  fireEvent.change(fridayInput('Accepted time'), { target: { value: fields.time } });
  return fields;
}
function fridayCommands(value: Fixture) {
  return value.trace().filter(entry => ['friday:create-job', 'friday:fill-job', 'friday:cancel-job'].includes(entry.channel));
}
async function requestFriday(context: FridayContext) {
  setFridayRequest(context);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Request job' })); });
  await settleFriday(context.value);
  const command = fridayCommands(context.value).filter(entry => entry.channel === 'friday:create-job').at(-1)!;
  return createJobRequestSchema.parse(command.args[0]);
}
function assertFridayInventory(context: FridayContext, reports: number, commands: { channel: string; args: unknown[] }[]) {
  const { value } = context;
  expect(fridayCommands(value).map(({ channel, args }) => ({ channel, args }))).toEqual(commands);
  const counts: Record<string, number> = {};
  for (const entry of value.trace()) {
    counts[entry.channel] = (counts[entry.channel] ?? 0) + 1;
    expect(entry.handlerStarted).toBe(true); expect(entry.synthetic).toBeUndefined();
    if (entry.channel === 'lead-detail:outbound-capabilities') expect(entry.args).toEqual([{}]);
    else if (entry.channel === 'review:list') expect(entry.args).toEqual([{ kinds: [], cursor: null, limit: 1 }]);
    else if (!['friday:create-job', 'friday:fill-job', 'friday:cancel-job'].includes(entry.channel)) expect(entry.args).toEqual([]);
  }
  const mutations: Record<string, number> = {};
  for (const command of commands) mutations[command.channel] = (mutations[command.channel] ?? 0) + 1;
  expect(counts).toEqual({ 'health:get': 1, 'lead-detail:outbound-capabilities': 1, 'review:list': 1, 'friday:get': reports, ...mutations });
  expect([...transport.registrations].sort()).toEqual([...CONTINUITY_UI_REGISTERED_CHANNELS].sort()); expect(transport.registrations).toHaveLength(33);
  expect(value.uiCounters()).toEqual({ network: 0, forbidden: 0, delegationDisposals: 0 });
  assertOneHealthGraph(value, { credentialLoads: 0, inboxCreations: 0 });
}
type ExpectedFridayJob = { request: CreateJobRequest; state: 'queued' | 'succeeded' | 'cancelled'; acceptedAt: string | null };
async function assertFridayJobs(context: FridayContext, expected: ExpectedFridayJob[]) {
  const evidence = await context.value.fridayEvidence();
  expect(evidence.audit).toEqual([]); expect(evidence.owner).toEqual(context.evidence.owner);
  expect(evidence.jobs.map(row => row.id)).toEqual(expected.map(row => row.request.jobId).sort());
  for (const { request, state, acceptedAt } of expected) {
    expect(request).toEqual({ jobId: expect.any(String), salesCycleId: context.owner.cycleId, requestedAt: FRIDAY_REQUESTED_AT });
    const row = evidence.jobs.find(row => row.id === request.jobId)!;
    expect(row).toMatchObject({ id: request.jobId, type: 'founder_job_request_v1', idempotency_key: `founder-job:${request.jobId}`, state });
    expect(JSON.parse(row.payload_json)).toEqual({ formatVersion: 1, jobId: request.jobId, salesCycleId: context.owner.cycleId, requestedAt: FRIDAY_REQUESTED_AT });
    expect(row.result_json === null ? null : JSON.parse(row.result_json)).toEqual(acceptedAt === null ? null : { formatVersion: 1, contractorAcceptedAt: acceptedAt });
  }
  const lastCommand = fridayCommands(context.value).at(-1);
  if (lastCommand) expect(mutationReceiptSchema.parse(lastCommand.result).revision).toBe(evidence.changes);
  for (const entry of fridayCommands(context.value)) {
    const receipt = mutationReceiptSchema.parse(entry.result);
    expect(receipt).toEqual({ revision: expect.any(Number), affectedPersonIds: [],
      affectedSalesCycleIds: entry.channel === 'friday:create-job' ? [context.owner.cycleId] : [] });
  }
  return evidence;
}
function assertFridayHistory(context: FridayContext, expected: ExpectedFridayJob[]) {
  const read = context.value.trace().filter(entry => entry.channel === 'friday:get' && entry.outcome === 'resolved').at(-1)!;
  const report = fridayReportSchema.parse(read.result);
  expect(report.asOf).toBe(CONTINUITY_NOW);
  expect(Date.parse(FRIDAY_REQUESTED_AT)).toBeGreaterThanOrEqual(Date.parse(report.periodStartsAt));
  expect(Date.parse(CONTINUITY_NOW)).toBeLessThan(Date.parse(report.periodEndsAt));
  expect([...report.jobs].sort((a, b) => a.id.localeCompare(b.id))).toEqual(expected.map(({ request, state, acceptedAt }) => ({
    id: request.jobId, salesCycleId: request.salesCycleId, requestedAt: request.requestedAt,
    status: state === 'queued' ? 'requested' : state === 'succeeded' ? 'filled' : 'cancelled', contractorAcceptedAt: acceptedAt,
  })).sort((a, b) => a.id.localeCompare(b.id)));
  for (const { request, state } of expected) {
    const row = screen.getByText(request.jobId).closest('li')!;
    expect(row.textContent).toContain(state === 'queued' ? 'Requested' : state === 'succeeded' ? 'Filled' : 'Cancelled');
  }
}

describe('actual Friday job persistence through public UI boundaries', () => {
  it('F1 creates fills and cancels exact independently persisted jobs for one real Won owner', async () => {
    const context = await renderFridayApp(), { value } = context;
    const filled = await requestFriday(context);
    const requested: ExpectedFridayJob = { request: filled, state: 'queued', acceptedAt: null };
    await assertFridayJobs(context, [requested]); assertFridayHistory(context, [requested]);
    setFridayFill(filled.jobId);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm fill' })); }); await settleFriday(value);
    const fill = fillJobRequestSchema.parse(fridayCommands(value).at(-1)!.args[0]);
    expect(fill).toEqual({ jobId: filled.jobId, contractorAcceptedAt: CONTINUITY_NOW });
    const first: ExpectedFridayJob = { request: filled, state: 'succeeded', acceptedAt: CONTINUITY_NOW };
    await assertFridayJobs(context, [first]); assertFridayHistory(context, [first]);
    const cancelled = await requestFriday(context); expect(cancelled.jobId).not.toBe(filled.jobId);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `Cancel ${cancelled.jobId}` })); }); await settleFriday(value);
    const cancel = cancelJobRequestSchema.parse(fridayCommands(value).at(-1)!.args[0]); expect(cancel).toEqual({ jobId: cancelled.jobId });
    const last: ExpectedFridayJob = { request: cancelled, state: 'cancelled', acceptedAt: null };
    await assertFridayJobs(context, [first, last]); assertFridayHistory(context, [first, last]);
    expect(screen.getByText('Saved')).not.toBeNull();
    assertFridayInventory(context, 5, [
      { channel: 'friday:create-job', args: [filled] }, { channel: 'friday:fill-job', args: [fill] },
      { channel: 'friday:create-job', args: [cancelled] }, { channel: 'friday:cancel-job', args: [cancel] },
    ]);
    expect(value.trace().every(entry => entry.outcome === 'resolved')).toBe(true);
  });

  it('F2 explicitly retries identical create fill and cancel after real commits lose delivery', async () => {
    const context = await renderFridayApp(), { value } = context;
    const control = await requestFriday(context);
    const unchanged: ExpectedFridayJob = { request: control, state: 'queued', acceptedAt: null };
    const controlRow = (await assertFridayJobs(context, [unchanged])).jobs[0]!;
    const createHold = value.holdNextFridayMutation(), fields = setFridayRequest(context);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Request job' })); expect(await createHold.arrival).not.toBeNull(); });
    const target = createJobRequestSchema.parse(fridayCommands(value).at(-1)!.args[0]); expect(target.jobId).not.toBe(control.jobId);
    const requested: ExpectedFridayJob = { request: target, state: 'queued', acceptedAt: null };
    const createSaved = await assertFridayJobs(context, [unchanged, requested]);
    await act(async () => { createHold.reject(); }); await settleFriday(value);
    expect(screen.getByText('The change could not be confirmed. Your input is kept. Review the job before retrying.')).not.toBeNull();
    expect(fridayInput('Requested date').value).toBe(fields.date); expect(fridayInput('Requested time').value).toBe(fields.time);
    expect(fridayInput('Won sales cycle (optional)').value).toBe(context.owner.cycleId);
    assertFridayInventory(context, 2, [{ channel: 'friday:create-job', args: [control] }, { channel: 'friday:create-job', args: [target] }]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); }); await settleFriday(value);
    expect((await assertFridayJobs(context, [unchanged, requested])).jobs).toEqual(createSaved.jobs);
    expect(fridayInput('Requested date').value).toBe(''); expect(fridayInput('Requested time').value).toBe('');
    expect(fridayInput('Won sales cycle (optional)').value).toBe('');
    const fillHold = value.holdNextFridayMutation(), accepted = setFridayFill(target.jobId);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm fill' })); expect(await fillHold.arrival).not.toBeNull(); });
    const fill = fillJobRequestSchema.parse(fridayCommands(value).at(-1)!.args[0]); expect(fill).toEqual({ jobId: target.jobId, contractorAcceptedAt: CONTINUITY_NOW });
    const filled: ExpectedFridayJob = { request: target, state: 'succeeded', acceptedAt: CONTINUITY_NOW };
    const fillSaved = await assertFridayJobs(context, [unchanged, filled]);
    await act(async () => { fillHold.reject(); }); await settleFriday(value);
    expect(screen.getByText('The change could not be confirmed. Your input is kept. Review the job before retrying.')).not.toBeNull();
    expect(fridayInput('Accepted date').value).toBe(accepted.date); expect(fridayInput('Accepted time').value).toBe(accepted.time);
    expect(screen.getByRole('group', { name: `Fill ${target.jobId}` })).not.toBeNull();
    expect(value.trace().filter(entry => entry.channel === 'friday:get')).toHaveLength(3); expect(fridayCommands(value)).toHaveLength(4);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); }); await settleFriday(value);
    expect((await assertFridayJobs(context, [unchanged, filled])).jobs).toEqual(fillSaved.jobs);
    expect(screen.queryByRole('group', { name: `Fill ${target.jobId}` })).toBeNull();
    const cancelTarget = await requestFriday(context);
    expect(new Set([control.jobId, target.jobId, cancelTarget.jobId]).size).toBe(3);
    const cancelHold = value.holdNextFridayMutation();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `Cancel ${cancelTarget.jobId}` })); expect(await cancelHold.arrival).not.toBeNull(); });
    const cancel = cancelJobRequestSchema.parse(fridayCommands(value).at(-1)!.args[0]); expect(cancel).toEqual({ jobId: cancelTarget.jobId });
    const cancelled: ExpectedFridayJob = { request: cancelTarget, state: 'cancelled', acceptedAt: null };
    const cancelSaved = await assertFridayJobs(context, [unchanged, filled, cancelled]);
    await act(async () => { cancelHold.reject(); }); await settleFriday(value);
    expect(screen.getByText('The change could not be confirmed. Your input is kept. Review the job before retrying.')).not.toBeNull();
    expect(value.trace().filter(entry => entry.channel === 'friday:get')).toHaveLength(5); expect(fridayCommands(value)).toHaveLength(7);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); }); await settleFriday(value);
    const final = await assertFridayJobs(context, [unchanged, filled, cancelled]); expect(final.jobs).toEqual(cancelSaved.jobs);
    expect(final.jobs.find(row => row.id === control.jobId)).toEqual(controlRow);
    assertFridayHistory(context, [unchanged, filled, cancelled]);
    assertFridayInventory(context, 6, [
      { channel: 'friday:create-job', args: [control] }, { channel: 'friday:create-job', args: [target] }, { channel: 'friday:create-job', args: [target] },
      { channel: 'friday:fill-job', args: [fill] }, { channel: 'friday:fill-job', args: [fill] },
      { channel: 'friday:create-job', args: [cancelTarget] }, { channel: 'friday:cancel-job', args: [cancel] }, { channel: 'friday:cancel-job', args: [cancel] },
    ]);
    expect(value.trace().filter(entry => entry.outcome === 'rejected').map(entry => entry.channel)).toEqual(['friday:create-job', 'friday:fill-job', 'friday:cancel-job']);
  });

  it('F3 keeps Saved and a new draft while an acknowledged mutation report is held rejected and refreshed', async () => {
    const context = await renderFridayApp(), { value } = context;
    setFridayRequest(context); const reportHold = value.holdFridayReport();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Request job' })); expect(await reportHold.arrival).not.toBeNull(); });
    const request = createJobRequestSchema.parse(fridayCommands(value).at(-1)!.args[0]);
    const expected: ExpectedFridayJob = { request, state: 'queued', acceptedAt: null };
    expect(screen.getByText('Saved')).not.toBeNull();
    expect(fridayInput('Requested date').value).toBe(''); expect(fridayInput('Requested time').value).toBe('');
    expect(fridayInput('Won sales cycle (optional)').value).toBe('');
    const committed = await assertFridayJobs(context, [expected]);
    expect(value.trace().filter(entry => entry.channel === 'friday:get').map(entry => entry.outcome)).toEqual(['resolved', 'pending']);
    const newFields = localFields('2026-09-10T14:45:00.000Z');
    fireEvent.change(fridayInput('Requested date'), { target: { value: newFields.date } });
    fireEvent.change(fridayInput('Requested time'), { target: { value: newFields.time } });
    fireEvent.change(fridayInput('Won sales cycle (optional)'), { target: { value: 'new unsent draft cycle' } });
    const assertDraft = () => {
      expect(fridayInput('Requested date').value).toBe(newFields.date); expect(fridayInput('Requested time').value).toBe(newFields.time);
      expect(fridayInput('Won sales cycle (optional)').value).toBe('new unsent draft cycle');
    };
    assertDraft();
    await act(async () => { reportHold.reject(); }); await settleFriday(value);
    expect(screen.getByText('Saved; scoreboard refresh failed')).not.toBeNull(); assertDraft();
    expect(await assertFridayJobs(context, [expected])).toEqual(committed);
    assertFridayInventory(context, 2, [{ channel: 'friday:create-job', args: [request] }]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh jobs' })); }); await settleFriday(value);
    expect(screen.getByText('Saved')).not.toBeNull(); assertDraft(); assertFridayHistory(context, [expected]);
    expect(await assertFridayJobs(context, [expected])).toEqual(committed);
    assertFridayInventory(context, 3, [{ channel: 'friday:create-job', args: [request] }]);
    expect(value.trace().filter(entry => entry.outcome === 'rejected').map(entry => entry.channel)).toEqual(['friday:get']);
  });
});
