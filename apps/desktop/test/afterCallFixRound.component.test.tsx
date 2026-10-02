// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import type { CallControl } from '../src/renderer/calling/useCall.ts';
import type { HomeView } from '../src/renderer/homeView.ts';
import { TodayWorkspace, useTodayMemory } from '../src/renderer/today/TodayWorkspace.tsx';
import { PENDING_POLL_MS, WAITING_POLL_MS, WAITING_WINDOW_MS, intervalOf, useReview } from '../src/renderer/today/useAnalysis.ts';
import type { Today, TodayActions } from '../src/renderer/today/useToday.ts';
import type { TodayState } from '../src/renderer/todayContract.ts';
import { buildTodayView } from '../src/renderer/todayView.ts';
import { PROPOSALS, SESSION_ID, analysisAnswer, reviewAnswer, proposalItem } from './support/analysisAnswers.ts';

/**
 * Slice 3a, lane C, fix round (review S3C): the polling bound (8), a failed review read that
 * keeps the last list (7), a late Apply that must not reopen the previous firm (6), and the
 * latest-call card reading the current analysis (minor).
 */

afterEach(() => {
  cleanup();
  (globalThis as { callieApi?: unknown }).callieApi = undefined;
});

describe('finding 8: polling is bounded whatever the state', () => {
  const view = (state: 'pending' | 'completed') => ({ analysis: analysisAnswer({ state }), reason: null });
  it('polls a pending analysis every 4 s inside the window and stops after twenty minutes', () => {
    const ended = 1_000_000;
    expect(intervalOf(view('pending'), ended, ended + 60_000)).toBe(PENDING_POLL_MS);
    expect(intervalOf(view('pending'), ended, ended + WAITING_WINDOW_MS)).toBe(false);
    expect(intervalOf(view('pending'), ended, ended + 7 * 86_400_000)).toBe(false);
  });
  it('waits for an analysis that is not there yet only inside the window; a completed one is never polled', () => {
    const ended = 1_000_000;
    expect(intervalOf({ analysis: null, reason: 'not_found' }, ended, ended + 1000)).toBe(WAITING_POLL_MS);
    expect(intervalOf({ analysis: null, reason: 'not_found' }, ended, ended + WAITING_WINDOW_MS)).toBe(false);
    expect(intervalOf(view('completed'), ended, ended + 1000)).toBe(false);
  });
});

describe('finding 7: a failed review read keeps the last known list', () => {
  function Probe(): JSX.Element {
    const review = useReview(true);
    return (
      <div>
        <span data-testid="count">{review.items === null ? 'none' : String(review.items.length)}</span>
        <span data-testid="failed">{String(review.failed)}</span>
        <button data-testid="reload" onClick={review.reload} />
      </div>
    );
  }
  it('shows the failure once and keeps the items; a 404 hides the group; a later answer clears the line', async () => {
    const answers: { current: unknown }[] = [
      { current: JSON.parse(JSON.stringify(reviewAnswer([proposalItem(PROPOSALS.referral)]))) },
    ];
    let next: unknown = { items: answers[0]?.current ? (answers[0].current as { items: unknown }).items : null, failed: false };
    (globalThis as { callieApi?: unknown }).callieApi = { read: async () => await Promise.resolve(next) };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('1'));
    expect(screen.getByTestId('failed').textContent).toBe('false');

    next = { items: null, failed: true };
    fireEvent.click(screen.getByTestId('reload'));
    await waitFor(() => expect(screen.getByTestId('failed').textContent).toBe('true'));
    expect(screen.getByTestId('count').textContent).toBe('1');

    next = { items: null, failed: false };
    fireEvent.click(screen.getByTestId('reload'));
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('none'));
    expect(screen.getByTestId('failed').textContent).toBe('false');
  });
});

