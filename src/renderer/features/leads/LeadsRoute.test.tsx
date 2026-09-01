// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { StrictMode } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  LeadRow,
  LeadsListResponse,
} from '../../../shared/contracts/leadsContract';
import type { LeadsApi } from '../../../preload/apis/leadsApi';
import { LeadsRoute } from './LeadsRoute';

const elementSizes: PropertyDescriptor[] = [];

beforeAll(() => {
  elementSizes.push(
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight') ?? {},
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth') ?? {},
  );
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 480,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 960,
  });
});

afterAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', elementSizes[0]!);
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', elementSizes[1]!);
});

afterEach(() => {
  cleanup();
});

const leadRow: LeadRow = {
  personId: 'person-1',
  salesCycleId: 'cycle-1',
  personName: 'Avery Landlord',
  initials: 'AL',
  organization: 'Landlord LLC',
  propertySummary: '12 Benefit St, Providence',
  stage: 'ready',
  source: 'frbo',
  segment: 'hot',
  cloudScores: { fit: 62, timing: 41 },
  priorityContext: {
    priority: 'P1',
    fitPoints: 24,
    fitBand: 'high',
    timingValue: 31,
    timingBand: 'hot',
    reachability: 'direct',
    dataConfidence: 8,
  },
  nextAction: {
    id: 'action-1',
    type: 'call_lead',
    channel: 'call',
    dueAt: '2026-08-31T15:00:00.000Z',
    label: 'Call lead',
    overdue: false,
  },
  optedOut: false,
  lastActivityAt: '2026-08-30T12:00:00.000Z',
};

const page = (rows: LeadRow[]): LeadsListResponse => ({
  rows,
  nextCursor: null,
  total: rows.length,
  revision: 1,
});

const receipt = {
  revision: 2,
  affectedPersonIds: ['person-1'],
  affectedSalesCycleIds: ['cycle-1'],
};

function fakeApi(overrides: Partial<LeadsApi> = {}): LeadsApi {
  return {
    list: vi.fn(async () => page([leadRow])),
    updateField: vi.fn(async () => receipt),
    bulkUpdate: vi.fn(async () => receipt),
    ...overrides,
  } as LeadsApi;
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

describe('LeadsRoute', () => {
  it('shows a loading state, then the loaded people, under StrictMode', async () => {
    const api = fakeApi();
    render(
      <StrictMode>
        <LeadsRoute api={api} onOpenLead={vi.fn()} onOpenImport={vi.fn()} />
      </StrictMode>,
    );

    expect(screen.getByRole('status').textContent).toContain('Loading');
    await screen.findByText('Avery Landlord');
    expect(screen.getByRole('columnheader', { name: 'Person' })).toBeTruthy();
  });

  it('shows an empty state with an import action when there are no leads', async () => {
    const onOpenImport = vi.fn();
    const api = fakeApi({ list: vi.fn(async () => page([])) });
    render(
      <LeadsRoute api={api} onOpenLead={vi.fn()} onOpenImport={onOpenImport} />,
    );

    await screen.findByRole('heading', { name: 'No leads yet' });
    fireEvent.click(screen.getByRole('button', { name: 'Import leads' }));
    expect(onOpenImport).toHaveBeenCalledTimes(1);
  });

  it('shows a safe error state with retry when the list request fails', async () => {
    let failures = 0;
    const api = fakeApi({
      list: vi.fn(async () => {
        if (failures === 0) {
          failures += 1;
          throw new Error('SQLITE_IOERR: disk I/O error at /private/leads.db');
        }
        return page([leadRow]);
      }),
    });
    render(
      <LeadsRoute api={api} onOpenLead={vi.fn()} onOpenImport={vi.fn()} />,
    );

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toMatch(/sqlite|errno|\/private/i);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Avery Landlord');
  });

  it('ignores stale responses when the search changes quickly', async () => {
    const first = deferred<LeadsListResponse>();
    const second = deferred<LeadsListResponse>();
    const responses = [first, second];
    const api = fakeApi({
      list: vi.fn(async () => {
        const next = responses.shift();
        return next === undefined ? page([]) : next.promise;
      }),
    });
    render(
      <LeadsRoute api={api} onOpenLead={vi.fn()} onOpenImport={vi.fn()} />,
    );

    const search = await screen.findByRole('searchbox', { name: 'Search leads' });
    fireEvent.change(search, { target: { value: 'blake' } });
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));

    second.resolve(page([{ ...leadRow, personId: 'person-2', personName: 'Blake Owner' }]));
    await screen.findByText('Blake Owner');
    first.resolve(page([leadRow]));
    await waitFor(() => {
      expect(screen.queryByText('Avery Landlord')).toBeNull();
      expect(screen.getByText('Blake Owner')).toBeTruthy();
    });
  });

  it('opens a lead from the grid', async () => {
    const onOpenLead = vi.fn();
    render(
      <LeadsRoute api={fakeApi()} onOpenLead={onOpenLead} onOpenImport={vi.fn()} />,
    );

    const row = await screen.findByRole('row', { name: /Avery Landlord/ });
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onOpenLead).toHaveBeenCalledWith('person-1');
  });

  it('sends an inline edit through the api and refreshes the list', async () => {
    const api = fakeApi();
    render(
      <LeadsRoute api={api} onOpenLead={vi.fn()} onOpenImport={vi.fn()} />,
    );

    fireEvent.doubleClick(await screen.findByText('Avery Landlord'));
    const input = screen.getByRole('textbox', {
      name: 'Edit name for Avery Landlord',
    });
    fireEvent.change(input, { target: { value: 'Avery Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(api.updateField).toHaveBeenCalledWith({
        personId: 'person-1',
        field: 'person_name',
        value: 'Avery Renamed',
      }),
    );
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  });

  it('applies a bulk organization update to checked people', async () => {
    const api = fakeApi({
      list: vi.fn(async () =>
        page([
          leadRow,
          { ...leadRow, personId: 'person-2', salesCycleId: 'cycle-2', personName: 'Blake Owner' },
        ]),
      ),
    });
    render(
      <LeadsRoute api={api} onOpenLead={vi.fn()} onOpenImport={vi.fn()} />,
    );

    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'Select Avery Landlord' }),
    );
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select Blake Owner' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Set organization' }));
    const input = screen.getByRole('textbox', { name: 'Organization for 2 selected' });
    fireEvent.change(input, { target: { value: 'Shared Holdings' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(api.bulkUpdate).toHaveBeenCalledWith({
        personIds: ['person-1', 'person-2'],
        field: 'organization_label',
        value: 'Shared Holdings',
      }),
    );
  });
});
