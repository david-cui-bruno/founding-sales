// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  TodayItem,
  TodayLaneId,
  TodaySnapshot,
} from '../../../shared/contracts/todayContract';
import { TodayPage } from './TodayPage';

afterEach(() => {
  cleanup();
});

const LANE_IDS: readonly TodayLaneId[] = [
  'onboarding', 'fresh_inbound', 'due_cadence', 'new_p0', 'p1', 'exploration', 'later',
];

const queueItem = (
  lane: TodayLaneId,
  seq: number,
  overrides: Partial<TodayItem> = {},
): TodayItem => ({
  id: `cycle-${lane}-${seq}`,
  lane,
  personId: `person-${lane}-${seq}`,
  salesCycleId: `cycle-${lane}-${seq}`,
  personName: `Person ${lane} ${seq}`,
  contextLabel: null,
  stage: 'ready',
  priorityContext: {
    priority: 'P1',
    fitPoints: 20,
    fitBand: 'high',
    timingValue: 25,
    timingBand: 'warm',
    reachability: 'direct',
    dataConfidence: 7,
  },
  action: {
    id: `action-${lane}-${seq}`,
    type: 'call_lead',
    channel: 'call',
    label: 'Call lead',
  },
  reason: 'cadence_step_next',
  activeTriggers: [],
  verifyFirst: false,
  pinned: false,
  consentRequirement: null,
  cloudScores: null,
  ...overrides,
});

const emptySnapshot = (overrides: Partial<TodaySnapshot> = {}): TodaySnapshot => ({
  lanes: LANE_IDS.map((lane) => ({ id: lane, items: [] as TodayItem[], overflowCount: 0 })),
  dialBudget: 40,
  scheduledDials: 0,
  conversationTarget: 5,
  reviewErrorCount: 0,
  unreviewedBacklogCount: 0,
  unreviewedCloudSignalCount: 0,
  conversationsHeld: 0,
  revision: 1,
  ...overrides,
});

/** Due cadence holds two rows and P1 two rows; every other lane is empty. */
const denseSnapshot: TodaySnapshot = emptySnapshot({
  lanes: LANE_IDS.map((lane) => ({
    id: lane,
    items:
      lane === 'due_cadence'
        ? [queueItem(lane, 1), queueItem(lane, 2)]
        : lane === 'p1'
          ? [queueItem(lane, 1), queueItem(lane, 2)]
          : [],
    overflowCount: 0,
  })),
  scheduledDials: 12,
});

const renderPage = (
  snapshot: TodaySnapshot,
  overrides: Partial<Parameters<typeof TodayPage>[0]> = {},
) =>
  render(
    <TodayPage
      snapshot={snapshot}
      onOpenLead={vi.fn()}
      onCall={vi.fn()}
      onSnoozeUntil={vi.fn()}
      onSkipToday={vi.fn()}
      onLogPastActivity={vi.fn()}
      onOpenInLeads={vi.fn()}
      onStartTriage={vi.fn()}
      {...overrides}
    />,
  );

const rowByCycleId = (cycleId: string): HTMLElement => {
  const row = document.querySelector(`[data-cycle-id="${cycleId}"]`);
  expect(row).not.toBeNull();
  return row as HTMLElement;
};