const A = '11111111-1111-4111-8111-111111111111';
const B = '44444444-4444-4444-8444-444444444444';
const ROUTE_ID = '22222222-2222-4222-8222-222222222222';
const NAMES: Readonly<Record<string, string>> = { [A]: 'Elm Fork Test Rentals', [B]: 'Cedar Hollow Test Homes' };
const card = (firmId: string): TodayState['cards'][number] => ({ firmId, firmName: NAMES[firmId] ?? '', lane: 'new_firm', dueAt: '2026-10-01T13:00:00.000Z', counts: { replies: 0, emailsDue: 0, callsDue: 0 } });
const expandedFor = (firmId: string): NonNullable<TodayState['expanded']> => ({
  firmId,
  firmName: NAMES[firmId] ?? '',
  snapshotDate: '2026-10-01',
  lane: 'new_firm',
  counts: { replies: 0, emailsDue: 0, callsDue: 0 },
  tasks: [],
  routes: [{ routeId: ROUTE_ID, contactId: null, e164: '+12145550142', version: 1, eligibility: 'usable' }],
  callingIdentityId: null,
});
const initial = (): TodayState => ({
  snapshotDate: '2026-10-01',
  businessTimeZone: 'America/Chicago',
  cards: [card(A), card(B)],
  expanded: expandedFor(A),
  online: true,
  stale: false,
  asOf: '2026-10-01T13:00:00.000Z',
  mayMutate: true,
  role: 'admin',
  notice: null,
  handoffNotice: '',
  dialAdvice: [{ routeId: ROUTE_ID, callable: true, reasons: [], e164: '+12145550142', firmLocalTime: '09:40' }],
  followUpTemplates: [],
});
const home = {
  heading: 'Thursday, 1 October',
  summary: null,
  notices: [],
  lanes: { sections: [], emptyLine: null },
  status: [],
  needs: [],
  needsLine: 'Nothing needs you.',
  figures: { label: 'Numbers', cells: [], line: null },
} as unknown as HomeView;
const ended: CallControl = {
  state: { phase: 'ended', firmId: A, routeId: ROUTE_ID, sessionId: SESSION_ID, seconds: 30 },
  muted: false,
  seconds: 30,
  place: vi.fn(),
  toggleMute: vi.fn(),
  hangUp: vi.fn(),
  dismiss: vi.fn(),
};

let asked: { firmId: string; answer: () => void }[] = [];

function Harness(): JSX.Element {
  const [state, setState] = useState<TodayState>(initial);
  const memory = useTodayMemory();
  const actions = {
    busy: () => false,
    dial: vi.fn(),
    expand: (firmId: string) => {
      asked.push({ firmId, answer: () => setState(current => ({ ...current, expanded: expandedFor(firmId) })) });
    },
  } as unknown as TodayActions;
  const today: Today = { state, pending: 0, commands: 0, refreshAnswered: true, now: Date.parse('2026-10-01T14:00:00.000Z'), refresh: vi.fn(), actions, autoRefresh: vi.fn() };
  return <TodayWorkspace home={home} today={today} todayView={buildTodayView(state)} call={ended} memory={memory} hasTodayBridge onRefresh={vi.fn()} onConnectMailbox={vi.fn()} />;
}

describe('finding 6: a late Apply never reopens the firm it came from', () => {
  let release: () => void = () => undefined;
  beforeEach(() => {
    asked = [];
    const applied = {
      applied: {
        analysisId: '33333333-3333-4333-8333-3333333333cc',
        callSessionId: SESSION_ID,
        callLogId: null,
        results: [{ key: 'outcome', kind: 'outcome', result: 'applied', edited: false, id: null }],
        followUps: [],
      },
      reason: null,
      keyReasons: {},
    };
    (globalThis as { callieApi?: unknown }).callieApi = {
      read: vi.fn(async (operation: string) => {
        if (operation === 'calling.analysis') return { analysis: analysisAnswer({ proposals: [PROPOSALS.outcome] }), reason: null };
        if (operation === 'calling.status') return { provider: 'twilio', cadence: { unansweredAttempts: 0, nextAttempt: 1, limit: 4, parked: false, refusal: null } };
        if (operation === 'review.list') return { items: [], failed: false };
        return { calls: [] };
      }),
      command: vi.fn(async () => await new Promise(resolve => (release = () => resolve(applied)))),
    };
  });

  it('refreshes A’s data but leaves B open when A’s answer lands after the move', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <DraftsProvider>
          <Harness />
        </DraftsProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('apply')).toBeTruthy());
    const before = asked.length;
    fireEvent.click(screen.getByTestId('apply'));
    fireEvent.click(screen.getByText(NAMES[B]!, { selector: '[data-testid="queue-firm"]' }));
    await act(async () => {
      asked[asked.length - 1]!.answer();
    });
    expect(screen.getByTestId('firm-name').textContent).toBe(NAMES[B]);
    const mark = asked.length;
    expect(mark).toBeGreaterThan(before);
    await act(async () => {
      release();
      await Promise.resolve();
    });
    // No expansion of A was asked for by the late answer.
    expect(asked.slice(mark).filter(entry => entry.firmId === A)).toEqual([]);
    expect(screen.getByTestId('firm-name').textContent).toBe(NAMES[B]);
  });
});
