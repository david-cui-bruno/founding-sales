// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  FridayReport,
  Metric,
  MetricDrilldown,
  MetricId,
} from '../../../shared/contracts/fridayContract';
import type { MutationReceipt } from '../../../shared/contracts/commonContract';
import type { FridayApi } from './FridayRoute';
import { FridayRoute } from './FridayRoute';

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
      label: 'Interviews', displayValue: '2', numericValue: 2, drilldownCount: 2,
    }),
    metric('fill_rate', {
      label: 'Fill rate', displayValue: '—', numericValue: null,
      numerator: 0, denominator: 0,
    }),
  ],
  sourceRows: [],
  jobs: [
    {
      id: 'job-1', salesCycleId: null, requestedAt: '2026-08-31T13:00:00.000Z',
      status: 'requested', contractorAcceptedAt: null,
    },
  ],
  revision: 4,
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

const receipt: MutationReceipt = {
  revision: 5,
  affectedPersonIds: [],
  affectedSalesCycleIds: [],
};

function createApi(overrides: Partial<FridayApi> = {}): FridayApi {
  return {
    getCurrent: vi.fn(async () => report),
    getDrilldown: vi.fn(async () => drilldown),
    createJob: vi.fn(async () => receipt),
    fillJob: vi.fn(async () => receipt),
    cancelJob: vi.fn(async () => receipt),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('FridayRoute', () => {
  it('loads and renders the current report', async () => {
    const api = createApi();

    await act(async () => {
      render(<FridayRoute api={api} onOpenLead={vi.fn()} />);
    });

    expect(api.getCurrent).toHaveBeenCalledWith(undefined);
    expect(screen.getByRole('heading', { name: 'Friday scoreboard' })).toBeTruthy();
    expect(screen.getByText('No data yet')).toBeTruthy();
  });

  it('refetches with a week offset when stepping back and clamps at the current week', async () => {
    const api = createApi();

    await act(async () => {
      render(<FridayRoute api={api} onOpenLead={vi.fn()} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    });

    expect(api.getCurrent).toHaveBeenLastCalledWith({ weekOffset: -1 });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    });

    expect(api.getCurrent).toHaveBeenLastCalledWith(undefined);
    expect(
      (screen.getByRole('button', { name: 'Next week' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('shows a safe error state and retries', async () => {
    const getCurrent = vi
      .fn<() => Promise<FridayReport>>()
      .mockRejectedValueOnce(new Error('boom /var/db/secret.sqlite3'))
      .mockResolvedValue(report);
    const api = createApi({ getCurrent });

    await act(async () => {
      render(<FridayRoute api={api} onOpenLead={vi.fn()} />);
    });

    expect(screen.getByRole('alert').textContent).not.toContain('secret');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(screen.getByRole('heading', { name: 'Friday scoreboard' })).toBeTruthy();
  });

  it('opens a metric drilldown and forwards rows to onOpenLead', async () => {
    const api = createApi();
    const onOpenLead = vi.fn();

    await act(async () => {
      render(<FridayRoute api={api} onOpenLead={onOpenLead} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Interviews/ }));
    });

    expect(api.getDrilldown).toHaveBeenCalledWith({ metricId: 'interviews' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Kevin Shin/ }));
    });
    expect(onOpenLead).toHaveBeenCalledWith('person-1');
  });

  it('creates a job then refetches the report', async () => {
    const api = createApi();

    await act(async () => {
      render(<FridayRoute api={api} onOpenLead={vi.fn()} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Request job' }));
    });

    expect(api.createJob).toHaveBeenCalledTimes(1);
    expect(api.getCurrent).toHaveBeenCalledTimes(2);
  });

  it('fills a job only after contractor acceptance confirmation and refetches', async () => {
    const api = createApi();

    await act(async () => {
      render(<FridayRoute api={api} onOpenLead={vi.fn()} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Fill job-1' }));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Accepted date'), {
        target: { value: '2026-08-31' },
      });
      fireEvent.change(screen.getByLabelText('Accepted time'), {
        target: { value: '16:00' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Confirm fill' }));
    });

    expect(api.fillJob).toHaveBeenCalledWith({
      jobId: 'job-1',
      contractorAcceptedAt: new Date('2026-08-31T16:00').toISOString(),
    });
    expect(api.getCurrent).toHaveBeenCalledTimes(2);
  });

  it('cancels a job and refetches', async () => {
    const api = createApi();

    await act(async () => {
      render(<FridayRoute api={api} onOpenLead={vi.fn()} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel job-1' }));
    });

    expect(api.cancelJob).toHaveBeenCalledWith({ jobId: 'job-1' });
    expect(api.getCurrent).toHaveBeenCalledTimes(2);
  });
});
