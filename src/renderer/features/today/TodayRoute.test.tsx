import { firstUseFixture, dailyFixture, localSnapshot, nativeDeskFixture } from './nativeDesk.fixture';
import { PresentationRoot } from '../../app/PresentationRoot';
// @vitest-environment jsdom

import { act, cleanup, fireEvent, render as testingRender, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type DiscoveryApi } from '../../../shared/contracts/discoveryContract';
import type { MutationReceipt } from '../../../shared/contracts/commonContract';
import type {
  TodayItem,
  TodaySnapshot,
  TriageQueue,
} from '../../../shared/contracts/todayContract';
import { TodayRoute, type TodayLeadCommandApi, type TodayRouteApi } from './TodayRoute';

afterEach(() => {
  cleanup();
});

const item = (overrides: Partial<TodayItem> = {}): TodayItem => ({
  id: 'cycle-p1',
  lane: 'p1',
  personId: 'person-p1',
  salesCycleId: 'cycle-p1',
  personName: 'Avery Landlord',
  contextLabel: 'Landlord LLC',
  stage: 'ready',
  priorityContext: {
    priority: 'P1',
    fitPoints: 24,
    fitBand: 'high',
    timingValue: 31,
    timingBand: 'hot',
    reachability: 'direct',
    dataConfidence: 8,
  },
  action: {
    id: 'action-p1',
    type: 'call_lead',
    channel: 'call',
    label: 'Call lead',
  },
  reason: 'Ready P1 within capacity',
  activeTriggers: [],
  verifyFirst: false,
  pinned: false,
  consentRequirement: null,
  cloudScores: null,
  ...overrides,
});

const snapshot = (revision: number, items: TodayItem[]): TodaySnapshot => ({
  lanes: [
    { id: 'onboarding', items: [], overflowCount: 0 },
    { id: 'fresh_inbound', items: [], overflowCount: 0 },
    { id: 'due_cadence', items: [], overflowCount: 0 },
    { id: 'new_p0', items: [], overflowCount: 0 },
    { id: 'p1', items, overflowCount: 0 },
    { id: 'exploration', items: [], overflowCount: 0 },
    { id: 'later', items: [], overflowCount: 0 },
  ],
  dialBudget: 40,
  scheduledDials: items.length,
  conversationTarget: 5,
  reviewErrorCount: 0,
  unreviewedBacklogCount: 0,
  unreviewedCloudSignalCount: 0,
  conversationsHeld: 0,
  revision,
});

const receipt: MutationReceipt = {
  revision: 2,
  affectedPersonIds: ['person-p1'],
  affectedSalesCycleIds: ['cycle-p1'],
};

const triageQueue = (
  names: string[],
  position = 0,
): TriageQueue => ({
  items: names.map((name, index): TriageQueue['items'][number] => ({
    personId: `person-t${index}`,
    salesCycleId: `cycle-t${index}`,
    personName: name,
    contextLabel: null,
    propertySummary: null,
    phone: null,
    email: null,
    cloudScores: null,
    cloudSignals: [],
  })),
  position,
  revision: 1,
});

function fakeApi(overrides: Partial<TodayRouteApi> = {}): TodayRouteApi & { firstUse: ReturnType<typeof firstUseFixture> } {
  return {
    firstUse: firstUseFixture(),
    get: vi.fn(async () => snapshot(1, [
      item(),
      item({
        id: 'cycle-p1-b',
        salesCycleId: 'cycle-p1-b',
        personId: 'person-p1-b',
        personName: 'Blake Owner',
        action: {
          id: 'action-p1-b',
          type: 'call_lead',
          channel: 'call',
          label: 'Call lead',
        },
      }),
    ])),
    complete: vi.fn(async () => receipt),
    snooze: vi.fn(async () => receipt),
    pin: vi.fn(async () => receipt),
    logPastActivity: vi.fn(async () => receipt),
    getTriageQueue: vi.fn(async () => triageQueue(['Cap Lead One', 'Cap Lead Two'])),
    setReviewPosition: vi.fn(async () => receipt),
    ...overrides,
  } as TodayRouteApi & { firstUse: ReturnType<typeof firstUseFixture> };
}

