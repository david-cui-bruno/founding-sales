// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { StrictMode, useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppHealth } from '../shared/healthContract';
import type {
  AppleSpikePreloadApi,
  CalliePreloadApi,
} from '../shared/preload';
import { App } from './App';
import { commitments, dailyFixture, localSnapshot } from './features/today/nativeDesk.fixture';

const health: AppHealth = {
  appVersion: '1.0.0',
  schemaVersion: 2,
  databasePath: '/tmp/callie.sqlite3',
  databaseEncrypted: true,
  cipherVersion: 'SQLite3 Multiple Ciphers 2.3.5',
  fts5Available: true,
  pendingJobs: 0,
  interruptedJobsRecovered: 0,
  domainStatus: 'ready',
  domainReady: true,
  domainBlockingViolationCount: 0,
  domainRepairableIssueCount: 0,
  domainProjectionRefreshCandidateCount: 0,
  pendingProjectionRebuilds: 0,
  domainStartupEvaluatedAt: '2026-08-30T12:00:00.000Z',
  operationalStatus: 'ready',
  sourcing: {
    status: 'healthy', reasons: [], lastSuccessAgeMs: null,
    state: {
      state: 'idle', pollId: null, startedAt: null, lastCompletedAt: null,
      consecutiveFailures: 0, lastFailureAt: null, lastFailureCode: null,
      backlogCount: null,
    },
  },
};

type Deferred<T> = {
  promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
};

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
};

const disabledAppleSpike = (): AppleSpikePreloadApi => ({
  getStatus: vi.fn(async () => ({
    enabled: false,
    bridge: { state: 'disabled', reason: 'not_packaged_or_configured' },
  } as const)),
  probeCapabilities: vi.fn(),
  requestContacts: vi.fn(),
  promptAccessibility: vi.fn(),
  scanRecentNotes: vi.fn(),
  scanTestMessages: vi.fn(),
  startCallObservation: vi.fn(),
  stopCallObservation: vi.fn(),
  sendTestMessage: vi.fn(),
  subscribeObservationEvidence: vi.fn(async (): Promise<() => void> => () => undefined),
});

/** Complete preload shape. Unused reads and commands remain pending without IO. */
const pendingWorkflowApis = (): Omit<CalliePreloadApi, 'health' | 'appleSpike'> => {
  const pending = () => vi.fn(() => new Promise<never>(() => undefined));
  return {
    daily: { get: pending() },
    localWorkspace: { get: pending(), getCommitments: pending(), reviewCompany: pending(), createCompany: pending(), getCompanyCreateStatus: pending(), transition: pending() },
    discovery: { get: pending(), getBrief: pending(), begin: pending(), override: pending() },
    delegation: {
      status: pending(), policyImport: { selectAndPreview: pending(), confirm: pending(), resume: pending(), status: pending() },
      prepareRequestedFollowup: pending(), getRequestedFollowup: pending(), editRequestedFollowup: pending(), approveRequestedFollowup: pending(),
      beginPhone: pending(), bootstrap: pending(), configurePolicy: pending(), configureResearch: pending(), pair: pending(), configure: pending(), submit: pending(), sync: pending(),
    },
    linkedin: { prepare: pending(), get: pending(), recover: pending(), save: pending(), begin: pending(), open: pending(), copy: pending(), reportOutcome: pending() },
    phoneSetup: { status: pending(), confirm: pending(), clear: pending() },
    outreach: { status: pending(), configure: pending(), connectGmail: pending(), disconnectGmail: pending(), openDraft: pending(), saveDraft: pending(), generateDraft: pending(), sendDraft: pending() },
    leads: { list: pending(), updateField: pending(), bulkUpdate: pending() },
    leadDetail: { get: pending(), beginOutbound: pending(), getOutboundCapabilities: pending(), confirmTransition: pending(), findContactInfo: pending(), dismissLead: pending(), overrideCloudScore: pending() },
    today: { get: pending(), complete: pending(), snooze: pending(), pin: pending(), logPastActivity: pending(), getLeadTriageSnapshot: pending(), addLeadNote: pending(), logCallOutcome: pending(), markActivityInError: pending(), getTriageQueue: pending(), setReviewPosition: pending() },
    pipeline: { get: pending() },
    review: { list: pending(), resolve: pending() },
    friday: { getCurrent: pending(), getDrilldown: pending(), createJob: pending(), fillJob: pending(), cancelJob: pending() },
    imports: { preview: pending(), remap: pending(), commit: pending(), status: pending() },
    conversations: { list: pending(), get: pending(), attachTranscript: pending() },
    learnings: { list: pending(), capture: pending(), addEvidence: pending(), updateStatus: pending() },
    sourcing: { pollNow: pending(), status: pending(), retry: pending(), setHmacSalt: pending() },
    shell: { revealDatabase: pending(), revealLogDirectory: pending() },
    recovery: { status: pending(), beginSetup: pending(), saveSetupMaterial: pending(), completeSetup: pending(), selectAndRunRestoreDrill: pending() },
  };
};

