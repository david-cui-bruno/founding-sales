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
    segment: 'hot_frbo',
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

  it('clamps a too-small persisted width up to the minimum', async () => {
    window.localStorage.setItem(WIDTH_KEY, '10');
    const inspector = await renderInspector(createApi(detailFor()));

    expect(inspector.getAttribute('style')).toContain('380px');
  });

  it('resizes with an accessible separator and persists the clamped width', async () => {
    await renderInspector(createApi(detailFor()));

    const separator = screen.getByRole('separator', { name: 'Resize inspector' });
    expect(separator.getAttribute('aria-valuemin')).toBe('380');
    expect(separator.getAttribute('aria-valuemax')).toBe('640');

    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    const widened = Number(separator.getAttribute('aria-valuenow'));
    expect(widened).toBeGreaterThan(420);
    expect(window.localStorage.getItem(WIDTH_KEY)).toBe(String(widened));

    for (let i = 0; i < 40; i += 1) {
      fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    }
    expect(separator.getAttribute('aria-valuenow')).toBe('640');
    expect(window.localStorage.getItem(WIDTH_KEY)).toBe('640');

    for (let i = 0; i < 40; i += 1) {
      fireEvent.keyDown(separator, { key: 'ArrowRight' });
    }
    expect(separator.getAttribute('aria-valuenow')).toBe('380');
    expect(window.localStorage.getItem(WIDTH_KEY)).toBe('380');
  });

  it('shows separate Fit and Timing explanations that are never combined', async () => {
    const inspector = await renderInspector(createApi(detailFor()));

    const fit = within(inspector).getByRole('region', { name: 'Fit' });
    const timing = within(inspector).getByRole('region', { name: 'Timing' });
    expect(fit.textContent).toContain('22/30');
    expect(fit.textContent).toContain('high');
    expect(timing.textContent).toContain('31/40');
    expect(timing.textContent).toContain('hot');
    expect(fit.textContent).not.toContain('31/40');
    expect(timing.textContent).not.toContain('22/30');
    expect(inspector.textContent).not.toMatch(/combined|overall score|lead score/i);

    expect(within(inspector).getByText('Reachability')).toBeTruthy();
    expect(within(inspector).getByText('direct')).toBeTruthy();
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

  it('moves between tabs with arrow keys and renders each section', async () => {
    const inspector = await renderInspector(createApi(detailFor()));

    const overviewTab = within(inspector).getByRole('tab', { name: 'Overview' });
    expect(overviewTab.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(overviewTab, { key: 'ArrowRight' });
    const activityTab = within(inspector).getByRole('tab', { name: 'Activity' });
    expect(activityTab.getAttribute('aria-selected')).toBe('true');
    expect(
      within(inspector).getByText('Left voicemail about 12 Benefit St'),
    ).toBeTruthy();

    fireEvent.keyDown(activityTab, { key: 'ArrowRight' });
    expect(
      within(inspector)
        .getByRole('tab', { name: 'Conversations' })
        .getAttribute('aria-selected'),
    ).toBe('true');
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

  it('confirms the guarded review transition with the expected revision', async () => {
    const api = createApi(detailFor());
    const inspector = await renderInspector(api);

    fireEvent.click(
      within(inspector).getByRole('button', { name: 'Confirm ready' }),
    );

    expect(api.confirmTransition).toHaveBeenCalledWith({
      transition: 'review_to_ready',
      salesCycleId: 'cycle-kevin',
      expectedRevision: 4,
    });
  });
});
