// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function fakeApi(overrides: Partial<TodayRouteApi> = {}): TodayRouteApi {
  return {
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
  } as TodayRouteApi;
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
        <TodayRoute api={api} onOpenLead={vi.fn()} />
      </StrictMode>,
    );

    expect(
      screen.getByRole('progressbar', { name: 'Loading today' }),
    ).toBeTruthy();
    expect(await screen.findByText('Avery Landlord')).toBeTruthy();
  });

  it('renders the header dial meter and the muted date, with no visible Refresh', async () => {
    const api = fakeApi();
    render(<TodayRoute api={api} onOpenLead={vi.fn()} />);
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
    render(<TodayRoute api={api} onOpenLead={vi.fn()} />);
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
    render(<TodayRoute api={api} onOpenLead={vi.fn()} />);

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
      <TodayRoute
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
    render(<TodayRoute api={api} onOpenLead={vi.fn()} />);
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
    render(<TodayRoute api={api} onOpenLead={vi.fn()} />);

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
    render(<TodayRoute api={api} onOpenLead={vi.fn()} />);
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
  render(<TodayRoute api={api} leadApi={leadApi} discoveryApi={discoveryApi} onOpenLead={vi.fn()} />);
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
  render(<TodayRoute api={api} onOpenLead={vi.fn()} />);
  await screen.findByText('No contacts due right now.');
  expect(screen.queryByText(/Queue done|All done/)).toBeNull();
});
it('refreshes queue membership after an accepted email without a focus workaround', async () => {
  const api = fakeApi(); render(<TodayRoute api={api} onOpenLead={vi.fn()} />);
  await screen.findByText('Avery Landlord'); const reads = vi.mocked(api.get).mock.calls.length;
  fireEvent(window, new CustomEvent('callie:email-sent', { detail: { personId: 'person-p1', salesCycleId: 'cycle-p1' } }));
  await waitFor(() => expect(vi.mocked(api.get).mock.calls.length).toBe(reads + 1));
});

it('shows the real current date badge and opens the primary brief without a call or mutation', async () => {
  const api = fakeApi(); const open = vi.fn(); const fullPage = vi.fn();
  render(<TodayRoute api={api} onOpenLead={open} onOpenLeadPage={fullPage} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Avery Landlord' }));
  expect(open).toHaveBeenCalledWith('person-p1'); expect(fullPage).not.toHaveBeenCalled();
  expect(api.complete).not.toHaveBeenCalled(); expect(api.logPastActivity).not.toHaveBeenCalled();
  const badge = screen.getByLabelText('Current date');
  expect(badge.textContent).toContain(new Date().toLocaleDateString(undefined, { day: '2-digit' }));
  expect(badge.getAttribute('datetime')).toBe(new Date().toLocaleDateString('en-CA'));
});
