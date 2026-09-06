// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
