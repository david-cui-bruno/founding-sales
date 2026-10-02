// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type JSX } from 'react';
import type { DashboardResponse } from '@fss/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import type { CallControl } from '../src/renderer/calling/useCall.ts';
import { figuresView, type HomeView } from '../src/renderer/homeView.ts';
import { TodayWorkspace, useTodayMemory, type TodayMemory } from '../src/renderer/today/TodayWorkspace.tsx';
import type { Today, TodayActions } from '../src/renderer/today/useToday.ts';
import type { TodayState } from '../src/renderer/todayContract.ts';
import { buildTodayView } from '../src/renderer/todayView.ts';

/**
 * Slice 3a, C0: Today's subtabs, the toggles, the numbers' periods and links, and what
 * survives a round trip out of Today. The workspace is drawn whole, with the bridges absent
 * (the harness has no `callieApi`), so these are the shipped components and not copies.
 * No real firm or number: the number is in the NANP 555-01XX block.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const FIRM_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';
const ROUTE_ID = '22222222-2222-4222-8222-222222222222';
const WINDOW = { from: '2026-09-18T12:00:00.000Z', to: '2026-09-25T12:00:00.000Z' };

const dashboard = {
  window: WINDOW,
  audience: 'workspace',
  firmsInScope: 5,
  messages: { incomingMatched: 6, human: 3, uncertain: 1, automated: 0, bounces: 0, optOuts: 0 },
  replyHandling: { replies: 4, handled: 2, medianSecondsToHandle: 600, slowestSecondsToHandle: 1200 },
  calls: [{ key: 'voicemail_left', count: 5 }],
  stageMovement: [],
  holds: { open: 2, byReason: [] },
  suppressions: [],
  sending: { available: false, owner: 'G7-2', reason: 'not in this build' },
  enrollments: { available: false, owner: 'G8', reason: 'not in this build' },
  classifier: { available: false, owner: 'G7b', reason: 'not in this build' },
  funnel: { available: true, byKind: [{ key: 'meeting.booked', count: 2 }], firmsByKind: [], uniqueFirms: 2, firmsInScope: 5 },
} as unknown as DashboardResponse;

const card = (firmId: string, name: string): TodayState['cards'][number] => ({
  firmId,
  firmName: name,
  lane: 'new_firm',
  dueAt: '2026-10-01T13:00:00.000Z',
  counts: { replies: 0, emailsDue: 0, callsDue: 0 },
});

function stateOf(overrides: Partial<TodayState> = {}): TodayState {
  return {
    snapshotDate: '2026-10-01',
    businessTimeZone: 'America/Chicago',
    cards: [card(FIRM_ID, 'Elm Fork Test Rentals'), card(OTHER_ID, 'Birch Test Partners')],
    expanded: {
      firmId: FIRM_ID,
      firmName: 'Elm Fork Test Rentals',
      snapshotDate: '2026-10-01',
      lane: 'new_firm',
      counts: { replies: 0, emailsDue: 0, callsDue: 0 },
      tasks: [],
      routes: [{ routeId: ROUTE_ID, contactId: null, e164: '+12145550142', version: 1, eligibility: 'usable' }],
      callingIdentityId: null,
    },
    online: true,
    stale: false,
    asOf: '2026-10-01T13:00:00.000Z',
    mayMutate: true,
    role: 'admin',
    notice: null,
    handoffNotice: '',
    dialAdvice: [{ routeId: ROUTE_ID, callable: true, reasons: [], e164: '+12145550142', firmLocalTime: '09:40' }],
    followUpTemplates: [],
    ...overrides,
  };
}

const home = {
  heading: 'Thursday, 1 October',
  summary: null,
  notices: [],
  lanes: { sections: [], emptyLine: null },
  status: [],
  needs: [],
  needsLine: 'Nothing needs you.',
  figures: figuresView({ admin: true, figures: { requested: WINDOW, answered: true, dashboard }, callsToday: 2, zone: 'America/New_York' }),
} as unknown as HomeView;

const idle: CallControl = {
  state: { phase: 'idle' },
  muted: false,
  seconds: 0,
  place: vi.fn(),
  toggleMute: vi.fn(),
  hangUp: vi.fn(),
  dismiss: vi.fn(),
};

const actions = { busy: () => false, expand: vi.fn(), dial: vi.fn() } as unknown as TodayActions;

/** The workspace as the shell mounts it: its memory and the draft store are above it. */
function Shell({ memory, state, call = idle }: { readonly memory: TodayMemory; readonly state: TodayState; readonly call?: CallControl }): JSX.Element {
  const today = {
    state,
    pending: 0,
    commands: 0,
    refreshAnswered: true,
    now: Date.parse('2026-10-01T13:05:00.000Z'),
    refresh: vi.fn(),
    actions,
    autoRefresh: vi.fn(),
  } as unknown as Today;
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

/** Today, and a stand-in for "somewhere else" the test can switch to and back from. */
function Window({ state = stateOf(), call }: { readonly state?: TodayState; readonly call?: CallControl }): JSX.Element {
  const memory = useTodayMemory();
  const [elsewhere, setElsewhere] = useState(false);
  return (
    <>
      <button type="button" data-testid="go-away" onClick={() => setElsewhere(true)} />
      <button type="button" data-testid="come-back" onClick={() => setElsewhere(false)} />
      {elsewhere ? <p data-testid="elsewhere">Pipeline</p> : <Shell memory={memory} state={state} {...(call === undefined ? {} : { call })} />}
    </>
  );
}

function mount(props: Parameters<typeof Window>[0] = {}) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DraftsProvider>
        <Window {...props} />
      </DraftsProvider>
    </QueryClientProvider>,
  );
}

