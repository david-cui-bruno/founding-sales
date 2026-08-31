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
  'onboarding', 'fresh_inbound', 'overdue', 'post_interview_offer',
  'due_cadence', 'new_p0', 'p1', 'exploration', 'later',
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
    dueAt: '2026-08-31T15:00:00.000Z',
    label: 'Call lead',
    overdue: false,
  },
  reason: `Reason ${lane} ${seq}`,
  activeTriggers: [],
  verifyFirst: false,
  pinned: false,
  consentRequirement: null,
  ...overrides,
});

const snapshotWithAllLanes: TodaySnapshot = {
  lanes: LANE_IDS.map((lane) => ({
    id: lane,
    items: lane === 'p1'
      ? [queueItem(lane, 1), queueItem(lane, 2)]
      : [queueItem(lane, 1)],
  })),
  dialBudget: 40,
  scheduledDials: 12,
  conversationTarget: 5,
  reviewErrorCount: 2,
  revision: 7,
};

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
      {...overrides}
    />,
  );

describe('TodayPage', () => {
  it('renders the promise-first lanes in fixed order', () => {
    render(
      <TodayPage
        snapshot={snapshotWithAllLanes}
        onOpenLead={vi.fn()}
        onComplete={vi.fn()}
        onSnooze={vi.fn()}
        onPin={vi.fn()}
      />,
    );
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent),
    ).toEqual([
      'Onboard now', 'Fresh inbound', 'Overdue', 'Post-interview & offers',
      'Due cadence', 'New P0', 'P1', 'Exploration', 'Later',
    ]);
  });

  it('keeps the fixed lane order even when the snapshot shuffles lanes', () => {
    const shuffled: TodaySnapshot = {
      ...snapshotWithAllLanes,
      lanes: [...snapshotWithAllLanes.lanes].reverse(),
    };
    renderPage(shuffled);
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent),
    ).toEqual([
      'Onboard now', 'Fresh inbound', 'Overdue', 'Post-interview & offers',
      'Due cadence', 'New P0', 'P1', 'Exploration', 'Later',
    ]);
  });

  it('renders every row exactly once, inside its own lane, in snapshot order', () => {
    renderPage(snapshotWithAllLanes);

    const p1Lane = screen.getByRole('region', { name: 'P1' });
    const names = within(p1Lane)
      .getAllByRole('button', { name: /^Person p1/ })
      .map((node) => node.textContent);
    expect(names).toEqual(['Person p1 1', 'Person p1 2']);
    expect(screen.getAllByText('Person p1 1')).toHaveLength(1);
    expect(screen.getAllByText('Person overdue 1')).toHaveLength(1);
    expect(
      within(screen.getByRole('region', { name: 'Overdue' }))
        .queryByText('Person p1 1'),
    ).toBeNull();
  });

  it('shows the capacity labels from the snapshot', () => {
    renderPage(snapshotWithAllLanes);

    expect(screen.getByText('12 of 40 dials scheduled')).toBeTruthy();
    expect(screen.getByText('Conversation target 5')).toBeTruthy();
    expect(screen.getByText('2 review errors')).toBeTruthy();
  });

  it('pins only against a lane-local neighbor and never across lanes', () => {
    const onPin = vi.fn();
    renderPage(snapshotWithAllLanes, { onPin });

    const p1Lane = screen.getByRole('region', { name: 'P1' });
    const pins = within(p1Lane).getAllByRole('button', { name: 'Pin' });
    expect((pins[0] as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(pins[1]!);
    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onPin).toHaveBeenCalledWith(
      expect.objectContaining({ salesCycleId: 'cycle-p1-2', lane: 'p1' }),
      'cycle-p1-1',
    );
  });

  it('snoozes against the next lane-local row and disables the last row', () => {
    const onSnooze = vi.fn();
    renderPage(snapshotWithAllLanes, { onSnooze });

    const p1Lane = screen.getByRole('region', { name: 'P1' });
    const snoozes = within(p1Lane).getAllByRole('button', { name: 'Snooze' });
    expect((snoozes[1] as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(snoozes[0]!);
    expect(onSnooze).toHaveBeenCalledWith(
      expect.objectContaining({ salesCycleId: 'cycle-p1-1' }),
      'cycle-p1-2',
    );
  });

  it('completes the row primary action', () => {
    const onComplete = vi.fn();
    renderPage(snapshotWithAllLanes, { onComplete });

    const overdueLane = screen.getByRole('region', { name: 'Overdue' });
    fireEvent.click(within(overdueLane).getByRole('button', { name: 'Done' }));
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ salesCycleId: 'cycle-overdue-1' }),
    );
  });

  it('explains reason, triggers, Verify First, consent, pinned, and overdue state', () => {
    const explained: TodaySnapshot = {
      ...snapshotWithAllLanes,
      lanes: snapshotWithAllLanes.lanes.map((lane) =>
        lane.id === 'due_cadence'
          ? {
            id: lane.id,
            items: [
              queueItem('due_cadence', 1, {
                reason: 'Inbound SLA breached',
                activeTriggers: [
                  { label: 'inbound_reply', expiresAt: '2026-09-01T15:00:00.000Z' },
                ],
                verifyFirst: true,
                pinned: true,
                consentRequirement: 'Verbal consent required before recording',
                action: {
                  id: 'action-due_cadence-1',
                  type: 'call_lead',
                  channel: 'call',
                  dueAt: '2026-08-30T15:00:00.000Z',
                  label: 'Call lead',
                  overdue: true,
                },
              }),
            ],
          }
          : lane,
      ),
    };
    renderPage(explained);

    const cadenceLane = screen.getByRole('region', { name: 'Due cadence' });
    expect(within(cadenceLane).getByText('Inbound SLA breached')).toBeTruthy();
    expect(within(cadenceLane).getByText(/inbound_reply/)).toBeTruthy();
    expect(within(cadenceLane).getByText('Verify first')).toBeTruthy();
    expect(
      within(cadenceLane).getByText('Verbal consent required before recording'),
    ).toBeTruthy();
    expect(within(cadenceLane).getByText('Pinned')).toBeTruthy();
    expect(within(cadenceLane).getByText('Overdue')).toBeTruthy();
  });

  it('disables every command while a command is pending', () => {
    renderPage(snapshotWithAllLanes, { busy: true });

    for (const name of ['Done', 'Snooze', 'Pin']) {
      for (const button of screen.getAllByRole('button', { name })) {
        expect((button as HTMLButtonElement).disabled).toBe(true);
      }
    }
  });

  it('opens the lead from the person name', () => {
    const onOpenLead = vi.fn();
    renderPage(snapshotWithAllLanes, { onOpenLead });

    fireEvent.click(screen.getByRole('button', { name: 'Person overdue 1' }));
    expect(onOpenLead).toHaveBeenCalledWith('person-overdue-1');
  });
});
