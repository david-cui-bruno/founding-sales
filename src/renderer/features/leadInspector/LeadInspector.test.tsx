// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  leadDetailSchema,
  type ContactMethod,
  type LeadDetail,
} from '../../../shared/contracts/leadDetailContract';
import { InspectorOverview } from './InspectorOverview';
import type { FindContactInfoReceipt } from '../../../shared/contracts/enrichmentRequestContract';
import type { OutboundRequest, OutboundReceipt, OutboundCapabilities } from '../../../shared/contracts/outboundContract';
import { LeadInspectorProvider } from './LeadInspectorProvider';
import { useLeadInspector } from './useLeadInspector';

const WIDTH_KEY = 'callie.inspector.width';

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

const phoneFor = (overrides: Partial<ContactMethod> = {}): ContactMethod => ({
  contactSnapshot: 'a'.repeat(64),
  id: 'phone-1', kind: 'phone', value: '+14015550100', label: null, valid: false,
  validationState: 'unverified', reachability: 'none', sourceLabel: null,
  vendorRank: null, phoneKind: null, ownershipState: 'unknown', evidenceObservedAt: null,
  compliance: null,
  ...overrides,
});

const clearCompliance: NonNullable<ContactMethod['compliance']> = {
  status: 'verified_clear', label: 'Verified clear until Sep 15, 2026',
  expiresAt: '2026-09-15T00:00:00.000Z', callRefusalReason: null, textRefusalReason: null,
};

const unknownCompliance: NonNullable<ContactMethod['compliance']> = {
  status: 'compliance_unknown', label: 'Compliance unknown', expiresAt: null,
  callRefusalReason: 'federal_status_unknown', textRefusalReason: 'tcpa_status_unknown',
};

// Deliberately shuffled input, including a positively blocked rank-one phone.
const tenCandidates = (): ContactMethod[] => {
  const vendorPhone = (overrides: Partial<ContactMethod>) => phoneFor({
    sourceLabel: 'Synthetic vendor', ownershipState: 'vendor_candidate', phoneKind: 'mobile',
    evidenceObservedAt: '2026-09-04T12:00:00.000Z', compliance: unknownCompliance,
    ...overrides,
  });
  return [
    vendorPhone({ id: 'listed-rank-one', value: '+14015550108', vendorRank: 1,
      compliance: { status: 'federal_dnc_listed', label: 'Federal DNC listed', expiresAt: null,
        callRefusalReason: 'federal_dnc_listed', textRefusalReason: 'federal_dnc_listed' } }),
    vendorPhone({ id: 'conflicting', value: '+14015550107', vendorRank: 2, ownershipState: 'conflicting_identity' }),
    vendorPhone({ id: 'clear-vendor', value: '+14015550103', vendorRank: 2,
      valid: true, validationState: 'valid', compliance: clearCompliance }),
    vendorPhone({ id: 'unranked', value: '+14015550106' }),
    vendorPhone({ id: 'primary', value: '+14015550101', vendorRank: 1 }),
    vendorPhone({ id: 'tcpa', value: '+14015550110', vendorRank: 4,
      compliance: { status: 'tcpa_blocked', label: 'TCPA blocked', expiresAt: null,
        callRefusalReason: 'tcpa_blocked', textRefusalReason: 'tcpa_blocked' } }),
    vendorPhone({ id: 'clear-unknown-owner', value: '+14015550104', vendorRank: 3,
      valid: true, validationState: 'valid', ownershipState: 'unknown', compliance: clearCompliance }),
    vendorPhone({ id: 'unknown-rank-three', value: '+14015550105', vendorRank: 3 }),
    vendorPhone({ id: 'listed-rank-two', value: '+14015550109', vendorRank: 2,
      compliance: { status: 'federal_dnc_listed', label: 'Federal DNC listed', expiresAt: null,
        callRefusalReason: 'federal_dnc_listed', textRefusalReason: 'federal_dnc_listed' } }),
    vendorPhone({ id: 'clear-verified', value: '+14015550102', vendorRank: 5,
      valid: true, validationState: 'valid', ownershipState: 'verified_person', compliance: clearCompliance }),
  ];
};

