import { PresentationRoot } from '../../src/renderer/app/PresentationRoot';
// @vitest-environment jsdom

import { cleanup, render as testingRender } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LeadRow } from '../../src/shared/contracts/leadsContract';
import type { PipelineSnapshot } from '../../src/shared/contracts/pipelineContract';
import type { ReviewSnapshot } from '../../src/shared/contracts/reviewContract';
import type { TodaySnapshot } from '../../src/shared/contracts/todayContract';
import { LeadsGrid } from '../../src/renderer/features/leads/LeadsGrid';
import { PipelinePage } from '../../src/renderer/features/pipeline/PipelinePage';
import { ReviewPage } from '../../src/renderer/features/review/ReviewPage';
import { TodayPage } from '../../src/renderer/features/today/TodayPage';

afterEach(() => {
  cleanup();
});

/**
 * Machine enums never render raw (audit 2.9/4.9.10): every snake_case token
 * that reaches the founder's eyes must pass through a display-label mapper.
 * Text nodes that look like `lower_snake_case` are treated as leaks.
 */
const SNAKE_CASE = /^[a-z]+(_[a-z]+)+$/;

function snakeCaseLeaks(container: HTMLElement): string[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const leaks: string[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    for (const word of text.split(/\s+/)) {
      if (SNAKE_CASE.test(word)) leaks.push(word);
    }
  }
  return leaks;
}

const todaySnapshot: TodaySnapshot = {
  lanes: [
    { id: 'onboarding', items: [], overflowCount: 0 },
    { id: 'fresh_inbound', items: [], overflowCount: 0 },
    {
      id: 'due_cadence',
      items: [
        {
          id: 'cycle-1',
          lane: 'due_cadence',
          personId: 'person-1',
          salesCycleId: 'cycle-1',
          personName: 'Avery Landlord',
          contextLabel: null,
          stage: 'lost_nurture',
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
            id: 'action-1',
            type: 'call_lead',
            channel: 'call',
            label: 'Call lead',
          },
          reason: 'callback_promised_today',
          activeTriggers: [],
          verifyFirst: false,
          pinned: false,
          consentRequirement: null,
          cloudScores: null,
        },
      ],
      overflowCount: 3,
    },
    { id: 'new_p0', items: [], overflowCount: 0 },
    { id: 'p1', items: [], overflowCount: 0 },
    { id: 'exploration', items: [], overflowCount: 0 },
    { id: 'later', items: [], overflowCount: 0 },
  ],
  dialBudget: 40,
  scheduledDials: 3,
  conversationTarget: 5,
  reviewErrorCount: 0,
  unreviewedBacklogCount: 4,
  unreviewedCloudSignalCount: 0,
  conversationsHeld: 0,
  revision: 1,
};

const leadRows: LeadRow[] = [
  {
    personId: 'person-1',
    salesCycleId: 'cycle-1',
    personName: 'Avery Landlord',
    initials: 'AL',
    organization: null,
    propertySummary: null,
    stage: 'lost_nurture',
    source: 'inbound_demo',
    segment: 'warm',
    priorityContext: {
      priority: 'P2',
      fitPoints: 10,
      fitBand: 'medium',
      timingValue: 12,
      timingBand: 'warm',
      reachability: 'indirect',
      dataConfidence: 5,
    },
    cloudScores: null,
    nextAction: {
      id: 'action-1',
      type: 'book_promised_follow_up',
      channel: 'call',
      label: 'Book promised follow up',
    },
    optedOut: false,
    lastActivityAt: '2026-08-30T15:00:00.000Z',
  },
];

const pipelineSnapshot: PipelineSnapshot = {
  stages: [
    {
      stage: 'lost_nurture',
      cards: [
        {
          personId: 'person-1',
          salesCycleId: 'cycle-1',
          personName: 'Avery Landlord',
          contextLabel: null,
          stage: 'lost_nurture',
          stageEnteredAt: '2026-08-30T15:00:00.000Z',
          priorityContext: null,
          nextAction: null,
          lostReasonCode: 'bad_timing',
        },
      ],
    },
  ],
  revision: 1,
};

const reviewSnapshot: ReviewSnapshot = {
  items: [
    {
      kind: 'unmatched_communication',
      reviewId: 'review-1',
      channel: 'text',
      handle: '+14015551234',
      occurredAt: '2026-08-30T15:00:00.000Z',
      summary: 'Unknown caller left a voicemail.',
    },
  ],
  totalOpenCount: 1,
  nextCursor: null, matchedCount: 1,
  countScope: 'lifecycle_review_items', observedAt: '2026-09-10T00:00:00.000Z',
  queues: {
    unmatched_communication: { source: 'lifecycle_review_items', openCount: 1 },
    system_error: { source: 'lifecycle_review_items', openCount: 0 },
    ambiguous_identity: { source: 'not_integrated', openCount: null },
    transcript_suggestion: { source: 'not_integrated', openCount: null },
    import_problem: { source: 'not_integrated', openCount: null },
    adapter_failure: { source: 'not_integrated', openCount: null },
  },
  revision: 1,
};

describe('no raw machine enums in rendered output', () => {
  it('Today renders zero snake_case tokens', () => {
    const { container } = render(
      <TodayPage
        snapshot={todaySnapshot}
        onOpenLead={vi.fn()}
        onCall={vi.fn()}
        onSnoozeUntil={vi.fn()}
        onSkipToday={vi.fn()}
        onLogPastActivity={vi.fn(async () => {})}
        onOpenInLeads={vi.fn()}
      />,
    );
    expect(snakeCaseLeaks(container)).toEqual([]);
  });

  it('Leads renders zero snake_case tokens', () => {
    const { container } = render(
      <LeadsGrid
        rows={leadRows}
        selectedPersonId={null}
        onSelect={vi.fn()}
        editor={{ session: null, pending: false, start: vi.fn(), change: vi.fn(), cancel: vi.fn(), bindInput: vi.fn(), focusInput: vi.fn() }}
        onUpdateField={async () => ({ status: 'saved' })}
      />,
    );
    expect(snakeCaseLeaks(container)).toEqual([]);
  });

  it('Pipeline renders zero snake_case tokens', () => {
    const { container } = render(
      <PipelinePage snapshot={pipelineSnapshot} onOpenLead={vi.fn()} />,
    );
    expect(snakeCaseLeaks(container)).toEqual([]);
  });

  it('Inbox renders zero snake_case tokens', () => {
    const { container } = render(
      <ReviewPage
        snapshot={reviewSnapshot}
        selectedKind="unmatched_communication"
        onSelectKind={vi.fn()}
        onResolve={vi.fn()}
        onOpenLead={vi.fn()}
      />,
    );
    expect(snakeCaseLeaks(container)).toEqual([]);
  });
});

const render = (ui: Parameters<typeof testingRender>[0], options?: Parameters<typeof testingRender>[1]) => testingRender(ui, { wrapper: PresentationRoot, ...options });

Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