function LayoutObservation({ observe }: { observe?: () => void }): null {
  useLayoutEffect(() => { observe?.(); }, [observe]);
  return null;
}

const renderApp = (
  getHealth: () => Promise<AppHealth>,
  appleSpike: AppleSpikePreloadApi = disabledAppleSpike(),
  observe?: () => void,
) => {
  window.callie = {
    health: { get: getHealth },
    ...pendingWorkflowApis(),
    appleSpike,
  };
  window.location.hash = '';
  return render(
    <StrictMode>
      <App />
      <LayoutObservation observe={observe} />
    </StrictMode>,
  );
};

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.density;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function workspaceApi(): CalliePreloadApi {
  const api: CalliePreloadApi = { ...pendingWorkflowApis(), health: { get: vi.fn(async () => health) }, appleSpike: disabledAppleSpike() };
  api.daily.get = vi.fn(async () => dailyFixture());
  api.localWorkspace.get = vi.fn(async () => localSnapshot());
  api.localWorkspace.getCommitments = vi.fn(async () => commitments());
  vi.mocked(api.localWorkspace.reviewCompany).mockImplementation(async input => ({ scope: 'local_database', input, candidates: [], complete: true }));
  vi.mocked(api.delegation.status).mockResolvedValue({ state: 'unconfigured', workspaceId: null, endpoint: null, configuration: null });
  return api;
}

async function openCompanyEditor(api: CalliePreloadApi) {
  window.callie = api;
  window.location.hash = '#/accounts';
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<App />); });
  const add = screen.getByRole('button', { name: 'Add company' });
  expect((add as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(add);
  const input = screen.getByRole('textbox', { name: 'Company name' }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'Harbor Management' } });
  input.focus();
  input.setSelectionRange(2, 8);
  return { view, input };
}

