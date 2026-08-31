// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  pipelineSnapshotSchema,
  type PipelineCard,
  type PipelineSnapshot,
} from '../../../shared/contracts/pipelineContract';
import { PipelineBoard } from './PipelineBoard';
import { PipelinePage } from './PipelinePage';

afterEach(() => {
  cleanup();
});

const kevinCard: PipelineCard = {
  personId: 'person-kevin',
  salesCycleId: 'cycle-kevin',
  personName: 'Kevin Shin',
  contextLabel: 'Shin Properties',
  stage: 'contacted' as const,
  stageEnteredAt: '2026-08-28T12:00:00.000Z',
  priorityContext: {
    priority: 'P1' as const,
    fitPoints: 22,
    fitBand: 'high' as const,
    timingValue: 31.5,
    timingBand: 'hot' as const,
    reachability: 'direct' as const,
    dataConfidence: 7,
  },
  nextAction: {
    id: 'action-kevin',
    type: 'call_lead',
    channel: 'call' as const,
    dueAt: '2026-08-31T15:00:00.000Z',
    label: 'call lead',
    overdue: true,
  },
  lostReasonCode: null,
};

const onboardingCard: PipelineCard = {
  personId: 'person-maya',
  salesCycleId: 'cycle-maya',
  personName: 'Maya Ortiz',
  contextLabel: null,
  stage: 'won' as const,
  stageEnteredAt: '2026-08-29T09:00:00.000Z',
  priorityContext: {
    priority: 'P2' as const,
    fitPoints: 18,
    fitBand: 'medium' as const,
    timingValue: 12,
    timingBand: 'warm' as const,
    reachability: 'direct' as const,
    dataConfidence: 6,
  },
  nextAction: {
    id: 'action-maya',
    type: 'onboarding_checkin',
    channel: 'onboarding' as const,
    dueAt: '2026-09-01T15:00:00.000Z',
    label: 'onboarding checkin',
    overdue: false,
  },
  lostReasonCode: null,
};

const closedWonCard: PipelineCard = {
  personId: 'person-ada',
  salesCycleId: 'cycle-ada',
  personName: 'Ada Lin',
  contextLabel: null,
  stage: 'won' as const,
  stageEnteredAt: '2026-08-20T09:00:00.000Z',
  priorityContext: {
    priority: 'P3' as const,
    fitPoints: 10,
    fitBand: 'medium' as const,
    timingValue: 5,
    timingBand: 'cold' as const,
    reachability: 'indirect' as const,
    dataConfidence: 4,
  },
  nextAction: null,
  lostReasonCode: null,
};

const lostCard: PipelineCard = {
  personId: 'person-noah',
  salesCycleId: 'cycle-noah',
  personName: 'Noah Reyes',
  contextLabel: null,
  stage: 'lost_nurture' as const,
  stageEnteredAt: '2026-08-25T10:00:00.000Z',
  priorityContext: null,
  nextAction: null,
  lostReasonCode: 'no_response',
};

const pipelineSnapshot: PipelineSnapshot = pipelineSnapshotSchema.parse({
  stages: [
    { stage: 'unreviewed', cards: [] },
    { stage: 'ready', cards: [] },
    { stage: 'contacted', cards: [kevinCard] },
    { stage: 'interviewed', cards: [] },
    { stage: 'offered', cards: [] },
    { stage: 'won', cards: [onboardingCard, closedWonCard] },
    { stage: 'lost_nurture', cards: [lostCard] },
  ],
  revision: 4,
});

describe('PipelinePage', () => {
  it('renders only the approved lifecycle stages', () => {
    render(<PipelinePage snapshot={pipelineSnapshot} onOpenLead={vi.fn()} />);
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent),
    ).toEqual([
      'Unreviewed', 'Ready', 'Contacted', 'Interviewed', 'Offered', 'Won', 'Lost-Nurture',
    ]);
    expect(screen.queryByRole('button', { name: /add stage/i })).toBeNull();
  });

  it('never offers drag-and-drop or stage mutation controls', () => {
    const { container } = render(
      <PipelinePage snapshot={pipelineSnapshot} onOpenLead={vi.fn()} />,
    );
    expect(container.querySelector('[draggable="true"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /move to/i })).toBeNull();
  });

  it('shows the next action and won metadata on cards', () => {
    render(<PipelinePage snapshot={pipelineSnapshot} onOpenLead={vi.fn()} />);
    const kevin = screen.getByRole('button', { name: /Kevin Shin/ });
    expect(within(kevin).getByText('call lead')).toBeTruthy();
    expect(within(kevin).getByText('Overdue')).toBeTruthy();
    const maya = screen.getByRole('button', { name: /Maya Ortiz/ });
    expect(within(maya).getByText('Onboarding')).toBeTruthy();
    const ada = screen.getByRole('button', { name: /Ada Lin/ });
    expect(within(ada).getByText('Closed won')).toBeTruthy();
  });

  it('renders a missing priority context as muted copy instead of a fallback score', () => {
    render(<PipelinePage snapshot={pipelineSnapshot} onOpenLead={vi.fn()} />);
    const noah = screen.getByRole('button', { name: /Noah Reyes/ });
    const muted = within(noah).getByText('No priority data');
    expect(muted.className).toContain('pipeline-card__muted');
    expect(within(noah).getByText(/no response/)).toBeTruthy();
  });

  it('switches to a table sharing the same DTO through the segmented control', () => {
    const onOpenLead = vi.fn();
    render(<PipelinePage snapshot={pipelineSnapshot} onOpenLead={onOpenLead} />);

    const tableToggle = screen.getByRole('button', { name: 'Table', pressed: false });
    fireEvent.click(tableToggle);

    const table = screen.getByRole('table');
    const rowNames = within(table)
      .getAllByRole('button')
      .map((node) => node.textContent);
    expect(rowNames).toEqual(['Kevin Shin', 'Maya Ortiz', 'Ada Lin', 'Noah Reyes']);
    expect(screen.getByRole('button', { name: 'Table', pressed: true })).toBeTruthy();

    fireEvent.click(within(table).getByRole('button', { name: 'Kevin Shin' }));
    expect(onOpenLead).toHaveBeenCalledWith('person-kevin');
  });
});

describe('PipelineBoard', () => {
  it('opens a person instead of mutating stage by drag', () => {
    const onOpenLead = vi.fn();
    render(<PipelineBoard snapshot={pipelineSnapshot} onOpenLead={onOpenLead} />);
    fireEvent.click(screen.getByRole('button', { name: /Kevin Shin/ }));
    expect(onOpenLead).toHaveBeenCalledWith('person-kevin');
  });

  it('keeps empty stages visible as empty columns', () => {
    render(<PipelineBoard snapshot={pipelineSnapshot} onOpenLead={vi.fn()} />);
    const ready = screen.getByRole('region', { name: 'Ready' });
    expect(within(ready).getByText('No leads')).toBeTruthy();
    expect(within(ready).queryAllByRole('button')).toHaveLength(0);
  });
});
