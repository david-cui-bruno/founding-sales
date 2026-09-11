// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { leadDetailSchema, type ContactMethod } from '../../../shared/contracts/leadDetailContract';
import { InspectorOverview } from './InspectorOverview';
afterEach(cleanup);
const contact: ContactMethod = { id: 'phone', contactSnapshot: 'a'.repeat(64), kind: 'phone', value: '+14015550100', label: null, valid: true, validationState: 'valid', reachability: 'direct', sourceLabel: null, vendorRank: null, phoneKind: 'mobile', ownershipState: 'verified_person', evidenceObservedAt: null, compliance: { status: 'verified_clear', label: 'Verified clear', expiresAt: null, callRefusalReason: null, textRefusalReason: null } };
const detail = leadDetailSchema.parse({ personId: 'avery', salesCycleId: 'cycle', personName: 'Avery', phones: [contact], emails: [{ ...contact, id: 'email', kind: 'email', value: 'avery@example.com', compliance: null }], organizationLabel: 'Example Properties', propertySummaries: [], stage: 'ready', workflowStatus: 'active', sourceLabel: 'parcel', segment: 'cold', priorityContext: null, cloudScores: null, cloudLinked: false, findContactEligibility: { eligible: false, refusalReason: null }, priorityReasons: [], nextAction: null, optedOut: false, cadence: null, activities: [], conversations: [], outboundAttempts: [], properties: [], history: [], revision: 1, portfolio: { role: 'owner', ownedCount: 2, managedCount: 0, linkedCount: 1, knownUnits: 4, locations: ['Providence, RI'], summary: '2 known owned properties. 4 known units where recorded. Partial records, not a complete portfolio.', completeness: 'partial', facts: [{ id: 'p1', text: 'Recorded owner of 12 Elm St.' }] }, contactReason: { text: 'Recorded owner of 12 Elm St.', evidenceIds: ['p1'] } });
const unavailable = { state: 'unavailable' as const, reasonCode: 'not_integrated' as const };
function overview(overrides = {}) { const outbound = vi.fn(async () => ({ commandId: 'id', channel: 'call' as const, status: 'handoff_accepted' as const, reasonCode: null, mutation: { revision: 1, affectedPersonIds: [], affectedSalesCycleIds: [] } }));
  render(<InspectorOverview detail={{ ...detail, ...overrides }} onBeginOutbound={outbound} onConfirmTransition={vi.fn()} onDismissLead={vi.fn()} onOverrideCloudScore={vi.fn()} discoveryEvidence={<button>Adjust discovery</button>} capabilities={{ phoneHandoff: { state: 'available', reasonCode: null }, callObservation: unavailable, recording: unavailable, messagesSend: unavailable, gmailSend: unavailable, managedAudioImport: unavailable, appleTranscriptExtraction: unavailable, localDrafts: true }} />); return outbound; }
it('leads with known portfolio and factual reason, with explicit Call and visible actual Email', () => {
  overview(); expect(screen.getByRole('heading', { name: 'Known portfolio' })).toBeTruthy();
  expect(screen.getByText(/Partial records, not a complete portfolio/)).toBeTruthy();
  expect(screen.getAllByText('Recorded owner of 12 Elm St.').length).toBeGreaterThan(0);
  expect(screen.getByRole('button', { name: 'Call' }).className).toContain('primary');
  expect(screen.getByRole('button', { name: 'Email' })).toBeTruthy(); expect(screen.getByText('avery@example.com')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Adjust discovery|Mark ready|Wrong signal|Refresh|Next/ })).toBeNull();
  expect(screen.queryByText('Not assessed')).toBeNull();
});
it('retains the two-step explicit phone confirmation and keeps email available without an account', () => {
  const outbound = overview(); fireEvent.click(screen.getByRole('button', { name: 'Call' }));
  expect(outbound).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Open Phone' })); expect(outbound).toHaveBeenCalledOnce();
});
it('keeps an opted-out person disabled on both default channels', () => {
  overview({ optedOut: true }); for (const name of ['Call', 'Email']) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
});
it('shows one usable primary Email for multiple contacts and opens that exact recipient', () => {
  const email = detail.emails[0]!;
  overview({ emails: [
    { ...email, id: 'invalid', value: 'old@example.com', valid: false, validationState: 'invalid' },
    { ...email, id: 'usable', value: 'current@example.com' },
    { ...email, id: 'alternative', value: 'alternative@example.com' },
  ] });
  expect(screen.getAllByRole('button', { name: 'Email' })).toHaveLength(1);
  expect(screen.getByText('current@example.com')).toBeTruthy();
  expect(screen.queryByText('alternative@example.com')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Email' }));
  expect(screen.getByRole('region', { name: 'Unsent email draft' }).textContent).toContain('current@example.com');
});
