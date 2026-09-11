// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
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
  it('retires the old week synchronously before a same-act old form submit', async () => {
    const api = createApi();
    await act(async () => { render(<FridayRoute api={api} onOpenLead={vi.fn()} />); });
    const previous = screen.getByRole('button', { name: 'Previous week' });
    const oldForm = screen.getByRole('button', { name: 'Request job' }).closest('form')!;
    await act(async () => {
      fireEvent.click(previous);
      fireEvent.submit(oldForm);
    });
    expect(api.getCurrent).toHaveBeenLastCalledWith({ weekOffset: -1 });
    expect(api.createJob).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Request job' })); });
    expect(api.createJob).toHaveBeenCalledTimes(1);
    expect(api.getCurrent).toHaveBeenLastCalledWith({ weekOffset: -1 });
  });

  it('ignores a StrictMode first-lifetime report and admits a current-lifetime mutation', async () => {
    let resolve!: (value: FridayReport) => void;
    const first = new Promise<FridayReport>((done) => { resolve = done; });
    const getCurrent = vi.fn<FridayApi['getCurrent']>()
      .mockImplementationOnce(() => first).mockResolvedValue(report);
    const api = createApi({ getCurrent });
    await act(async () => { render(<StrictMode><FridayRoute api={api} onOpenLead={vi.fn()} /></StrictMode>); });
    expect(getCurrent).toHaveBeenCalledTimes(2);
    await act(async () => { resolve({ ...report, jobs: [{ ...report.jobs[0]!, id: 'obsolete-strict' }] }); });
    expect(screen.queryByText('obsolete-strict')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Request job' })); });
    expect(api.createJob).toHaveBeenCalledTimes(1);
    expect(getCurrent).toHaveBeenCalledTimes(3);
  });

  it('ignores an earlier drilldown in the same owner after a newer request', async () => {
    let resolve!: (value: MetricDrilldown) => void;
    const first = new Promise<MetricDrilldown>((done) => { resolve = done; });
    const latest = { ...drilldown, rows: [{ ...drilldown.rows[0]!, label: 'Current row', personId: 'current-person' }] };
    const getDrilldown = vi.fn<FridayApi['getDrilldown']>()
      .mockImplementationOnce(() => first).mockResolvedValue(latest);
    const api = createApi({ getDrilldown }); const onOpenLead = vi.fn();
    await act(async () => { render(<FridayRoute api={api} onOpenLead={onOpenLead} />); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Interviews/ })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Interviews/ })); });
    await act(async () => { resolve(drilldown); });
    expect(screen.queryByRole('button', { name: /Kevin Shin/ })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Current row/ })); });
    expect(onOpenLead.mock.calls).toEqual([['current-person']]);
  });

  it.each(['api', 'week'] as const)('ignores departed drilldown after real %s replacement', async (replacement) => {
    let resolve!: (value: MetricDrilldown) => void;
    const pending = new Promise<MetricDrilldown>((done) => { resolve = done; });
    const old = createApi({ getDrilldown: vi.fn(() => pending) });
    const next = createApi(); const onOpenLead = vi.fn();
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<FridayRoute api={old} onOpenLead={onOpenLead} />); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Interviews/ })); });
    expect(old.getDrilldown).toHaveBeenCalledTimes(1);
    await act(async () => {
      if (replacement === 'api') view.rerender(<FridayRoute api={next} onOpenLead={onOpenLead} />);
      else fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    });
    await act(async () => { resolve(drilldown); });
    expect(screen.queryByRole('button', { name: /Kevin Shin/ })).toBeNull();
    expect(onOpenLead).not.toHaveBeenCalled();
    // Positive control: a current-owner drilldown still opens and forwards exactly once.
    vi.mocked(replacement === 'api' ? next.getDrilldown : old.getDrilldown).mockResolvedValue(drilldown);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Interviews/ })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Kevin Shin/ })); });
    expect(onOpenLead.mock.calls).toEqual([['person-1']]);
  });

  it('replaces the displayed report through real historical/current week navigation', async () => {
    let resolveOld!: (value: FridayReport) => void;
    const oldRead = new Promise<FridayReport>((resolve) => { resolveOld = resolve; });
    const getCurrent = vi.fn<FridayApi['getCurrent']>()
      .mockResolvedValueOnce(report).mockImplementationOnce(() => oldRead)
      .mockResolvedValue({ ...report, jobs: [{ ...report.jobs[0]!, id: 'latest-week' }] });
    const api = createApi({ getCurrent });
    await act(async () => { render(<FridayRoute api={api} onOpenLead={vi.fn()} />); });
    const previous = screen.getByRole('button', { name: 'Previous week' });
    await act(async () => { fireEvent.click(previous); });
    // Once the earlier week settles, navigation is publicly available again.
    await act(async () => { resolveOld({ ...report, jobs: [{ ...report.jobs[0]!, id: 'older-week' }] }); });
    expect(getCurrent).toHaveBeenLastCalledWith({ weekOffset: -1 });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Next week' })); });
    expect(getCurrent).toHaveBeenLastCalledWith(undefined);
    expect(screen.getByText('latest-week')).toBeTruthy();
    expect(screen.queryByText('older-week')).toBeNull();
    expect((screen.getByRole('button', { name: 'Next week' }) as HTMLButtonElement).disabled).toBe(true);
  });

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
