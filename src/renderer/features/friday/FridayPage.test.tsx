// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  FridayReport,
  Metric,
  MetricDrilldown,
  MetricId,
} from '../../../shared/contracts/fridayContract';
import { FridayPage } from './FridayPage';
import { JobRequestForm } from './JobRequestForm';
import {
  MetricCard,
  formatMetricEvidence,
  formatMetricTarget,
  formatPriorDelta,
} from './MetricCard';
import { MetricDrilldownPanel } from './MetricDrilldown';

const metric = (id: MetricId, overrides: Partial<Metric> = {}): Metric => ({
  id,
  label: id,
  displayValue: '0',
  numericValue: 0,
  target: null,
  priorDelta: null,
  numerator: null,
  denominator: null,
  drilldownCount: 0,
  ...overrides,
});

const report: FridayReport = {
  periodStartsAt: '2026-08-31T04:00:00.000Z',
  periodEndsAt: '2026-09-05T04:00:00.000Z',
  asOf: '2026-08-31T15:00:00.000Z',
  metrics: [
    metric('interviews', {
      label: 'Interviews', displayValue: '4', numericValue: 4, drilldownCount: 4,
    }),
    metric('offer_rate', {
      label: 'Offer rate', displayValue: '75%', numericValue: 0.75,
      numerator: 3, denominator: 4, target: 0.5, priorDelta: 0.25,
    }),
    metric('fill_rate', {
      label: 'Fill rate', displayValue: '33%', numericValue: 1 / 3,
      numerator: 1, denominator: 3,
    }),
    metric('new_mrr', {
      label: 'New MRR', displayValue: '$1,500.00', numericValue: 1500,
    }),
  ],
  sourceRows: [{ source: 'frbo', interviews: 4, offers: 3, wins: 2 }],
  jobs: [
    {
      id: 'job-1', salesCycleId: null, requestedAt: '2026-08-31T13:00:00.000Z',
      status: 'requested', contractorAcceptedAt: null,
    },
    {
      id: 'job-2', salesCycleId: 'cycle-2', requestedAt: '2026-08-31T12:00:00.000Z',
      status: 'filled', contractorAcceptedAt: '2026-08-31T14:00:00.000Z',
    },
    {
      id: 'job-3', salesCycleId: null, requestedAt: '2026-08-31T11:00:00.000Z',
      status: 'cancelled', contractorAcceptedAt: null,
    },
  ],
  revision: 7,
};

const drilldown: MetricDrilldown = {
  metricId: 'interviews',
  label: 'Interviews',
  rows: [
    {
      id: 'event-1', personId: 'person-1', salesCycleId: 'cycle-1',
      label: 'Kevin Shin', occurredAt: '2026-08-31T13:30:00.000Z', detail: null,
    },
  ],
};

// Structural spread stays runnable against baseline props. These are the frozen
// future props, not imports of nonexistent Friday mutation helpers/types.
const idleMutationProps = {
  mutation: { status: 'idle' as const },
  onRetryMutation: async () => ({ status: 'not_started' as const }),
  onRefreshJobs: async () => ({ status: 'not_started' as const }),
};
const saved = async () => ({ status: 'saved' as const });