describe('actual App readonly observation and workspace continuity', () => {
  it('keeps separate workspace and diagnostic strip slots stable through pending, stale and recovered reads', async () => {
    const api = workspaceApi();
    const { input } = await openCompanyEditor(api);
    const frame = document.querySelector('.foundation-frame');
    const workspace = document.querySelector('.foundation-workspace');
    const strip = document.querySelector('.foundation-observation');
    expect(frame).not.toBeNull(); expect(workspace).not.toBeNull(); expect(strip).not.toBeNull();
    expect(workspace?.parentElement).toBe(frame);
    expect(strip?.parentElement).toBe(frame);
    expect(workspace?.nextElementSibling).toBe(strip);
    expect(workspace?.contains(input)).toBe(true);
    const observation = screen.getByRole('region', { name: 'Diagnostic observation' });
    expect(strip?.contains(observation)).toBe(true);
    const pending = deferred<AppHealth>();
    vi.mocked(api.health.get).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh diagnostics' }));
    expect(screen.getByText('Refreshing diagnostics…')).toBeTruthy();
    await act(async () => pending.reject(new Error('private diagnostic failure')));
    expect(screen.getByRole('alert').textContent).toContain('Your work is kept.');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh diagnostics' })));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelector('.foundation-frame')).toBe(frame);
    expect(document.querySelector('.foundation-workspace')).toBe(workspace);
    expect(document.querySelector('.foundation-observation')).toBe(strip);
    expect(screen.getByRole('region', { name: 'Diagnostic observation' })).toBe(observation);
    expect(screen.getByRole('textbox', { name: 'Company name' })).toBe(input);
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 8]);
  });

  it('retains an unsent draft through blocked diagnostics without granting recovery or write authority', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const api = workspaceApi();
    await openCompanyEditor(api);
    vi.mocked(api.health.get).mockResolvedValueOnce({ ...health, domainReady: false, domainStatus: 'blocked' });
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
    expect(screen.getByText(/startup audit is blocked or inconsistent/)).toBeTruthy();
    expect(screen.getByText(health.domainStartupEvaluatedAt)).toBeTruthy();
    for (const command of [api.localWorkspace.reviewCompany, api.localWorkspace.createCompany, api.localWorkspace.getCompanyCreateStatus, api.recovery.beginSetup, api.recovery.selectAndRunRestoreDrill]) expect(command).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect((screen.getByRole('textbox', { name: 'Company name' }) as HTMLInputElement).value).toBe('Harbor Management');
    expect(api.localWorkspace.reviewCompany).not.toHaveBeenCalled();
  });

  it('retains the original intake deadline and exact unknown command across a blocked interval', async () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const api = workspaceApi();
    await openCompanyEditor(api);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Review company' })));
    fireEvent.click(screen.getByRole('button', { name: 'Create company' }));
    const request = vi.mocked(api.localWorkspace.createCompany).mock.calls[0][0];
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    vi.mocked(api.health.get).mockResolvedValueOnce({ ...health, domainReady: false, domainStatus: 'blocked' });
    await act(async () => window.dispatchEvent(new Event('focus')));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(screen.getByRole('button', { name: 'Check save status' })).toBeTruthy();
    expect(api.localWorkspace.createCompany).toHaveBeenCalledTimes(1);
    expect(api.localWorkspace.getCompanyCreateStatus).not.toHaveBeenCalled();
    vi.mocked(api.localWorkspace.getCompanyCreateStatus).mockResolvedValueOnce({ status: 'not_recorded', commandId: request.commandId });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Check save status' })));
    expect(api.localWorkspace.getCompanyCreateStatus).toHaveBeenCalledWith(request);
    expect(screen.getByRole('button', { name: 'Retry create' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry create' }));
    expect(api.localWorkspace.createCompany).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.localWorkspace.createCompany).mock.calls[1][0]).toEqual(request);
  });

  it.each(['manual', 'focus', 'timer'] as const)('keeps the exact editor, caret and stale read time through %s refresh rejection', async trigger => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-09-10T16:00:00.000Z');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const api = workspaceApi();
    const { input } = await openCompanyEditor(api);
    const refresh = deferred<AppHealth>();
    vi.mocked(api.health.get).mockReturnValue(refresh.promise);
    if (trigger === 'manual') fireEvent.click(screen.getByRole('button', { name: 'Refresh diagnostics' }));
    else if (trigger === 'focus') act(() => window.dispatchEvent(new Event('focus')));
    else await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(api.health.get).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('textbox', { name: 'Company name' })).toBe(input);
    expect(document.activeElement).toBe(input);
    expect([input.value, input.selectionStart, input.selectionEnd]).toEqual(['Harbor Management', 2, 8]);
    await act(async () => refresh.reject(new Error('/private/key-secret')));
    expect(screen.getByRole('textbox', { name: 'Company name' })).toBe(input);
    expect([input.value, input.selectionStart, input.selectionEnd]).toEqual(['Harbor Management', 2, 8]);
    expect(document.activeElement).toBe(input);
    expect(screen.getByText(/Last successful read/).textContent).toContain('2026-09-10T16:00:00.000Z');
    expect(screen.getByRole('alert').textContent).toContain('stale');
    expect(document.body.textContent).not.toContain('key-secret');
    for (const command of [api.localWorkspace.reviewCompany, api.localWorkspace.createCompany, api.localWorkspace.getCompanyCreateStatus, api.sourcing.pollNow, api.sourcing.retry, api.recovery.beginSetup, api.recovery.selectAndRunRestoreDrill]) expect(command).not.toHaveBeenCalled();
  });

  it('keeps the editor through a hung refresh deadline and ignores an expired blocked reply', async () => {
    vi.useFakeTimers();
    const api = workspaceApi();
    const { input } = await openCompanyEditor(api);
    const old = deferred<AppHealth>();
    vi.mocked(api.health.get).mockReturnValueOnce(old.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh diagnostics' }));
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(screen.getByRole('textbox', { name: 'Company name' })).toBe(input);
    expect(screen.getByRole('alert').textContent).toContain('stale');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh diagnostics' })));
    await act(async () => old.resolve({ ...health, domainReady: false, domainStatus: 'blocked' }));
    expect(screen.getByRole('textbox', { name: 'Company name' })).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  it('keeps one intake owner across ready-blocked-ready and stores a verified save while detached without replay', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const api = workspaceApi();
    const save = deferred<Awaited<ReturnType<CalliePreloadApi['localWorkspace']['createCompany']>>>();
    vi.mocked(api.localWorkspace.createCompany).mockReturnValue(save.promise);
    await openCompanyEditor(api);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Review company' })));
    fireEvent.click(screen.getByRole('button', { name: 'Create company' }));
    const request = vi.mocked(api.localWorkspace.createCompany).mock.calls[0][0];
    expect(request).toMatchObject({ name: 'Harbor Management', domain: null });
    vi.mocked(api.health.get).mockResolvedValueOnce({ ...health, domainReady: false, domainStatus: 'blocked' });
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
    const readsWhileBlocked = vi.mocked(api.localWorkspace.get).mock.calls.length;
    await act(async () => save.resolve({ status: 'saved', commandId: request.commandId, replayed: false, account: { id: 'saved-harbor', name: request.name, domain: request.domain, version: 1 } }));
    expect(api.localWorkspace.get).toHaveBeenCalledTimes(readsWhileBlocked);
    expect(window.location.hash).toBe('#/accounts');
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(screen.getByText('Company saved.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh saved company' })).toBeTruthy();
    expect(api.localWorkspace.reviewCompany).toHaveBeenCalledTimes(1);
    expect(api.localWorkspace.createCompany).toHaveBeenCalledTimes(1);
    expect(api.localWorkspace.getCompanyCreateStatus).not.toHaveBeenCalled();
    expect(vi.mocked(api.localWorkspace.createCompany).mock.calls[0][0]).toEqual(request);
  });

  it('invalidates a pending owner on exact localWorkspace API replacement even with the same worker identity', async () => {
    const api = workspaceApi();
    const save = deferred<Awaited<ReturnType<CalliePreloadApi['localWorkspace']['createCompany']>>>();
    vi.mocked(api.localWorkspace.createCompany).mockReturnValue(save.promise);
    const { view } = await openCompanyEditor(api);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Review company' })));
    fireEvent.click(screen.getByRole('button', { name: 'Create company' }));
    const request = vi.mocked(api.localWorkspace.createCompany).mock.calls[0][0];
    const replacement = workspaceApi().localWorkspace;
    window.callie = { ...api, localWorkspace: replacement };
    await act(async () => view.rerender(<App />));
    expect(screen.queryByRole('textbox', { name: 'Company name' })).toBeNull();
    await act(async () => save.resolve({ status: 'saved', commandId: request.commandId, replayed: false, account: { id: 'old-harbor', name: request.name, domain: request.domain, version: 1 } }));
    expect(screen.queryByText('Company saved.')).toBeNull();
    expect(replacement.createCompany).not.toHaveBeenCalled();
    expect(replacement.getCompanyCreateStatus).not.toHaveBeenCalled();
  });

  it('denies actual App admission in the first layout after health API replacement', async () => {
    const api = workspaceApi();
    window.callie = api;
    window.location.hash = '#/accounts';
    const observations: boolean[] = [];
    const view = render(<><App /><LayoutObservation /></>);
    await screen.findByRole('navigation', { name: 'Primary' });
    window.callie = { ...api, health: { get: vi.fn(() => new Promise<AppHealth>(() => undefined)) } };
    view.rerender(<><App /><LayoutObservation observe={() => observations.push(screen.queryByRole('navigation', { name: 'Primary' }) !== null)} /></>);
    expect(observations[0]).toBe(false);
  });
});

