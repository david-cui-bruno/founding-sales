// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';

import type { LeadDetail } from '../../shared/contracts/leadDetailContract';
import type { CalliePreloadApi } from '../../shared/preload';
import type { AppHealth } from '../../shared/healthContract';
import { dailyFixture, localSnapshot, commitments, fixtureNow } from '../features/today/nativeDesk.fixture';
import type { FoundationHealth } from '../foundation/useFoundationHealth';
import { FounderApp, type FounderAppProps } from './FounderApp';
import { useTheme } from './useTheme';
import { useDensity } from './useDensity';
import { PresentationRoot } from './PresentationRoot';

function FounderAppHarness(props: Omit<FounderAppProps, 'theme' | 'density'>) {
  const theme = useTheme();
  const density = useDensity();
  return <PresentationRoot><FounderApp {...props} theme={theme} density={density} /></PresentationRoot>;
}

/** Route links live in the primary rail; workspace bodies carry their own in-page links. */
const primaryNavigation = () => within(screen.getByRole('navigation', { name: 'Primary' }));
const navLink = (name: 'Today' | 'Accounts' | 'Campaigns' | 'Settings') => primaryNavigation().getByRole('link', { name });

const detail: LeadDetail = {
  personId: 'person-kevin',
  salesCycleId: 'cycle-kevin',
  personName: 'Kevin Shin',
  phones: [],
  emails: [],
  organizationLabel: null,
  propertySummaries: [],
  stage: 'ready',
  workflowStatus: 'active',
  sourceLabel: 'frbo',
  segment: 'hot',
  cloudScores: null,
  cloudLinked: false,
  findContactEligibility: { eligible: false, refusalReason: 'qualification_required' },
  priorityContext: null,
  priorityReasons: ['Direct phone on file'],
  nextAction: null,
  optedOut: false,
  cadence: null,
  outboundAttempts: [],
  activities: [],
  conversations: [],
  properties: [],
  history: [],
  revision: 0,
};

const LEGACY_HASHES = ['leads', 'pipeline', 'conversations', 'learnings', 'friday', 'inbox', 'review'] as const;

function fakeCallieApi(): CalliePreloadApi {
  const pending = vi.fn(() => new Promise<never>(() => undefined));
  return {
    health: { get: vi.fn(async () => healthValue) },
    daily: { get: vi.fn(async () => dailyFixture()) },
    localWorkspace: {
      get: vi.fn(async () => localSnapshot()),
      getCompany: pending,
      researchCompany: pending, getCompanyResearchStatus: pending, prepareCompanyDraft: async () => { throw Error('Company preparation unavailable in this fixture'); }, admitCompanyDraftEmail: async () => { throw Error('Company drafts unavailable in this fixture'); }, openCompanyDraft: async () => { throw Error('Company drafts unavailable in this fixture'); }, getCompanyDraft: async () => { throw Error('Company drafts unavailable in this fixture'); }, saveCompanyDraft: async () => { throw Error('Company drafts unavailable in this fixture'); }, getCompanyResearchSettings: pending, updateCompanyResearchSettings: pending, getCallSettings: async () => { throw Error('Call capacity unavailable in this fixture'); }, updateCallSettings: async () => { throw Error('Call capacity unavailable in this fixture'); }, linkCompanyPerson: pending,
      getCommitments: vi.fn(async () => commitments()),
      reviewCompany: pending, createCompany: pending, getCompanyCreateStatus: pending, transition: pending,
    },
    delegation: {
      getAccountPreparation: pending,
      status: vi.fn(async () => ({ state: 'unconfigured' as const, workspaceId: null, endpoint: null, configuration: null })),
      policyImport: { selectAndPreview: pending, confirm: pending, resume: pending, status: pending },
      prepareRequestedFollowup: pending, getRequestedFollowup: pending, editRequestedFollowup: pending, approveRequestedFollowup: pending,
      reconcileReplyDraft: pending, editReplyDraft: pending, getPhoneHandoffState: pending, beginPhone: pending, bootstrap: pending, configurePolicy: pending, configureResearch: pending, pair: pending, pairing: pending, rotatePairing: pending, configure: pending, submit: pending, sync: pending,
    },
    phoneSetup: { status: pending, confirm: pending, clear: pending },
    outreach: {
      status: vi.fn(async () => ({ model: 'unconfigured' as const, modelName: '', gmail: 'unconfigured' as const, accountEmail: null, senderName: '', postalAddress: '' })),
      configure: pending, connectGmail: pending, disconnectGmail: pending, openDraft: pending, saveDraft: pending, generateDraft: pending, sendDraft: pending,
      inspectLocalAuthority: vi.fn(() => new Promise<never>(() => undefined)),
    },
    leads: {
      list: vi.fn(async () => ({
        rows: [], nextCursor: null, total: 0, revision: 0,
      })),
    },
    leadDetail: {
      get: vi.fn(async () => detail),
    },
    shell: { revealDatabase: pending, revealLogDirectory: pending },
    recovery: { status: pending, beginSetup: pending, saveSetupMaterial: pending, completeSetup: pending, selectAndRunRestoreDrill: pending },
  };
}