function renderPage(overrides: Partial<Parameters<typeof FridayPage>[0]> = {}) {
  return render(
    <FridayPage
      {...idleMutationProps}
      report={report}
      onOpenMetric={vi.fn()}
      onCreateJob={vi.fn(saved)}
      onFillJob={vi.fn(saved)}
      onCancelJob={vi.fn(saved)}
      {...overrides}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe('FridayPage', () => {
  it('renders actual, target, prior change, and exact fill-rate evidence', () => {
    renderPage();

    expect(screen.getByRole('heading', { name: 'Friday scoreboard' })).toBeTruthy();
    expect(screen.getByText('3 / 4')).toBeTruthy();
    expect(screen.getByText('75%')).toBeTruthy();
    expect(screen.getByText('Target 50%')).toBeTruthy();
    expect(screen.getByText('+25% vs prior week')).toBeTruthy();
    expect(screen.getByText(/contractor accepted/i)).toBeTruthy();
  });

  it('groups metrics into the Funnel, Revenue, and Health bands', () => {
    renderPage();

    const funnel = screen.getByRole('region', { name: 'Funnel' });
    expect(funnel.textContent).toContain('Interviews');
    expect(funnel.textContent).toContain('Offer rate');
    const revenue = screen.getByRole('region', { name: 'Revenue' });
    expect(revenue.textContent).toContain('New MRR');
    const health = screen.getByRole('region', { name: 'Health' });
    expect(health.textContent).toContain('Fill rate');
    expect(revenue.textContent).not.toContain('Interviews');
  });

  it('drives the week picker and disables next-week at the current week', () => {
    const onPreviousWeek = vi.fn();
    const onNextWeek = vi.fn();
    renderPage({ weekOffset: 0, onPreviousWeek, onNextWeek });

    const next = screen.getByRole('button', { name: 'Next week' });
    expect((next as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    expect(onPreviousWeek).toHaveBeenCalledTimes(1);
    expect(onNextWeek).not.toHaveBeenCalled();
  });

  it('enables next-week when browsing a past week', () => {
    const onNextWeek = vi.fn();
    renderPage({ weekOffset: -2, onNextWeek });

    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(onNextWeek).toHaveBeenCalledTimes(1);
  });

  it('exposes a metric as a button only when drilldown evidence exists', () => {
    const onOpenMetric = vi.fn();
    renderPage({ onOpenMetric });

    const interviews = screen.getByRole('button', { name: /Interviews/ });
    fireEvent.click(interviews);
    expect(onOpenMetric).toHaveBeenCalledWith('interviews');
    expect(screen.queryByRole('button', { name: /Offer rate/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /New MRR/ })).toBeNull();
  });

  it('renders the source funnel with neutral counted columns', () => {
    renderPage();

    const headers = screen
      .getAllByRole('columnheader')
      .map((node) => node.textContent);
    expect(headers).toEqual(['Source', 'Interviews', 'Offers', 'Wins']);
    expect(screen.getByRole('rowheader', { name: 'frbo' })).toBeTruthy();
  });

  it('keeps cancelled jobs visible without fill or cancel controls', () => {
    renderPage();

    expect(screen.getByText('job-3')).toBeTruthy();
    expect(screen.getByText('Cancelled')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Fill job-3' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel job-3' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fill job-2' })).toBeNull();
  });

  it('forwards drilldown row activation to onOpenLead', () => {
    const onOpenLead = vi.fn();
    renderPage({ drilldown, onOpenLead, onCloseDrilldown: vi.fn() });

    fireEvent.click(screen.getByRole('button', { name: /Kevin Shin/ }));
    expect(onOpenLead).toHaveBeenCalledWith('person-1');
  });
});

describe('MetricCard', () => {
  it('renders a quiet No data yet for a zero denominator', () => {
    render(
      <MetricCard
        metric={metric('fill_rate', {
          label: 'Fill rate', displayValue: '—', numericValue: null,
          numerator: 0, denominator: 0,
        })}
        onOpenMetric={vi.fn()}
      />,
    );

    expect(screen.getByText('No data yet')).toBeTruthy();
    expect(screen.queryByText('—')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('colors the delta arrow by direction', () => {
    const { container } = render(
      <MetricCard
        metric={metric('wins', {
          label: 'Wins', displayValue: '1', numericValue: 1, priorDelta: -1,
        })}
        onOpenMetric={vi.fn()}
      />,
    );

    expect(screen.getByText('-1 vs prior week')).toBeTruthy();
    expect(container.querySelector('.metric-card__delta--down')).not.toBeNull();
    expect(container.querySelector('.metric-card__delta--up')).toBeNull();
  });
});

describe('metric display formatting', () => {
  it('formats evidence as numerator over denominator without dividing', () => {
    expect(formatMetricEvidence(metric('offer_rate', { numerator: 3, denominator: 4 })))
      .toBe('3 / 4');
    expect(formatMetricEvidence(metric('interviews'))).toBeNull();
  });

  it('formats USD targets and deltas with Intl.NumberFormat', () => {
    expect(formatMetricTarget(metric('new_mrr', { target: 2000 }))).toBe('$2,000.00');
    expect(formatPriorDelta(metric('new_mrr', { priorDelta: 300 }))).toBe('+$300.00');
  });

  it('formats rate and count targets and deltas', () => {
    expect(formatMetricTarget(metric('fill_rate', { target: 0.5 }))).toBe('50%');
    expect(formatPriorDelta(metric('fill_rate', { priorDelta: 0.25 }))).toBe('+25%');
    expect(formatMetricTarget(metric('wins', { target: 2 }))).toBe('2');
    expect(formatPriorDelta(metric('wins', { priorDelta: -1 }))).toBe('-1');
    expect(formatMetricTarget(metric('wins'))).toBeNull();
    expect(formatPriorDelta(metric('wins'))).toBeNull();
  });
});

describe('MetricDrilldownPanel', () => {
  it('opens the inspected lead from a drilldown row', () => {
    const onOpenLead = vi.fn();
    render(
      <MetricDrilldownPanel
        drilldown={drilldown}
        onOpenLead={onOpenLead}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Kevin Shin/ }));
    expect(onOpenLead).toHaveBeenCalledWith('person-1');
  });

  it('closes through the panel action', () => {
    const onClose = vi.fn();
    render(
      <MetricDrilldownPanel
        drilldown={drilldown}
        onOpenLead={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('JobRequestForm', () => {
  it('uses a labeled in-flow fill group, not an alertdialog', async () => {
    renderPage();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Fill job-1' })); });
    expect(screen.getByRole('group', { name: 'Fill job-1' })).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('uses local midnight for a nonblank requested date and blank time', async () => {
    const onCreateJob = vi.fn(saved);
    renderPage({ onCreateJob });
    fireEvent.change(screen.getByLabelText('Requested date'), {
      target: { value: '2026-08-31' },
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Request job' })); });
    expect(onCreateJob).toHaveBeenCalledWith({
      jobId: expect.stringMatching(/\S/), salesCycleId: null,
      requestedAt: new Date('2026-08-31T00:00').toISOString(),
    });
  });

  it('creates a job request from the local date and time pair with an optional Won cycle', async () => {
    const onCreateJob = vi.fn(saved);
    render(
      <JobRequestForm
        {...idleMutationProps}
        jobs={[]}
        onCreateJob={onCreateJob}
        onFillJob={vi.fn(saved)}
        onCancelJob={vi.fn(saved)}
        now={() => '2026-08-31T15:00:00.000Z'}
      />,
    );

    fireEvent.change(screen.getByLabelText('Requested date'), {
      target: { value: '2026-08-31' },
    });
    fireEvent.change(screen.getByLabelText('Requested time'), {
      target: { value: '11:30' },
    });
    fireEvent.change(screen.getByLabelText('Won sales cycle (optional)'), {
      target: { value: 'cycle-9' },
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Request job' })); });

    expect(onCreateJob).toHaveBeenCalledWith({
      jobId: expect.stringMatching(/\S/),
      salesCycleId: 'cycle-9',
      requestedAt: new Date('2026-08-31T11:30').toISOString(),
    });
  });

  it('creates a job without a Won cycle as null', async () => {
    const onCreateJob = vi.fn(saved);
    render(
      <JobRequestForm
        {...idleMutationProps}
        jobs={[]}
        onCreateJob={onCreateJob}
        onFillJob={vi.fn(saved)}
        onCancelJob={vi.fn(saved)}
        now={() => '2026-08-31T15:00:00.000Z'}
      />,
    );

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Request job' })); });

    expect(onCreateJob).toHaveBeenCalledWith({
      jobId: expect.stringMatching(/\S/),
      salesCycleId: null,
      requestedAt: '2026-08-31T15:00:00.000Z',
    });
  });

  it('requires contractor acceptance confirmation before filling', async () => {
    const onFillJob = vi.fn(saved);
    render(
      <JobRequestForm
        {...idleMutationProps}
        jobs={report.jobs}
        onCreateJob={vi.fn(saved)}
        onFillJob={onFillJob}
        onCancelJob={vi.fn(saved)}
        now={() => '2026-08-31T15:00:00.000Z'}
      />,
    );

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Fill job-1' })); });

    expect(screen.getByText(/contractor acceptance is the fill event/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Accepted date'), {
      target: { value: '2026-08-31' },
    });
    fireEvent.change(screen.getByLabelText('Accepted time'), {
      target: { value: '16:00' },
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm fill' })); });

    expect(onFillJob).toHaveBeenCalledWith({
      jobId: 'job-1',
      contractorAcceptedAt: new Date('2026-08-31T16:00').toISOString(),
    });
  });

  it('does not fill when the confirmation is dismissed', async () => {
    const onFillJob = vi.fn(saved);
    render(
      <JobRequestForm
        {...idleMutationProps}
        jobs={report.jobs}
        onCreateJob={vi.fn(saved)}
        onFillJob={onFillJob}
        onCancelJob={vi.fn(saved)}
      />,
    );

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Fill job-1' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Keep requested' })); });

    expect(onFillJob).not.toHaveBeenCalled();
    expect(screen.queryByText(/contractor acceptance is the fill event/i)).toBeNull();
  });

  it('cancels a requested job', async () => {
    const onCancelJob = vi.fn(saved);
    render(
      <JobRequestForm
        {...idleMutationProps}
        jobs={report.jobs}
        onCreateJob={vi.fn(saved)}
        onFillJob={vi.fn(saved)}
        onCancelJob={onCancelJob}
      />,
    );

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel job-1' })); });
    expect(onCancelJob).toHaveBeenCalledWith({ jobId: 'job-1' });
  });
});