function fakeLeadApi(overrides: Partial<TodayLeadCommandApi> = {}): TodayLeadCommandApi & { beginOutbound: ReturnType<typeof vi.fn> } {
  return {
    beginOutbound: vi.fn(async () => receipt),
    confirmTransition: vi.fn(async () => receipt),
    dismissLead: vi.fn(async () => receipt),
    get: vi.fn(async () => ({ revision: 0, phones: [{ id: 'phone-1' }] })),
    ...overrides,
  };
}

describe('TodayRoute', () => {
  it('shows a loading state, then the loaded queue, under StrictMode', async () => {
    const api = fakeApi();
    render(
      <StrictMode>
        <TodayRoute firstUse={api.firstUse} api={api} onOpenLead={vi.fn()} />
      </StrictMode>,
    );

    expect(
      screen.getByRole('progressbar', { name: 'Loading today' }),
    ).toBeTruthy();
    expect(await screen.findByText('Avery Landlord')).toBeTruthy();
  });

  it('renders the header dial meter and the muted date, with no visible Refresh', async () => {
    const api = fakeApi();
    render(<TodayRoute firstUse={api.firstUse} api={api} onOpenLead={vi.fn()} />);
    await screen.findByText('Avery Landlord');

    fireEvent.click(screen.getByText('Queue capacity'));
    const meter = screen.getByRole('meter', { name: 'Queued discretionary calls' });
    expect(meter.getAttribute('aria-valuenow')).toBe('2');
    expect(meter.getAttribute('aria-valuemax')).toBe('40');
    expect(screen.getByText('2 queued discretionary calls · target 40')).toBeTruthy();
    expect(screen.queryByTestId('today-refresh')).toBeNull();
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
  });

  it('refetches on window focus', async () => {
    const api = fakeApi();
    render(<TodayRoute firstUse={api.firstUse} api={api} onOpenLead={vi.fn()} />);
    await screen.findByText('Avery Landlord');
    const fetchesBefore = (api.get as ReturnType<typeof vi.fn>).mock.calls.length;

    fireEvent(window, new Event('focus'));

    await waitFor(() => {
      expect(
        (api.get as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBeGreaterThan(fetchesBefore);
    });
  });

  it('shows a retryable error state without raw error details', async () => {
    const failing = vi.fn(async () => {
      throw new Error('SQLITE_IOERR at /private/tmp/callie.sqlite3');
    });
    const api = fakeApi({ get: failing as unknown as TodayRouteApi['get'] });
    render(<TodayRoute firstUse={api.firstUse} api={api} onOpenLead={vi.fn()} />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/SQLITE_IOERR/)).toBeNull();

    api.get = vi.fn(async () => snapshot(3, [item()]));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Avery Landlord')).toBeTruthy();
  });

  it('never implicitly launches and opens the lead page from the explicit row Call button', async () => {
    const api = fakeApi();
    const leadApi = fakeLeadApi();
    const onOpenLeadPage = vi.fn();
    render(
      <TodayRoute firstUse={api.firstUse}
        api={api}
        leadApi={leadApi}
        onOpenLead={vi.fn()}
        onOpenLeadPage={onOpenLeadPage}
      />,
    );
    await screen.findByText('Avery Landlord');

    fireEvent.click(screen.getByRole('button', { name: 'Call Avery Landlord' }));

    expect(leadApi.beginOutbound).not.toHaveBeenCalled();
    expect(leadApi.get).not.toHaveBeenCalled();
    expect(api.complete).not.toHaveBeenCalled();
    expect(api.logPastActivity).not.toHaveBeenCalled();
    await waitFor(() => expect(onOpenLeadPage).toHaveBeenCalledWith('person-p1'));
  });

  it('writes resurface_at through snooze from the S key', async () => {
    const api = fakeApi();
    render(<TodayRoute firstUse={api.firstUse} api={api} onOpenLead={vi.fn()} />);
    await screen.findByText('Blake Owner');

    const row = document.querySelector('[data-cycle-id="cycle-p1-b"]') as HTMLElement;
    row.focus();
    fireEvent.keyDown(row, { key: 's' });

    await waitFor(() => expect(api.snooze).toHaveBeenCalledTimes(1));
    expect(api.snooze).toHaveBeenCalledWith({
      salesCycleId: 'cycle-p1-b',
      resurfaceAt: expect.any(String),
    });
  });

  it('ignores a stale snapshot that resolves after a newer fetch', async () => {
    let call = 0;
    let releaseStale: (value: TodaySnapshot) => void = () => undefined;
    const stale = new Promise<TodaySnapshot>((resolve) => {
      releaseStale = resolve;
    });
    const api = fakeApi({
      get: vi.fn(() => {
        call += 1;
        if (call === 1) return stale;
        return Promise.resolve(snapshot(9, [item({ personName: 'Fresh Person' })]));
      }) as unknown as TodayRouteApi['get'],
    });
    render(<TodayRoute firstUse={api.firstUse} api={api} onOpenLead={vi.fn()} />);

    await waitFor(() => expect(call).toBeGreaterThanOrEqual(1));
    fireEvent(window, new Event('focus'));
    expect(await screen.findByText('Fresh Person')).toBeTruthy();

    releaseStale(snapshot(1, [item({ personName: 'Stale Person' })]));
    await waitFor(() => expect(screen.queryByText('Stale Person')).toBeNull());
    expect(screen.getByText('Fresh Person')).toBeTruthy();
  });

  it('surfaces a safe command error and keeps the queue visible', async () => {
    const api = fakeApi({
      snooze: vi.fn(async () => {
        throw new Error('opted_out person: raw tombstone id 123');
      }) as unknown as TodayRouteApi['snooze'],
    });
    render(<TodayRoute firstUse={api.firstUse} api={api} onOpenLead={vi.fn()} />);
    await screen.findByText('Avery Landlord');

    const row = document.querySelector('[data-cycle-id="cycle-p1"]') as HTMLElement;
    row.focus();
    fireEvent.keyDown(row, { key: 's' });

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/tombstone/)).toBeNull();
    expect(screen.getByText('Avery Landlord')).toBeTruthy();
  });
});

