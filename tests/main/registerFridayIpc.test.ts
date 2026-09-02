import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: electron.handle,
    removeHandler: electron.removeHandler,
  },
}));

import type { MutationReceipt } from '../../src/shared/contracts/commonContract';
import type {
  FridayReport,
  Metric,
  MetricDrilldown,
  MetricId,
} from '../../src/shared/contracts/fridayContract';
import type { FridayProvider } from '../../src/main/friday/fridayService';
import { registerFridayIpc } from '../../src/main/friday/registerFridayIpc';
import {
  registeredIpcHandler,
  type IpcInvokeEvent,
} from '../fixtures/registeredIpcHandler';

const trustedEvent: IpcInvokeEvent = {
  senderFrame: { url: 'callie://app/index.html' },
};
const untrustedEvent: IpcInvokeEvent = {
  senderFrame: { url: 'https://attacker.test/' },
};

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

const validReport: FridayReport = {
  periodStartsAt: '2026-08-31T04:00:00.000Z',
  periodEndsAt: '2026-09-05T04:00:00.000Z',
  asOf: '2026-08-31T15:00:00.000Z',
  metrics: [
    metric('interviews', { label: 'Interviews', drilldownCount: 1 }),
    metric('fill_rate', {
      label: 'Fill rate', displayValue: '—', numericValue: null,
      numerator: 0, denominator: 0,
    }),
  ],
  sourceRows: [{ source: 'frbo', interviews: 1, offers: 0, wins: 0 }],
  jobs: [
    {
      id: 'job-1', salesCycleId: null, requestedAt: '2026-08-31T13:00:00.000Z',
      status: 'requested', contractorAcceptedAt: null,
    },
  ],
  revision: 3,
};

const validDrilldown: MetricDrilldown = {
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
  revision: 4,
  affectedPersonIds: [],
  affectedSalesCycleIds: [],
};

function createProvider(overrides: Partial<FridayProvider> = {}): FridayProvider {
  return {
    getCurrent: vi.fn(async () => validReport),
    getDrilldown: vi.fn(async () => validDrilldown),
    createJob: vi.fn(async () => receipt),
    fillJob: vi.fn(async () => receipt),
    cancelJob: vi.fn(async () => receipt),
    ...overrides,
  };
}

function handler(channel: string) {
  return registeredIpcHandler(electron.handle, channel);
}

