// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  leadDetailSchema,
  type LeadDetail,
} from '../../../shared/contracts/leadDetailContract';
import { LeadInspectorProvider } from './LeadInspectorProvider';
import { useLeadInspector } from './useLeadInspector';

const receipt = {
  revision: 9,
  affectedPersonIds: ['person-kevin'],
  affectedSalesCycleIds: ['cycle-kevin'],
};

const detailFor = (overrides: Partial<LeadDetail> = {}): LeadDetail =>
  leadDetailSchema.parse({
    personId: 'person-kevin',
    salesCycleId: 'cycle-kevin',
    personName: 'Kevin Shin',
    phones: [
      { id: 'phone-1', kind: 'phone', value: '+14015550100', label: null, valid: true },
    ],
    emails: [
      { id: 'email-1', kind: 'email', value: 'kevin@example.com', label: null, valid: true },
    ],
    organizationLabel: 'Shin Properties',
    propertySummaries: ['12 Benefit St, Providence'],
    stage: 'unreviewed',
    workflowStatus: 'active',
    sourceLabel: 'craigslist',
    segment: 'hot',
    priorityContext: {
      priority: 'P1',
      fitPoints: 22,
      fitBand: 'high',
      timingValue: 31,
      timingBand: 'hot',
      reachability: 'direct',
      dataConfidence: 7,
    },
    priorityReasons: ['Fit high 22/30', 'Timing hot 31/40', 'Reachability direct'],
    cloudScores: null,
    nextAction: {
      id: 'action-1',
      type: 'review_lead',
      channel: 'review',
      dueAt: '2026-08-31T15:00:00.000Z',
      label: 'Review lead',
      overdue: false,
    },
    optedOut: false,
    cadence: { name: 'FRBO warm', stepLabel: 'Call 1', touchIndex: 1, touchLimit: 4 },
    activities: [
      {
        id: 'act-1',
        kind: 'call',
        occurredAt: '2026-08-30T15:00:00.000Z',
        summary: 'Left voicemail about 12 Benefit St',
        outcome: 'voicemail',
      },
    ],
    conversations: [],
    properties: [],
    history: [],
    revision: 4,
    ...overrides,
  });

const kevin = detailFor();
const dana = detailFor({
  personId: 'person-dana',
  salesCycleId: 'cycle-dana',
  personName: 'Dana Whitman',
});

function createApi(details: LeadDetail[]) {
  const byId = new Map(details.map((detail) => [detail.personId, detail]));
  return {
    get: vi.fn(async ({ personId }: { personId: string }) => {
      const detail = byId.get(personId);
      if (detail === undefined) {
        throw new Error('missing person');
      }
      return detail;
    }),
    beginOutbound: vi.fn(async () => receipt),
    confirmTransition: vi.fn(async () => receipt),
    dismissLead: vi.fn(async () => receipt),
    overrideCloudScore: vi.fn(async () => receipt),
  };
}

