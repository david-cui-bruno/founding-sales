// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PipelineSnapshot } from '../../shared/contracts/pipelineContract';
import type { TodaySnapshot } from '../../shared/contracts/todayContract';
import type { LeadDetail } from '../../shared/contracts/leadDetailContract';
import type { CalliePreloadApi } from '../../shared/preload';
import type { FoundationHealth } from '../foundation/useFoundationHealth';
import { FounderApp } from './FounderApp';

const detail: LeadDetail = {
  personId: 'person-kevin',
  salesCycleId: 'cycle-kevin',
  personName: 'Kevin Shin',
  phones: [],
  emails: [],
  organizationLabel: null,
  propertySummaries: [],
  stage: 'ready',
  workflowStatus: 'active',
  sourceLabel: 'frbo',
  segment: 'hot',
  cloudScores: null,
  cloudLinked: false,
  priorityContext: null,
  priorityReasons: ['Direct phone on file'],
  nextAction: null,
  optedOut: false,
  cadence: null,
  activities: [],
  conversations: [],
  properties: [],
  history: [],
  revision: 0,
};

const todaySnapshot: TodaySnapshot = {
  lanes: [
    {
      id: 'new_p0',
      items: [
        {
          id: 'item-1',
          lane: 'new_p0',
          personId: 'person-kevin',
          salesCycleId: 'cycle-kevin',
          personName: 'Kevin Shin',
          contextLabel: null,
          stage: 'ready',
          priorityContext: null,
          action: {
            id: 'action-1',
            type: 'call',
            channel: 'call',
            label: 'call',
          },
          reason: 'new p0',
          activeTriggers: [],
          verifyFirst: false,
          pinned: false,
          consentRequirement: null,
          cloudScores: null,
        },
      ],
      overflowCount: 0,
    },
  ],
  dialBudget: 20,
  scheduledDials: 1,
  conversationTarget: 5,
  reviewErrorCount: 0,
  unreviewedBacklogCount: 0,
  unreviewedCloudSignalCount: 0,
  conversationsHeld: 0,
  revision: 0,
};

const pipelineSnapshot: PipelineSnapshot = {
  stages: [
    {
      stage: 'ready',
      cards: [
        {
          personId: 'person-kevin',
          salesCycleId: 'cycle-kevin',
          personName: 'Kevin Shin',
          contextLabel: null,
          stage: 'ready',
          stageEnteredAt: '2026-08-30T12:00:00.000Z',
          priorityContext: null,
          nextAction: null,
          lostReasonCode: null,
        },
      ],
    },
  ],
  revision: 0,
};

const emptyReview = {
  items: [] as never[],
  totalOpenCount: 0,
  revision: 0,
};

function fakeCallieApi(): CalliePreloadApi {
  const pending = vi.fn(() => new Promise<never>(() => undefined));
  return {
    health: { get: vi.fn(async () => ({}) as never) },
    leads: {
      list: vi.fn(async () => ({
        rows: [], nextCursor: null, total: 0, revision: 0,
      })),
      updateField: pending,
      bulkUpdate: pending,
    },
    leadDetail: {
      get: vi.fn(async () => detail),
      beginOutbound: pending,
      confirmTransition: pending,
    },
    today: {
      get: vi.fn(async () => todaySnapshot),
      complete: pending,
      snooze: pending,
      pin: pending,
      logPastActivity: pending,
    },
    pipeline: { get: vi.fn(async () => pipelineSnapshot) },
    review: { list: vi.fn(async () => emptyReview), resolve: pending },
    friday: {
      getCurrent: pending,
      getDrilldown: pending,
      createJob: pending,
      fillJob: pending,
      cancelJob: pending,
    },
    imports: {
      preview: pending,
      remap: pending,
      commit: pending,
      status: pending,
    },
    conversations: {
      list: vi.fn(async () => ({
        rows: [], total: 0, nextCursor: null, revision: 0,
      })),
      get: pending,
      attachTranscript: pending,
    },
    learnings: {
      list: vi.fn(async () => ({
        rows: [], totalActiveCount: 0, revision: 0,
      })),
      capture: pending,
      addEvidence: pending,
      updateStatus: pending,
    },
    sourcing: { pollNow: pending, status: pending },
    appleSpike: {} as never,
  } as unknown as CalliePreloadApi;
}

const readyHealth: FoundationHealth = {
  status: 'ready',
  health: {} as never,
  retry: vi.fn(),
};

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('FounderApp', () => {
  it('defaults to the Today route inside the navigation shell', async () => {
    window.location.hash = '';
    render(<FounderApp api={fakeCallieApi()} health={readyHealth} />);

    expect(screen.getByRole('navigation', { name: 'Primary' })).not.toBeNull();
    expect(
      screen.getByRole('link', { name: 'Today' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(await screen.findByRole('button', { name: 'Kevin Shin' })).not.toBeNull();
  });

  it('opens the same global inspector from Today and Pipeline routes', async () => {
    window.location.hash = '';
    render(<FounderApp api={fakeCallieApi()} health={readyHealth} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Kevin Shin' }));
    expect(
      await screen.findByRole('complementary', { name: 'Kevin Shin details' }),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    expect(
      screen.queryByRole('complementary', { name: 'Kevin Shin details' }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('link', { name: 'Pipeline' }));
    fireEvent.click(await screen.findByRole('button', { name: /Kevin Shin/ }));
    expect(
      await screen.findByRole('complementary', { name: 'Kevin Shin details' }),
    ).not.toBeNull();
  });

  it('opens the global import dialog from the Leads route', async () => {
    window.location.hash = '#/leads';
    render(<FounderApp api={fakeCallieApi()} health={readyHealth} />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Import' }),
    );
    expect(await screen.findByRole('dialog')).not.toBeNull();
  });

  it('routes Conversations and Learnings to their live workspaces', async () => {
    window.location.hash = '';
    render(<FounderApp api={fakeCallieApi()} health={readyHealth} />);

    for (const name of ['Conversations', 'Learnings']) {
      expect(
        screen.getByRole('link', { name }).getAttribute('aria-disabled'),
      ).toBeNull();
    }

    fireEvent.click(screen.getByRole('link', { name: 'Conversations' }));
    expect(await screen.findByText('No conversations yet')).not.toBeNull();

    fireEvent.click(screen.getByRole('link', { name: 'Learnings' }));
    expect(
      (await screen.findAllByRole('button', { name: 'Capture learning' })).length,
    ).toBeGreaterThan(0);
  });
});
