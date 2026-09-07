// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { discoveryBriefSchema, type DiscoveryApi, type DiscoveryBrief } from '../../../shared/contracts/discoveryContract';
import {
  leadDetailSchema,
  type ContactMethod,
  type LeadDetail,
} from '../../../shared/contracts/leadDetailContract';
import type { OutboundRequest, OutboundReceipt, OutboundCapabilities } from '../../../shared/contracts/outboundContract';
import { LeadInspectorProvider } from './LeadInspectorProvider';
import { useLeadInspector } from './useLeadInspector';

const unavailable = { state: 'unavailable', reasonCode: 'not_integrated' } as const;
const capabilities: OutboundCapabilities = { phoneHandoff: { state: 'available', reasonCode: null }, callObservation: unavailable, recording: unavailable, messagesSend: unavailable, gmailSend: unavailable, managedAudioImport: unavailable, appleTranscriptExtraction: unavailable, localDrafts: true };

const receipt = {
  revision: 9,
  affectedPersonIds: ['person-kevin'],
  affectedSalesCycleIds: ['cycle-kevin'],
};

const legacyContactEvidence: Pick<ContactMethod,
  'contactSnapshot' | 'validationState' | 'reachability' | 'sourceLabel' | 'vendorRank' |
  'phoneKind' | 'ownershipState' | 'evidenceObservedAt'> = {
  contactSnapshot: 'a'.repeat(64),
  validationState: 'valid', reachability: 'none', sourceLabel: null, vendorRank: null,
  phoneKind: null, ownershipState: 'unknown', evidenceObservedAt: null,
};