function Harness() {
  const inspector = useLeadInspector();

  return (
    <>
      <button type="button" onClick={() => inspector.openLead('person-kevin')}>
        Open Kevin Shin
      </button>
      <button type="button" onClick={() => inspector.openLead('person-dana')}>
        Open Dana Whitman
      </button>
      <button type="button" onClick={() => inspector.openFullPage('person-kevin')}>
        Open Kevin full page
      </button>
      <button type="button" onClick={() => inspector.closeLead()}>
        Close lead
      </button>
      <button
        type="button"
        onClick={() =>
          inspector.setReviewAdvance((personId) =>
            personId === 'person-kevin' ? 'person-dana' : null,
          )
        }
      >
        Register advance
      </button>
      <output data-testid="selected-person">
        {inspector.selectedPersonId ?? 'none'}
      </output>
    </>
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('LeadInspectorProvider', () => {
  it('opens one global complementary panel for a selected person', async () => {
    const api = createApi([kevin, dana]);
    render(
      <LeadInspectorProvider api={api}>
        <Harness />
      </LeadInspectorProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' }));

    expect(
      await screen.findByRole('complementary', { name: 'Kevin Shin details' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByTestId('selected-person').textContent).toBe('person-kevin');
  });

  it('replaces the current selection instead of stacking inspectors', async () => {
    const api = createApi([kevin, dana]);
    render(
      <LeadInspectorProvider api={api}>
        <Harness />
      </LeadInspectorProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' }));
    await screen.findByRole('complementary', { name: 'Kevin Shin details' });
    fireEvent.click(screen.getByRole('button', { name: 'Open Dana Whitman' }));
    await screen.findByRole('complementary', { name: 'Dana Whitman details' });

    expect(screen.getAllByRole('complementary')).toHaveLength(1);
    expect(
      screen.queryByRole('complementary', { name: 'Kevin Shin details' }),
    ).toBeNull();
    expect(screen.getByTestId('selected-person').textContent).toBe('person-dana');
  });

  it('ignores stale responses after the selection changes', async () => {
    const pending = new Map<string, (detail: LeadDetail) => void>();
    const api = {
      get: vi.fn(
        ({ personId }: { personId: string }) =>
          new Promise<LeadDetail>((resolve) => {
            pending.set(personId, resolve);
          }),
      ),
      beginOutbound: vi.fn(async () => receipt),
      confirmTransition: vi.fn(async () => receipt),
      dismissLead: vi.fn(async () => receipt),
      overrideCloudScore: vi.fn(async () => receipt),
    };
    render(
      <LeadInspectorProvider api={api}>
        <Harness />
      </LeadInspectorProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Dana Whitman' }));
    await act(async () => {
      pending.get('person-dana')?.(dana);
    });
    await screen.findByRole('complementary', { name: 'Dana Whitman details' });
    await act(async () => {
      pending.get('person-kevin')?.(kevin);
    });

    expect(
      screen.queryByRole('complementary', { name: 'Kevin Shin details' }),
    ).toBeNull();
    expect(
      screen.getByRole('complementary', { name: 'Dana Whitman details' }),
    ).toBeTruthy();
  });

  it('closes the inspector through closeLead', async () => {
    const api = createApi([kevin, dana]);
    render(
      <LeadInspectorProvider api={api}>
        <Harness />
      </LeadInspectorProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' }));
    await screen.findByRole('complementary', { name: 'Kevin Shin details' });
    fireEvent.click(screen.getByRole('button', { name: 'Close lead' }));

    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.getByTestId('selected-person').textContent).toBe('none');
  });

  it('opens the full page from the inspector without refetching the DTO', async () => {
    const api = createApi([kevin, dana]);
    render(
      <LeadInspectorProvider api={api}>
        <Harness />
      </LeadInspectorProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' }));
    await screen.findByRole('complementary', { name: 'Kevin Shin details' });
    fireEvent.click(screen.getByRole('button', { name: 'Open full page' }));

    expect(
      await screen.findByRole('article', { name: 'Kevin Shin full page' }),
    ).toBeTruthy();
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('loads the full page directly when nothing is selected', async () => {
    const api = createApi([kevin, dana]);
    render(
      <LeadInspectorProvider api={api}>
        <Harness />
      </LeadInspectorProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Kevin full page' }));

    expect(
      await screen.findByRole('article', { name: 'Kevin Shin full page' }),
    ).toBeTruthy();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('shows a safe error state and retries the fetch', async () => {
    const api = createApi([kevin, dana]);
    api.get.mockRejectedValueOnce(new Error('database exploded at /private/path'));
    render(
      <LeadInspectorProvider api={api}>
        <Harness />
      </LeadInspectorProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' }));
    const alert = await screen.findByRole('alert');

    expect(alert.textContent).not.toContain('database exploded');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('complementary', { name: 'Kevin Shin details' });
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('rejects useLeadInspector outside of the provider', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => render(<Harness />)).toThrow('LeadInspectorProvider');

    errorSpy.mockRestore();
  });

  it('advances to the next lead after Mark ready using the registered order', async () => {
    const api = createApi([kevin, dana]);
    render(
      <LeadInspectorProvider api={api}>
        <Harness />
      </LeadInspectorProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Register advance' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' }));
    await screen.findByRole('complementary', { name: 'Kevin Shin details' });

    fireEvent.click(screen.getByRole('button', { name: 'Mark ready' }));

    await screen.findByRole('complementary', { name: 'Dana Whitman details' });
    expect(api.confirmTransition).toHaveBeenCalledWith({
      transition: 'review_to_ready',
      salesCycleId: 'cycle-kevin',
      expectedRevision: 4,
    });
    expect(screen.getByTestId('selected-person').textContent).toBe('person-dana');
  });

  it('advances to the next lead after a dismissal', async () => {
    const api = createApi([kevin, dana]);
    render(
      <LeadInspectorProvider api={api}>
        <Harness />
      </LeadInspectorProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Register advance' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' }));
    await screen.findByRole('complementary', { name: 'Kevin Shin details' });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm dismiss' }));

    await screen.findByRole('complementary', { name: 'Dana Whitman details' });
    expect(api.dismissLead).toHaveBeenCalledWith({
      salesCycleId: 'cycle-kevin',
      personId: 'person-kevin',
      qualificationGateReason: 'out_of_area',
      expectedRevision: 4,
    });
  });

  it('closes after reviewing the last lead in the registered order', async () => {
    const api = createApi([kevin, dana]);
    render(
      <LeadInspectorProvider api={api}>
        <Harness />
      </LeadInspectorProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Register advance' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Dana Whitman' }));
    await screen.findByRole('complementary', { name: 'Dana Whitman details' });

    fireEvent.click(screen.getByRole('button', { name: 'Mark ready' }));

    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
  });

  it('closes after a dismissal when no list registered an order', async () => {
    const api = createApi([kevin, dana]);
    render(
      <LeadInspectorProvider api={api}>
        <Harness />
      </LeadInspectorProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' }));
    await screen.findByRole('complementary', { name: 'Kevin Shin details' });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm dismiss' }));

    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
  });
});
