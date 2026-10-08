// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState, type JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import type { CallControl, CallPhase } from '../src/renderer/calling/useCall.ts';
import type { HomeView } from '../src/renderer/homeView.ts';
import { OutcomeForm } from '../src/renderer/today/OutcomeForm.tsx';
import { TodayWorkspace, useTodayMemory } from '../src/renderer/today/TodayWorkspace.tsx';
import type { Today, TodayActions } from '../src/renderer/today/useToday.ts';
import type { TodayState } from '../src/renderer/todayContract.ts';
import { buildTodayView } from '../src/renderer/todayView.ts';

/**
 * The outcome form reset (X1F) in Today itself: "the call just placed" is resolved once, when
 * the form opens, from the main process's last call and its session; the request names that
 * call; a retry after a lost answer is that call's request whatever was dialled since; a
 * recorded call leaves the form open on no call, which takes the next call only while nothing
 * is typed there; and the live call's note is that call's draft from the start.
 */

afterEach(() => {
  cleanup();
  (globalThis as { callieApi?: unknown }).callieApi = undefined;
});

const A = '11111111-1111-4111-8111-111111111111';
const ROUTE_ID = '22222222-2222-4222-8222-222222222222';
const CONTACT_ID = '33333333-3333-4333-8333-333333333333';
const S1 = '5a5a5a5a-5a5a-45a5-85a5-5a5a5a5a5a51';
const S2 = '5a5a5a5a-5a5a-45a5-85a5-5a5a5a5a5a52';
const S3 = '5a5a5a5a-5a5a-45a5-85a5-5a5a5a5a5a53';

const lastCallOf = (callSessionId: string | null): NonNullable<TodayState['lastCall']> => ({
  firmId: A,
  routeId: ROUTE_ID,
  contactId: CONTACT_ID,
  e164: '+12145550142',
  callSessionId,
});
const initial = (callSessionId: string | null): TodayState => ({
  snapshotDate: '2026-10-02',
  businessTimeZone: 'America/Chicago',
  cards: [{ firmId: A, firmName: 'Elm Fork Test Rentals', lane: 'new_firm', dueAt: '2026-10-02T13:00:00.000Z', counts: { replies: 0, emailsDue: 0, callsDue: 0 } }],
  expanded: {
    firmId: A,
    firmName: 'Elm Fork Test Rentals',
    snapshotDate: '2026-10-02',
    lane: 'new_firm',
    counts: { replies: 0, emailsDue: 0, callsDue: 0 },
    tasks: [],
    routes: [{ routeId: ROUTE_ID, contactId: CONTACT_ID, e164: '+12145550142', version: 1, eligibility: 'usable' }],
    callingIdentityId: null,
  },
  online: true,
  stale: false,
  asOf: '2026-10-02T13:00:00.000Z',
  mayMutate: true,
  role: 'admin',
  notice: null,
  handoffNotice: '',
  dialAdvice: [{ routeId: ROUTE_ID, callable: true, reasons: [], e164: '+12145550142', firmLocalTime: '09:40' }],
  followUpTemplates: [],
  lastCall: callSessionId === undefined ? null : lastCallOf(callSessionId),
});
const home = {
  heading: 'Friday, 2 October',
  summary: null,
  notices: [],
  lanes: { sections: [], emptyLine: null },
  status: [],
  needs: [],
  needsLine: 'Nothing needs you.',
  figures: { label: 'Numbers', cells: [], line: null },
} as unknown as HomeView;
const control = (state: CallPhase): CallControl => ({ state, muted: false, seconds: 0, place: vi.fn(), toggleMute: vi.fn(), hangUp: vi.fn(), dismiss: vi.fn() });
const IDLE: CallPhase = { phase: 'idle' };

type Sent = Record<string, unknown> & { readonly commandId: string };

