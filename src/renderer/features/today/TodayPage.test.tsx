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
  ...overrides,
});

const emptySnapshot = (overrides: Partial<TodaySnapshot> = {}): TodaySnapshot => ({
  lanes: LANE_IDS.map((lane) => ({ id: lane, items: [] as TodayItem[], overflowCount: 0 })),
  dialBudget: 40,
  scheduledDials: 0,
  conversationTarget: 5,
  reviewErrorCount: 0,
  unreviewedBacklogCount: 0,
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
      onComplete={vi.fn()}
      onSnooze={vi.fn()}
      onPin={vi.fn()}
      onReviewBacklog={vi.fn()}
      {...overrides}
    />,
  );

const rowByCycleId = (cycleId: string): HTMLElement => {
  const row = document.querySelector(`[data-cycle-id="${cycleId}"]`);
  expect(row).not.toBeNull();
  return row as HTMLElement;
};

describe('TodayPage', () => {
  it('renders lanes in fixed order with empty lanes collapsed to one quiet line', () => {
    renderPage(denseSnapshot);

    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((node) => node.textContent);
    expect(headings).toEqual([
      'Onboard now — 0', 'Fresh inbound — 0', 'Due cadence',
      'New P0 — 0', 'P1', 'Exploration — 0', 'Later — 0',
    ]);
  });

  it('keeps the fixed lane order even when the snapshot shuffles lanes', () => {
    const shuffled: TodaySnapshot = {
      ...denseSnapshot,
      lanes: [...denseSnapshot.lanes].reverse(),
    };
    renderPage(shuffled);
    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((node) => node.textContent);
    expect(headings[2]).toBe('Due cadence');
    expect(headings[4]).toBe('P1');
  });

  it('promotes the first item of the first non-empty lane into the Next up hero', () => {
    renderPage(denseSnapshot);

    const hero = screen.getByRole('group', { name: 'Next up: Person due_cadence 1' });
    expect(within(hero).getByRole('button', { name: 'Person due_cadence 1' })).toBeTruthy();
    expect(within(hero).getByRole('button', { name: 'Done' })).toBeTruthy();
    // The hero row does not render again inside the Overdue lane.
    const dueLane = screen.getByRole('region', { name: 'Due cadence' });
    expect(within(dueLane).queryByText('Person due_cadence 1')).toBeNull();
    expect(within(dueLane).getByText('Person due_cadence 2')).toBeTruthy();
    // The lane count still reports the full snapshot size.
    expect(within(dueLane).getByText('2')).toBeTruthy();
  });

  it('renders two-line rows: Title Case name, stage chip, humanized reason', () => {
    const shouting = emptySnapshot({
      lanes: LANE_IDS.map((lane) => ({
        id: lane,
        items: lane === 'due_cadence'
          ? [
            queueItem('due_cadence', 1, { personName: 'Avery Landlord' }),
            queueItem('due_cadence', 2, {
              personName: 'FOX WILLIAM P ETAL',
              reason: 'callback_promised_today',
              action: {
                id: 'action-shout',
                type: 'call_lead',
                channel: 'call',
                label: 'Call lead',
              },
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
    expect(screen.queryByText(/_/)).toBeNull();
    // The reason line reads humanized.
    const row = rowByCycleId('cycle-due_cadence-2');
    expect(within(row).getByText('Callback you promised for today · Call lead')).toBeTruthy();
    // The stage chip is humanized.
    expect(within(row).getByText('Ready')).toBeTruthy();
  });

  it('reveals Done/Snooze/Pin on focus-within only', () => {
    renderPage(denseSnapshot);

    const row = rowByCycleId('cycle-p1-1');
    expect(row.getAttribute('data-focus-within')).toBeNull();
    fireEvent.focus(row);
    expect(row.getAttribute('data-focus-within')).toBe('true');
    expect(within(row).getByRole('button', { name: 'Complete · E' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Snooze · H' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Pin · P' })).toBeTruthy();
    fireEvent.blur(row);
    expect(row.getAttribute('data-focus-within')).toBeNull();
  });

  it('moves focus with J/K and the arrow keys across hero and rows', () => {
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

  it('opens the inspector with Enter on the focused row', () => {
    const onOpenLead = vi.fn();
    renderPage(denseSnapshot, { onOpenLead });

    const row = rowByCycleId('cycle-due_cadence-2');
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onOpenLead).toHaveBeenCalledWith('person-due_cadence-2');
  });

  it('runs E=complete, H=snooze, P=pin on the focused row', () => {
    const onComplete = vi.fn();
    const onSnooze = vi.fn();
    const onPin = vi.fn();
    renderPage(denseSnapshot, { onComplete, onSnooze, onPin });

    const secondP1 = rowByCycleId('cycle-p1-2');
    secondP1.focus();
    fireEvent.keyDown(secondP1, { key: 'e' });
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ salesCycleId: 'cycle-p1-2' }),
    );
    fireEvent.keyDown(secondP1, { key: 'p' });
    expect(onPin).toHaveBeenCalledWith(
      expect.objectContaining({ salesCycleId: 'cycle-p1-2' }),
      'cycle-p1-1',
    );
    // Snooze needs no lane-local comparison: it writes resurface_at.
    fireEvent.keyDown(secondP1, { key: 'h' });
    expect(onSnooze).toHaveBeenCalledWith(
      expect.objectContaining({ salesCycleId: 'cycle-p1-2' }),
    );
  });

  it('pins only against a lane-local neighbor and never across lanes', () => {
    const onPin = vi.fn();
    renderPage(denseSnapshot, { onPin });

    const p1Lane = screen.getByRole('region', { name: 'P1' });
    const pins = within(p1Lane).getAllByRole('button', { name: 'Pin · P' });
    expect((pins[0] as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(pins[1]!);
    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onPin).toHaveBeenCalledWith(
      expect.objectContaining({ salesCycleId: 'cycle-p1-2', lane: 'p1' }),
      'cycle-p1-1',
    );
  });

  it('renders the dial budget as a real progress bar', () => {
    renderPage(denseSnapshot);

    const bar = screen.getByRole('progressbar', { name: 'Dial budget' });
    expect(bar.getAttribute('aria-valuenow')).toBe('12');
    expect(bar.getAttribute('aria-valuemax')).toBe('40');
    expect(screen.getByText('12 of 40 dials today')).toBeTruthy();
  });

  it('summarizes the unreviewed backlog as one band with a Leads link and no rows', () => {
    const onReviewBacklog = vi.fn();
    renderPage(emptySnapshot({ unreviewedBacklogCount: 354 }), { onReviewBacklog });

    expect(screen.getByText('Unreviewed backlog · 354')).toBeTruthy();
    expect(document.querySelectorAll('.today-row')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Review in Leads' }));
    expect(onReviewBacklog).toHaveBeenCalledTimes(1);
  });

  it('hides the backlog band and the hero when the queue is empty', () => {
    renderPage(emptySnapshot());

    expect(screen.queryByText(/Unreviewed backlog/)).toBeNull();
    expect(screen.queryByRole('group', { name: /Next up/ })).toBeNull();
  });

  it('disables every command while a command is pending', () => {
    renderPage(denseSnapshot, { busy: true });

    for (const name of ['Done', 'Complete · E', 'Snooze · H', 'Pin · P']) {
      for (const button of screen.getAllByRole('button', { name })) {
        expect((button as HTMLButtonElement).disabled).toBe(true);
      }
    }
  });

  it('opens the lead from the person name in hero and rows', () => {
    const onOpenLead = vi.fn();
    renderPage(denseSnapshot, { onOpenLead });

    fireEvent.click(screen.getByRole('button', { name: 'Person due_cadence 1' }));
    expect(onOpenLead).toHaveBeenCalledWith('person-due_cadence-1');
    fireEvent.click(screen.getByRole('button', { name: 'Person p1 2' }));
    expect(onOpenLead).toHaveBeenCalledWith('person-p1-2');
  });
});
