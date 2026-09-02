// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  leadDetailSchema,
  type LeadDetail,
} from '../../../shared/contracts/leadDetailContract';
import { LeadInspectorProvider } from './LeadInspectorProvider';
import { useLeadInspector } from './useLeadInspector';

const WIDTH_KEY = 'callie.inspector.width';

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
      { id: 'phone-1', kind: 'phone', value: '+14015550100', label: null, valid: true, dncListed: false, tcpaFlag: false },
    ],
    emails: [
      { id: 'email-1', kind: 'email', value: 'kevin@example.com', label: null, valid: true, dncListed: false, tcpaFlag: false },
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
    priorityReasons: ['Owner of 3+ doors', 'Live vacancy posted this week'],
    cloudScores: null,
    nextAction: {
      id: 'action-1',
      type: 'review_lead',
      channel: 'review',
      label: 'Review lead',
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
        markedInError: false,
      },
    ],
    conversations: [
      {
        id: 'conv-1',
        occurredAt: '2026-08-29T15:00:00.000Z',
        durationSeconds: 340,
        recordingAvailable: true,
        transcriptAvailable: false,
        reviewCount: 0,
      },
    ],
    properties: [
      {
        id: 'prop-1',
        address: '12 Benefit St, Providence',
        doors: 6,
        ownershipEvidence: 'Registry deed match',
        liveVacancy: true,
      },
    ],
    history: [
      {
        id: 'hist-1',
        occurredAt: '2026-08-28T15:00:00.000Z',
        label: 'Ready',
        detail: 'manual',
      },
    ],
    revision: 4,
    ...overrides,
  });

function createApi(detail: LeadDetail) {
  return {
    get: vi.fn(async () => detail),
    beginOutbound: vi.fn(async () => receipt),
    confirmTransition: vi.fn(async () => receipt),
    dismissLead: vi.fn(async () => receipt),
    overrideCloudScore: vi.fn(async () => receipt),
  };
}

type Api = ReturnType<typeof createApi>;

function OpenButton() {
  const inspector = useLeadInspector();

  return (
    <button type="button" onClick={() => inspector.openLead('person-kevin')}>
      Open lead
    </button>
  );
}