/** Today over a shell that keeps its memory, with the state and the call driven by the test. */
function world(start: TodayState) {
  const sent: Sent[] = [];
  const pending: ((state: TodayState | null) => void)[] = [];
  const handle: { setState: (next: TodayState) => void; setCall: (next: CallPhase) => void } = { setState: () => undefined, setCall: () => undefined };
  function Shell(): JSX.Element {
    const [state, setState] = useState<TodayState>(start);
    const [phase, setPhase] = useState<CallPhase>(IDLE);
    handle.setState = setState;
    handle.setCall = setPhase;
    const memory = useTodayMemory();
    const actions = {
      busy: () => false,
      dial: vi.fn(),
      expand: vi.fn(),
      previewFollowUp: vi.fn(),
      recordOutcome: (input: Sent) => {
        sent.push(input);
        return new Promise<TodayState | null>(resolve => pending.push(resolve));
      },
    } as unknown as TodayActions;
    const today: Today = { state, pending: 0, commands: 0, refreshAnswered: true, now: Date.parse('2026-10-02T14:00:00.000Z'), refresh: vi.fn(), actions, autoRefresh: vi.fn() };
    return <TodayWorkspace home={home} today={today} todayView={buildTodayView(state)} call={control(phase)} memory={memory} hasTodayBridge onRefresh={vi.fn()} onConnectMailbox={vi.fn()} />;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DraftsProvider>
        <Shell />
      </DraftsProvider>
    </QueryClientProvider>,
  );
  return {
    sent,
    setState: async (next: TodayState) => {
      await act(async () => {
        handle.setState(next);
        await Promise.resolve();
      });
    },
    setCall: async (next: CallPhase) => {
      await act(async () => {
        handle.setCall(next);
        await Promise.resolve();
      });
    },
    /** Answer request `index`: recorded, refused or lost (null), with the state main answers with. */
    answer: async (index: number, outcomeAnswer: { recorded: boolean; reason: string | null } | null, state: TodayState) => {
      await act(async () => {
        pending[index]?.(outcomeAnswer === null ? null : { ...state, outcomeAnswer: { commandId: sent[index]!.commandId, ...outcomeAnswer } });
        await Promise.resolve();
      });
    },
  };
}

const choose = (testId: string, value: string): void => {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
};
const record = (outcome: string): void => {
  choose('outcome-select', outcome);
  fireEvent.click(screen.getByTestId('outcome-submit'));
};

beforeEach(() => {
  (globalThis as { callieApi?: unknown }).callieApi = {
    read: vi.fn(async (operation: string) => {
      if (operation === 'recordings.recoveries') return { items: [], truncated: false };
      if (operation === 'calling.status') return { provider: 'twilio', cadence: { unansweredAttempts: 0, nextAttempt: 1, limit: 4, parked: false, refusal: null } };
      if (operation === 'review.list') return { items: [], failed: false };
      if (operation === 'calling.analysis') return { analysis: null, reason: 'not_found' };
      return { calls: [] };
    }),
    command: vi.fn(async () => ({})),
  };
});