it('keeps the main-ordered queue alongside read-only discovery without manual judgment', async () => {
  const api = fakeApi({ get: vi.fn(async () => ({ ...snapshot(1, [item()]), unreviewedBacklogCount: 2881 })) });
  const discoveryApi: DiscoveryApi = { get: vi.fn(async () => ({ prepared: [], judgment: [], counts: { unassessed: 0, research: 0, watch: 0, excluded: 0 }, processing: 'idle' as const, researchCapability: 'not_configured' as const, generatedAt: '2026-09-08T12:00:00.000Z', revision: 1 })), getBrief: vi.fn(), begin: vi.fn(), override: vi.fn() };
  const leadApi = fakeLeadApi();
  render(<TodayRoute firstUse={api.firstUse} api={api} leadApi={leadApi} discoveryApi={discoveryApi} onOpenLead={vi.fn()} />);
  await screen.findByText('Avery Landlord');
  expect(screen.getByRole('list', { name: 'Work queue' })).toBeTruthy();
  expect(screen.queryByText(/Prepared conversations|Manual review|Preparing your shortlist/)).toBeNull();
  expect(screen.queryByRole('button', { name: /Review|Next|Prepare|Refresh/i })).toBeNull();
  expect(api.getTriageQueue).not.toHaveBeenCalled();
  expect(discoveryApi.get).toHaveBeenCalled();
  expect(discoveryApi.begin).not.toHaveBeenCalled();
  expect(leadApi.confirmTransition).not.toHaveBeenCalled();
});
it('states only that no contacts are due rather than claiming all discovery is done', async () => {
  const api = fakeApi({ get: vi.fn(async () => snapshot(1, [])) });
  render(<TodayRoute firstUse={api.firstUse} api={api} onOpenLead={vi.fn()} />);
  await screen.findByText('No contacts due right now.');
  expect(screen.queryByText(/Queue done|All done/)).toBeNull();
});
it('refreshes queue membership after an accepted email without a focus workaround', async () => {
  const api = fakeApi(); render(<TodayRoute firstUse={api.firstUse} api={api} onOpenLead={vi.fn()} />);
  await screen.findByText('Avery Landlord'); const reads = vi.mocked(api.get).mock.calls.length;
  fireEvent(window, new CustomEvent('callie:email-sent', { detail: { personId: 'person-p1', salesCycleId: 'cycle-p1' } }));
  await waitFor(() => expect(vi.mocked(api.get).mock.calls.length).toBe(reads + 1));
});