describe('Today’s subtabs (item 1)', () => {
  it('opens on the Queue, holds the numbers back, and shows them on Overview', () => {
    mount();
    expect(screen.getByTestId('today-tab-queue').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('queue-region')).toBeTruthy();
    // The numbers are not under the queue any more.
    expect(screen.queryByTestId('figures')).toBeNull();
    fireEvent.click(screen.getByTestId('today-tab-overview'));
    expect(screen.getByTestId('today-tab-overview').getAttribute('aria-selected')).toBe('true');
    expect(within(screen.getByTestId('today-overview')).getByTestId('figures')).toBeTruthy();
    expect(screen.queryByTestId('queue-region')).toBeNull();
  });

  it('opens on the Queue again every time Today is mounted, even after Overview was left open', () => {
    mount();
    fireEvent.click(screen.getByTestId('today-tab-overview'));
    fireEvent.click(screen.getByTestId('go-away'));
    fireEvent.click(screen.getByTestId('come-back'));
    expect(screen.getByTestId('today-tab-queue').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('queue-region')).toBeTruthy();
  });

  it('keeps the live call visible on Overview, with the way back to it', () => {
    const live: CallControl = {
      ...idle,
      state: { phase: 'connected', firmId: FIRM_ID, routeId: ROUTE_ID, sessionId: 's', attempt: 1, voicemailScript: null, answeredAt: 0 },
      seconds: 75,
    };
    mount({ call: live });
    expect(screen.queryByTestId('today-live-call')).toBeNull();
    fireEvent.click(screen.getByTestId('today-tab-overview'));
    expect(screen.getByTestId('today-live-call-status').textContent).toContain('On a call · recording');
    fireEvent.click(screen.getByTestId('today-live-call-show'));
    expect(screen.getByTestId('queue-region')).toBeTruthy();
  });
});