describe('X1F rule 1: the call is resolved when the form opens, and the request names it', () => {
  it('keeps typed outcomes with their firm and call across A-to-B-to-A navigation', async () => {
    const w = world(initial(S1));
    fireEvent.click(screen.getByTestId('firm-outcome'));
    fireEvent.change(screen.getByTestId('outcome-note'), { target: { value: 'Elm Fork call notes.' } });
    const otherFirmId = '44444444-4444-4444-8444-444444444444';
    const other = initial(S2);
    const otherState: TodayState = {
      ...other,
      cards: [...other.cards, { ...other.cards[0]!, firmId: otherFirmId, firmName: 'Cedar Hollow Test Homes' }],
      expanded: { ...other.expanded!, firmId: otherFirmId, firmName: 'Cedar Hollow Test Homes' },
      lastCall: { ...other.lastCall!, firmId: otherFirmId },
    };
    await w.setState(otherState);
    expect(screen.queryByTestId('outcome-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('firm-outcome'));
    expect((screen.getByTestId('outcome-note') as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(screen.getByTestId('outcome-note'), { target: { value: 'Cedar Hollow call notes.' } });

    await w.setState(initial(S1));
    fireEvent.click(screen.getByTestId('firm-outcome'));
    expect((screen.getByTestId('outcome-note') as HTMLTextAreaElement).value).toBe('Elm Fork call notes.');
    record('no_answer');
    expect(w.sent[0]).toMatchObject({ firmId: A, callSessionId: S1, note: 'Elm Fork call notes.' });
  });

  it('names the last call’s session, number and person', async () => {
    const w = world(initial(S1));
    fireEvent.click(screen.getByTestId('firm-outcome'));
    record('no_answer');
    expect(w.sent[0]).toMatchObject({ callSessionId: S1, routeId: ROUTE_ID, contactId: CONTACT_ID, outcome: 'no_answer' });
  });

  it('a lost answer, then a new call on the same number, then Record again: the same request under the same id', async () => {
    const w = world(initial(S1));
    fireEvent.click(screen.getByTestId('firm-outcome'));
    record('no_answer');
    await w.answer(0, null, initial(S1));
    // Call S2 is placed on the same number while S1's answer is unknown.
    await w.setState(initial(S2));
    expect(screen.getByTestId('outcome-unanswered')).toBeTruthy();
    fireEvent.click(screen.getByTestId('outcome-submit'));
    expect(JSON.stringify(w.sent[1])).toBe(JSON.stringify(w.sent[0]));
    expect(w.sent[1]!['callSessionId']).toBe(S1);
  });

  it('a recorded call leaves the form on no call, and the next call placed is the next opening’s', async () => {
    const w = world(initial(S1));
    fireEvent.click(screen.getByTestId('firm-outcome'));
    record('no_answer');
    // Main recorded S1 and cleared its last call; the form stays open, on no call.
    await w.answer(0, { recorded: true, reason: null }, { ...initial(S1), lastCall: null });
    await w.setState({ ...initial(S1), lastCall: null });
    expect(screen.getByTestId('outcome-call').textContent).toContain('records the call as history');
    // The next call is placed: nothing is typed under "no call", so the open form takes it.
    await w.setState(initial(S3));
    expect(screen.getByTestId('outcome-call').textContent).toBe('The call to +12145550142.');
    record('voicemail_left');
    expect(w.sent[1]).toMatchObject({ callSessionId: S3, outcome: 'voicemail_left' });
    expect(w.sent[1]!.commandId).not.toBe(w.sent[0]!.commandId);
  });

  it('never resolves again to the call it just recorded, even from a state read before main cleared it', async () => {
    const w = world(initial(S1));
    fireEvent.click(screen.getByTestId('firm-outcome'));
    record('no_answer');
    // The answer lands while the state on screen still shows S1 as the last call.
    await w.answer(0, { recorded: true, reason: null }, initial(S1));
    expect(screen.getByTestId('outcome-call').textContent).toContain('records the call as history');
    fireEvent.click(screen.getByTestId('outcome-submit'));
    expect(w.sent).toHaveLength(1);
  });

  it('a form on no call with something typed keeps it when a call is placed', async () => {
    const w = world({ ...initial(S1), lastCall: null });
    fireEvent.click(screen.getByTestId('firm-outcome'));
    fireEvent.change(screen.getByTestId('outcome-note'), { target: { value: 'Typed before the call.' } });
    await w.setState(initial(S3));
    expect((screen.getByTestId('outcome-note') as HTMLTextAreaElement).value).toBe('Typed before the call.');
    expect(screen.getByTestId('outcome-call').textContent).toContain('records the call as history');
  });
});

describe('X1F rule 2: the live call’s note is that call’s draft from the start', () => {
  it('the note typed during the call is in the form for that call, and in no other call’s', async () => {
    const w = world(initial(S1));
    await w.setCall({ phase: 'connected', firmId: A, routeId: ROUTE_ID, sessionId: S1, attempt: 1, voicemailScript: null, answeredAt: Date.now() });
    fireEvent.change(screen.getByTestId('call-notes'), { target: { value: 'Said to call after lunch.' } });
    await w.setCall({ phase: 'ended', firmId: A, routeId: ROUTE_ID, sessionId: S1, seconds: 40 });
    fireEvent.click(screen.getByTestId('firm-outcome'));
    expect((screen.getByTestId('outcome-note') as HTMLTextAreaElement).value).toBe('Said to call after lunch.');
    // The queue still marks this firm as having a note typed and not yet saved.
    expect(screen.queryAllByTestId('queue-note')).toHaveLength(1);
  });

  it('while the call is starting there is no session yet, and the note field waits for one', async () => {
    const w = world(initial(S1));
    await w.setCall({ phase: 'starting', firmId: A, routeId: ROUTE_ID });
    expect((screen.getByTestId('call-notes') as HTMLTextAreaElement).disabled).toBe(true);
  });
});

describe('X1F rule 2: a named session reads the same call’s drafts', () => {
  it('"Enter manually" for the call finds what was typed for it as the call just placed', async () => {
    const state = initial(S1);
    const actions = { busy: () => false, recordOutcome: vi.fn(), previewFollowUp: vi.fn() } as unknown as TodayActions;
    const drawn = render(
      <DraftsProvider>
        <OutcomeForm state={state} view={buildTodayView(state)} enabled actions={actions} target={{ kind: 'current', call: { routeId: ROUTE_ID, contactId: CONTACT_ID, e164: '+12145550142', callSessionId: S1 } }} />
      </DraftsProvider>,
    );
    fireEvent.change(screen.getByTestId('outcome-note'), { target: { value: 'For S1.' } });
    drawn.rerender(
      <DraftsProvider>
        <OutcomeForm state={state} view={buildTodayView(state)} enabled actions={actions} target={{ kind: 'session', callSessionId: S1 }} />
      </DraftsProvider>,
    );
    expect((screen.getByTestId('outcome-note') as HTMLTextAreaElement).value).toBe('For S1.');
    drawn.rerender(
      <DraftsProvider>
        <OutcomeForm state={state} view={buildTodayView(state)} enabled actions={actions} target={{ kind: 'session', callSessionId: S2 }} />
      </DraftsProvider>,
    );
    expect((screen.getByTestId('outcome-note') as HTMLTextAreaElement).value).toBe('');
  });
});