describe('App async lifecycle', () => {
  it.each([
    ['blocked', false],
    ['blocked', true],
    ['ready', false],
  ] as const)('does not admit normal routes for domainStatus=%s and domainReady=%s', async (domainStatus, domainReady) => {
    const response = deferred<AppHealth>();
    const getHealth = vi.fn(() => response.promise);
    renderApp(getHealth);
    expect(getHealth).toHaveBeenCalled();

    await act(async () => response.resolve({ ...health, domainStatus, domainReady }));

    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
  });

  it('keeps the actual ready shell mounted through a failed focus refresh', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const getHealth = vi.fn<() => Promise<AppHealth>>().mockResolvedValue(health);
    renderApp(getHealth);
    const navigation = await screen.findByRole('navigation', { name: 'Primary' });
    const initialReads = getHealth.mock.calls.length;
    const refresh = deferred<AppHealth>();
    getHealth.mockReturnValue(refresh.promise);

    act(() => window.dispatchEvent(new Event('focus')));

    expect(getHealth).toHaveBeenCalledTimes(initialReads + 1);
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBe(navigation);
    await act(async () => refresh.reject(new Error('private refresh failure')));
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBe(navigation);
  });

  it('renders the workflow shell with the Today route once health is ready', async () => {
    renderApp(vi.fn(async () => health));

    expect(await screen.findByRole('navigation', { name: 'Primary' })).not.toBeNull();
    expect(
      screen.getByRole('link', { name: 'Today' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(screen.queryByText('Checking local foundation…')).toBeNull();
  });

  it('keeps foundation diagnostics and the Apple spike behind the Settings route', async () => {
    const appleSpike = disabledAppleSpike();
    appleSpike.getStatus = vi.fn(async () => ({
      enabled: true,
      bridge: { state: 'ready', helperVersion: '1.0.0', protocolVersion: 1 },
    } as const));

    renderApp(vi.fn(async () => health), appleSpike);

    await screen.findByRole('navigation', { name: 'Primary' });
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));

    await screen.findByText('Encrypted SQLite ready');
    expect(
      await screen.findByRole('region', { name: 'Apple feasibility spike' }),
    ).not.toBeNull();
  });

  it('ignores a stale failed request after the latest request is ready', async () => {
    const first = deferred<AppHealth>();
    const second = deferred<AppHealth>();
    const getHealth = vi
      .fn<() => Promise<AppHealth>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    renderApp(getHealth);
    await waitFor(() => expect(getHealth).toHaveBeenCalledTimes(2));

    await act(async () => second.resolve(health));
    await screen.findByRole('navigation', { name: 'Primary' });
    await act(async () => first.reject(new Error('stale failure')));

    expect(screen.getByRole('navigation', { name: 'Primary' })).not.toBeNull();
    expect(screen.queryByText('The diagnostic read could not be completed')).toBeNull();
  });

  it('ignores a stale successful request after the latest request fails', async () => {
    const first = deferred<AppHealth>();
    const second = deferred<AppHealth>();
    const getHealth = vi
      .fn<() => Promise<AppHealth>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    renderApp(getHealth);
    await waitFor(() => expect(getHealth).toHaveBeenCalledTimes(2));

    await act(async () => second.reject(new Error('latest failure')));
    await screen.findByRole('alert');
    await act(async () => first.resolve(health));

    expect(screen.getByRole('alert').textContent).toContain(
      'The diagnostic read could not be completed',
    );
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
  });

  it('announces failure and ignores a retry that resolves after unmount', async () => {
    const stale = deferred<AppHealth>();
    const initial = deferred<AppHealth>();
    const retry = deferred<AppHealth>();
    const getHealth = vi
      .fn<() => Promise<AppHealth>>()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(retry.promise);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = renderApp(getHealth);

    await waitFor(() => expect(getHealth).toHaveBeenCalledTimes(2));
    await act(async () => initial.reject(new Error('initial failure')));
    const alert = await screen.findByRole('alert');

    expect(alert.getAttribute('aria-live')).toBe('assertive');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(getHealth).toHaveBeenCalledTimes(3));
    view.unmount();
    await act(async () => retry.resolve(health));

    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('startup appearance before workspace readiness', () => {
  it.each([
    ['dark', 'compact', false, 'dark'],
    ['light', 'comfortable', true, 'light'],
    ['system', 'compact', true, 'dark'],
    ['system', 'comfortable', false, 'light'],
  ] as const)('applies %s/%s before the first layout observation', (preference, density, systemDark, resolved) => {
    window.localStorage.setItem('callie.theme', preference);
    window.localStorage.setItem('callie.density', density);
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: systemDark, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const observations: unknown[] = [];
    const view = renderApp(() => new Promise(() => undefined), undefined, () => {
      observations.push([document.documentElement.dataset.theme, document.documentElement.dataset.density]);
    });
    expect(observations[0]).toEqual([resolved, density]);
    expect(screen.getByText('Checking local foundation…')).toBeTruthy();
    expect(view.container.querySelector('.presentation-root')?.getAttribute('data-presentation')).toBe('native-a');
    expect(view.container.querySelector('[data-workflow-mode]')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(window.callie.today.get).not.toHaveBeenCalled();
    expect(window.callie.leads.list).not.toHaveBeenCalled();
    expect(window.callie.appleSpike.getStatus).not.toHaveBeenCalled();
  });

  it('retains saved preferences and truthful presentation through failure, retry and readiness', async () => {
    window.localStorage.setItem('callie.theme', 'dark');
    window.localStorage.setItem('callie.density', 'compact');
    const failed = deferred<AppHealth>();
    const retry = deferred<AppHealth>();
    const get = vi.fn().mockReturnValueOnce(failed.promise).mockReturnValueOnce(failed.promise).mockReturnValue(retry.promise);
    const view = renderApp(get);
    const root = view.container.querySelector('.presentation-root');
    expect(root).not.toBeNull();
    await act(async () => failed.reject(new Error('private path must not appear')));
    expect(screen.getByRole('alert').textContent).not.toContain('private path');
    expect(view.container.querySelector('.presentation-root')).toBe(root);
    expect(view.container.querySelector('.presentation-root')?.getAttribute('data-presentation')).toBe('native-a');
    expect(window.callie.today.get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(view.container.querySelector('.presentation-root')).toBe(root);
    expect(screen.getByText('Checking local foundation…')).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.density).toBe('compact');
    await act(async () => retry.resolve(health));
    await screen.findByRole('navigation', { name: 'Primary' });
    expect(view.container.querySelector('.presentation-root')).toBe(root);
    expect(root?.contains(screen.getByRole('navigation', { name: 'Primary' }))).toBe(true);
    expect(root?.hasAttribute('data-workflow-mode')).toBe(false);
    const main = screen.getByRole('main');
    expect(main.tabIndex).toBe(-1);
    main.focus();
    expect(document.activeElement).toBe(main);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.density).toBe('compact');
  });
});

it.each(['missing', 'invalid', 'throwing'] as const)('resolves %s storage before actual App checking layout', mode => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  if (mode === 'invalid') {
    window.localStorage.setItem('callie.theme', 'invalid');
    window.localStorage.setItem('callie.density', 'invalid');
  }
  if (mode === 'throwing') vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  const observed: unknown[] = [];
  renderApp(() => new Promise(() => undefined), undefined, () => {
    observed.push([document.documentElement.dataset.theme, document.documentElement.dataset.density]);
  });
  expect(observed[0]).toEqual(['dark', 'comfortable']);
  expect(window.callie.today.get).not.toHaveBeenCalled();
});
it('keeps one live system listener through the health gate without extra reads', async () => {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false,
    addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => listeners.delete(listener),
  })));
  const ready = deferred<AppHealth>();
  const get = vi.fn(() => ready.promise);
  const view = renderApp(get);
  expect(listeners.size).toBe(1);
  act(() => listeners.forEach(listener => listener({ matches: true })));
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(get).toHaveBeenCalledTimes(2);
  expect(window.callie.today.get).not.toHaveBeenCalled();
  await act(async () => ready.resolve(health));
  await screen.findByRole('navigation', { name: 'Primary' });
  expect(listeners.size).toBe(1);
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(get).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(listeners.size).toBe(0);
});


it('does not observe review counts before the real foundation gate succeeds', async () => {
  const ready = deferred<AppHealth>();
  renderApp(vi.fn(() => ready.promise));
  expect(window.callie.review.list).not.toHaveBeenCalled();
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(window.callie.review.list).not.toHaveBeenCalled();
  await act(async () => { ready.resolve(health); });
  await screen.findByRole('navigation', { name: 'Primary' });
  expect(window.callie.review.list).toHaveBeenCalledWith({ kinds: [], cursor: null, limit: 1 });
});
