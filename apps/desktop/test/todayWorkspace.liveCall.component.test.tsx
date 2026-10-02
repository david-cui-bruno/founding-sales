// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState, type JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import type { CallControl } from '../src/renderer/calling/useCall.ts';
import type { HomeView } from '../src/renderer/homeView.ts';
import { TodayWorkspace, useTodayMemory } from '../src/renderer/today/TodayWorkspace.tsx';
import type { Today, TodayActions } from '../src/renderer/today/useToday.ts';
import type { TodayState } from '../src/renderer/todayContract.ts';
import { buildTodayView } from '../src/renderer/todayView.ts';

/**
 * S2 review, finding 4: a navigation read that lands after Call was pressed on another
 * firm. Select B; before B's expansion answers, a call starts on A; then B's answer lands.
 * Hang up and Mute stay on screen for A's call, A's queue row stays pressable, and Today
 * opens A again. The reads are completed by hand, so the order is the one in the finding.
 * No real firm or number; the number is in the NANP 555-01XX block.
 */

afterEach(cleanup);

const A = '11111111-1111-4111-8111-111111111111';
const B = '44444444-4444-4444-8444-444444444444';
const ROUTE_ID = '22222222-2222-4222-8222-222222222222';
const NAMES: Readonly<Record<string, string>> = { [A]: 'Elm Fork Test Rentals', [B]: 'Cedar Hollow Test Homes' };

const card = (firmId: string): TodayState['cards'][number] => ({
  firmId,
  firmName: NAMES[firmId] ?? '',
  lane: 'new_firm',
  dueAt: '2026-10-01T13:00:00.000Z',
  counts: { replies: 0, emailsDue: 0, callsDue: 0 },
});

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

const callOf = (phase: CallControl['state']): CallControl => ({
  state: phase,
  muted: false,
  seconds: 12,
  place: vi.fn(),
  toggleMute: vi.fn(),
  hangUp: vi.fn(),
  dismiss: vi.fn(),
});

/** Every expansion asked for, each answered only when the test says so. */
let asked: { firmId: string; answer: () => void }[] = [];

function Harness({ call }: { readonly call: CallControl }): JSX.Element {
  const [state, setState] = useState<TodayState>(initial);
  const memory = useTodayMemory();
  const actions = {
    busy: () => false,
    dial: vi.fn(),
    expand: (firmId: string) => {
      asked.push({ firmId, answer: () => setState(current => ({ ...current, expanded: expandedFor(firmId) })) });
    },
  } as unknown as TodayActions;
  const today: Today = {
    state,
    pending: 0,
    commands: 0,
    refreshAnswered: true,
    now: Date.parse('2026-10-01T14:00:00.000Z'),
    refresh: vi.fn(),
    actions,
    autoRefresh: vi.fn(),
  };
  return (
    <TodayWorkspace
      home={home}
      today={today}
      todayView={buildTodayView(state)}
      call={call}
      memory={memory}
      hasTodayBridge
      onRefresh={vi.fn()}
      onConnectMailbox={vi.fn()}
    />
  );
}

beforeEach(() => {
  asked = [];
  globalThis.callieApi = {
    read: vi.fn(async (operation: string) =>
      operation === 'calling.status'
        ? { provider: 'twilio', cadence: { unansweredAttempts: 0, nextAttempt: 1, limit: 4, parked: false, refusal: null } }
        : { calls: [] },
    ),
    command: vi.fn(async () => ({})),
  } as unknown as typeof globalThis.callieApi;
});

describe('a late navigation read during a call', () => {
  it('leaves the call’s controls on screen, keeps its firm reachable, and opens that firm again', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (call: CallControl): JSX.Element => (
      <QueryClientProvider client={client}>
        <DraftsProvider>
          <Harness call={call} />
        </DraftsProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(tree(callOf({ phase: 'idle' })));
    expect(screen.getByTestId('firm-name').textContent).toBe(NAMES[A]);

    // B is chosen; its read is on the wire.
    fireEvent.click(screen.getByText(NAMES[B]!, { selector: '[data-testid="queue-firm"]' }));
    expect(asked.map(entry => entry.firmId)).toEqual([B]);

    // Call is pressed on A, which is still the firm on screen, and A's call rings.
    rerender(
      tree(
        callOf({ phase: 'ringing', firmId: A, routeId: ROUTE_ID, sessionId: 'session-1', attempt: 1, voicemailScript: null, answeredAt: null }),
      ),
    );
    expect(screen.queryByTestId('call-hang-up')).not.toBeNull();

    // B's answer lands late.
    await act(async () => {
      asked[0]!.answer();
    });
    expect(screen.getByTestId('firm-name').textContent).toBe(NAMES[B]);
    // The call's controls are still there, for A's call.
    expect(screen.queryByTestId('call-hang-up')).not.toBeNull();
    expect(screen.queryByTestId('call-mute')).not.toBeNull();
    // A stays reachable from the queue; B, the firm that is open, cannot be left for a third.
    const rowA = document.querySelector(`[data-testid="queue-row"][data-firm="${A}"]`) as HTMLButtonElement;
    expect(rowA.disabled).toBe(false);
    // And Today opens A again by itself.
    expect(asked.map(entry => entry.firmId)).toEqual([B, A]);
    await act(async () => {
      asked[1]!.answer();
    });
    expect(screen.getByTestId('firm-name').textContent).toBe(NAMES[A]);
    expect(screen.queryByTestId('call-hang-up')).not.toBeNull();
    expect(asked).toHaveLength(2);
  });
});