const healthValue: AppHealth = {
  appVersion: '1.0.0', schemaVersion: 24, databasePath: '/synthetic/foundation.sqlite3', databaseEncrypted: true,
  cipherVersion: 'synthetic', fts5Available: true, pendingJobs: 0, interruptedJobsRecovered: 0,
  domainStatus: 'ready', domainReady: true, domainBlockingViolationCount: 0, domainRepairableIssueCount: 0,
  domainProjectionRefreshCandidateCount: 0, pendingProjectionRebuilds: 0, domainStartupEvaluatedAt: fixtureNow,
};
const readyHealth: FoundationHealth = {
  status: 'ready',
  health: healthValue,
  retry: vi.fn(),
};

// jsdom lacks the native dialog API. Model open state only here, as the
// palette tests do. Packaged bauhausWorkflow verifies real modal behavior.
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) { this.setAttribute('open', ''); },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) { this.removeAttribute('open'); },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  window.location.hash = '';
});

describe('FounderApp', () => {
  it('defaults to the Today route inside the navigation shell', async () => {
    window.location.hash = '';
    const api = fakeCallieApi();
    render(<FounderAppHarness api={api} health={readyHealth} />);

    expect(screen.getByRole('navigation', { name: 'Primary' })).not.toBeNull();
    expect(
      navLink('Today').getAttribute('aria-current'),
    ).toBe('page');
    expect(await screen.findByTestId('native-desk')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Today' })).toBeTruthy();
    expect(screen.queryByTestId('today-route')).toBeNull();
    expect(api.daily.get).toHaveBeenCalled();
    expect(api.localWorkspace.get).toHaveBeenCalled();
    expect(api.leads.list).not.toHaveBeenCalled();
    expect(api.leadDetail.get).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.presentation-root[data-presentation="native-a"]')).toHaveLength(1);
  });

  it.each(LEGACY_HASHES)('lands the removed #/%s hash on Today with no legacy navigation left', async (legacy) => {
    window.location.hash = `#/${legacy}`;
    const api = fakeCallieApi();
    render(<FounderAppHarness api={api} health={readyHealth} />);

    expect(await screen.findByTestId('native-desk')).toBeTruthy();
    expect(navLink('Today').getAttribute('aria-current')).toBe('page');
    expect(primaryNavigation().getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Today', 'Accounts', 'Campaigns', 'Settings',
    ]);
    expect(screen.getByRole('link', { name: 'Skip to content' }).getAttribute('href')).toBe('#main-content');
    expect(screen.queryByRole('button', { name: 'More workspaces' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.leads.list).not.toHaveBeenCalled();
  });

  it('offers only the four company-model destinations from the command palette', async () => {
    window.location.hash = '';
    render(<FounderAppHarness api={fakeCallieApi()} health={readyHealth} />);
    await screen.findByTestId('native-desk');

    fireEvent.keyDown(window, { key: 'k', metaKey: true, ctrlKey: true });
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    expect(within(palette).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Go to Today', 'Go to Accounts', 'Go to Campaigns', 'Go to Settings',
    ]);
    fireEvent.change(within(palette).getByRole('combobox'), { target: { value: 'Accounts' } });
    fireEvent.keyDown(within(palette).getByRole('combobox'), { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull());
    expect(navLink('Accounts').getAttribute('aria-current')).toBe('page');
    expect(window.location.hash).toBe('#/accounts');
    expect(await screen.findByRole('heading', { level: 1, name: 'Accounts' })).toBeTruthy();
  });

  it('keeps the local company draft across real Accounts route navigation', async () => {
    window.location.hash = '#/accounts';
    const api = fakeCallieApi();
    api.localWorkspace.reviewCompany = vi.fn<CalliePreloadApi['localWorkspace']['reviewCompany']>(() => new Promise(() => undefined));
    api.localWorkspace.createCompany = vi.fn<CalliePreloadApi['localWorkspace']['createCompany']>(() => new Promise(() => undefined));
    render(<FounderAppHarness api={api} health={readyHealth} />);

    const addCompany = await screen.findByRole('button', { name: 'Add company' });
    await waitFor(() => expect((addCompany as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(addCompany);
    fireEvent.change(screen.getByRole('textbox', { name: 'Company name' }), {
      target: { value: ' Harbor Management ' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Company domain (optional)' }), {
      target: { value: ' HARBOR.EXAMPLE ' },
    });

    fireEvent.click(navLink('Campaigns'));
    await screen.findByRole('heading', { name: 'Campaigns' });
    fireEvent.click(navLink('Today'));
    await screen.findByRole('heading', { level: 1, name: 'Today' });
    fireEvent.click(navLink('Accounts'));

    expect(((await screen.findByRole('textbox', { name: 'Company name' })) as HTMLInputElement).value).toBe(' Harbor Management ');
    expect((screen.getByRole('textbox', { name: 'Company domain (optional)' }) as HTMLInputElement).value).toBe(' HARBOR.EXAMPLE ');
    expect(api.localWorkspace.reviewCompany).not.toHaveBeenCalled();
    expect(api.localWorkspace.createCompany).not.toHaveBeenCalled();
  });
});

it('uses the required external appearance states and setters in Settings', async () => {
  window.location.hash = '#/settings';
  const theme = { preference: 'dark' as const, resolvedTheme: 'dark' as const, setPreference: vi.fn() };
  const density = { density: 'compact' as const, setDensity: vi.fn() };
  render(<PresentationRoot><FounderApp api={fakeCallieApi()} health={readyHealth} theme={theme} density={density} initialRoute="settings" /></PresentationRoot>);
  fireEvent.click(await screen.findByRole('button', { name: 'Appearance' }));
  const dark = screen.getByRole('button', { name: 'Dark appearance' });
  expect(dark.getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: 'Compact density' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Light appearance' }));
  fireEvent.click(screen.getByRole('button', { name: 'Comfortable density' }));
  expect(theme.setPreference).toHaveBeenCalledWith('light');
  expect(density.setDensity).toHaveBeenCalledWith('comfortable');
});
it('preserves the mounted Native Desk node when external appearance states change', async () => {
  const api = fakeCallieApi();
  const theme = { preference: 'dark' as const, resolvedTheme: 'dark' as const, setPreference: vi.fn() };
  const density = { density: 'compact' as const, setDensity: vi.fn() };
  const view = render(<PresentationRoot><FounderApp api={api} health={readyHealth} theme={theme} density={density} /></PresentationRoot>);
  const desk = await screen.findByTestId('native-desk');
  const reads = vi.mocked(api.daily.get).mock.calls.length;
  view.rerender(<PresentationRoot><FounderApp api={api} health={readyHealth} theme={{ ...theme, preference: 'light', resolvedTheme: 'light' }} density={{ ...density, density: 'comfortable' }} /></PresentationRoot>);
  expect(screen.getByTestId('native-desk')).toBe(desk);
  expect(api.daily.get).toHaveBeenCalledTimes(reads);
});

// Real routeRegistry and real hash routing, not a synthetic form key.
describe('FounderApp company phase continuity', () => {
  it.each(['reviewed', 'reviewing', 'creating', 'unknown', 'conflict'] as const)('retains %s across actual route navigation without intake replay', async (phase) => {
    window.location.hash = '#/accounts';
    const api = fakeCallieApi();
    type Review = Awaited<ReturnType<CalliePreloadApi['localWorkspace']['reviewCompany']>>;
    type Result = Awaited<ReturnType<CalliePreloadApi['localWorkspace']['createCompany']>>;
    let resolveReview!: (value: Review) => void;
    let resolveCreate!: (value: Result) => void;
    const pendingReview = new Promise<Review>(resolve => { resolveReview = resolve; });
    const pendingCreate = new Promise<Result>(resolve => { resolveCreate = resolve; });
    const input = { name: 'Harbor Management', domain: 'harbor.example' };
    const reviewed: Review = { scope: 'local_database', input, complete: true, candidates: [] };
    api.localWorkspace.reviewCompany = vi.fn<CalliePreloadApi['localWorkspace']['reviewCompany']>(async () => phase === 'reviewing' ? pendingReview : reviewed);
    api.localWorkspace.createCompany = vi.fn<CalliePreloadApi['localWorkspace']['createCompany']>(async request => {
      if (phase === 'unknown') throw new Error('unconfirmed');
      if (phase === 'conflict') return { status: 'command_conflict', commandId: request.commandId };
      return pendingCreate;
    });
    api.localWorkspace.getCompanyCreateStatus = vi.fn<CalliePreloadApi['localWorkspace']['getCompanyCreateStatus']>(async request => ({ status: 'not_recorded', commandId: request.commandId }));
    render(<FounderAppHarness api={api} health={readyHealth} />);
    const add = await screen.findByRole('button', { name: 'Add company' });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(add);
    fireEvent.change(screen.getByRole('textbox', { name: 'Company name' }), { target: { value: ' Harbor Management ' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Company domain (optional)' }), { target: { value: ' HARBOR.EXAMPLE ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review company' }));
    if (phase === 'reviewing') await screen.findByText('Reviewing local companies…');
    else {
      await screen.findByText('No matching companies in the current local review.');
      if (phase !== 'reviewed') {
        fireEvent.click(screen.getByRole('button', { name: 'Create company' }));
        await screen.findByText(phase === 'creating' ? 'Saving company…' : phase === 'unknown' ? /Save outcome unknown/ : /Command conflict/);
      }
    }
    const commands = { review: vi.mocked(api.localWorkspace.reviewCompany).mock.calls.length, create: vi.mocked(api.localWorkspace.createCompany).mock.calls.length, status: vi.mocked(api.localWorkspace.getCompanyCreateStatus).mock.calls.length };
    const request = vi.mocked(api.localWorkspace.createCompany).mock.calls[0]?.[0];
    fireEvent.click(navLink('Campaigns'));
    await screen.findByRole('heading', { name: 'Campaigns' });
    expect(screen.queryByRole('textbox', { name: 'Company name' })).toBeNull();
    fireEvent.click(navLink('Today')); await screen.findByRole('heading', { level: 1, name: 'Today' });
    fireEvent.click(navLink('Accounts'));
    const name = await screen.findByRole('textbox', { name: 'Company name' });
    expect((name as HTMLInputElement).value).toBe(phase === 'reviewing' ? ' Harbor Management ' : input.name);
    expect((screen.getByRole('textbox', { name: 'Company domain (optional)' }) as HTMLInputElement).value).toBe(phase === 'reviewing' ? ' HARBOR.EXAMPLE ' : input.domain);
    const close = screen.getByRole('button', { name: 'Close company form' }) as HTMLButtonElement;
    expect(close.disabled).toBe(['creating', 'unknown', 'conflict'].includes(phase));
    if (phase === 'reviewed') await waitFor(() => expect((screen.getByRole('button', { name: 'Create company' }) as HTMLButtonElement).disabled).toBe(false));
    else await screen.findByText(phase === 'reviewing' ? 'Reviewing local companies…' : phase === 'creating' ? 'Saving company…' : phase === 'unknown' ? /Save outcome unknown/ : /Command conflict/);
    expect(api.localWorkspace.reviewCompany).toHaveBeenCalledTimes(commands.review);
    expect(api.localWorkspace.createCompany).toHaveBeenCalledTimes(commands.create);
    expect(api.localWorkspace.getCompanyCreateStatus).toHaveBeenCalledTimes(commands.status);
    if (phase === 'reviewing') {
      await act(async () => { resolveReview(reviewed); });
      expect(await screen.findByText('No matching companies in the current local review.')).toBeTruthy();
    } else if (phase === 'creating') {
      await act(async () => { resolveCreate({ status: 'command_conflict', commandId: request!.commandId }); });
      expect(await screen.findByText(/Command conflict/)).toBeTruthy();
      expect((screen.getByRole('button', { name: 'Close company form' }) as HTMLButtonElement).disabled).toBe(true);
    } else if (phase === 'unknown') {
      await waitFor(() => expect((screen.getByRole('button', { name: 'Check save status' }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByRole('button', { name: 'Check save status' })); await screen.findByText(/not recorded yet/);
      expect(vi.mocked(api.localWorkspace.getCompanyCreateStatus).mock.calls).toEqual([[request]]);
      expect(request).toEqual({ ...input, commandId: expect.stringMatching(/^[a-f\d-]{36}$/) });
      expect(api.localWorkspace.createCompany).toHaveBeenCalledOnce();
    }
  });
});


// Task 4 additive public composition tests. No new-module import: baseline can reach missing UI.
import type { LocalCompanyDetail, LocalCompanyResearchStatus, SelectedResearch } from '../../shared/contracts/localWorkspaceContract';
const f4AppReleases: Array<() => void> = [];
const f4AppPending: Promise<unknown>[] = [];
function f4AppDeferred<T>(fallback: T) { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); f4AppReleases.push(() => resolve(fallback)); f4AppPending.push(promise); return { promise, resolve }; }
afterEach(async () => { try { cleanup(); } finally { try { await act(async () => { for (const release of f4AppReleases.splice(0)) release(); await Promise.allSettled(f4AppPending.splice(0)); }); } finally { vi.restoreAllMocks(); } } });
function f4AppDetail(accountId = 'a'): LocalCompanyDetail {
  const snapshot = structuredClone(dailyFixture().accounts.find(item => item.account.id === accountId)!);
  snapshot.portfolio = []; snapshot.claims = []; snapshot.routes = [];
  return { scope: 'local_database', generatedAt: fixtureNow, snapshot, sources: [{ id: `first-use-${accountId}`, url: `https://${accountId}.example/source`, fetchedAt: fixtureNow, sha256: 'd'.repeat(64), excerpt: `Founder selected source ${accountId}`, permitted: true }], links: [] };
}
function f4AppStatus(r: SelectedResearch, state: LocalCompanyResearchStatus['state']): LocalCompanyResearchStatus { return { ...r, state, receipt: state === 'completed' ? { accountId: r.accountId, version: 2, duplicate: false } : null, reason: null }; }
function f4FounderApi() {
  const api = fakeCallieApi();
  // Explicit legacy research: no standalone configuration, paired policy remains authoritative.
  api.localWorkspace.getCompanyResearchSettings = vi.fn(async () => ({ revision: 0, configuration: null, profiles: [], blockedReason: 'paired_research_present' as const, reservedOrSpentMicros: 0 }));
  vi.mocked(api.daily.get).mockResolvedValue(dailyFixture());
  vi.mocked(api.localWorkspace.get).mockResolvedValue(localSnapshot({ accounts: { state: 'available', snapshots: dailyFixture().accounts } }));
  api.localWorkspace.getCompany = vi.fn<CalliePreloadApi['localWorkspace']['getCompany']>(async ({ accountId }) => f4AppDetail(accountId));
  api.localWorkspace.researchCompany = vi.fn<CalliePreloadApi['localWorkspace']['researchCompany']>(async r => f4AppStatus(r, 'held'));
  api.localWorkspace.getCompanyResearchStatus = vi.fn<CalliePreloadApi['localWorkspace']['getCompanyResearchStatus']>(async r => f4AppStatus(r, 'not_recorded'));
  return api;
}

it('F4-founder-01 selecting a real local row exposes explicit Research through FounderApp routes', async () => {
  const api = f4FounderApi(); render(<FounderAppHarness api={api} health={readyHealth} initialRoute="accounts" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Local account · Account A' }));
  expect(await screen.findByRole('button', { name: /^Research(?: company)?$/i })).toBeTruthy();
  expect(await screen.findByText('Founder selected source a')).toBeTruthy();
  expect(api.localWorkspace.getCompany).toHaveBeenCalledWith({ accountId: 'a' }); expect(api.localWorkspace.researchCompany).not.toHaveBeenCalled();
}, 10_000);

it('F4-founder-02 Campaigns and back retain selected local account and the same pending request without automatic execution', async () => {
  const api = f4FounderApi(); const r = { accountId: 'a', commandId: '10000000-0000-4000-8000-000000000001' };
  const gate = f4AppDeferred(f4AppStatus(r, 'completed')); const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue('10000000-0000-4000-8000-000000000001');
  api.localWorkspace.researchCompany = vi.fn<CalliePreloadApi['localWorkspace']['researchCompany']>(() => gate.promise);
  render(<StrictMode><FounderAppHarness api={api} health={readyHealth} initialRoute="accounts" /></StrictMode>);
  fireEvent.click(await screen.findByRole('button', { name: 'Local account · Account A' })); await screen.findByText('Founder selected source a');
  await screen.findByText('Existing paired research remains governed by its policy. Standalone local activation is unavailable.');
  const research = screen.getByRole('button', { name: /^Research(?: company)?$/i }); act(() => { fireEvent.click(research); fireEvent.click(research); });
  expect(api.localWorkspace.researchCompany).toHaveBeenCalledOnce(); const original = vi.mocked(api.localWorkspace.researchCompany).mock.calls[0][0];
  fireEvent.click(navLink('Campaigns')); await screen.findByRole('heading', { level: 1, name: 'Campaigns' });
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  fireEvent.click(navLink('Accounts')); await screen.findByText('Founder selected source a');
  expect(screen.getByRole('button', { name: 'Local account · Account A' }).getAttribute('aria-current')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: /^Research(?: company)?$/i })); expect(api.localWorkspace.researchCompany).toHaveBeenCalledOnce(); expect(uuid).toHaveBeenCalledOnce();
  await act(async () => gate.resolve(f4AppStatus(original, 'completed'))); expect(await screen.findByText(/^Research known · completed$/)).toBeTruthy();
  expect(vi.mocked(api.localWorkspace.researchCompany).mock.calls[0][0]).toBe(original);
}, 10_000);

it('F4-founder-03 palette Escape does not close selected research or resume its pending request', async () => {
  const api = f4FounderApi(); const r = { accountId: 'a', commandId: '10000000-0000-4000-8000-000000000001' };
  const gate = f4AppDeferred(f4AppStatus(r, 'completed')); vi.spyOn(crypto, 'randomUUID').mockReturnValue('10000000-0000-4000-8000-000000000001'); api.localWorkspace.researchCompany = vi.fn<CalliePreloadApi['localWorkspace']['researchCompany']>(() => gate.promise);
  render(<FounderAppHarness api={api} health={readyHealth} initialRoute="accounts" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Local account · Account A' })); await screen.findByText('Founder selected source a');
  await screen.findByText('Existing paired research remains governed by its policy. Standalone local activation is unavailable.');
  const research = screen.getByRole('button', { name: /^Research(?: company)?$/i }); fireEvent.click(research);
  fireEvent.keyDown(window, { key: 'k', metaKey: true, ctrlKey: true }); const palette = await screen.findByRole('dialog', { name: 'Command palette' });
  fireEvent.keyDown(within(palette).getByRole('combobox'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull());
  expect(screen.getByText('Founder selected source a')).toBeTruthy(); expect(api.localWorkspace.researchCompany).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Local account · Account A' }).getAttribute('aria-current')).toBe('true');
  await act(async () => gate.resolve(f4AppStatus(r, 'completed'))); expect(await screen.findByText(/^Research known · completed$/)).toBeTruthy();
}, 10_000);

it('F4-founder-04 intake Open account selects the same research detail rather than a worker account', async () => {
  const api = f4FounderApi(); const newSnapshot = f4AppDetail('a').snapshot;
  newSnapshot.account = { id: 'new-local', name: 'New Local Company', domain: 'new.example', version: 1 };
  let saved = false;
  api.localWorkspace.get = vi.fn<CalliePreloadApi['localWorkspace']['get']>(async () => localSnapshot({ accounts: { state: 'available', snapshots: saved ? [...dailyFixture().accounts, newSnapshot] : dailyFixture().accounts } }));
  api.localWorkspace.reviewCompany = vi.fn<CalliePreloadApi['localWorkspace']['reviewCompany']>(async input => ({ scope: 'local_database', input, candidates: [], complete: true }));
  api.localWorkspace.createCompany = vi.fn<CalliePreloadApi['localWorkspace']['createCompany']>(async input => { saved = true; return { status: 'saved', commandId: input.commandId, account: newSnapshot.account, replayed: false }; });
  api.localWorkspace.getCompany = vi.fn<CalliePreloadApi['localWorkspace']['getCompany']>(async ({ accountId }) => accountId === 'new-local' ? { ...f4AppDetail('a'), snapshot: newSnapshot } : f4AppDetail(accountId));
  render(<FounderAppHarness api={api} health={readyHealth} initialRoute="accounts" />);
  const add = await screen.findByRole('button', { name: 'Add company' }); await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(add);
  fireEvent.change(screen.getByRole('textbox', { name: 'Company name' }), { target: { value: 'New Local Company' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Company domain (optional)' }), { target: { value: 'new.example' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review company' })); const create = await screen.findByRole('button', { name: 'Create company' });
  await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(create);
  await waitFor(() => expect(api.localWorkspace.getCompany).toHaveBeenCalledWith({ accountId: 'new-local' }));
  expect(screen.getByRole('button', { name: 'Local account · New Local Company' }).getAttribute('aria-current')).toBe('true');
  expect(await screen.findByRole('button', { name: /^Research(?: company)?$/i })).toBeTruthy(); expect(api.localWorkspace.researchCompany).not.toHaveBeenCalled();
}, 10_000);


// Task 6 additive actual FounderApp composition. No ContactLink or new owner imports.
// APIs below are fake projections. The saved-person finder is the real one.
const t6AppQuote = 'Avery manages Account A. Office team: office@a.example.';
function t6AppCompany(): LocalCompanyDetail { const value = f4AppDetail(); value.sources[0].excerpt = t6AppQuote; return value; }
function t6AppPerson(): LeadDetail {
  return { ...structuredClone(detail), personId: 'person-51', personName: 'Avery', salesCycleId: 'cycle-51', organizationLabel: 'Shared Organization', emails: [{ id: 'method-person-51', contactSnapshot: 'b'.repeat(64), kind: 'email', value: 'avery@example.test', label: 'User supplied', valid: true, validationState: 'valid', reachability: 'direct', sourceLabel: 'Imported spreadsheet', vendorRank: null, phoneKind: null, ownershipState: 'unknown', evidenceObservedAt: null, compliance: null }] };
}
function t6AppRows(start: number, count: number): Awaited<ReturnType<CalliePreloadApi['leads']['list']>>['rows'] {
  return Array.from({ length: count }, (_, i): Awaited<ReturnType<CalliePreloadApi['leads']['list']>>['rows'][number] => { const n = start + i; return { personId: `person-${n}`, personName: n === 1 || n === 51 ? 'Avery' : `Person ${n}`, salesCycleId: `cycle-${n}`, initials: 'AV', organization: 'Shared Organization', propertySummary: null, stage: 'ready', source: 'custom', segment: 'warm', priorityContext: null, cloudScores: null, nextAction: null, optedOut: false, lastActivityAt: null }; });
}
async function t6AppFillReview() {
  fireEvent.change(screen.getByRole('textbox', { name: 'Role' }), { target: { value: 'Manager' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Relationship' }), { target: { value: 'Manages company' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Source quotation' }), { target: { value: t6AppQuote } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'I confirm this saved person and quoted relationship' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Link saved person' }) as HTMLButtonElement).disabled).toBe(false));
}
it('T6-A01 explicit person51 selection through the saved-person finder links once and lists the stored link with no open or import control', async () => {
  const api = f4FounderApi(); let linked = false; const company = t6AppCompany();
  api.localWorkspace.getCompany = vi.fn<CalliePreloadApi['localWorkspace']['getCompany']>(async () => ({ ...company, links: linked ? [{ id: 'stored-person-link', kind: 'person_role', personId: 'person-51', role: 'Manager', relationship: 'Manages company', evidenceIds: ['first-use-a'], authority: 'unconfirmed', authorityEvidenceIds: [], validFrom: fixtureNow, validTo: null }] : [] }));
  api.localWorkspace.linkCompanyPerson = vi.fn<CalliePreloadApi['localWorkspace']['linkCompanyPerson']>(async input => { linked = true; return { accountId: input.accountId, version: 2, duplicate: false }; });
  api.leads.list = vi.fn<CalliePreloadApi['leads']['list']>(async input => ({ rows: input.cursor === null ? t6AppRows(1, 50) : t6AppRows(51, 2), nextCursor: input.cursor === null ? 'opaque-person-page-2' : null, total: 52, revision: 2 }));
  const savedPeople = [t6AppPerson(), { ...t6AppPerson(), personId: 'person-52' }];
  const peopleBefore = structuredClone(savedPeople);
  api.leadDetail.get = vi.fn<CalliePreloadApi['leadDetail']['get']>(async ({ personId }) => structuredClone(savedPeople.find(person => person.personId === personId)!));
  // Inventory only local reads, not provider work or settings mutations.
  const safeLocalReads = new Set(['get', 'getCommitments', 'getCompany', 'getCompanyResearchSettings', 'getCallSettings']);
  const localMethods = Object.keys(api.localWorkspace) as Array<keyof CalliePreloadApi['localWorkspace']>;
  for (const method of localMethods) vi.spyOn(api.localWorkspace, method);
  render(<FounderAppHarness api={api} health={readyHealth} initialRoute="accounts" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Local account · Account A' })); await screen.findByText(t6AppQuote);
  expect(api.localWorkspace.getCompany).toHaveBeenCalledWith({ accountId: 'a' });
  expect(await screen.findByText('Contact not established')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Import named person' })).toBeNull();
  expect(screen.queryByRole('dialog', { name: 'Import leads' })).toBeNull();
  fireEvent.keyDown(window, { key: 'k', metaKey: true, ctrlKey: true }); const palette = await screen.findByRole('dialog', { name: 'Command palette' });
  expect(within(palette).queryByRole('option', { name: /Import/ })).toBeNull();
  fireEvent.keyDown(within(palette).getByRole('combobox'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull());
  expect(screen.getByRole('button', { name: 'Local account · Account A' }).getAttribute('aria-current')).toBe('true');
  expect(api.localWorkspace.linkCompanyPerson).not.toHaveBeenCalled(); expect(api.leadDetail.get).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Find saved person' })); await screen.findByRole('button', { name: 'Select Avery · person-1' });
  expect(api.leads.list).toHaveBeenLastCalledWith({ query: '', stages: [], priorities: [], sort: 'person_name', cursor: null, limit: 50 });
  fireEvent.click(screen.getByRole('button', { name: 'Load more' })); fireEvent.click(await screen.findByRole('button', { name: 'Select Avery · person-51' }));
  await screen.findByText('avery@example.test'); expect(api.leads.list).toHaveBeenLastCalledWith({ query: '', stages: [], priorities: [], sort: 'person_name', cursor: 'opaque-person-page-2', limit: 50 });
  expect(api.leadDetail.get).toHaveBeenLastCalledWith({ personId: 'person-51' }); await t6AppFillReview();
  const reads = vi.mocked(api.localWorkspace.getCompany).mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Link saved person' }));
  expect(await screen.findByText('person-51 · Manager · Manages company')).toBeTruthy();
  expect(screen.getByText('Authority: unconfirmed')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open saved contact' })).toBeNull();
  expect(screen.queryByRole('complementary', { name: /details$/ })).toBeNull();
  expect(api.localWorkspace.getCompany).toHaveBeenCalledTimes(reads + 1); expect(api.localWorkspace.linkCompanyPerson).toHaveBeenCalledOnce();
  expect(vi.mocked(api.localWorkspace.linkCompanyPerson).mock.calls[0][0]).toEqual(expect.objectContaining({ accountId: 'a', sourceQuotes: [{ sourceId: 'first-use-a', quote: t6AppQuote }], link: expect.objectContaining({ personId: 'person-51', authority: 'unconfirmed', authorityEvidenceIds: [], validTo: null }) }));
  // The one detail read belongs to the explicit finder selection; listing the stored link reads nothing.
  expect(vi.mocked(api.leadDetail.get).mock.calls).toEqual([[{ personId: 'person-51' }]]);
  expect(api.localWorkspace.researchCompany).not.toHaveBeenCalled();
  expect(api.localWorkspace.getCompanyResearchSettings).toHaveBeenCalledWith();
  expect(api.localWorkspace.getCallSettings).not.toHaveBeenCalled();
  for (const method of localMethods) {
    if (!safeLocalReads.has(method) && method !== 'linkCompanyPerson') expect(api.localWorkspace[method]).not.toHaveBeenCalled();
  }
  // Fake link implementation above changes only its local link flag. This is NOT main storage proof.
  expect(savedPeople).toEqual(peopleBefore);
}, 10_000);
it('T6-A02 office-only actual account reaches missing contact UI with the finder as its only person control', async () => {
  const api = f4FounderApi(); const office = f4AppDetail(); office.sources[0].excerpt = 'Office team only: office@a.example +1 401 555 0100';
  api.localWorkspace.getCompany = vi.fn<CalliePreloadApi['localWorkspace']['getCompany']>(async () => office);
  api.localWorkspace.linkCompanyPerson = vi.fn<CalliePreloadApi['localWorkspace']['linkCompanyPerson']>(async () => { throw Error('No reviewed saved person'); });
  render(<FounderAppHarness api={api} health={readyHealth} initialRoute="accounts" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Local account · Account A' })); await screen.findAllByText(office.sources[0].excerpt);
  expect(await screen.findByText('Contact not established')).toBeTruthy(); expect(screen.queryByText(/verified person/i)).toBeNull();
  expect(screen.getByRole('button', { name: 'Find saved person' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Import named person' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Open saved contact' })).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(api.localWorkspace.linkCompanyPerson).not.toHaveBeenCalled(); expect(api.leads.list).not.toHaveBeenCalled(); expect(api.leadDetail.get).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Local account · Account A' }).getAttribute('aria-current')).toBe('true');
}, 10_000);
it('T6-A03 actual Campaigns and Today route departures retain dirty reviewed identity without auto-link', async () => {
  const api = f4FounderApi(); api.localWorkspace.getCompany = vi.fn<CalliePreloadApi['localWorkspace']['getCompany']>(async () => t6AppCompany());
  api.leads.list = vi.fn<CalliePreloadApi['leads']['list']>(async () => ({ rows: t6AppRows(51, 1), nextCursor: null, total: 1, revision: 1 }));
  api.leadDetail.get = vi.fn<CalliePreloadApi['leadDetail']['get']>(async () => t6AppPerson());
  api.localWorkspace.linkCompanyPerson = vi.fn<CalliePreloadApi['localWorkspace']['linkCompanyPerson']>(async () => ({ accountId: 'a', version: 2, duplicate: false }));
  render(<FounderAppHarness api={api} health={readyHealth} initialRoute="accounts" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Local account · Account A' })); await screen.findByText(t6AppQuote);
  fireEvent.click(await screen.findByRole('button', { name: 'Find saved person' })); fireEvent.click(await screen.findByRole('button', { name: 'Select Avery · person-51' })); await screen.findByText('avery@example.test'); await t6AppFillReview();
  fireEvent.click(navLink('Campaigns')); await screen.findByRole('heading', { level: 1, name: 'Campaigns' }); fireEvent.click(navLink('Accounts')); await screen.findByText(t6AppQuote);
  expect((screen.getByRole('textbox', { name: 'Role' }) as HTMLInputElement).value).toBe('Manager');
  fireEvent.click(navLink('Today')); await screen.findByRole('heading', { level: 1, name: 'Today' }); fireEvent.click(navLink('Accounts')); await screen.findByText(t6AppQuote);
  expect((screen.getByRole('textbox', { name: 'Role' }) as HTMLInputElement).value).toBe('Manager'); expect((screen.getByRole('textbox', { name: 'Source quotation' }) as HTMLInputElement).value).toBe(t6AppQuote);
  expect(screen.getByRole('button', { name: 'Local account · Account A' }).getAttribute('aria-current')).toBe('true'); expect(api.localWorkspace.linkCompanyPerson).not.toHaveBeenCalled();
  // Each remount re-reads only the explicitly selected saved person; nothing else is ever fetched.
  expect(vi.mocked(api.leadDetail.get).mock.calls.every(([input]) => input.personId === 'person-51')).toBe(true);
}, 10_000);

it('T6-A04 actual route departure preserves pending link, lost reply offers exact replay without new UUID', async () => {
  const api = f4FounderApi(); api.localWorkspace.getCompany = vi.fn<CalliePreloadApi['localWorkspace']['getCompany']>(async () => t6AppCompany());
  api.leads.list = vi.fn<CalliePreloadApi['leads']['list']>(async () => ({ rows: t6AppRows(51, 1), nextCursor: null, total: 1, revision: 1 }));
  api.leadDetail.get = vi.fn<CalliePreloadApi['leadDetail']['get']>(async () => t6AppPerson());
  let resolve!: (receipt: Awaited<ReturnType<CalliePreloadApi['localWorkspace']['linkCompanyPerson']>>) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<Awaited<ReturnType<CalliePreloadApi['localWorkspace']['linkCompanyPerson']>>>((yes, no) => { resolve = yes; reject = no; });
  api.localWorkspace.linkCompanyPerson = vi.fn<CalliePreloadApi['localWorkspace']['linkCompanyPerson']>().mockImplementationOnce(() => pending).mockResolvedValue({ accountId: 'a', version: 2, duplicate: true });
  const view = render(<FounderAppHarness api={api} health={readyHealth} initialRoute="accounts" />);
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Local account · Account A' })); await screen.findByText(t6AppQuote);
    fireEvent.click(await screen.findByRole('button', { name: 'Find saved person' })); fireEvent.click(await screen.findByRole('button', { name: 'Select Avery · person-51' })); await screen.findByText('avery@example.test'); await t6AppFillReview();
    fireEvent.click(screen.getByRole('button', { name: 'Link saved person' })); expect(api.localWorkspace.linkCompanyPerson).toHaveBeenCalledOnce();
    const original = vi.mocked(api.localWorkspace.linkCompanyPerson).mock.calls[0][0];
    fireEvent.click(navLink('Campaigns')); await screen.findByRole('heading', { level: 1, name: 'Campaigns' });
    fireEvent.click(navLink('Accounts')); await screen.findByText(t6AppQuote);
    expect(api.localWorkspace.linkCompanyPerson).toHaveBeenCalledOnce();
    const replayWhilePending = screen.queryByRole('button', { name: 'Replay link' });
    if (replayWhilePending) expect((replayWhilePending as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(navLink('Campaigns')); await screen.findByRole('heading', { level: 1, name: 'Campaigns' });
    expect(screen.queryByRole('button', { name: 'Find saved person' })).toBeNull();
    const readsWhileAway = vi.mocked(api.localWorkspace.getCompany).mock.calls.length;
    await act(async () => { reject(Error('lost renderer reply')); await Promise.allSettled([pending]); });
    expect(api.localWorkspace.getCompany).toHaveBeenCalledTimes(readsWhileAway);
    expect(api.localWorkspace.linkCompanyPerson).toHaveBeenCalledOnce();
    fireEvent.click(navLink('Accounts')); await screen.findByText(t6AppQuote);
    const replay = await screen.findByRole('button', { name: 'Replay link' }); expect((replay as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(replay); await waitFor(() => expect(api.localWorkspace.linkCompanyPerson).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.localWorkspace.linkCompanyPerson).mock.calls[1][0]).toBe(original);
    expect(screen.getByRole('button', { name: 'Local account · Account A' }).getAttribute('aria-current')).toBe('true');
  } finally { view.unmount(); await act(async () => { resolve({ accountId: 'a', version: 2, duplicate: false }); await Promise.allSettled([pending]); }); }
}, 10_000);

it('capacity save retains actual Settings editor and returning normally to Today reads current values', async () => {
  window.location.hash = '#/settings';
  const api = fakeCallieApi();
  let stored: import('../../shared/contracts/localWorkspaceContract').MeetingFirstAccountCallSettings = {
    newCallSlots: null, totalCallCapacity: null, revision: 0, updatedAt: '2026-09-11T12:00:00.000Z',
  };
  api.localWorkspace.getCallSettings = vi.fn(async () => stored);
  api.localWorkspace.updateCallSettings = vi.fn(async input => stored = { newCallSlots: input.newCallSlots, totalCallCapacity: input.totalCallCapacity, revision: input.expectedRevision + 1, updatedAt: stored.updatedAt });
  api.daily.get = vi.fn(async () => dailyFixture({ answers: [], callSettings: { newCallSlots: stored.newCallSlots, totalCallCapacity: stored.totalCallCapacity } }));
  api.localWorkspace.get = vi.fn(async () => localSnapshot({ workflowMode: 'meeting_first' }));
  render(<FounderAppHarness api={api} health={readyHealth} initialRoute="settings" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Call capacity' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Save call capacity' }) as HTMLButtonElement).disabled).toBe(false));
  const editor = screen.getByRole('region', { name: 'Call capacity' });
  fireEvent.change(within(editor).getByLabelText('New call slots configuration'), { target: { value: 'number' } });
  fireEvent.change(within(editor).getByLabelText('New call slots'), { target: { value: '0' } });
  fireEvent.click(within(editor).getByRole('button', { name: 'Save call capacity' })); await screen.findByText('Call capacity saved.');
  expect(screen.getByRole('region', { name: 'Call capacity' })).toBe(editor);
  expect(screen.getByRole('button', { name: 'Call capacity' }).getAttribute('aria-current')).toBe('true');
  expect(api.localWorkspace.updateCallSettings).toHaveBeenCalledTimes(1);
  fireEvent.click(navLink('Today'));
  await screen.findByRole('button', { name: 'Call · Account A' });
  expect(screen.queryByRole('region', { name: 'Call capacity' })).toBeNull();
  expect(screen.getByText(/New-call slots:/).textContent).toContain('New-call slots: 0');
});
