// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MutationReceipt } from '../../../shared/contracts/commonContract';
import type {
  TodayItem,
  TodaySnapshot,
} from '../../../shared/contracts/todayContract';
import type { TodayApi } from '../../../preload/apis/todayApi';
import { TodayRoute } from './TodayRoute';

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
    dueAt: '2026-08-31T15:00:00.000Z',
    label: 'Call lead',
    overdue: false,
  },
  reason: 'Ready P1 within capacity',
  activeTriggers: [],
  verifyFirst: false,
  pinned: false,
  consentRequirement: null,
  ...overrides,
});

const snapshot = (revision: number, items: TodayItem[]): TodaySnapshot => ({
  lanes: [
    { id: 'onboarding', items: [] },
    { id: 'fresh_inbound', items: [] },
    { id: 'overdue', items: [] },
    { id: 'post_interview_offer', items: [] },
    { id: 'due_cadence', items: [] },
    { id: 'new_p0', items: [] },
    { id: 'p1', items },
    { id: 'exploration', items: [] },
    { id: 'later', items: [] },
  ],
  dialBudget: 40,
  scheduledDials: items.length,
  conversationTarget: 5,
  reviewErrorCount: 0,
  unreviewedBacklogCount: 0,
  revision,
});

const receipt: MutationReceipt = {
  revision: 2,
  affectedPersonIds: ['person-p1'],
  affectedSalesCycleIds: ['cycle-p1'],
};

function fakeApi(overrides: Partial<TodayApi> = {}): TodayApi {
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
          dueAt: '2026-08-31T15:00:00.000Z',
          label: 'Call lead',
          overdue: false,
        },
      }),
    ])),
    complete: vi.fn(async () => receipt),
    snooze: vi.fn(async () => receipt),
    pin: vi.fn(async () => receipt),
    logPastActivity: vi.fn(async () => receipt),
    ...overrides,
  } as TodayApi;
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

  it('shows a retryable error state without raw error details', async () => {
    const failing = vi.fn(async () => {
      throw new Error('SQLITE_IOERR at /private/tmp/callie.sqlite3');
    });
    const api = fakeApi({ get: failing as unknown as TodayApi['get'] });
    render(<TodayRoute api={api} onOpenLead={vi.fn()} />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/SQLITE_IOERR/)).toBeNull();

    api.get = vi.fn(async () => snapshot(3, [item()]));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Avery Landlord')).toBeTruthy();
  });

  it('does not let pin move a row across lanes', async () => {
    const api = fakeApi();
    render(<TodayRoute api={api} onOpenLead={vi.fn()} />);
    await screen.findByText('Blake Owner');

    // Avery is promoted to the Next up hero; Blake is the lane row whose
    // pin comparison is still the lane-local row above (Avery).
    const pins = screen.getAllByRole('button', { name: 'Pin · P' });
    fireEvent.click(pins[0]!);

    await waitFor(() => expect(api.pin).toHaveBeenCalledTimes(1));
    expect(api.pin).toHaveBeenCalledWith({
      salesCycleId: 'cycle-p1-b',
      reason: 'Keep at the top of its lane',
      expiresAt: expect.any(String),
      comparedSalesCycleId: 'cycle-p1',
    });
  });

  it('navigates to Leads from the unreviewed backlog band', async () => {
    const api = fakeApi({
      get: vi.fn(async () => ({
        ...snapshot(1, [item()]),
        unreviewedBacklogCount: 354,
      })) as unknown as TodayApi['get'],
    });
    render(<TodayRoute api={api} onOpenLead={vi.fn()} />);
    await screen.findByText('Unreviewed backlog · 354');

    fireEvent.click(screen.getByRole('button', { name: 'Review in Leads' }));
    expect(window.location.hash).toBe('#/leads');
  });

  it('refetches after a successful complete receipt', async () => {
    const api = fakeApi();
    render(<TodayRoute api={api} onOpenLead={vi.fn()} />);
    await screen.findByText('Avery Landlord');
    expect(api.get).toHaveBeenCalled();
    const fetchesBefore = (api.get as ReturnType<typeof vi.fn>).mock.calls.length;

    fireEvent.click(screen.getAllByRole('button', { name: 'Done' })[0]!);

    await waitFor(() => expect(api.complete).toHaveBeenCalledTimes(1));
    expect(api.complete).toHaveBeenCalledWith({
      salesCycleId: 'cycle-p1',
      actionId: 'action-p1',
      outcome: 'answered',
      activityId: null,
    });
    await waitFor(() => {
      expect(
        (api.get as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBeGreaterThan(fetchesBefore);
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
      }) as unknown as TodayApi['get'],
    });
    render(<TodayRoute api={api} onOpenLead={vi.fn()} />);

    await waitFor(() => expect(call).toBeGreaterThanOrEqual(1));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Fresh Person')).toBeTruthy();

    releaseStale(snapshot(1, [item({ personName: 'Stale Person' })]));
    await waitFor(() => expect(screen.queryByText('Stale Person')).toBeNull());
    expect(screen.getByText('Fresh Person')).toBeTruthy();
  });

  it('surfaces a safe command error and keeps the queue visible', async () => {
    const api = fakeApi({
      complete: vi.fn(async () => {
        throw new Error('opted_out person: raw tombstone id 123');
      }) as unknown as TodayApi['complete'],
    });
    render(<TodayRoute api={api} onOpenLead={vi.fn()} />);
    await screen.findByText('Avery Landlord');

    fireEvent.click(screen.getAllByRole('button', { name: 'Done' })[0]!);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/tombstone/)).toBeNull();
    expect(screen.getByText('Avery Landlord')).toBeTruthy();
  });
});