const evidenceValue = (row: HTMLElement, label: string): HTMLElement =>
  within(row).getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement;

function expectDisabledHelp(button: HTMLElement, expected: string) {
  expect((button as HTMLButtonElement).disabled).toBe(true);
  const helpId = button.getAttribute('aria-describedby');
  expect(helpId).toBeTruthy();
  const help = document.getElementById(helpId!);
  expect(help?.textContent).toBe(expected);
  expect(help?.closest('[hidden], [aria-hidden="true"]')).toBeNull();
}

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
    priorityReasons: ['Owner of 3+ doors', 'Live vacancy posted this week'],
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
    beginOutbound: vi.fn(async (request: OutboundRequest): Promise<OutboundReceipt> => ({ commandId: request.commandId, channel: request.channel, status: 'handoff_accepted', reasonCode: null, mutation: receipt })),
    getOutboundCapabilities: vi.fn(async () => capabilities),
    confirmTransition: vi.fn(async () => receipt),
    dismissLead: vi.fn(async () => receipt),
    overrideCloudScore: vi.fn(async () => receipt),
    findContactInfo: vi.fn(async () => ({ written: false, refusalReason: null })),
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
  it('requires explicit Phone confirmation before any outbound invocation', async () => {
    const api = createApi(detailFor());
    await renderInspector(api);
    fireEvent.click(screen.getByRole('button', { name: 'Call +14015550100' }));
    expect(api.beginOutbound).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Open Phone' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel call' }));
    expect(api.beginOutbound).not.toHaveBeenCalled();
  });

  it('clears unsubmitted confirmation on snapshot/channel changes and submits only the final current contact', async () => {
    const detail = detailFor();
    const api = createApi(detail);
    const props = { onBeginOutbound: api.beginOutbound, onConfirmTransition: vi.fn(), onDismissLead: vi.fn(), onOverrideCloudScore: vi.fn(), capabilities };
    const { rerender } = render(<InspectorOverview detail={detail} {...props} />);
    const uuid = vi.spyOn(crypto, 'randomUUID');
    fireEvent.click(screen.getByRole('button', { name: 'Call +14015550100' }));
    expect(uuid).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel call' }));
    expect(api.beginOutbound).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Call +14015550100' }));
    const changed = detailFor({ phones: [{ ...detail.phones[0], contactSnapshot: 'b'.repeat(64) }] });
    rerender(<InspectorOverview detail={changed} {...props} />);
    expect(screen.queryByRole('button', { name: 'Open Phone' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Call +14015550100' }));
    fireEvent.click(screen.getByRole('button', { name: 'Email kevin@example.com' }));
    expect(screen.queryByRole('button', { name: 'Open Phone' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Call +14015550100' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Phone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Phone' }));
    expect(uuid).toHaveBeenCalledTimes(1);
    expect(api.beginOutbound).toHaveBeenCalledTimes(1);
    expect(api.beginOutbound).toHaveBeenCalledWith(expect.objectContaining({ expectedContactSnapshot: 'b'.repeat(64), contactMethodId: 'phone-1' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open Phone' })).toBeNull());
    uuid.mockRestore();
  });

  it('presents one rank-one candidate as evidence and keeps nine alternatives collapsed', async () => {
    const api = createApi(detailFor({ phones: tenCandidates() }));
    const inspector = await renderInspector(api);
    const primary = within(inspector).getByRole('region', { name: 'Primary phone candidate' });

    expect(within(inspector).getAllByRole('region', { name: 'Primary phone candidate' })).toHaveLength(1);
    expect(within(primary).getByText('+14015550101')).toBeTruthy();
    expect(within(primary).getByText('Primary candidate')).toBeTruthy();
    expect(evidenceValue(primary, 'Source').textContent).toBe('Synthetic vendor');
    expect(evidenceValue(primary, 'Vendor rank').textContent).toBe('1');
    expect(evidenceValue(primary, 'Phone kind').textContent).toBe('Mobile');
    expect(evidenceValue(primary, 'Ownership').textContent).toBe('Vendor candidate');
    expect(evidenceValue(primary, 'Validation').textContent).toBe('Unverified');
    expect(evidenceValue(primary, 'Compliance').textContent).toBe('Compliance unknown');
    const observed = evidenceValue(primary, 'Evidence observed').querySelector('time');
    expect(observed?.dateTime).toBe('2026-09-04T12:00:00.000Z');
    expect(observed?.textContent).toContain('Sep 4, 2026');
    expect(observed?.textContent).toContain('UTC');
    expect(evidenceValue(primary, 'Compliance expires').textContent).toBe('Unknown');

    const toggle = within(inspector).getByRole('button', { name: 'Show 9 alternative numbers' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const alternatives = document.getElementById(toggle.getAttribute('aria-controls')!);
    expect(alternatives).not.toBeNull();
    expect(alternatives?.hidden).toBe(true);
    expect(within(alternatives!).queryAllByRole('article')).toHaveLength(0);
    expect(within(inspector).getAllByRole('button', { name: /^(Call|Text) / })).toHaveLength(2);
    for (const button of within(primary).getAllByRole('button')) {
      expectDisabledHelp(button, 'Phone validation is unverified.');
      fireEvent.click(button);
    }
    expect(api.beginOutbound).not.toHaveBeenCalled();
  });

  it('expands with Enter and collapses with Space while preserving ordered, focusable evidence', async () => {
    const inspector = await renderInspector(createApi(detailFor({ phones: tenCandidates() })));
    const toggle = within(inspector).getByRole('button', { name: 'Show 9 alternative numbers' });
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    expect(fireEvent.keyDown(toggle, { key: 'Enter' })).toBe(false);
    fireEvent.keyUp(toggle, { key: 'Enter' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(inspector).getByRole('button', { name: 'Hide 9 alternative numbers' })).toBe(toggle);
    const alternatives = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(alternatives.hidden).toBe(false);
    fireEvent.keyDown(toggle, { key: 'Enter', repeat: true });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const rows = within(alternatives).getAllByRole('article');
    expect(rows.map((row) => within(row).getByRole('heading').textContent)).toEqual([
      '+14015550102', '+14015550103', '+14015550104', '+14015550105', '+14015550106',
      '+14015550107', '+14015550108', '+14015550109', '+14015550110',
    ]);
    expect(rows.map((row) => evidenceValue(row, 'Ownership').textContent)).toEqual([
      'Verified for this person', 'Vendor candidate', 'Unknown ownership', 'Vendor candidate',
      'Vendor candidate', 'Conflicting identity', 'Vendor candidate', 'Vendor candidate', 'Vendor candidate',
    ]);
    expect(rows.map((row) => evidenceValue(row, 'Vendor rank').textContent)).toEqual([
      '5', '2', '3', '3', 'Unknown', '2', '1', '2', '4',
    ]);
    for (const row of rows) {
      expect(row.tabIndex).toBe(0);
      row.focus();
      expect(document.activeElement).toBe(row);
      expect(evidenceValue(row, 'Source').textContent).toBe('Synthetic vendor');
      expect(evidenceValue(row, 'Phone kind').textContent).toBe('Mobile');
      expect(evidenceValue(row, 'Evidence observed').querySelector('time')?.dateTime)
        .toBe('2026-09-04T12:00:00.000Z');
      expect(evidenceValue(row, 'Compliance').textContent).toBeTruthy();
      expect(evidenceValue(row, 'Validation').textContent).toBeTruthy();
      expect(evidenceValue(row, 'Compliance expires').textContent).toBeTruthy();
    }
    const expiry = evidenceValue(rows[0]!, 'Compliance expires').querySelector('time');
    expect(expiry?.dateTime).toBe('2026-09-15T00:00:00.000Z');
    expect(expiry?.textContent).toContain('Sep 15, 2026');
    expect(expiry?.textContent).toContain('UTC');
    expect(evidenceValue(rows[6]!, 'Compliance').textContent).toBe('Federal DNC listed');
    expect(evidenceValue(rows[8]!, 'Compliance').textContent).toBe('TCPA blocked');

    toggle.focus();
    expect(fireEvent.keyDown(toggle, { key: ' ' })).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(fireEvent.keyUp(toggle, { key: ' ' })).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(inspector).getByRole('button', { name: 'Show 9 alternative numbers' })).toBe(toggle);
    expect(within(alternatives).queryAllByRole('article')).toHaveLength(0);
    expect(document.activeElement).toBe(toggle);

    fireEvent.keyDown(toggle, { key: ' ' });
    fireEvent.keyUp(toggle, { key: ' ' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(toggle, { key: 'Enter' });
    fireEvent.keyUp(toggle, { key: 'Enter' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows no phone candidate or disclosure for zero phones and preserves email', async () => {
    const inspector = await renderInspector(createApi(detailFor({ phones: [] })));
    expect(within(inspector).queryByRole('region', { name: 'Primary phone candidate' })).toBeNull();
    expect(within(inspector).getByText('No phone candidates on file.')).toBeTruthy();
    expect(within(inspector).queryByRole('button', { name: /alternative numbers?/ })).toBeNull();
    expect(within(inspector).queryAllByRole('button', { name: /^(Call|Text) / })).toHaveLength(0);
    expect((within(inspector).getByRole('button', { name: 'Email kevin@example.com' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('fails closed for null compliance even when a single phone is valid', async () => {
    const api = createApi(detailFor({ phones: [phoneFor({ valid: true, validationState: 'valid' })] }));
    const inspector = await renderInspector(api);
    for (const verb of ['Call', 'Text']) {
      const button = within(inspector).getByRole('button', { name: `${verb} +14015550100` });
      expectDisabledHelp(button, 'Compliance unknown. Outreach is disabled.');
      fireEvent.click(button);
    }
    const primary = within(inspector).getByRole('region', { name: 'Primary phone candidate' });
    expect(evidenceValue(primary, 'Source').textContent).toBe('Unknown source');
    expect(evidenceValue(primary, 'Vendor rank').textContent).toBe('Unknown');
    expect(evidenceValue(primary, 'Phone kind').textContent).toBe('Unknown');
    expect(evidenceValue(primary, 'Ownership').textContent).toBe('Unknown ownership');
    expect(evidenceValue(primary, 'Validation').textContent).toBe('Valid');
    expect(evidenceValue(primary, 'Compliance').textContent).toBe('Compliance unknown');
    expect(evidenceValue(primary, 'Evidence observed').textContent).toBe('Unknown');
    expect(evidenceValue(primary, 'Compliance expires').textContent).toBe('Unknown');
    expect(within(inspector).queryByRole('button', { name: /alternative numbers?/ })).toBeNull();
    expect(api.beginOutbound).not.toHaveBeenCalled();
  });

  it.each(['unverified', 'invalid'] as const)('refuses %s validation despite a legacy valid flag and clear compliance', async (validationState) => {
    const api = createApi(detailFor({ phones: [phoneFor({
      valid: true, validationState, ownershipState: 'verified_person', vendorRank: 1,
      compliance: clearCompliance,
    })] }));
    const inspector = await renderInspector(api);
    for (const verb of ['Call', 'Text']) {
      const button = within(inspector).getByRole('button', { name: `${verb} +14015550100` });
      expectDisabledHelp(button, `Phone validation is ${validationState}.`);
      fireEvent.click(button);
    }
    const primary = within(inspector).getByRole('region', { name: 'Primary phone candidate' });
    expect(evidenceValue(primary, 'Validation').textContent).toBe(validationState === 'invalid' ? 'Invalid' : 'Unverified');
    expect(evidenceValue(primary, 'Ownership').textContent).toBe('Verified for this person');
    expect(evidenceValue(primary, 'Compliance').textContent).toBe('Verified clear until Sep 15, 2026');
    expect(api.beginOutbound).not.toHaveBeenCalled();
  });

  it.each([1, 2])('retains all %i positively blocked phones without recommending any primary', async (count) => {
    const phones = [
      phoneFor({ id: 'tcpa', value: '+14015550102', vendorRank: 2, validationState: 'valid', valid: true,
        compliance: { status: 'tcpa_blocked', label: 'TCPA blocked', expiresAt: null,
          callRefusalReason: 'tcpa_blocked', textRefusalReason: 'tcpa_blocked' } }),
      phoneFor({ id: 'listed', value: '+14015550101', vendorRank: 1, validationState: 'valid', valid: true,
        compliance: { status: 'federal_dnc_listed', label: 'Federal DNC listed', expiresAt: null,
          callRefusalReason: 'federal_dnc_listed', textRefusalReason: 'federal_dnc_listed' } }),
    ].slice(0, count);
    const api = createApi(detailFor({ phones }));
    const inspector = await renderInspector(api);
    expect(within(inspector).queryByRole('region', { name: 'Primary phone candidate' })).toBeNull();
    expect(within(inspector).getByText('No recommended phone candidate. All numbers are positively blocked.')).toBeTruthy();
    expect(within(inspector).queryAllByRole('button', { name: /^(Call|Text) / })).toHaveLength(0);
    fireEvent.click(within(inspector).getByRole('button', {
      name: `Show ${count} alternative ${count === 1 ? 'number' : 'numbers'}`,
    }));
    const rows = within(inspector).getAllByRole('article');
    expect(rows.map((row) => within(row).getByRole('heading').textContent)).toEqual(
      count === 1 ? ['+14015550102'] : ['+14015550101', '+14015550102'],
    );
    for (const row of rows) {
      const expected = within(row).getByRole('heading').textContent === '+14015550101'
        ? 'Federal DNC listed.' : 'TCPA blocked.';
      for (const button of within(row).getAllByRole('button')) {
        expectDisabledHelp(button, expected);
        fireEvent.click(button);
      }
    }
    expect(api.beginOutbound).not.toHaveBeenCalled();
  });

  it.each(['call', 'text'] as const)('uses the independent %s refusal without blocking the other channel', async (blockedChannel) => {
    const api = createApi(detailFor({ phones: [phoneFor({
      id: 'channel-specific', valid: true, validationState: 'valid',
      compliance: { ...clearCompliance, status: 'outside_recipient_window', label: 'Outside recipient calling window',
        callRefusalReason: blockedChannel === 'call' ? 'outside_recipient_window' : null,
        textRefusalReason: blockedChannel === 'text' ? 'outside_recipient_window' : null },
    })] }));
    const inspector = await renderInspector(api);
    const blocked = within(inspector).getByRole('button', {
      name: `${blockedChannel === 'call' ? 'Call' : 'Text'} +14015550100`,
    });
    expectDisabledHelp(blocked, 'Outside recipient calling window.');
    fireEvent.click(blocked);
    expect(api.beginOutbound).not.toHaveBeenCalled();
    const allowed = within(inspector).getByRole('button', {
      name: `${blockedChannel === 'call' ? 'Text' : 'Call'} +14015550100`,
    });
    expect((allowed as HTMLButtonElement).disabled).toBe(false);
    expect(allowed.getAttribute('aria-describedby')).toBeNull();
    fireEvent.click(allowed);
    expect(api.beginOutbound).not.toHaveBeenCalled();
    if (blockedChannel === 'text') {
      fireEvent.click(screen.getByRole('button', { name: 'Open Phone' }));
      expect(api.beginOutbound).toHaveBeenCalledWith(expect.objectContaining({ channel: 'call', contactMethodId: 'channel-specific', expectedContactSnapshot: 'a'.repeat(64) }));
      await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    } else expect(screen.getByLabelText('Message')).toBeTruthy();
  });

  it.each(['Call', 'Text'] as const)('keeps the selected alternative contact ID for %s', async (verb) => {
    const api = createApi(detailFor({ phones: tenCandidates() }));
    const inspector = await renderInspector(api);
    fireEvent.click(within(inspector).getByRole('button', { name: 'Show 9 alternative numbers' }));
    fireEvent.click(within(inspector).getByRole('button', { name: `${verb} +14015550103` }));
    expect(api.beginOutbound).not.toHaveBeenCalled();
    if (verb === 'Call') {
      fireEvent.click(screen.getByRole('button', { name: 'Open Phone' }));
      expect(api.beginOutbound).toHaveBeenCalledWith(expect.objectContaining({ channel: 'call', contactMethodId: 'clear-vendor', expectedContactSnapshot: 'a'.repeat(64) }));
      await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    } else {
      expect(screen.getByRole('region', { name: 'Unsent text draft' }).textContent).toContain('+14015550103');
      expect(api.get).toHaveBeenCalledTimes(1);
    }
  });

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

  it('shows Not assessed for missing Fit and Timing without fabricating scores or enabling enrichment', async () => {
    const api = createApi(detailFor({ priorityContext: null, priorityReasons: [], cloudLinked: true,
      findContactEligibility: { eligible: false, refusalReason: 'fit_gate_failed' } }));
    const inspector = await renderInspector(api);
    for (const axis of ['Fit', 'Timing']) {
      const region = within(inspector).getByRole('region', { name: axis });
      expect(within(region).getByText('Not assessed')).toBeTruthy();
      expect(region.textContent).not.toMatch(/0\/30|0\/40|Low|Cold/);
    }
    expect(within(inspector).queryByText('Priority')).toBeNull();
    expect((within(inspector).getByRole('button', { name: 'Find contact info' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.findContactInfo).not.toHaveBeenCalled();
    expect(api.confirmTransition).not.toHaveBeenCalled();
    expect(api.beginOutbound).not.toHaveBeenCalled();
  });

  it('displays a real zero projection as Fit 0/30 Low and Timing 0/40 Cold, not Not assessed', async () => {
    const inspector = await renderInspector(createApi(detailFor({ priorityContext: {
      priority: 'P3', fitPoints: 0, fitBand: 'low', timingValue: 0, timingBand: 'cold', reachability: 'none', dataConfidence: 0,
    }, priorityReasons: ['Fit low 0/30', 'Timing cold 0/40'] })));
    const fit = within(inspector).getByRole('region', { name: 'Fit' });
    const timing = within(inspector).getByRole('region', { name: 'Timing' });
    expect(fit.textContent).toContain('0/30');
    expect(within(fit).getByText('Low')).toBeTruthy();
    expect(timing.textContent).toContain('0/40');
    expect(within(timing).getByText('Cold')).toBeTruthy();
    expect(within(inspector).queryByText('Not assessed')).toBeNull();
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

  it('opens editable text/email drafts without invoking outbound and discards them on close', async () => {
    const api = createApi(detailFor());
    await renderInspector(api);
    fireEvent.click(screen.getByRole('button', { name: 'Text +14015550100' }));
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Unsent text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Email kevin@example.com' }));
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Local subject' } });
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.beginOutbound).not.toHaveBeenCalled();
    expect(api.get).toHaveBeenCalledTimes(1);
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
    expectDisabledHelp(call, 'This person opted out.');
    expectDisabledHelp(text, 'This person opted out.');

    fireEvent.click(call);
    fireEvent.click(text);
    fireEvent.click(email);
    expect(api.beginOutbound).not.toHaveBeenCalled();

    expect(
      within(inspector).getByText(
        'This person opted out. Outreach is permanently disabled.',
      ),
    ).toBeTruthy();
  });

  it('renders each explicit phone compliance label', async () => {
    const cases = [
      ['verified_clear', 'Verified clear until Sep 15, 2026'],
      ['federal_dnc_listed', 'Federal DNC listed'],
      ['tcpa_blocked', 'TCPA blocked'],
      ['compliance_unknown', 'Compliance unknown'],
      ['scrub_expired', 'Scrub expired'],
      ['area_code_not_covered', 'Area code not covered'],
      ['state_clearance_required', 'State clearance required'],
      ['outside_recipient_window', 'Outside recipient calling window'],
    ] as const;
    const inspector = await renderInspector(createApi(detailFor({
      phones: cases.map(([status, label], index) => ({
        id: `phone-${index}`,
        kind: 'phone' as const,
        value: `+1401555010${index}`,
        label: null as string | null,
        valid: true,
        ...legacyContactEvidence,
        compliance: {
          status,
          label,
          expiresAt: status === 'verified_clear' ? '2026-09-15T00:00:00.000Z' : null,
          callRefusalReason: status === 'verified_clear' ? null : 'federal_status_unknown',
          textRefusalReason: status === 'verified_clear' ? null : 'federal_status_unknown',
        },
      })),
    })));

    fireEvent.click(within(inspector).getByRole('button', { name: 'Show 7 alternative numbers' }));
    for (const [, label] of cases) {
      expect(within(inspector).getByText(label)).toBeTruthy();
    }
  });

  it('disables call and text for every status except verified clear with state clearance inside the current window', async () => {
    const cases = [
      ['federal_dnc_listed', 'Federal DNC listed', 'federal_dnc_listed', 'federal_dnc_listed'],
      ['tcpa_blocked', 'TCPA blocked', 'tcpa_blocked', 'tcpa_blocked'],
      ['compliance_unknown', 'Compliance unknown', 'federal_status_unknown', 'tcpa_status_unknown'],
      ['scrub_expired', 'Scrub expired', 'federal_evidence_stale', 'federal_evidence_stale'],
      ['area_code_not_covered', 'Area code not covered', 'federal_area_code_mismatch', 'federal_area_code_mismatch'],
      ['state_clearance_required', 'State clearance required', 'state_registration_missing', 'state_consent_rule_unknown'],
      ['outside_recipient_window', 'Outside recipient calling window', 'outside_recipient_window', 'outside_recipient_window'],
    ] as const;
    const api = createApi(detailFor({
      phones: [
        ...cases.map(([status, label, callRefusalReason, textRefusalReason], index) => ({
          id: `blocked-${index}`,
          kind: 'phone' as const,
          value: `+1401555020${index}`,
          label: null as string | null,
          valid: true,
          ...legacyContactEvidence,
          compliance: {
            status, label, expiresAt: null as string | null,
            callRefusalReason, textRefusalReason,
          },
        })),
        { id: 'clear-phone', kind: 'phone', value: '+14015550199', label: null, valid: true, ...legacyContactEvidence, compliance: { status: 'verified_clear', label: 'Verified clear until Sep 15, 2026', expiresAt: '2026-09-15T00:00:00.000Z', callRefusalReason: null, textRefusalReason: null } },
      ],
    }));
    const inspector = await renderInspector(api);

    fireEvent.click(within(inspector).getByRole('button', { name: 'Show 7 alternative numbers' }));
    const expectedHelp = [
      ['Federal DNC listed.', 'Federal DNC listed.'],
      ['TCPA blocked.', 'TCPA blocked.'],
      ['Federal DNC status is unknown.', 'TCPA status is unknown.'],
      ['Federal scrub evidence has expired.', 'Federal scrub evidence has expired.'],
      ['Area code is not covered by federal scrub evidence.', 'Area code is not covered by federal scrub evidence.'],
      ['State registration is missing.', 'State consent requirements are unknown.'],
      ['Outside recipient calling window.', 'Outside recipient calling window.'],
    ];
    expectedHelp.forEach(([callReason, textReason], index) => {
      const value = `+1401555020${index}`;
      const call = within(inspector).getByRole('button', { name: `Call ${value}` });
      const text = within(inspector).getByRole('button', { name: `Text ${value}` });
      expectDisabledHelp(call, callReason);
      expectDisabledHelp(text, textReason);
      fireEvent.click(call);
      fireEvent.click(text);
    });
    expect(api.beginOutbound).not.toHaveBeenCalled();
    const clearCall = within(inspector).getByRole('button', { name: 'Call +14015550199' });
    const clearText = within(inspector).getByRole('button', { name: 'Text +14015550199' });
    expect((clearCall as HTMLButtonElement).disabled).toBe(false);
    expect((clearText as HTMLButtonElement).disabled).toBe(false);
  });

  it('presents each channel refusal as human-readable accessible disabled-control help', async () => {
    const inspector = await renderInspector(createApi(detailFor({
      phones: [{ id: 'phone-1', kind: 'phone', value: '+14015550100', label: null, valid: true, ...legacyContactEvidence, compliance: { status: 'state_clearance_required', label: 'State clearance required', expiresAt: null, callRefusalReason: 'state_registration_missing', textRefusalReason: 'outside_recipient_window' } }],
    })));

    expectDisabledHelp(within(inspector).getByRole('button', { name: 'Call +14015550100' }), 'State registration is missing.');
    expectDisabledHelp(within(inspector).getByRole('button', { name: 'Text +14015550100' }), 'Outside recipient calling window.');
    expect(within(inspector).queryByText('state_registration_missing')).toBeNull();
    expect(within(inspector).queryByText('outside_recipient_window')).toBeNull();
  });

  it('never exposes source JSON, contact HMAC, evidence reference, or policy internals', async () => {
    const inspector = await renderInspector(createApi(detailFor()));
    expect(inspector.textContent).not.toMatch(/source[_ ]json|contact[_ ]hmac|evidence[_ ]ref|policy[_ ]version/i);
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


const enrichmentReasons = [
  ['qualification_required', 'Founder qualification is required.'],
  ['fit_gate_failed', 'Medium or High Fit is required.'],
  ['identity_or_address_missing', 'A verified identity, cloud link, and usable property address are required.'],
  ['direct_contact_exists', 'A usable verified contact is already on file.'],
  ['suppression_blocked', 'Opt-out or suppression prevents contact enrichment.'],
  ['rate_limited', 'Already requested in the last 30 days.'],
  ['credentials_unavailable', 'Sourcing credentials are not provisioned.'],
] as const;

describe('domain-gated Find contact info', () => {
  function renderEnrichment(input: {
    eligibility: { eligible: boolean; refusalReason: FindContactInfoReceipt['refusalReason'] };
    phones?: ContactMethod[];
    result?: FindContactInfoReceipt;
    fail?: boolean;
  }) {
    const onFindContactInfo = vi.fn(async (): Promise<FindContactInfoReceipt> => {
      if (input.fail) throw new Error('Synthetic offline failure');
      return input.result ?? { written: true, refusalReason: null };
    });
    // Inject the domain DTO directly so pre-implementation RED exercises the UI,
    // not the old strict schema rejecting a new field before rendering.
    const detail = {
      ...detailFor({ cloudLinked: true, phones: input.phones ?? [] }),
      findContactEligibility: input.eligibility,
    };
    render(<InspectorOverview detail={detail} onBeginOutbound={vi.fn()}
      onConfirmTransition={vi.fn()} onDismissLead={vi.fn()} onOverrideCloudScore={vi.fn()}
      onFindContactInfo={onFindContactInfo} />);
    return onFindContactInfo;
  }

  it.each(enrichmentReasons)('keeps %s inert with a readable domain reason even with zero phones', (reason, label) => {
    const request = renderEnrichment({ eligibility: { eligible: false, refusalReason: reason } });
    const button = screen.getByRole('button', { name: 'Find contact info' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(label)).toBeTruthy();
    fireEvent.click(button);
    expect(request).not.toHaveBeenCalled();
  });

  it('allows one explicit request with ten vendor candidates when the domain permits it', async () => {
    const request = renderEnrichment({ eligibility: { eligible: true, refusalReason: null }, phones: tenCandidates() });
    const button = screen.getByRole('button', { name: 'Find contact info' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Contact info requested. Results arrive with the next sync.'));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ personId: 'person-kevin' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(enrichmentReasons)('shows a current %s refusal receipt in role=status', async (reason, label) => {
    const request = renderEnrichment({
      eligibility: { eligible: true, refusalReason: null }, result: { written: false, refusalReason: reason },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find contact info' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(label));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('keeps a request failure non-destructive and does not automatically retry', async () => {
    const request = renderEnrichment({ eligibility: { eligible: true, refusalReason: null }, fail: true });
    fireEvent.click(screen.getByRole('button', { name: 'Find contact info' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('The request failed. Try again later.'));
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('region', { name: 'Fit' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Timing' })).toBeTruthy();
  });
});