const detailFor = (overrides: Partial<LeadDetail> = {}): LeadDetail =>
  leadDetailSchema.parse({
    personId: 'person-kevin',
    salesCycleId: 'cycle-kevin',
    personName: 'Kevin Shin',
    phones: [
      { id: 'phone-1', kind: 'phone', value: '+14015550100', label: null, valid: true, ...legacyContactEvidence, compliance: { status: 'verified_clear', label: 'Verified clear until Sep 15, 2026', expiresAt: '2026-09-15T00:00:00.000Z', callRefusalReason: null, textRefusalReason: null } },
    ],
    emails: [
      { id: 'email-1', kind: 'email', value: 'kevin@example.com', label: null, valid: true, ...legacyContactEvidence, compliance: null },
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
    cloudLinked: false,
    findContactEligibility: { eligible: false, refusalReason: 'qualification_required' },
    nextAction: {
      id: 'action-1',
      type: 'review_lead',
      channel: 'review',
      label: 'Review lead',
    },
    optedOut: false,
    cadence: { name: 'FRBO warm', stepLabel: 'Call 1', touchIndex: 1, touchLimit: 4 },
    outboundAttempts: [],
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
    beginOutbound: vi.fn(async (request: OutboundRequest): Promise<OutboundReceipt> => ({ commandId: request.commandId, channel: request.channel, status: 'handoff_accepted', reasonCode: null, mutation: receipt })),
    getOutboundCapabilities: vi.fn(async () => capabilities),
    confirmTransition: vi.fn(async () => receipt),
    dismissLead: vi.fn(async () => receipt),
    overrideCloudScore: vi.fn(async () => receipt),
    findContactInfo: vi.fn(async () => ({ written: false, refusalReason: null })),
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
  vi.useRealTimers();
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
      beginOutbound: vi.fn(async (request: OutboundRequest): Promise<OutboundReceipt> => ({ commandId: request.commandId, channel: request.channel, status: 'handoff_accepted', reasonCode: null, mutation: receipt })),
    getOutboundCapabilities: vi.fn(async () => capabilities),
      confirmTransition: vi.fn(async () => receipt),
      dismissLead: vi.fn(async () => receipt),
      overrideCloudScore: vi.fn(async () => receipt),
    findContactInfo: vi.fn(async () => ({ written: false, refusalReason: null })),
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

  async function openCall() {
    fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' }));
    await screen.findByRole('complementary', { name: 'Kevin Shin details' });
    fireEvent.click(screen.getByRole('button', { name: 'Call +14015550100' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open Phone' }));
  }

  it('synchronously excludes duplicate confirmation and retains one UUID through pending and unknown', async () => {
    const api = createApi([kevin]);
    let resolve!: (receipt: OutboundReceipt) => void;
    api.beginOutbound.mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<LeadInspectorProvider api={api}><Harness /></LeadInspectorProvider>);
    await openCall();
    const submit = screen.getByRole('button', { name: 'Open Phone' });
    fireEvent.click(submit); fireEvent.click(submit);
    expect(api.beginOutbound).toHaveBeenCalledTimes(1);
    const request = api.beginOutbound.mock.calls[0][0];
    expect(request).toEqual({ commandId: expect.stringMatching(/^[a-f0-9-]{36}$/), channel: 'call', personId: kevin.personId,
      salesCycleId: kevin.salesCycleId, contactMethodId: 'phone-1', expectedContactSnapshot: 'a'.repeat(64) });
    api.get.mockResolvedValueOnce(detailFor({ outboundAttempts: [{ commandId: request.commandId, channel: 'call', contactMethodId: 'phone-1', requestedAt: '2026-09-06T15:00:00.000Z', manualActivityId: null, status: 'handoff_accepted', reasonCode: null }] }));
    await act(async () => resolve({ commandId: request.commandId, channel: 'call', status: 'unknown', reasonCode: 'handoff_uncertain', mutation: receipt }));
    expect(await screen.findByText('Phone handoff unknown. Do not retry.')).toBeTruthy();
    expect(screen.queryByText('Phone handoff accepted. Call outcome unverified.')).toBeNull();
    expect(api.get).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Call +14015550100' }));
    expect(screen.queryByRole('button', { name: 'Open Phone' })).toBeNull();
    expect(api.beginOutbound).toHaveBeenCalledTimes(1);
    expect(screen.getByText(request.commandId)).toBeTruthy();
  });

  it('keeps receipt visible independently while same-Person detail refresh is pending', async () => {
    const api = createApi([kevin]);
    render(<LeadInspectorProvider api={api}><Harness /></LeadInspectorProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' }));
    await screen.findByRole('complementary', { name: 'Kevin Shin details' });
    api.get.mockImplementationOnce(() => new Promise(() => undefined));
    fireEvent.click(screen.getByRole('button', { name: 'Call +14015550100' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Phone' }));
    expect(await screen.findByText('Phone handoff accepted. Call outcome unverified.')).toBeTruthy();
    expect(screen.getByText('Loading lead details')).toBeTruthy();
  });

  it('isolates late A receipt and refresh from B selection and draft', async () => {
    const api = createApi([kevin, dana]);
    let resolve!: (receipt: OutboundReceipt) => void;
    api.beginOutbound.mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<LeadInspectorProvider api={api}><Harness /></LeadInspectorProvider>);
    await openCall();
    const request = api.beginOutbound.mock.calls[0][0];
    fireEvent.click(screen.getByRole('button', { name: 'Open Dana Whitman' }));
    await screen.findByRole('complementary', { name: 'Dana Whitman details' });
    fireEvent.click(screen.getByRole('button', { name: 'Text +14015550100' }));
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Dana draft' } });
    await act(async () => resolve({ commandId: request.commandId, channel: 'call', status: 'unknown', reasonCode: 'handoff_uncertain', mutation: receipt }));
    expect(screen.getByTestId('selected-person').textContent).toBe(dana.personId);
    expect(screen.queryByText(request.commandId)).toBeNull();
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Dana draft');
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('renders fixed transport uncertainty without retrying or displaying raw error', async () => {
    const api = createApi([kevin]);
    api.beginOutbound.mockRejectedValueOnce(new Error('private transport details'));
    render(<LeadInspectorProvider api={api}><Harness /></LeadInspectorProvider>);
    await openCall();
    expect(await screen.findByText('Phone handoff response unavailable. Execution is unknown. Do not retry.')).toBeTruthy();
    expect(screen.queryByText(/private transport/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Call +14015550100' }));
    expect(screen.queryByRole('button', { name: 'Open Phone' })).toBeNull();
    expect(api.beginOutbound).toHaveBeenCalledTimes(1);
  });

  it('retains live transport uncertainty over a deferred accepted refresh and requests manual association explicitly', async () => {
    const api = createApi([kevin]);
    let resolveDetail!: (detail: LeadDetail) => void;
    api.get.mockResolvedValueOnce(kevin).mockImplementationOnce(() => new Promise((resolve) => { resolveDetail = resolve; }));
    api.beginOutbound.mockRejectedValueOnce(new Error('private lost reply'));
    const outcomeApi = { logCallOutcome: vi.fn<(input: import('../../../shared/contracts/todayContract').LogCallOutcomeRequest) => Promise<typeof receipt>>(async () => receipt), addLeadNote: vi.fn(async () => receipt), get: vi.fn(async () => ({ lanes: [] } as never)) };
    render(<LeadInspectorProvider api={api} outcomeApi={outcomeApi}><Harness /></LeadInspectorProvider>);
    await openCall();
    expect(await screen.findByText('Phone handoff response unavailable. Execution is unknown. Do not retry.')).toBeTruthy();
    const request = api.beginOutbound.mock.calls[0][0];
    expect(request.commandId).toMatch(/^[a-f0-9-]{36}$/);
    expect(screen.getByText(request.commandId)).toBeTruthy();
    expect(screen.getByText('Loading lead details')).toBeTruthy();
    await act(async () => resolveDetail(detailFor({ outboundAttempts: [{ commandId: request.commandId, channel: 'call', contactMethodId: 'phone-1', requestedAt: '2026-09-06T15:00:00.000Z', manualActivityId: null, status: 'handoff_accepted', reasonCode: null }] })));

    expect(screen.queryByText('Phone handoff accepted. Call outcome unverified.')).toBeNull();
    expect(screen.getByText('Phone handoff response unavailable. Execution is unknown. Do not retry.')).toBeTruthy();
    expect(screen.getByText(request.commandId)).toBeTruthy();
    expect(screen.queryByText(/private lost reply/)).toBeNull();
    expect(api.get).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Call +14015550100' }));
    expect(screen.queryByRole('button', { name: 'Open Phone' })).toBeNull();
    expect(api.beginOutbound).toHaveBeenCalledTimes(1);
    expect(outcomeApi.logCallOutcome).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Log past activity' }));
    expect(await screen.findByRole('article', { name: 'Kevin Shin full page' })).toBeTruthy();
    expect(outcomeApi.logCallOutcome).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'No answer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save & next' }));
    await waitFor(() => expect(outcomeApi.logCallOutcome).toHaveBeenCalledTimes(1));
    expect(outcomeApi.logCallOutcome).toHaveBeenCalledWith(expect.objectContaining({ personId: kevin.personId, salesCycleId: kevin.salesCycleId, outboundCommandId: request.commandId, outcome: 'no_answer' }));
    expect(api.beginOutbound).toHaveBeenCalledTimes(1);
  });

  it('keeps live transport uncertainty beside refreshed manual evidence without another linked-write invitation', async () => {
    const api = createApi([kevin]);
    let resolveDetail!: (detail: LeadDetail) => void;
    api.get.mockResolvedValueOnce(kevin).mockImplementationOnce(() => new Promise((resolve) => { resolveDetail = resolve; }));
    api.beginOutbound.mockRejectedValueOnce(new Error('lost reply'));
    const outcomeApi = { logCallOutcome: vi.fn<(input: import('../../../shared/contracts/todayContract').LogCallOutcomeRequest) => Promise<typeof receipt>>(async () => receipt), addLeadNote: vi.fn(async () => receipt), get: vi.fn(async () => ({ lanes: [] } as never)) };
    render(<LeadInspectorProvider api={api} outcomeApi={outcomeApi}><Harness /></LeadInspectorProvider>);
    await openCall();
    await screen.findByText('Phone handoff response unavailable. Execution is unknown. Do not retry.');
    const request = api.beginOutbound.mock.calls[0][0];
    await act(async () => resolveDetail(detailFor({ outboundAttempts: [{ commandId: request.commandId, channel: 'call', contactMethodId: 'phone-1', requestedAt: '2026-09-06T15:00:00.000Z', manualActivityId: 'manual-activity', status: 'handoff_accepted', reasonCode: null }] })));

    expect(screen.queryByText('Phone handoff accepted. Call outcome unverified.')).toBeNull();
    expect(screen.getByText('Phone handoff response unavailable. Execution is unknown. Do not retry.')).toBeTruthy();
    expect(screen.getByText(request.commandId)).toBeTruthy();
    expect(screen.getByText('Manual evidence: manual-activity. This does not verify the handoff.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Log past activity' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Call +14015550100' }));
    expect(screen.queryByRole('button', { name: 'Open Phone' })).toBeNull();
    expect(api.beginOutbound).toHaveBeenCalledTimes(1);
    expect(outcomeApi.logCallOutcome).not.toHaveBeenCalled();
    expect(outcomeApi.addLeadNote).not.toHaveBeenCalled();
  });

  it.each([null, 'manual-activity'])('keeps cold accepted recovery truthful with manual evidence %s', async (manualActivityId) => {
    const commandId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const api = createApi([detailFor({ outboundAttempts: [{ commandId, channel: 'call', contactMethodId: 'phone-1', requestedAt: '2026-09-06T15:00:00.000Z', manualActivityId, status: 'handoff_accepted', reasonCode: null }] })]);
    render(<LeadInspectorProvider api={api}><Harness /></LeadInspectorProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' }));
    expect(await screen.findByText('Phone handoff accepted. Call outcome unverified.')).toBeTruthy();
    expect(screen.queryByText('Phone handoff response unavailable. Execution is unknown. Do not retry.')).toBeNull();
    expect(screen.getByText(commandId)).toBeTruthy();
    if (manualActivityId === null) {
      expect(screen.getByRole('button', { name: 'Log past activity' })).toBeTruthy();
    } else {
      expect(screen.getByText('Manual evidence: manual-activity. This does not verify the handoff.')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Log past activity' })).toBeNull();
    }
    expect(api.beginOutbound).not.toHaveBeenCalled();
  });

  it.each(['missing', 'refused'] as const)('keeps live transport uncertainty manual fallback unlinked with %s durable evidence', async (evidence) => {
    const api = createApi([kevin]);
    let resolveDetail!: (detail: LeadDetail) => void;
    api.get.mockResolvedValueOnce(kevin).mockImplementationOnce(() => new Promise((resolve) => { resolveDetail = resolve; }));
    api.beginOutbound.mockRejectedValueOnce(new Error('lost reply'));
    const outcomeApi = { logCallOutcome: vi.fn<(input: import('../../../shared/contracts/todayContract').LogCallOutcomeRequest) => Promise<typeof receipt>>(async () => receipt), addLeadNote: vi.fn(async () => receipt), get: vi.fn(async () => ({ lanes: [] } as never)) };
    render(<LeadInspectorProvider api={api} outcomeApi={outcomeApi}><Harness /></LeadInspectorProvider>);
    await openCall();
    await screen.findByText('Phone handoff response unavailable. Execution is unknown. Do not retry.');
    const request = api.beginOutbound.mock.calls[0][0];
    await act(async () => resolveDetail(detailFor({ outboundAttempts: evidence === 'missing' ? [] : [{ commandId: request.commandId, channel: 'call', contactMethodId: 'phone-1', requestedAt: '2026-09-06T15:00:00.000Z', manualActivityId: null, status: 'refused', reasonCode: 'federal_dnc_listed' }] })));
    expect(screen.getByText('Phone handoff response unavailable. Execution is unknown. Do not retry.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Log past activity' }));
    expect(await screen.findByRole('article', { name: 'Kevin Shin full page' })).toBeTruthy();
    expect(outcomeApi.logCallOutcome).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'No answer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save & next' }));
    await waitFor(() => expect(outcomeApi.logCallOutcome).toHaveBeenCalledTimes(1));
    expect(outcomeApi.logCallOutcome.mock.calls[0][0]).not.toHaveProperty('outboundCommandId');
    expect(api.beginOutbound).toHaveBeenCalledTimes(1);
  });

  it.each(['unavailable', 'failure'] as const)('fails closed for capability %s with manual fallback', async (mode) => {
    const api = createApi([kevin]);
    if (mode === 'failure') api.getOutboundCapabilities.mockRejectedValueOnce(new Error('capability failed'));
    else api.getOutboundCapabilities.mockResolvedValueOnce({ ...capabilities, phoneHandoff: { state: 'unavailable', reasonCode: 'inbound_safety_unwired' } });
    render(<LeadInspectorProvider api={api}><Harness /></LeadInspectorProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' }));
    await screen.findByRole('complementary', { name: 'Kevin Shin details' });
    fireEvent.click(screen.getByRole('button', { name: 'Call +14015550100' }));
    expect(screen.queryByRole('button', { name: 'Open Phone' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Log past activity' })).toBeTruthy();
    expect(api.beginOutbound).not.toHaveBeenCalled();
  });

  it('recovers durable unresolved attempt and explicitly opens linked manual form without saving', async () => {
    const commandId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const api = createApi([detailFor({ outboundAttempts: [{ commandId, channel: 'call', contactMethodId: 'phone-1', requestedAt: '2026-09-06T15:00:00.000Z', manualActivityId: null, status: 'unknown', reasonCode: 'handoff_uncertain' }] })]);
    const outcomeApi = { logCallOutcome: vi.fn<(input: import('../../../shared/contracts/todayContract').LogCallOutcomeRequest) => Promise<typeof receipt>>(async () => receipt), addLeadNote: vi.fn(async () => receipt), get: vi.fn(async () => ({ lanes: [] } as never)) };
    render(<LeadInspectorProvider api={api} outcomeApi={outcomeApi}><Harness /></LeadInspectorProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' }));
    await screen.findByText('Phone handoff unknown. Do not retry.');
    fireEvent.click(screen.getByRole('button', { name: 'Log past activity' }));
    expect(await screen.findByRole('article', { name: 'Kevin Shin full page' })).toBeTruthy();
    expect(outcomeApi.logCallOutcome).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'No answer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save & next' }));
    await waitFor(() => expect(outcomeApi.logCallOutcome).toHaveBeenCalledWith(expect.objectContaining({ personId: kevin.personId, salesCycleId: kevin.salesCycleId, outboundCommandId: commandId, outcome: 'no_answer' })));
    expect(api.beginOutbound).not.toHaveBeenCalled();
  });

  it('displays existing manual evidence without inviting another linked write', async () => {
    const api = createApi([detailFor({ outboundAttempts: [{ commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', channel: 'call', contactMethodId: 'phone-1', requestedAt: '2026-09-06T15:00:00.000Z', manualActivityId: 'manual-activity', status: 'unknown', reasonCode: 'handoff_uncertain' }] })]);
    render(<LeadInspectorProvider api={api}><Harness /></LeadInspectorProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' }));
    await screen.findByText(/Manual evidence: manual-activity/);
    expect(screen.getByText('Phone handoff unknown. Do not retry.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Log past activity' })).toBeNull();
    expect(api.beginOutbound).not.toHaveBeenCalled();
  });

  it('keeps recovered refusal manual fallback unlinked', async () => {
    const api = createApi([detailFor({ outboundAttempts: [{ commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', channel: 'call', contactMethodId: 'phone-1', requestedAt: '2026-09-06T15:00:00.000Z', manualActivityId: null, status: 'refused', reasonCode: 'federal_dnc_listed' }] })]);
    const outcomeApi = { logCallOutcome: vi.fn<(input: import('../../../shared/contracts/todayContract').LogCallOutcomeRequest) => Promise<typeof receipt>>(async () => receipt), addLeadNote: vi.fn(async () => receipt), get: vi.fn(async () => ({ lanes: [] } as never)) };
    render(<LeadInspectorProvider api={api} outcomeApi={outcomeApi}><Harness /></LeadInspectorProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' }));
    await screen.findByText('Phone handoff refused.');
    fireEvent.click(screen.getByRole('button', { name: 'Log past activity' }));
    fireEvent.click(screen.getByRole('button', { name: 'No answer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save & next' }));
    await waitFor(() => expect(outcomeApi.logCallOutcome).toHaveBeenCalledTimes(1));
    expect(vi.mocked(outcomeApi.logCallOutcome).mock.calls[0]?.[0]).not.toHaveProperty('outboundCommandId');
  });

  it('discards an unsent draft when changing Person and does not resurrect it on return', async () => {
    const api = createApi([kevin, dana]);
    render(<LeadInspectorProvider api={api}><Harness /></LeadInspectorProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' }));
    await screen.findByRole('complementary', { name: 'Kevin Shin details' });
    fireEvent.click(screen.getByRole('button', { name: 'Text +14015550100' }));
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Private unsent Kevin draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open Dana Whitman' }));
    await screen.findByRole('complementary', { name: 'Dana Whitman details' });
    expect(screen.queryByLabelText('Message')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' }));
    await screen.findByRole('complementary', { name: 'Kevin Shin details' });
    fireEvent.click(screen.getByRole('button', { name: 'Text +14015550100' }));
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('');
    expect(api.beginOutbound).not.toHaveBeenCalled();
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

it('injects owner-bound discovery evidence and ignores an older Person brief without changing the current draft', async () => {
  const api = createApi([kevin, dana]); let resolve!: (value: DiscoveryBrief) => void;
  const discoveryApi: DiscoveryApi = { get: vi.fn(), begin: vi.fn(), override: vi.fn(),
    getBrief: vi.fn<DiscoveryApi['getBrief']>(({ personId }) => personId === kevin.personId ? new Promise(done => { resolve = done; }) : Promise.resolve(discoveryBriefSchema.parse({ personId: dana.personId, salesCycleId: dana.salesCycleId, personName: dana.personName, assessment: null, stale: false, latestOverride: null, pilotNextStep: null }))) };
  render(<LeadInspectorProvider api={api} discoveryApi={discoveryApi}><Harness /></LeadInspectorProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' }));
  await screen.findByRole('complementary', { name: 'Kevin Shin details' });
  fireEvent.click(screen.getByRole('button', { name: 'Open Dana Whitman' }));
  const panel = await screen.findByRole('complementary', { name: 'Dana Whitman details' });
  expect(await within(panel).findByRole('region', { name: 'Discovery evidence for Dana Whitman' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Text +14015550100' }));
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Only in memory for Dana' } });
  await act(async () => resolve(discoveryBriefSchema.parse({ personId: kevin.personId, salesCycleId: kevin.salesCycleId, personName: kevin.personName, assessment: null, stale: false, latestOverride: null, pilotNextStep: null })));
  expect(screen.queryByRole('region', { name: 'Discovery evidence for Kevin Shin' })).toBeNull();
  expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Only in memory for Dana');
  expect(api.findContactInfo).not.toHaveBeenCalled(); expect(api.beginOutbound).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Mark ready' })).toBeNull();
  fireEvent.click(screen.getByText('Founder manual controls'));
  expect(screen.getByRole('button', { name: 'Mark ready' })).toBeTruthy();
});

it('logs an actual dated price communication into the real domain and separately confirms Offered using its owned activity ID', async () => {
  const { createTempDatabase, createTestWorkspaceKey } = await import('../../../../tests/fixtures/tempDatabase');
  const { openDatabase, closeDatabase } = await import('../../../main/db/database');
  const { migrateToLatest } = await import('../../../main/db/migrate');
  const { createDomainServices } = await import('../../../main/domain/createDomainServices');
  const { createFounderSalesDomain } = await import('../../../main/domain/founderSalesDomain');
  const { createLeadDetailService } = await import('../../../main/leads/leadDetailService');
  const { seedProspect } = await import('../../../../tests/fixtures/domainRows');
  const { BUILTIN_PRIORITIZATION_RULE_V1 } = await import('../../../main/domain/prioritization/builtinPrioritizationRules');
  const temp = createTempDatabase(); const key = createTestWorkspaceKey();
  const database = openDatabase({ path: temp.path, key });
  try {
    await migrateToLatest(database, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
    const clock = { now: () => '2026-09-06T15:00:00.000Z' }; let sequence = 0;
    const ids = { next: () => `task8-generated-${++sequence}` };
    const services = createDomainServices({ database, clock, ids });
    services.unitOfWork.immediate(() => {
      const rule = services.prioritizationRepository.installRuleVersion(BUILTIN_PRIORITIZATION_RULE_V1);
      services.prioritizationRepository.activateRuleVersion({ ruleVersionId: rule.id, expectedActiveRuleVersionId: null });
      services.cadences.installBuiltins();
    });
    const prospect = seedProspect(database.raw, 'person-kevin');
    database.raw.prepare("UPDATE prospects SET qualification_state = 'unreviewed' WHERE id = ?").run(prospect.prospectId);
    const enteredAt = '2026-08-30T12:00:00.000Z';
    const unreviewed = services.lifecycle.createUnreviewedCycle({ personId: prospect.personId, prospectId: prospect.prospectId, entrySourceEventId: prospect.sourceEventId, effectiveAt: enteredAt });
    const ready = services.lifecycle.reviewToReady({ cycleId: unreviewed.id, expectedCycleVersion: unreviewed.version, expectedProspectVersion: 1, effectiveAt: enteredAt });
    services.unitOfWork.immediate(() => services.events.appendActivity({ id: 'actual-interview', personId: prospect.personId, prospectId: prospect.prospectId, salesCycleId: ready.id, kind: 'interview', direction: 'outbound', channel: 'phone', occurredAt: enteredAt, observedOutcome: 'substantive', metadata: {} }));
    const interviewed = services.lifecycle.confirmInterviewed({ cycleId: ready.id, expectedCycleVersion: ready.version, expectedCurrentActionId: ready.currentNextActionId!, suggestionActivityId: 'actual-interview', effectiveAt: enteredAt, confirmedAt: enteredAt });
    const cycle = { cycleId: interviewed.id };
    const domain = createFounderSalesDomain({ database, services, clock, ids });
    const api = createLeadDetailService(domain);
    const confirm = vi.spyOn(api, 'confirmTransition'); const outbound = vi.spyOn(api, 'beginOutbound');
    const pastActivityApi = { logPastActivity: vi.fn(async (request: import('../../../shared/contracts/todayContract').LogPastActivityRequest) => domain.logPastActivity(request)) };
    const RealHarness = () => { const inspector = useLeadInspector(); return <button onClick={() => inspector.openFullPage(prospect.personId)}>Open real lead</button>; };
    render(<LeadInspectorProvider api={api} pastActivityApi={pastActivityApi}><RealHarness /></LeadInspectorProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Open real lead' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Log dated past activity' }));
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'I stated the $50 pilot price on our call.' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'I stated the price' }));
    fireEvent.click(screen.getByRole('button', { name: 'Log activity' }));
    await screen.findByText(/Past activity saved/);
    expect(confirm).not.toHaveBeenCalled(); expect(outbound).not.toHaveBeenCalled();
    expect(domain.getLeadDetail({ personId: prospect.personId }).stage).toBe('interviewed');
    const logged = domain.getLeadDetail({ personId: prospect.personId });
    const activity = logged.activities.find(entry => entry.outcome === 'price_said')!;
    expect(activity.occurredAt).toBe(new Date('2026-09-01T12:00:00').toISOString());
    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    const selection = await screen.findByRole('combobox', { name: 'Price-stated evidence' });
    fireEvent.click(selection); fireEvent.click(screen.getByRole('option', { name: new RegExp(activity.id) }));
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Offered' }));
    await waitFor(() => expect(domain.getLeadDetail({ personId: prospect.personId }).stage).toBe('offered'));
    expect(confirm).toHaveBeenCalledWith({ transition: 'confirm_offered', salesCycleId: cycle.cycleId, suggestionActivityId: activity.id, expectedRevision: logged.revision });
    expect(pastActivityApi.logPastActivity).toHaveBeenCalledTimes(1);
    expect(domain.getLeadDetail({ personId: prospect.personId }).stage).not.toBe('won');
  } finally { cleanup(); closeDatabase(database); temp.cleanup(); }
});

it('loads injected discovery evidence under StrictMode', async () => {
  const api = createApi([kevin]);
  const discoveryApi: DiscoveryApi = { get: vi.fn(), begin: vi.fn(), override: vi.fn(), getBrief: vi.fn(async () => discoveryBriefSchema.parse({ personId: kevin.personId, salesCycleId: kevin.salesCycleId, personName: kevin.personName, assessment: null, stale: false, latestOverride: null, pilotNextStep: null })) };
  render(<StrictMode><LeadInspectorProvider api={api} discoveryApi={discoveryApi}><Harness /></LeadInspectorProvider></StrictMode>);
  fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' }));
  expect(await screen.findByRole('region', { name: 'Discovery evidence for Kevin Shin' })).toBeTruthy();
});
it('preserves a successful log outside bounded history without inferring price activity IDs', async () => {
  const current = detailFor({ stage: 'interviewed', activities: [
    { id: 'internal-note', kind: 'note', occurredAt: '2026-09-01T12:00:00.000Z', summary: '$50', outcome: 'price_said', markedInError: false },
    { id: 'withdrawn-price', kind: 'call', occurredAt: '2026-09-01T12:00:00.000Z', summary: 'Retracted', outcome: 'price_said', markedInError: true },
  ] });
  const api = createApi([current]); const pastActivityApi = { logPastActivity: vi.fn(async () => receipt) };
  render(<LeadInspectorProvider api={api} pastActivityApi={pastActivityApi}><Harness /></LeadInspectorProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Open Kevin full page' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Log dated past activity' }));
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-08-01' } });
  fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'Actual older communication' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'I stated the price' }));
  fireEvent.click(screen.getByRole('button', { name: 'Log activity' }));
  await screen.findByText(/Past activity saved/);
  fireEvent.click(await screen.findByRole('tab', { name: 'Activity' }));
  expect((screen.getByRole('button', { name: 'Confirm Offered' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/No eligible evidence in recent Activity/)).toBeTruthy();
  expect(api.confirmTransition).not.toHaveBeenCalled(); expect(pastActivityApi.logPastActivity).toHaveBeenCalledTimes(1);
});
it('does not refresh a different Person or destroy their draft after late founder confirmation', async () => {
  const current = detailFor({ stage: 'interviewed', activities: [{ id: 'owned-price', kind: 'call', occurredAt: '2026-09-01T12:00:00.000Z', summary: 'Price stated', outcome: 'price_said', markedInError: false }] });
  const api = createApi([current, dana]); let resolve!: (value: typeof receipt) => void;
  api.confirmTransition.mockImplementation(() => new Promise(done => { resolve = done; }));
  render(<LeadInspectorProvider api={api}><Harness /></LeadInspectorProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' }));
  fireEvent.click(await screen.findByRole('tab', { name: 'Activity' }));
  fireEvent.click(screen.getByRole('combobox', { name: 'Price-stated evidence' }));
  fireEvent.click(screen.getByRole('option', { name: /owned-price/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm Offered' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open Dana Whitman' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Text +14015550100' }));
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Keep Dana draft' } });
  await act(async () => resolve(receipt));
  expect(api.get).toHaveBeenCalledTimes(2);
  expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Keep Dana draft');
});

it('preserves the Ready-to-Interviewed founder backfill rule with explicitly chosen actual conversation evidence', async () => {
  const current = detailFor({ stage: 'ready', activities: [{ id: 'actual-answer', kind: 'call', occurredAt: '2026-09-01T12:00:00.000Z', summary: 'Actual conversation', outcome: 'answered', markedInError: false }] });
  const api = createApi([current]); render(<LeadInspectorProvider api={api}><Harness /></LeadInspectorProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' }));
  fireEvent.click(await screen.findByRole('tab', { name: 'Activity' }));
  fireEvent.click(screen.getByRole('combobox', { name: 'Conversation evidence' }));
  fireEvent.click(screen.getByRole('option', { name: /actual-answer/ }));
  expect(api.confirmTransition).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm Interviewed' }));
  await waitFor(() => expect(api.confirmTransition).toHaveBeenCalledWith({ transition: 'confirm_interviewed', salesCycleId: 'cycle-kevin', expectedRevision: 4, suggestionActivityId: 'actual-answer' }));
});
it.each(['closed', 'no_action'] as const)('never offers confirmation without an active cycle/current action: %s', async gate => {
  const current = detailFor({ stage: 'interviewed', workflowStatus: gate === 'closed' ? 'closed' : 'active', nextAction: gate === 'no_action' ? null : kevin.nextAction,
    activities: [{ id: 'price', kind: 'call', occurredAt: '2026-09-01T12:00:00.000Z', summary: 'Price stated', outcome: 'price_said', markedInError: false }] });
  const api = createApi([current]); render(<LeadInspectorProvider api={api}><Harness /></LeadInspectorProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' }));
  fireEvent.click(await screen.findByRole('tab', { name: 'Activity' }));
  expect(screen.queryByRole('button', { name: 'Confirm Offered' })).toBeNull(); expect(api.confirmTransition).not.toHaveBeenCalled();
});

function assessedDiscoveryApi() {
  return {
    get: vi.fn<DiscoveryApi['get']>(), begin: vi.fn<DiscoveryApi['begin']>(),
    override: vi.fn<DiscoveryApi['override']>(),
    getBrief: vi.fn<DiscoveryApi['getBrief']>(async ({ personId }) => {
      const detail = personId === kevin.personId ? kevin : dana;
      return discoveryBriefSchema.parse({
        personId, salesCycleId: detail.salesCycleId, personName: detail.personName, stale: false, latestOverride: null, pilotNextStep: null,
        assessment: {
          id: personId === kevin.personId ? '10000000-0000-4000-8000-000000000001' : '10000000-0000-4000-8000-000000000002',
          personId, prospectId: `prospect-${personId}`, salesCycleId: detail.salesCycleId,
          fingerprint: (personId === kevin.personId ? 'a' : 'b').repeat(64), policyVersion: 'discovery-v1', ruleVersionId: 'rules', modelVersion: null,
          evaluatedAt: '2026-09-06T12:00:00.000Z', expiresAt: '2026-09-07T12:00:00.000Z', localDate: '2026-09-06', overrideId: null,
          disposition: 'research', reasonCodes: ['unknown_owner'], axes: { fit: null, timing: { milliPoints: 0, band: 'cold', hasSupportedTrigger: false }, reachability: 'none' },
          claims: [], unknowns: ['Owner identity is not established'], questions: ['Who handles maintenance?'], identitySupported: false, needsResearch: true,
          ranking: { priority: null, earliestTriggerExpiresAt: null, dataConfidence: 0, lastContactAt: null, latestSourceObservedAt: null },
        },
      });
    }),
  } satisfies DiscoveryApi;
}

it.each(['success', 'stale'] as const)('refreshes the mounted inspector override %s exactly once under StrictMode', async outcome => {
  vi.useFakeTimers(); const api = createApi([kevin]); const discoveryApi = assessedDiscoveryApi(); let settle!: () => void;
  discoveryApi.override.mockImplementation(() => new Promise((resolve, reject) => {
    settle = () => outcome === 'success' ? resolve(receipt) : reject(new Error('DISCOVERY_STALE_ASSESSMENT'));
  }));
  const view = render(<StrictMode><LeadInspectorProvider api={api} discoveryApi={discoveryApi}><Harness /></LeadInspectorProvider></StrictMode>);
  fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' })); await act(async () => undefined);
  expect(discoveryApi.getBrief).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Adjust discovery' }));
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Existing relationship' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save discovery decision' }));
  await act(async () => { settle(); await vi.advanceTimersByTimeAsync(0); });
  expect(discoveryApi.getBrief.mock.calls).toEqual([[{ personId: kevin.personId }], [{ personId: kevin.personId }]]);
  expect(screen.getByText(outcome === 'success' ? /Discovery decision saved/ : /Evidence changed\. Refresh/)).toBeTruthy();
  expect(discoveryApi.override).toHaveBeenCalledTimes(1); expect(api.confirmTransition).not.toHaveBeenCalled();
  view.unmount(); expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ['success', 'selection'], ['stale', 'selection'], ['success', 'close'], ['stale', 'close'],
  ['success', 'unmount'], ['stale', 'unmount'], ['success', 'replace-api'], ['stale', 'replace-api'],
  ['success', 'return-api'], ['stale', 'return-api'],
] as const)('ignores inspector override %s after %s without old-Person reads, state or timers', async (outcome, change) => {
  vi.useFakeTimers(); const api = createApi([kevin, dana]);
  const discoveryApi = assessedDiscoveryApi(); const replacement = assessedDiscoveryApi(); let settle!: () => void;
  discoveryApi.override.mockImplementation(() => new Promise((resolve, reject) => {
    settle = () => outcome === 'success' ? resolve(receipt) : reject(new Error('DISCOVERY_STALE_ASSESSMENT'));
  }));
  const tree = (current: DiscoveryApi) => <StrictMode><LeadInspectorProvider api={api} discoveryApi={current}><Harness /></LeadInspectorProvider></StrictMode>;
  const view = render(tree(discoveryApi));
  fireEvent.click(screen.getByRole('button', { name: 'Open Kevin Shin' })); await act(async () => undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Adjust discovery' }));
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Original decision' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save discovery decision' }));
  expect(discoveryApi.override).toHaveBeenCalledTimes(1);
  if (change === 'unmount') view.unmount();
  else if (change === 'close') fireEvent.click(screen.getByRole('button', { name: 'Close lead' }));
  else if (change === 'selection') {
    fireEvent.click(screen.getByRole('button', { name: 'Open Dana Whitman' })); await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Text +14015550100' }));
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Keep Dana draft' } });
  } else {
    view.rerender(tree(replacement)); await act(async () => undefined);
    if (change === 'return-api') { view.rerender(tree(discoveryApi)); await act(async () => undefined); }
  }
  // Drain jsdom's zero-delay focus work before observing discovery timers.
  await act(async () => vi.advanceTimersByTimeAsync(0));
  const calls = discoveryApi.getBrief.mock.calls.slice(); const replacementCalls = replacement.getBrief.mock.calls.slice();
  const timers = vi.getTimerCount(); const html = view.container.innerHTML; const focus = document.activeElement;
  await act(async () => settle());
  expect.soft(discoveryApi.getBrief.mock.calls).toEqual(calls);
  expect.soft(replacement.getBrief.mock.calls).toEqual(replacementCalls);
  expect.soft(view.container.innerHTML).toBe(html); expect.soft(document.activeElement).toBe(focus);
  expect.soft(vi.getTimerCount()).toBe(timers);
  expect(discoveryApi.override).toHaveBeenCalledTimes(1); expect(replacement.override).not.toHaveBeenCalled();
  expect(discoveryApi.get).not.toHaveBeenCalled(); expect(discoveryApi.begin).not.toHaveBeenCalled();
  expect(api.confirmTransition).not.toHaveBeenCalled(); expect(api.beginOutbound).not.toHaveBeenCalled(); expect(api.findContactInfo).not.toHaveBeenCalled();
  view.unmount(); expect(vi.getTimerCount()).toBe(0);
});