it('shows the real current date badge and opens the primary brief without a call or mutation', async () => {
  const api = fakeApi(); const open = vi.fn(); const fullPage = vi.fn();
  render(<TodayRoute firstUse={api.firstUse} api={api} onOpenLead={open} onOpenLeadPage={fullPage} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Avery Landlord' }));
  expect(open).toHaveBeenCalledWith('person-p1'); expect(fullPage).not.toHaveBeenCalled();
  expect(api.complete).not.toHaveBeenCalled(); expect(api.logPastActivity).not.toHaveBeenCalled();
  const badge = screen.getByLabelText('Current date');
  expect(badge.textContent).toContain(new Date().toLocaleDateString(undefined, { day: '2-digit' }));
  expect(badge.getAttribute('datetime')).toBe(new Date().toLocaleDateString('en-CA'));
});

const render = (ui: Parameters<typeof testingRender>[0], options?: Parameters<typeof testingRender>[1]) => testingRender(ui, { wrapper: PresentationRoot, ...options });

Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });

it.each(['accepted', 'unconfirmed'] as const)('keeps legacy manual activity mounted until its %s result', async outcome => {
  let resolve!: (value: MutationReceipt) => void;
  let reject!: (error: Error) => void;
  const api = fakeApi({ logPastActivity: vi.fn(() => new Promise<MutationReceipt>((yes, no) => { resolve = yes; reject = no; })) });
  render(<TodayRoute firstUse={api.firstUse} api={api} onOpenLead={vi.fn()} />);
  await screen.findByText('Avery Landlord');
  fireEvent.click(screen.getAllByRole('button', { name: /More actions/ })[0]!);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Log past activity' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'Kept legacy summary' } });
  fireEvent.click(screen.getByRole('button', { name: 'Log activity' }));
  expect(screen.getByRole('dialog')).toBe(dialog);
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(api.logPastActivity).toHaveBeenCalledTimes(1);
  await act(async () => { if (outcome === 'accepted') resolve(receipt); else reject(new Error('private failure')); });
  if (outcome === 'accepted') {
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.get).toHaveBeenCalledTimes(2);
  } else {
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect((screen.getByLabelText('What happened') as HTMLTextAreaElement).value).toBe('Kept legacy summary');
    expect(screen.getByText('The command result was not confirmed. Check the current record before submitting again.')).toBeTruthy();
    expect(screen.getByText(/Past activity save was not confirmed/)).toBeTruthy();
    expect(api.get).toHaveBeenCalledTimes(1);
  }
});
it.each(['s', 'x'])('consumes the fire-and-forget %s rejection while showing unconfirmed status', async key => {
  const api = fakeApi({ snooze: vi.fn(async () => { throw new Error('private failure'); }) });
  render(<TodayRoute firstUse={api.firstUse} api={api} onOpenLead={vi.fn()} />);
  await screen.findByText('Avery Landlord');
  fireEvent.keyDown(screen.getByRole('listitem', { name: 'Avery Landlord' }), { key });
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'The command result was not confirmed. Check the current record before submitting again.');
  expect(api.snooze).toHaveBeenCalledTimes(1);
});
it('does not refresh a disposed legacy route after its pending manual receipt', async () => {
  let resolve!: (value: MutationReceipt) => void;
  const api = fakeApi({ logPastActivity: vi.fn(() => new Promise<MutationReceipt>(yes => { resolve = yes; })) });
  const view = render(<TodayRoute firstUse={api.firstUse} api={api} onOpenLead={vi.fn()} />);
  await screen.findByText('Avery Landlord');
  fireEvent.click(screen.getAllByRole('button', { name: /More actions/ })[0]!);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Log past activity' }));
  fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'Pending original route' } });
  fireEvent.click(screen.getByRole('button', { name: 'Log activity' }));
  view.unmount();
  await act(async () => resolve(receipt));
  expect(api.get).toHaveBeenCalledTimes(1);
});
it.each(['accepted', 'unconfirmed'] as const)('retains the exact pending manual form through failed focus refresh then %s result', async outcome => {
  let resolve!: (value: MutationReceipt) => void;
  let reject!: (error: Error) => void;
  const api = fakeApi({ logPastActivity: vi.fn(() => new Promise<MutationReceipt>((yes, no) => { resolve = yes; reject = no; })) });
  render(<TodayRoute firstUse={api.firstUse} api={api} onOpenLead={vi.fn()} />);
  await screen.findByText('Avery Landlord');
  const queue = screen.getByRole('list', { name: 'Work queue' });
  fireEvent.click(screen.getAllByRole('button', { name: /More actions/ })[0]!);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Log past activity' }));
  const dialog = screen.getByRole('dialog');
  const summary = screen.getByLabelText('What happened') as HTMLTextAreaElement;
  fireEvent.change(summary, { target: { value: 'Retain this exact past communication' } });
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-09-01' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'I stated the price' }));
  fireEvent.click(screen.getByRole('button', { name: 'Log activity' }));
  const exactRequest = vi.mocked(api.logPastActivity).mock.calls[0]![0];
  vi.mocked(api.get).mockRejectedValue(new Error('private read failure'));
  await act(async () => { fireEvent.focus(window); });
  expect(screen.queryByRole('dialog')).toBe(dialog);
  expect(screen.getByRole('list', { name: 'Work queue' })).toBe(queue);
  expect(screen.getByLabelText('What happened')).toBe(summary);
  expect(summary.value).toBe('Retain this exact past communication');
  expect(screen.getByText('Today could not refresh')).toBeTruthy();
  expect(screen.queryByText(/command result was not confirmed/)).toBeNull();
  expect(screen.queryByText(/Past activity save was not confirmed/)).toBeNull();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(api.logPastActivity).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api.logPastActivity).mock.calls[0]![0]).toBe(exactRequest);
  await act(async () => { if (outcome === 'accepted') resolve(receipt); else reject(new Error('unknown write result')); });
  if (outcome === 'accepted') {
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(/command result was not confirmed/)).toBeNull();
  } else {
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(summary.value).toBe('Retain this exact past communication');
    expect(screen.getByText(/Past activity save was not confirmed/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  }
  // A retained stale queue is not authority to issue another command.
  fireEvent.keyDown(screen.getByRole('listitem', { name: 'Avery Landlord' }), { key: 's' });
  await act(async () => {});
  expect(api.snooze).not.toHaveBeenCalled();
  expect(api.logPastActivity).toHaveBeenCalledTimes(1);
  vi.mocked(api.get).mockResolvedValue(snapshot(3, [item()]));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
  expect(screen.queryByText('Today could not refresh')).toBeNull();
  expect(api.logPastActivity).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(screen.getByRole('listitem', { name: 'Avery Landlord' }), { key: 's' });
  await act(async () => {});
  expect(api.snooze).toHaveBeenCalledTimes(1);
});