async function renderInspector(api: Api) {
  render(
    <LeadInspectorProvider api={api}>
      <OpenButton />
    </LeadInspectorProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open lead' }));
  return screen.findByRole('complementary');
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('LeadInspector', () => {
  it('clamps persisted width and closes on Escape', async () => {
    window.localStorage.setItem(WIDTH_KEY, '9999');
    const inspector = await renderInspector(createApi(detailFor()));

    expect(inspector.getAttribute('style')).toContain('640px');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('clamps a too-small persisted width up to the readable minimum', async () => {
    window.localStorage.setItem(WIDTH_KEY, '10');
    const inspector = await renderInspector(createApi(detailFor()));

    expect(inspector.getAttribute('style')).toContain('420px');
  });

  it('resizes with an accessible separator and persists the clamped width', async () => {
    await renderInspector(createApi(detailFor()));

    const separator = screen.getByRole('separator', { name: 'Resize inspector' });
    expect(separator.getAttribute('aria-valuemin')).toBe('420');
    expect(separator.getAttribute('aria-valuemax')).toBe('640');

    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    const widened = Number(separator.getAttribute('aria-valuenow'));
    expect(widened).toBeGreaterThan(460);
    expect(window.localStorage.getItem(WIDTH_KEY)).toBe(String(widened));

    for (let i = 0; i < 40; i += 1) {
      fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    }
    expect(separator.getAttribute('aria-valuenow')).toBe('640');
    expect(window.localStorage.getItem(WIDTH_KEY)).toBe('640');

    for (let i = 0; i < 40; i += 1) {
      fireEvent.keyDown(separator, { key: 'ArrowRight' });
    }
    expect(separator.getAttribute('aria-valuenow')).toBe('420');
    expect(window.localStorage.getItem(WIDTH_KEY)).toBe('420');
  });

  it('shows separate Fit and Timing explanations that are never combined', async () => {
    const inspector = await renderInspector(createApi(detailFor()));

    const fit = within(inspector).getByRole('region', { name: 'Fit' });
    const timing = within(inspector).getByRole('region', { name: 'Timing' });
    expect(fit.textContent).toContain('22/30');
    expect(fit.textContent).toContain('High');
    expect(timing.textContent).toContain('31/40');
    expect(timing.textContent).toContain('Hot');
    expect(fit.textContent).not.toContain('31/40');
    expect(timing.textContent).not.toContain('22/30');
    expect(inspector.textContent).not.toMatch(/combined|overall score|lead score/i);

    expect(within(inspector).getByText('Reachability')).toBeTruthy();
    expect(within(inspector).getByText('Direct')).toBeTruthy();
    expect(within(inspector).getByText('Owner of 3+ doors')).toBeTruthy();
    expect(within(inspector).getByText(/FRBO warm/)).toBeTruthy();
    expect(within(inspector).getByText('Review lead')).toBeTruthy();
  });

  it('begins outbound touches through the injected API', async () => {
    const api = createApi(detailFor());
    const inspector = await renderInspector(api);

    fireEvent.click(within(inspector).getByRole('button', { name: 'Call +14015550100' }));
    expect(api.beginOutbound).toHaveBeenCalledWith({
      channel: 'call',
      personId: 'person-kevin',
      salesCycleId: 'cycle-kevin',
      contactMethodId: 'phone-1',
    });

    fireEvent.click(within(inspector).getByRole('button', { name: 'Text +14015550100' }));
    expect(api.beginOutbound).toHaveBeenCalledWith({
      channel: 'text',
      personId: 'person-kevin',
      salesCycleId: 'cycle-kevin',
      contactMethodId: 'phone-1',
    });

    fireEvent.click(
      within(inspector).getByRole('button', { name: 'Email kevin@example.com' }),
    );
    expect(api.beginOutbound).toHaveBeenCalledWith({
      channel: 'email',
      personId: 'person-kevin',
      salesCycleId: 'cycle-kevin',
      contactMethodId: 'email-1',
    });
  });

  it('hard-disables call, text, and email with a visible reason when opted out', async () => {
    const api = createApi(detailFor({ optedOut: true }));
    const inspector = await renderInspector(api);

    const call = within(inspector).getByRole('button', { name: 'Call +14015550100' });
    const text = within(inspector).getByRole('button', { name: 'Text +14015550100' });
    const email = within(inspector).getByRole('button', {
      name: 'Email kevin@example.com',
    });
    expect((call as HTMLButtonElement).disabled).toBe(true);
    expect((text as HTMLButtonElement).disabled).toBe(true);
    expect((email as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(call);
    expect(api.beginOutbound).not.toHaveBeenCalled();

    expect(
      within(inspector).getByText(
        'This person opted out. Outreach is permanently disabled.',
      ),
    ).toBeTruthy();
  });

  it('shows a DNC badge and disables call/text for a flagged phone', async () => {
    const api = createApi(detailFor({
      phones: [
        { id: 'phone-1', kind: 'phone', value: '+14015550100', label: null, valid: true, dncListed: true, tcpaFlag: false },
        { id: 'phone-2', kind: 'phone', value: '+14015550199', label: null, valid: true, dncListed: false, tcpaFlag: false },
      ],
    }));
    const inspector = await renderInspector(api);

    const call = within(inspector).getByRole('button', { name: 'Call +14015550100' });
    const text = within(inspector).getByRole('button', { name: 'Text +14015550100' });
    expect((call as HTMLButtonElement).disabled).toBe(true);
    expect((text as HTMLButtonElement).disabled).toBe(true);
    expect(within(inspector).getByText('DNC')).toBeTruthy();

    fireEvent.click(call);
    expect(api.beginOutbound).not.toHaveBeenCalled();

    // The unflagged phone stays dialable.
    const cleanCall = within(inspector).getByRole('button', { name: 'Call +14015550199' });
    expect((cleanCall as HTMLButtonElement).disabled).toBe(false);
  });

  it('moves between tabs with arrow keys and renders each section', async () => {
    const inspector = await renderInspector(createApi(detailFor()));

    const overviewTab = within(inspector).getByRole('tab', { name: 'Overview' });
    expect(overviewTab.getAttribute('aria-selected')).toBe('true');
    // Exactly four tabs so the tablist fits 420px without horizontal scroll.
    expect(within(inspector).getAllByRole('tab')).toHaveLength(4);
    expect(
      within(inspector).queryByRole('tab', { name: 'Conversations' }),
    ).toBeNull();

    fireEvent.keyDown(overviewTab, { key: 'ArrowRight' });
    const activityTab = within(inspector).getByRole('tab', { name: 'Activity' });
    expect(activityTab.getAttribute('aria-selected')).toBe('true');
    expect(
      within(inspector).getByText('Left voicemail about 12 Benefit St'),
    ).toBeTruthy();
    // Conversations render inside Activity as a labelled subsection.
    expect(
      within(inspector).getByRole('region', { name: 'Conversations' }),
    ).toBeTruthy();
    expect(within(inspector).getByText('5m 40s')).toBeTruthy();

    fireEvent.click(within(inspector).getByRole('tab', { name: 'Properties' }));
    expect(within(inspector).getByText('12 Benefit St, Providence')).toBeTruthy();
    expect(within(inspector).getByText('Registry deed match')).toBeTruthy();

    fireEvent.click(within(inspector).getByRole('tab', { name: 'History' }));
    expect(within(inspector).getByText('Ready')).toBeTruthy();

    const historyTab = within(inspector).getByRole('tab', { name: 'History' });
    fireEvent.keyDown(historyTab, { key: 'ArrowRight' });
    expect(
      within(inspector)
        .getByRole('tab', { name: 'Overview' })
        .getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('hides the Conversations subsection when there are none', async () => {
    const inspector = await renderInspector(
      createApi(detailFor({ conversations: [] })),
    );

    fireEvent.click(within(inspector).getByRole('tab', { name: 'Activity' }));
    expect(
      within(inspector).queryByRole('region', { name: 'Conversations' }),
    ).toBeNull();
  });

  it('confirms the guarded review transition with the expected revision', async () => {
    const api = createApi(detailFor());
    const inspector = await renderInspector(api);

    const review = within(inspector).getByRole('region', {
      name: 'Review this lead',
    });
    fireEvent.click(within(review).getByRole('button', { name: 'Mark ready' }));

    expect(api.confirmTransition).toHaveBeenCalledWith({
      transition: 'review_to_ready',
      salesCycleId: 'cycle-kevin',
      expectedRevision: 4,
    });
  });

  it('dismisses through the gate-reason select in the review section', async () => {
    const api = createApi(detailFor());
    const inspector = await renderInspector(api);

    const review = within(inspector).getByRole('region', {
      name: 'Review this lead',
    });
    fireEvent.click(within(review).getByRole('button', { name: 'Dismiss' }));

    const reason = within(review).getByRole('combobox', {
      name: 'Dismissal reason',
    });
    fireEvent.click(reason);
    fireEvent.click(
      within(review).getByRole('option', { name: 'Institutional, outside ICP' }),
    );
    fireEvent.click(
      within(review).getByRole('button', { name: 'Confirm dismiss' }),
    );

    expect(api.dismissLead).toHaveBeenCalledWith({
      salesCycleId: 'cycle-kevin',
      personId: 'person-kevin',
      qualificationGateReason: 'institutional_outside_icp',
      expectedRevision: 4,
    });
  });

  it('shows no review section for an already-reviewed lead', async () => {
    const inspector = await renderInspector(
      createApi(detailFor({ stage: 'ready' })),
    );

    expect(
      within(inspector).queryByRole('region', { name: 'Review this lead' }),
    ).toBeNull();
    expect(
      within(inspector).queryByRole('button', { name: 'Mark ready' }),
    ).toBeNull();
  });

  it('shows the cloud chip with labelled top reasons and logs overrides', async () => {
    const api = createApi(detailFor({
      cloudScores: {
        scores: { fit: 62, timing: 41 },
        reasons: [
          { signal: 'portfolio_in_band', contribution: 15 },
          { signal: 'permit_filed_recent', contribution: 12 },
          { signal: 'pre_1940_stock', contribution: 8 },
        ],
        scoredAt: '2026-08-31T15:00:00.000Z',
      },
    }));
    const inspector = await renderInspector(api);

    // The chip keeps the two axes separate; never one blended number.
    expect(within(inspector).getByText('Fit 62 · Timing 41')).toBeTruthy();
    const reasons = within(inspector).getByRole('list', { name: 'Top cloud signals' });
    expect(within(reasons).getAllByRole('listitem').map((item) => item.textContent))
      .toEqual([
        'Portfolio in target band +15',
        'Permit filed recently +12',
        'Pre-1940 housing stock +8',
      ]);
    // The overrides read as feedback: the training explainer sits with them.
    expect(within(inspector).getByText('Feedback trains scoring')).toBeTruthy();

    fireEvent.click(within(inspector).getByRole('button', { name: 'Wrong signal' }));
    expect(api.overrideCloudScore).toHaveBeenCalledWith({
      personId: 'person-kevin',
      direction: 'down',
    });

    fireEvent.click(within(inspector).getByRole('button', { name: 'Signal too low' }));
    expect(api.overrideCloudScore).toHaveBeenCalledWith({
      personId: 'person-kevin',
      direction: 'up',
    });
  });

  it('drops the +0 suffix for a zero-contribution signal', async () => {
    const inspector = await renderInspector(createApi(detailFor({
      cloudScores: {
        scores: { fit: 0, timing: 0 },
        reasons: [{ signal: 'no_signals', contribution: 0 }],
        scoredAt: '2026-08-31T15:00:00.000Z',
      },
    })));

    const reasons = within(inspector).getByRole('list', { name: 'Top cloud signals' });
    const item = within(reasons).getByRole('listitem');
    expect(item.textContent).toBe('No active signals');
    expect(item.textContent).not.toContain('+0');
    expect(item.className).toContain('lead-inspector__cloud-reason--muted');
  });

  it('renders no cloud section for an unscored lead', async () => {
    const inspector = await renderInspector(createApi(detailFor()));

    expect(within(inspector).queryByText(/Fit \d+ · Timing \d+/)).toBeNull();
    expect(within(inspector).queryByRole('button', { name: 'Wrong signal' })).toBeNull();
  });
});