describe('the toggles (item 2)', () => {
  it('closes Edit on a second click, on Escape, and keeps what was typed', () => {
    mount();
    fireEvent.click(screen.getByTestId('firm-edit'));
    fireEvent.change(screen.getByTestId('basics-locality'), { target: { value: 'Waco' } });
    // A second click on the same button closes it.
    fireEvent.click(screen.getByTestId('firm-edit'));
    expect(screen.queryByTestId('basics-editor')).toBeNull();
    // Reopened, the draft is there.
    fireEvent.click(screen.getByTestId('firm-edit'));
    expect((screen.getByTestId('basics-locality') as HTMLInputElement).value).toBe('Waco');
    // Escape closes it, and does not discard.
    fireEvent.keyDown(screen.getByTestId('basics-locality'), { key: 'Escape' });
    expect(screen.queryByTestId('basics-editor')).toBeNull();
    fireEvent.click(screen.getByTestId('firm-edit'));
    expect((screen.getByTestId('basics-locality') as HTMLInputElement).value).toBe('Waco');
  });

  it('closes Notes and outcome on a second click, on Escape from inside it, and keeps the note', () => {
    mount();
    fireEvent.click(screen.getByTestId('firm-outcome'));
    const note = within(screen.getByTestId('outcome-panel')).getAllByRole('textbox')[0] as HTMLTextAreaElement;
    fireEvent.change(note, { target: { value: 'Ask for Glen' } });
    fireEvent.click(screen.getByTestId('firm-outcome'));
    expect(screen.queryByTestId('outcome-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('firm-outcome'));
    expect((within(screen.getByTestId('outcome-panel')).getAllByRole('textbox')[0] as HTMLTextAreaElement).value).toBe('Ask for Glen');
    fireEvent.keyDown(within(screen.getByTestId('outcome-panel')).getAllByRole('textbox')[0] as HTMLTextAreaElement, { key: 'Escape' });
    expect(screen.queryByTestId('outcome-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('firm-outcome'));
    expect((within(screen.getByTestId('outcome-panel')).getAllByRole('textbox')[0] as HTMLTextAreaElement).value).toBe('Ask for Glen');
  });
});

describe('the numbers (item 5)', () => {
  it('names a period on every figure, and shows the unconfirmed replies beside the confirmed ones', () => {
    mount();
    fireEvent.click(screen.getByTestId('today-tab-overview'));
    const periods = screen.getAllByTestId('figure-period').map(node => node.textContent);
    expect(periods).toEqual(['today', 'since 18 Sep', 'since 18 Sep', 'since 18 Sep', 'since 18 Sep', 'now', 'since 18 Sep']);
    const replies = screen.getByTestId('figure-replies');
    expect(within(replies).getByTestId('figure-value').textContent).toBe('3');
    expect(within(replies).getByTestId('figure-unconfirmed').textContent).toBe('(+1 unconfirmed)');
    expect(replies.getAttribute('aria-label')).toBe('Replies, since 18 Sep: 3 (+1 unconfirmed)');
  });

  it('leads an actionable count to its queue, and leaves a plain total as plain text', () => {
    mount();
    fireEvent.click(screen.getByTestId('today-tab-overview'));
    expect(within(screen.getByTestId('figure-calls')).queryByTestId('figure-link')).toBeNull();
    expect(within(screen.getByTestId('figure-waiting')).getByTestId('figure-link')).toBeTruthy();
    expect(within(screen.getByTestId('figure-replies')).getByTestId('figure-link')).toBeTruthy();
  });
});

describe('what survives leaving Today (item 7)', () => {
  it('finds the edit form open, with its draft, and the outcome note, after a round trip', () => {
    mount();
    fireEvent.click(screen.getByTestId('firm-edit'));
    fireEvent.change(screen.getByTestId('basics-phone'), { target: { value: '2145550177' } });
    fireEvent.click(screen.getByTestId('firm-outcome'));
    fireEvent.change(within(screen.getByTestId('outcome-panel')).getAllByRole('textbox')[0] as HTMLTextAreaElement, { target: { value: 'Call back after lunch' } });

    fireEvent.click(screen.getByTestId('go-away'));
    expect(screen.queryByTestId('basics-editor')).toBeNull();
    fireEvent.click(screen.getByTestId('come-back'));

    expect((screen.getByTestId('basics-phone') as HTMLInputElement).value).toBe('2145550177');
    expect((within(screen.getByTestId('outcome-panel')).getAllByRole('textbox')[0] as HTMLTextAreaElement).value).toBe('Call back after lunch');
  });

  it('keeps the queue’s scroll', () => {
    mount();
    const list = screen.getByTestId('queue-list');
    list.scrollTop = 120;
    fireEvent.scroll(list);
    fireEvent.click(screen.getByTestId('go-away'));
    fireEvent.click(screen.getByTestId('come-back'));
    expect(screen.getByTestId('queue-list').scrollTop).toBe(120);
  });

  it('closes the forms when the person moves to another firm, and a draft stays with its firm', () => {
    const { rerender } = mount();
    fireEvent.click(screen.getByTestId('firm-edit'));
    fireEvent.change(screen.getByTestId('basics-locality'), { target: { value: 'Waco' } });
    const other = stateOf({
      expanded: { ...(stateOf().expanded as NonNullable<TodayState['expanded']>), firmId: OTHER_ID, firmName: 'Birch Test Partners' },
    });
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <DraftsProvider>
          <Window state={other} />
        </DraftsProvider>
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId('basics-editor')).toBeNull();
  });
});

describe('local feedback (item 6)', () => {
  it('draws a task answer in the task list, not in a page banner', () => {
    const task = {
      itemId: '55555555-5555-4555-8555-555555555555',
      kind: 'call_due',
      status: 'open',
      dueAt: '2026-10-01T14:00:00.000Z',
      contactId: null,
      contactName: null,
      automated: false,
      snoozeUntil: null,
    };
    const base = stateOf();
    const state = stateOf({
      notice: 'snooze_reason_required',
      expanded: { ...(base.expanded as NonNullable<TodayState['expanded']>), tasks: [task] as never },
    });
    mount({ state });
    expect(within(screen.getByTestId('today-tasks').parentElement as HTMLElement).getByTestId('feedback-tasks').textContent).toBe(
      'A snooze needs a reason.',
    );
    expect(screen.queryByTestId('banners')).toBeNull();
  });

  it('keeps offline and stale as the page’s own lines, and does not say offline twice', () => {
    const view = buildTodayView(stateOf({ online: false, notice: 'offline' }));
    expect(view.banners.map(banner => banner.tone)).toContain('warning');
    expect(view.feedback).toBeNull();
  });
});