describe('registerFridayIpc', () => {
  beforeEach(() => {
    electron.handle.mockReset();
    electron.removeHandler.mockReset();
  });

  it('registers exactly the five friday channels', () => {
    registerFridayIpc(createProvider());

    const channels = electron.handle.mock.calls.map((call) => call[0]);
    expect(channels).toEqual([
      'friday:get',
      'friday:drilldown',
      'friday:create-job',
      'friday:fill-job',
      'friday:cancel-job',
    ]);
  });

  it('returns the validated report for friday:get without a payload', async () => {
    const provider = createProvider();
    registerFridayIpc(provider);

    await expect(handler('friday:get')(trustedEvent)).resolves.toEqual(validReport);
    expect(provider.getCurrent).toHaveBeenCalledTimes(1);
    expect(provider.getCurrent).toHaveBeenCalledWith(undefined);
  });

  it('accepts one strict week-offset request and rejects malformed ones', async () => {
    const provider = createProvider();
    registerFridayIpc(provider);

    await expect(
      handler('friday:get')(trustedEvent, { weekOffset: -3 }),
    ).resolves.toEqual(validReport);
    expect(provider.getCurrent).toHaveBeenCalledWith({ weekOffset: -3 });

    await expect(handler('friday:get')(trustedEvent, {})).rejects.toThrow();
    await expect(
      handler('friday:get')(trustedEvent, { weekOffset: 1 }),
    ).rejects.toThrow();
    await expect(
      handler('friday:get')(trustedEvent, { weekOffset: -1, extra: true }),
    ).rejects.toThrow();
    await expect(
      handler('friday:get')(trustedEvent, { weekOffset: -1 }, { weekOffset: -2 }),
    ).rejects.toThrow('at most one');
    expect(provider.getCurrent).toHaveBeenCalledTimes(1);
  });

  it('rejects an untrusted sender before invoking the provider', async () => {
    const provider = createProvider();
    registerFridayIpc(provider);

    await expect(handler('friday:get')(untrustedEvent)).rejects.toThrow('trusted');
    await expect(
      handler('friday:create-job')(untrustedEvent, {
        jobId: 'job-1', salesCycleId: null, requestedAt: '2026-08-31T13:00:00.000Z',
      }),
    ).rejects.toThrow('trusted');
    expect(provider.getCurrent).not.toHaveBeenCalled();
    expect(provider.createJob).not.toHaveBeenCalled();
  });

  it('validates the drilldown request and response', async () => {
    const provider = createProvider();
    registerFridayIpc(provider);

    await expect(
      handler('friday:drilldown')(trustedEvent, { metricId: 'interviews' }),
    ).resolves.toEqual(validDrilldown);
    expect(provider.getDrilldown).toHaveBeenCalledWith({ metricId: 'interviews' });
    await expect(
      handler('friday:drilldown')(trustedEvent, { metricId: 'lead_score' }),
    ).rejects.toThrow();
  });

  it('rejects a malformed create request before invoking the provider', async () => {
    const provider = createProvider();
    registerFridayIpc(provider);

    await expect(
      handler('friday:create-job')(trustedEvent, {
        jobId: '', salesCycleId: null, requestedAt: '2026-08-31T13:00:00.000Z',
      }),
    ).rejects.toThrow();
    await expect(
      handler('friday:create-job')(trustedEvent, {
        jobId: 'job-1', salesCycleId: null, requestedAt: 'not-a-time',
      }),
    ).rejects.toThrow();
    expect(provider.createJob).not.toHaveBeenCalled();
  });

  it('requires contractorAcceptedAt to fill a job', async () => {
    const provider = createProvider();
    registerFridayIpc(provider);

    await expect(
      handler('friday:fill-job')(trustedEvent, { jobId: 'job-1' }),
    ).rejects.toThrow();
    expect(provider.fillJob).not.toHaveBeenCalled();

    await expect(
      handler('friday:fill-job')(trustedEvent, {
        jobId: 'job-1', contractorAcceptedAt: '2026-08-31T16:00:00.000Z',
      }),
    ).resolves.toEqual(receipt);
    expect(provider.fillJob).toHaveBeenCalledWith({
      jobId: 'job-1', contractorAcceptedAt: '2026-08-31T16:00:00.000Z',
    });
  });

  it('cancels a job through the strict cancel contract', async () => {
    const provider = createProvider();
    registerFridayIpc(provider);

    await expect(
      handler('friday:cancel-job')(trustedEvent, { jobId: 'job-1' }),
    ).resolves.toEqual(receipt);
    expect(provider.cancelJob).toHaveBeenCalledWith({ jobId: 'job-1' });
    await expect(
      handler('friday:cancel-job')(trustedEvent, { jobId: 'job-1', force: true }),
    ).rejects.toThrow();
  });

  it('rejects a malformed provider report in the main process', async () => {
    const provider = createProvider({
      getCurrent: vi.fn(async () => ({
        ...validReport,
        metrics: [
          metric('interviews', { drilldownCount: -1 }),
        ],
      }) as FridayReport),
    });
    registerFridayIpc(provider);

    await expect(handler('friday:get')(trustedEvent)).rejects.toThrow();
  });

  it('removes all five handlers exactly once', () => {
    const unregister = registerFridayIpc(createProvider());

    unregister();
    unregister();

    expect(electron.removeHandler).toHaveBeenCalledTimes(5);
    const removed = electron.removeHandler.mock.calls.map((call) => call[0]);
    expect(removed).toEqual([
      'friday:get',
      'friday:drilldown',
      'friday:create-job',
      'friday:fill-job',
      'friday:cancel-job',
    ]);
  });
});