describe('TodayPage', () => {
  it('renders only non-empty lanes plus one line naming the empty ones', () => {
    renderPage(denseSnapshot);

    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((node) => node.textContent).filter(text => !text?.startsWith('Also today'));
    // Non-empty lanes render as sections (count included in the header).
    expect(headings).toEqual(['Due cadence2', 'P12']);
    // Empty lanes collapse into one muted line.
    expect(
      screen.getByText(
        'Nothing in: Onboard now · Fresh inbound · New P0 · Exploration · Later',
      ),
    ).toBeTruthy();
  });

  it('keeps the fixed lane order even when the snapshot shuffles lanes', () => {
    const shuffled: TodaySnapshot = {
      ...denseSnapshot,
      lanes: [...denseSnapshot.lanes].reverse(),
    };
    renderPage(shuffled);
    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((node) => node.textContent).filter(text => !text?.startsWith('Also today'));
    expect(headings).toEqual(['Due cadence2', 'P12']);
  });

  it('promotes the first item of the first non-empty lane into Next up', () => {
    renderPage(denseSnapshot);

    const hero = screen.getByRole('group', { name: 'Next up: Person due_cadence 1' });
    expect(within(hero).getByRole('button', { name: 'Person due_cadence 1' })).toBeTruthy();
    expect(within(hero).getByRole('button', { name: 'Call' })).toBeTruthy();
    // The hero row does not render again inside its lane.
    const dueLane = screen.getByRole('region', { name: /Due cadence/ });
    expect(within(dueLane).queryByText('Person due_cadence 1')).toBeNull();
    expect(within(dueLane).getByText('Person due_cadence 2')).toBeTruthy();
    // The lane count still reports the full snapshot size.
    expect(within(dueLane).getByText('2')).toBeTruthy();
  });

  it('renders two-line rows: Title Case name, one cloud chip max, humanized reason', () => {
    const shouting = emptySnapshot({
      lanes: LANE_IDS.map((lane) => ({
        id: lane,
        items: lane === 'due_cadence'
          ? [
            queueItem('due_cadence', 1, { personName: 'Avery Landlord' }),
            queueItem('due_cadence', 2, {
              personName: 'FOX WILLIAM P ETAL',
              reason: 'callback_promised_today',
              cloudScores: { fit: 62, timing: 41 },
            }),
          ]
          : [],
        overflowCount: 0,
      })),
    });
    renderPage(shouting);

    // Title Case, never shouting.
    expect(screen.getByText('Fox William P Etal')).toBeTruthy();
    // The raw machine enum never renders.
    expect(screen.queryByText(/callback_promised_today/)).toBeNull();
    // The reason line reads humanized; the row carries one cloud chip.
    const row = rowByCycleId('cycle-due_cadence-2');
    expect(within(row).getByText('Callback you promised for today · Call lead')).toBeTruthy();
    expect(within(row).getByText('Fit 62 · Timing 41')).toBeTruthy();
  });

  it('collapses and expands a lane with the chevron header and arrow keys', () => {
    renderPage(denseSnapshot);

    const header = screen.getByRole('button', { name: /P1\s*2/ });
    expect(header.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Person p1 1')).toBeNull();

    fireEvent.keyDown(header, { key: 'ArrowRight' });
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Person p1 1')).toBeTruthy();

    fireEvent.keyDown(header, { key: 'ArrowLeft' });
    expect(header.getAttribute('aria-expanded')).toBe('false');
  });

  it('reveals Call and the context menu on focus-within only', () => {
    renderPage(denseSnapshot);

    const row = rowByCycleId('cycle-p1-1');
    expect(row.getAttribute('data-focus-within')).toBeNull();
    fireEvent.focus(row);
    expect(row.getAttribute('data-focus-within')).toBe('true');
    expect(within(row).getByRole('button', { name: 'Call Person p1 1' })).toBeTruthy();
    expect(
      within(row).getByRole('button', { name: 'More actions for Person p1 1' }),
    ).toBeTruthy();
    fireEvent.blur(row);
    expect(row.getAttribute('data-focus-within')).toBeNull();
  });

  it('opens the context menu with Call, Snooze until, Skip, Log, Open in Leads', () => {
    const onSkipToday = vi.fn();
    renderPage(denseSnapshot, { onSkipToday });

    const row = rowByCycleId('cycle-p1-1');
    fireEvent.click(
      within(row).getByRole('button', { name: 'More actions for Person p1 1' }),
    );
    const menu = screen.getByRole('menu', { name: 'Actions for Person p1 1' });
    const labels = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
    expect(labels).toEqual([
      'Call', 'Snooze until…', 'Skip today', 'Log past activity', 'Open in Leads',
    ]);

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Skip today' }));
    expect(onSkipToday).toHaveBeenCalledWith(
      expect.objectContaining({ salesCycleId: 'cycle-p1-1' }),
    );
  });

  it('writes a founder-chosen resurface date through Snooze until', () => {
    const onSnoozeUntil = vi.fn();
    renderPage(denseSnapshot, { onSnoozeUntil });

    const row = rowByCycleId('cycle-p1-1');
    fireEvent.click(
      within(row).getByRole('button', { name: 'More actions for Person p1 1' }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Snooze until…' }));
    const dialog = screen.getByRole('dialog', { name: /Snooze Person p1 1 until/ });
    const date = within(dialog).getByLabelText(/Snooze until/);
    fireEvent.change(date, { target: { value: '2030-05-06' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Snooze' }));

    expect(onSnoozeUntil).toHaveBeenCalledTimes(1);
    const [item, resurfaceAt] = onSnoozeUntil.mock.calls[0]!;
    expect(item.salesCycleId).toBe('cycle-p1-1');
    expect(new Date(resurfaceAt).getFullYear()).toBe(2030);
  });

  it('moves focus with J/K and the arrow keys across Next up and rows', () => {
    renderPage(denseSnapshot);

    const hero = rowByCycleId('cycle-due_cadence-1');
    const second = rowByCycleId('cycle-due_cadence-2');
    const third = rowByCycleId('cycle-p1-1');

    hero.focus();
    fireEvent.keyDown(hero, { key: 'j' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third, { key: 'k' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(hero);
    // K at the top stays put.
    fireEvent.keyDown(hero, { key: 'k' });
    expect(document.activeElement).toBe(hero);
  });

  it('runs Enter=call, S=snooze tomorrow, X=skip on the focused row', () => {
    const onCall = vi.fn();
    const onSnoozeUntil = vi.fn();
    const onSkipToday = vi.fn();
    renderPage(denseSnapshot, { onCall, onSnoozeUntil, onSkipToday });

    const row = rowByCycleId('cycle-p1-2');
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onCall).toHaveBeenCalledWith(
      expect.objectContaining({ salesCycleId: 'cycle-p1-2' }),
    );
    fireEvent.keyDown(row, { key: 's' });
    expect(onSnoozeUntil).toHaveBeenCalledWith(
      expect.objectContaining({ salesCycleId: 'cycle-p1-2' }),
      expect.any(String),
    );
    fireEvent.keyDown(row, { key: 'x' });
    expect(onSkipToday).toHaveBeenCalledWith(
      expect.objectContaining({ salesCycleId: 'cycle-p1-2' }),
    );
  });

  it('starts triage with R when a backlog exists', () => {
    const onStartTriage = vi.fn();
    renderPage(
      emptySnapshot({
        unreviewedBacklogCount: 3,
        lanes: denseSnapshot.lanes,
      }),
      { onStartTriage },
    );

    const row = rowByCycleId('cycle-p1-1');
    row.focus();
    fireEvent.keyDown(row, { key: 'r' });
    expect(onStartTriage).toHaveBeenCalledTimes(1);
  });

  it('renders the backlog card with counts and a Review button', () => {
    const onStartTriage = vi.fn();
    renderPage(
      emptySnapshot({
        unreviewedBacklogCount: 354,
        unreviewedCloudSignalCount: 12,
      }),
      { onStartTriage },
    );

    expect(screen.getByText('354 unreviewed leads')).toBeTruthy();
    expect(screen.getByText('· 12 have cloud signal')).toBeTruthy();
    expect(document.querySelectorAll('.today-row')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(onStartTriage).toHaveBeenCalledTimes(1);
  });

  it('shows the queue-done state when every lane is empty', () => {
    renderPage(
      emptySnapshot({ scheduledDials: 40, conversationsHeld: 6 }),
    );

    expect(screen.getByText('Queue done · 40 dials · 6 conversations')).toBeTruthy();
    expect(
      screen.getByText('A fresh queue builds itself tomorrow morning.'),
    ).toBeTruthy();
    expect(screen.queryByRole('group', { name: /Next up/ })).toBeNull();
  });

  it('hides the backlog card at zero (zero-badge honesty)', () => {
    renderPage(emptySnapshot());

    expect(screen.queryByText(/unreviewed lead/)).toBeNull();
  });

  it('disables commands while a command is pending', () => {
    renderPage(denseSnapshot, { busy: true });

    for (const button of screen.getAllByRole('button', { name: 'Call' })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    const row = rowByCycleId('cycle-p1-1');
    fireEvent.focus(row);
    expect(
      (within(row).getByRole('button', { name: 'Call Person p1 1' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('opens the lead from the person name in Next up and rows', () => {
    const onOpenLead = vi.fn();
    renderPage(denseSnapshot, { onOpenLead });

    fireEvent.click(screen.getByRole('button', { name: 'Person due_cadence 1' }));
    expect(onOpenLead).toHaveBeenCalledWith('person-due_cadence-1');
    fireEvent.click(screen.getByRole('button', { name: 'Person p1 2' }));
    expect(onOpenLead).toHaveBeenCalledWith('person-p1-2');
  });

  it('submits a past activity through the Log past activity dialog', () => {
    const onLogPastActivity = vi.fn();
    renderPage(denseSnapshot, { onLogPastActivity });

    const row = rowByCycleId('cycle-p1-1');
    fireEvent.click(
      within(row).getByRole('button', { name: 'More actions for Person p1 1' }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Log past activity' }));
    const dialog = screen.getByRole('dialog', { name: /Log past activity/ });
    fireEvent.change(within(dialog).getByLabelText('What happened'), {
      target: { value: 'Met at the RIREIG meetup.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Log activity' }));

    expect(onLogPastActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        personId: 'person-p1-1',
        salesCycleId: 'cycle-p1-1',
        kind: 'call',
        direction: 'outbound',
        summary: 'Met at the RIREIG meetup.',
      }),
    );
  });
});

it('opens the primary brief read-only while keeping explicit Call and hero actions', () => {
  const onOpenLead = vi.fn(); const onCall = vi.fn();
  renderPage(denseSnapshot, { onOpenLead, onCall });
  const hero = screen.getByRole('group', { name: 'Next up: Person due_cadence 1' });
  fireEvent.click(within(hero).getByRole('button', { name: 'Open brief' }));
  expect(onOpenLead).toHaveBeenCalledWith('person-due_cadence-1');
  expect(onCall).not.toHaveBeenCalled();
  fireEvent.click(within(hero).getByRole('button', { name: 'More actions for Person due_cadence 1' }));
  expect(screen.getByRole('menuitem', { name: 'Log past activity' })).toBeTruthy();
});
it('bounds Also today and reveals all queued records in order with keyboard continuity', () => {
  renderPage(emptySnapshot({ lanes: [{ id: 'p1', items: Array.from({ length: 9 }, (_, i) => queueItem('p1', i + 1)), overflowCount: 12 }] }));
  const also = screen.getByRole('region', { name: 'Also today' });
  expect(within(also).getByRole('heading', { name: 'Also today 8' })).toBeTruthy();
  expect(within(also).getAllByRole('listitem')).toHaveLength(3);
  expect(screen.queryByText('Person p1 5')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show 5 more queued people' }));
  expect(within(also).getAllByRole('listitem').map(row => row.getAttribute('data-cycle-id'))).toEqual([
    'cycle-p1-2', 'cycle-p1-3', 'cycle-p1-4', 'cycle-p1-5', 'cycle-p1-6', 'cycle-p1-7', 'cycle-p1-8', 'cycle-p1-9',
  ]);
  const fourth = rowByCycleId('cycle-p1-4'); fourth.focus();
  fireEvent.keyDown(fourth, { key: 'j' });
  expect(document.activeElement).toBe(rowByCycleId('cycle-p1-5'));
  expect(screen.getByText('12 more beyond today’s capacity')).toBeTruthy();
});
it('does not hide overflow-only lanes as an empty queue', () => {
  renderPage(emptySnapshot({ lanes: [{ id: 'later', items: [], overflowCount: 27 }] }));
  expect(screen.getByText('27 more beyond today’s capacity')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Queue done' })).toBeNull();
});

it('keeps undisplayed lanes out of Also today until their records are requested', () => {
  renderPage(emptySnapshot({ lanes: [
    { id: 'due_cadence', items: [1, 2, 3, 4].map(i => queueItem('due_cadence', i)), overflowCount: 0 },
    { id: 'p1', items: [queueItem('p1', 1)], overflowCount: 0 },
  ] }));
  expect(screen.queryByRole('region', { name: /P1/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show 1 more queued people' }));
  expect(screen.getByRole('region', { name: /P1/ })).toBeTruthy();
  expect(screen.getByText('Person p1 1')).toBeTruthy();
});

it.each(['menu', 'snooze'] as const)('invalidates the hero %s session when a new sales cycle replaces it', mode => {
  const commands = { onOpenLead: vi.fn(), onCall: vi.fn(), onSnoozeUntil: vi.fn(), onSkipToday: vi.fn(),
    onLogPastActivity: vi.fn(), onOpenInLeads: vi.fn(), onStartTriage: vi.fn() };
  const a = queueItem('p1', 1, { personName: 'Same Person', personId: 'same-person' });
  const b = queueItem('p1', 2, { personName: 'Same Person', personId: 'same-person' });
  const tree = (item: TodayItem) => <TodayPage {...commands} snapshot={emptySnapshot({ lanes: [{ id: 'p1', items: [item], overflowCount: 0 }] })} />;
  const view = render(tree(a));
  fireEvent.click(screen.getByRole('button', { name: 'More actions for Same Person' }));
  if (mode === 'snooze') {
    fireEvent.click(screen.getByRole('menuitem', { name: 'Snooze until…' }));
    fireEvent.change(screen.getByLabelText('Snooze until'), { target: { value: '2030-05-06' } });
  }
  const staleCommand = mode === 'snooze' ? screen.getByRole('button', { name: 'Snooze' }) : screen.getByRole('menuitem', { name: 'Skip today' });
  view.rerender(tree(b));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('menu')).toBeNull();
  expect(staleCommand.isConnected).toBe(false);
  fireEvent.click(staleCommand);
  expect(commands.onSnoozeUntil).not.toHaveBeenCalled(); expect(commands.onSkipToday).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'More actions for Same Person' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Snooze until…' }));
  expect((screen.getByLabelText('Snooze until') as HTMLInputElement).value).not.toBe('2030-05-06');
  fireEvent.click(screen.getByRole('button', { name: 'Snooze' }));
  expect(commands.onSnoozeUntil).toHaveBeenCalledWith(b, expect.any(String));
});