function legacyWorkspace() {
  const workspace = nativeDeskFixture(dailyFixture({ workflowMode: 'legacy' }));
  const overviewGet = vi.spyOn(workspace.api.localWorkspace, 'get').mockResolvedValue(localSnapshot({ workflowMode: 'legacy' }));
  return { ...workspace, overviewGet };
}
it.each(['accepted', 'unconfirmed'] as const)('keeps actual workspaceApi legacy form through ancestor refresh hold and %s save', async outcome => {
  const workspace = legacyWorkspace();
  let finishOverview!: (value: ReturnType<typeof localSnapshot>) => void;
  let resolve!: (value: MutationReceipt) => void;
  let reject!: (error: Error) => void;
  const api = fakeApi({ logPastActivity: vi.fn(() => new Promise<MutationReceipt>((yes, no) => { resolve = yes; reject = no; })) });
  render(<TodayRoute firstUse={workspace.firstUse} api={api} workspaceApi={workspace.api} onOpenLead={vi.fn()} />);
  await screen.findByText('Avery Landlord');
  fireEvent.click(screen.getAllByRole('button', { name: /More actions/ })[0]!);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Log past activity' }));
  const dialog = screen.getByRole('dialog');
  const field = screen.getByLabelText('What happened') as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: 'Original composed form' } });
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-09-01' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'I stated the price' }));
  fireEvent.click(screen.getByRole('button', { name: 'Log activity' }));
  const request = vi.mocked(api.logPastActivity).mock.calls[0]![0];
  workspace.overviewGet.mockImplementationOnce(() => new Promise(done => { finishOverview = done; }));
  vi.mocked(api.get).mockRejectedValueOnce(new Error('Today refresh failed'));
  await act(async () => { fireEvent.focus(window); });
  expect(screen.queryByRole('dialog')).toBe(dialog);
  expect(screen.getByLabelText('What happened')).toBe(field);
  expect(field.value).toBe('Original composed form');
  expect(screen.getByText('Today could not refresh')).toBeTruthy();
  expect(screen.getByText(/Queue commands are held/)).toBeTruthy();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBe(dialog);
  await act(async () => { if (outcome === 'accepted') resolve(receipt); else reject(new Error('Unconfirmed write')); });
  if (outcome === 'accepted') expect(screen.queryByRole('dialog')).toBeNull();
  else {
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(screen.getByLabelText('What happened')).toBe(field);
    expect(field.value).toBe('Original composed form');
    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-09-01');
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    // Pending local mode read is not permission for a new manual request.
    fireEvent.click(screen.getByRole('button', { name: 'Log activity' }));
    await act(async () => {});
    expect(api.logPastActivity).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  }
  // Refresh the child queue independently: parent hold must still fence commands.
  if (screen.queryByRole('button', { name: 'Retry' })) {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
  }
  for (const key of ['s', 'x']) fireEvent.keyDown(screen.getByRole('listitem', { name: 'Avery Landlord' }), { key });
  await act(async () => {});
  expect(api.snooze).not.toHaveBeenCalled();
  await act(async () => finishOverview(localSnapshot({ workflowMode: 'legacy' })));
  expect(screen.queryByText(/Queue commands are held/)).toBeNull();
  fireEvent.keyDown(screen.getByRole('listitem', { name: 'Avery Landlord' }), { key: 's' });
  await act(async () => {});
  expect(api.snooze).toHaveBeenCalledTimes(1);
  expect(api.logPastActivity).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api.logPastActivity).mock.calls[0]![0]).toBe(request);
});
it.each(['mode', 'api'] as const)('invalidates the actual legacy form for confirmed %s replacement, not an old receipt', async replacement => {
  const workspace = legacyWorkspace();
  let resolve!: (value: MutationReceipt) => void;
  const api = fakeApi({ logPastActivity: vi.fn(() => new Promise<MutationReceipt>(done => { resolve = done; })) });
  const view = render(<TodayRoute firstUse={workspace.firstUse} api={api} workspaceApi={workspace.api} onOpenLead={vi.fn()} />);
  await screen.findByText('Avery Landlord');
  fireEvent.click(screen.getAllByRole('button', { name: /More actions/ })[0]!);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Log past activity' }));
  fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'Old owner request' } });
  fireEvent.click(screen.getByRole('button', { name: 'Log activity' }));
  if (replacement === 'mode') {
    workspace.setSnapshot(dailyFixture({ workflowMode: 'meeting_first' }));
    workspace.overviewGet.mockResolvedValue(localSnapshot({ workflowMode: 'meeting_first' }));
    await act(async () => { fireEvent.focus(window); });
    expect(screen.getByTestId('native-desk')).toBeTruthy();
  } else {
    const next = legacyWorkspace();
    view.rerender(<TodayRoute firstUse={next.firstUse} api={api} workspaceApi={next.api} onOpenLead={vi.fn()} />);
    await screen.findByText('Avery Landlord');
  }
  expect(screen.queryByRole('dialog')).toBeNull();
  const reads = vi.mocked(api.get).mock.calls.length;
  await act(async () => resolve(receipt));
  expect(api.get).toHaveBeenCalledTimes(reads);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(api.logPastActivity).toHaveBeenCalledTimes(1);
});
it('allows deliberate Close after original rejection while overview error persists, without releasing new writes', async () => {
  const workspace = legacyWorkspace();
  let reject!: (error: Error) => void;
  const api = fakeApi({ logPastActivity: vi.fn(() => new Promise<MutationReceipt>((_resolve, fail) => { reject = fail; })) });
  render(<TodayRoute firstUse={workspace.firstUse} api={api} workspaceApi={workspace.api} onOpenLead={vi.fn()} />);
  await screen.findByText('Avery Landlord');
  fireEvent.click(screen.getAllByRole('button', { name: /More actions/ })[0]!);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Log past activity' }));
  const dialog = screen.getByRole('dialog');
  const field = screen.getByLabelText('What happened') as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: 'Keep through persistent overview error' } });
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-09-01' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'I stated the price' }));
  fireEvent.click(screen.getByRole('button', { name: 'Log activity' }));
  const request = vi.mocked(api.logPastActivity).mock.calls[0]![0];
  workspace.overviewGet.mockRejectedValue(new Error('Persistent overview failure'));
  await act(async () => { fireEvent.focus(window); });
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => reject(new Error('Original write unknown')));
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(screen.getByLabelText('What happened')).toBe(field);
  expect(field.value).toBe('Keep through persistent overview error');
  expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-09-01');
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText(/Queue commands are held/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(false);
  // Child queue read succeeded. Only the persistent ancestor error fences this new attempt.
  fireEvent.click(screen.getByRole('button', { name: 'Log activity' }));
  await act(async () => {});
  expect(api.logPastActivity).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api.logPastActivity).mock.calls[0]![0]).toBe(request);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByText(/Queue commands are held/)).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('listitem', { name: 'Avery Landlord' }), { key: 'x' });
  await act(async () => {});
  expect(api.snooze).not.toHaveBeenCalled();
  workspace.overviewGet.mockResolvedValue(localSnapshot({ workflowMode: 'legacy' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh workspace status' })); });
  expect(screen.queryByText(/Queue commands are held/)).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(api.logPastActivity).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(screen.getByRole('listitem', { name: 'Avery Landlord' }), { key: 'x' });
  await act(async () => {});
  expect(api.snooze).toHaveBeenCalledTimes(1);
});
