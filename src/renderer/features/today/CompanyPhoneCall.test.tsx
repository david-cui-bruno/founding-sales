// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PresentationRoot } from '../../app/PresentationRoot';
import { NativeDeskRoute, type NativeDeskApi } from './NativeDeskRoute';
import { dailyFixture, nativeDeskFixture, fixtureNow } from './nativeDesk.fixture';
import { dailySnapshotSchema } from '../../../shared/contracts/dailyContract';
import { createCallCampaignDraft, describeCallCampaignTemplate } from '../../../shared/contracts/callCampaignDraft';
import { localCompanyDetailSchema } from '../../../shared/contracts/localWorkspaceContract';
import { delegatedPhoneStateReplySchema, type PhoneHandoffState } from '../../../shared/contracts/delegatedPhoneStateContract';
import type { PhoneSetupApi } from '../../../shared/contracts/phoneSetupContract';
import { delegatedPhoneHandoffRequestSchema, type DelegatedPhoneHandoffRequest } from '../../../shared/contracts/ownerCommandContract';
import { PHONE_DIAL_MODES } from './todayCopy';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function phoneFixture() {
  const initial = dailyFixture({ answers: [] });
  const account = initial.accounts[0];
  account.routes = [{ id: 'phone-route', version: 3, accountId: 'a', personId: null, channel: 'phone', value: '+14015550100', purpose: 'business', verification: 'published', evidenceIds: ['source'] }];
  const version = { ...createCallCampaignDraft({ campaignId: 'phone-campaign', versionId: 'phone-version', stepId: 'initial-call', accountId: 'a', offer: 'Review a fictional property-management workflow.' }), approvedAt: fixtureNow };
  initial.campaigns = [{ version, snapshotHash: 'c'.repeat(64), caps: [{ campaignVersionId: version.id, channel: 'call', revision: 1, reserved: 0, sent: 0 }], enrollments: [{ id: 'phone-enrollment', accountId: 'a', selectedRouteId: 'phone-route', selectedRouteVersion: 3, personId: null, campaignVersionId: version.id, currentStepId: 'initial-call', version: 5, state: 'active', executionContextId: 'phone-context', contextRevision: 2, startedAt: fixtureNow }] }];
  initial.ownerStatus = [{ accountId: 'a', authority: { accountId: 'a', owner: 'worker', generation: 7, state: 'active' }, executionVersion: 19, pendingCommands: [], status: 'owner_applied' }];
  const snapshot = dailySnapshotSchema.parse(initial);
  expect(describeCallCampaignTemplate(version)?.accountId).toBe('a');
  const source = localCompanyDetailSchema.parse({ scope: 'local_database', generatedAt: fixtureNow, snapshot: account, sources: [{ id: 'source', url: 'https://larkspur.example/contact', fetchedAt: fixtureNow, sha256: 'd'.repeat(64), excerpt: 'Business switchboard: +14015550100. Twelve managed buildings.', permitted: true }], links: [] });
  let history: PhoneHandoffState = delegatedPhoneStateReplySchema({ accountId: 'a', enrollmentId: 'phone-enrollment', stepId: 'initial-call' }).parse({ accountId: 'a', enrollmentId: 'phone-enrollment', stepId: 'initial-call', workspaceId: 'ws', campaign: { campaignId: 'phone-campaign', campaignRevision: 1, campaignVersionId: 'phone-version' }, generatedAt: fixtureNow, remote: 'unknown', completeness: 'complete', issue: null, attempts: [], completions: [] });
  const f = nativeDeskFixture(snapshot);
  const begin = vi.fn<NativeDeskApi['delegation']['beginPhone']>(async () => { throw Error('Unexpected phone begin'); });
  const submit = vi.fn<NativeDeskApi['delegation']['submit']>(async () => { throw Error('Unexpected submission'); });
  const sync = vi.fn<NativeDeskApi['delegation']['sync']>(async () => ({ applied: 0, gaps: 0, cursor: null, ownerFresh: true }));
  const setup: PhoneSetupApi = { status: vi.fn(async () => ({ state: 'configured' as const, candidateFingerprint: 'fictional-helper', confirmedAt: fixtureNow })), confirm: vi.fn(async () => { throw Error('Unexpected setup confirmation'); }), clear: vi.fn(async () => { throw Error('Unexpected setup clear'); }) };
  const api: NativeDeskApi & { phoneSetup: PhoneSetupApi } = { ...f.api, phoneSetup: setup, localWorkspace: { ...f.api.localWorkspace, getCompany: vi.fn(async input => { expect(input).toEqual({ accountId: 'a' }); return structuredClone(source); }) }, delegation: { ...f.api.delegation, beginPhone: begin, submit, sync, getPhoneHandoffState: vi.fn(async input => { expect(input).toEqual({ accountId: 'a', enrollmentId: 'phone-enrollment', stepId: 'initial-call' }); return delegatedPhoneStateReplySchema(input).parse(structuredClone(history)); }) } };
  return { ...f, api, begin, submit, sync, setup, snapshot, source, history: () => structuredClone(history), setHistory(value: PhoneHandoffState) { history = value; } };
}
function mount(f: ReturnType<typeof phoneFixture>) {
  return render(<NativeDeskRoute firstUse={f.firstUse} api={f.api} />, { wrapper: PresentationRoot });
}

it('P1 actual company-only Calls row exposes separate phone review and final handoff confirmation', async () => {
  const f = phoneFixture();
  mount(f);
  fireEvent.click(await screen.findByRole('button', { name: 'Call · Account A' }));
  expect(screen.getAllByText(/\+14015550100/).length).toBeGreaterThan(0);
  expect(f.begin).not.toHaveBeenCalled();
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.sync).not.toHaveBeenCalled();
  expect(f.setup.status).not.toHaveBeenCalled();
  const review = await screen.findByRole('button', { name: 'Check owner and review call' });
  fireEvent.click(review);
  await waitFor(() => expect(f.sync).toHaveBeenCalledTimes(1));
  const begin = await screen.findByRole('button', { name: 'Call with Phone.app' });
  expect((begin as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('checkbox', { name: /confirm the displayed destination and call purpose/i })).toBeTruthy();
  expect(f.begin).not.toHaveBeenCalled();
  expect(f.submit).not.toHaveBeenCalled();
});

async function openReview(f: ReturnType<typeof phoneFixture>) {
  mount(f); fireEvent.click(await screen.findByRole('button', { name: 'Call · Account A' }));
  const review = await screen.findByRole('button', { name: 'Check owner and review call' });
  await waitFor(() => expect((review as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(review);
  return screen.findByRole('checkbox', { name: 'I confirm the displayed destination and call purpose' });
}
it('cancelling exact review preserves no begin or submit and a fresh confirmation is unchecked', async () => {
  const f = phoneFixture(); const confirmation = await openReview(f);
  fireEvent.click(confirmation); fireEvent.click(screen.getByRole('button', { name: 'Cancel call review' }));
  expect(screen.queryByRole('button', { name: 'Call with Phone.app' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check owner and review call' }));
  const second = await screen.findByRole('checkbox', { name: 'I confirm the displayed destination and call purpose' });
  expect((second as HTMLInputElement).checked).toBe(false);
  expect(f.begin).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});
it.each(['route', 'owner', 'evidence', 'setup'] as const)('final confirmation refuses changed %s binding instead of rebuilding a command', async kind => {
  const f = phoneFixture(); const confirmation = await openReview(f);
  if (kind === 'route') { f.snapshot.accounts[0].routes[0].version++; f.setSnapshot(f.snapshot); }
  if (kind === 'owner') { f.snapshot.ownerStatus[0].executionVersion = 20; f.setSnapshot(f.snapshot); }
  if (kind === 'evidence') f.source.sources[0].excerpt += ' Revised saved source.';
  // Setup losing `configured` between review and confirmation now selects the hand-dialed path, so
  // it is refused as a changed binding rather than as an unconfigured readiness: either way the
  // reviewed helper dial never becomes something else without a fresh review.
  if (kind === 'setup') vi.mocked(f.setup.status).mockResolvedValue({ state: 'unavailable', candidateFingerprint: null, confirmedAt: null });
  fireEvent.click(confirmation); fireEvent.click(screen.getByRole('button', { name: 'Call with Phone.app' }));
  await screen.findByText(kind === 'route' ? 'HOLD: The exact selected company business phone route is unavailable.' : 'HOLD: Reviewed phone bindings changed. Check owner and review again before confirming.');
  expect(f.begin).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.sync).toHaveBeenCalledTimes(1);
});
it('unknown begin reply is latched once with current non-default versions and survives panel remount', async () => {
  const f = phoneFixture(); const confirmation = await openReview(f);
  fireEvent.click(confirmation); const button = screen.getByRole('button', { name: 'Call with Phone.app' });
  fireEvent.click(button); fireEvent.click(button);
  await screen.findByText('Handoff result unknown. Do not redial. Refresh saved phone history.');
  expect(f.begin).toHaveBeenCalledTimes(1);
  expect(f.begin.mock.calls[0][0]).toMatchObject({ command: { expectedAuthorityGeneration: 7, expectedVersion: 19, payload: { routeVersion: 3, campaign: { enrollmentRevision: 5 } } } });
  cleanup(); mount(f); fireEvent.click(await screen.findByRole('button', { name: 'Call · Account A' }));
  await screen.findByText(/Retained handoff request/);
  expect((screen.getByRole('button', { name: 'Check owner and review call' }) as HTMLButtonElement).disabled).toBe(true);
  expect(f.begin).toHaveBeenCalledTimes(1); expect(f.submit).not.toHaveBeenCalled();
});
it('incomplete selected history is not empty and holds review without owner reconciliation', async () => {
  const f = phoneFixture(); f.setHistory({ ...f.history(), completeness: 'incomplete', issue: 'source_limit', attempts: [], completions: [] });
  mount(f); fireEvent.click(await screen.findByRole('button', { name: 'Call · Account A' }));
  await screen.findByText(/incomplete phone history \(source_limit\)/);
  expect(screen.queryByText(/No saved handoff attempt/)).toBeNull();
  expect((screen.getByRole('button', { name: 'Check owner and review call' }) as HTMLButtonElement).disabled).toBe(true);
  expect(f.begin).not.toHaveBeenCalled(); expect(f.sync).not.toHaveBeenCalled(); expect(f.setup.status).not.toHaveBeenCalled();
});
it('selection teardown while owner review is pending cannot publish confirmation or begin', async () => {
  const f = phoneFixture(); let release!: (value: Awaited<ReturnType<typeof f.sync>>) => void;
  f.sync.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const view = mount(f); fireEvent.click(await screen.findByRole('button', { name: 'Call · Account A' }));
  const button = await screen.findByRole('button', { name: 'Check owner and review call' });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(button);
  await waitFor(() => expect(f.sync).toHaveBeenCalledTimes(1)); view.unmount();
  release({ applied: 0, gaps: 0, cursor: null, ownerFresh: true });
  mount(f); fireEvent.click(await screen.findByRole('button', { name: 'Call · Account A' }));
  await screen.findByText(/No saved handoff attempt/);
  expect(screen.queryByRole('checkbox', { name: 'I confirm the displayed destination and call purpose' })).toBeNull();
  expect(f.begin).not.toHaveBeenCalled(); expect(f.setup.status).not.toHaveBeenCalled();
});

/**
 * D6 acceptance 2, end to end in the renderer: the helper cannot dial, so the review offers the
 * hand-dialed control instead of the Phone.app one, the request carries `manual: true`, and the
 * consumed handoff that comes back opens the same outcome form a helper dial opens.
 */
function handDialledHistory(command: DelegatedPhoneHandoffRequest['command']): PhoneHandoffState {
  const selector = { accountId: 'a', enrollmentId: 'phone-enrollment', stepId: 'initial-call' };
  return delegatedPhoneStateReplySchema(selector).parse({
    ...selector, workspaceId: 'ws', campaign: { campaignId: 'phone-campaign', campaignRevision: 1, campaignVersionId: 'phone-version' },
    generatedAt: fixtureNow, remote: 'unknown', completeness: 'complete', issue: null, completions: [],
    attempts: [{ command, queuedAt: fixtureNow,
      receipt: { commandId: command.commandId, status: 'applied', authorityGeneration: 7, aggregateVersion: 20, reason: null },
      receiptEvent: { eventId: 'hand-dialled-event', kind: 'manual.handoff', authorityGeneration: 7, aggregateVersion: 20, appliedAt: fixtureNow },
      handoff: { value: { ...command.payload, handoffId: 'hand-dialled-handoff', expiresAt: '2026-09-09T13:00:00.000Z' },
        authorityGeneration: 7, consumedAt: fixtureNow } }],
  });
}
async function openHandDialledReview(f: ReturnType<typeof phoneFixture>) {
  vi.mocked(f.setup.status).mockResolvedValue({ state: 'unavailable', candidateFingerprint: null, confirmedAt: null });
  mount(f); fireEvent.click(await screen.findByRole('button', { name: 'Call · Account A' }));
  const review = await screen.findByRole('button', { name: 'Check owner and review call' });
  await waitFor(() => expect((review as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(review);
  return screen.findByRole('checkbox', { name: 'I dialed +14015550100 at Account A by hand' });
}

it('offers the hand-dialed control instead of Phone.app when the helper cannot dial, and only after one confirmation', async () => {
  const f = phoneFixture();
  const confirmation = await openHandDialledReview(f);
  expect(screen.queryByRole('button', { name: 'Call with Phone.app' })).toBeNull();
  expect(screen.queryByRole('checkbox', { name: 'I confirm the displayed destination and call purpose' })).toBeNull();
  expect((screen.getByRole('button', { name: 'I dialed this number by hand' }) as HTMLButtonElement).disabled).toBe(true);
  // The reason is the plain one Settings and the card use, and the confirmation names number and firm.
  const explanation = `Callie cannot dial from this Mac: ${PHONE_DIAL_MODES.unavailable.reason}. Dial +14015550100 yourself, then confirm below.`;
  expect(screen.getByText((_, element) => element?.tagName === 'P' && (element.textContent ?? '').startsWith(explanation))).toBeTruthy();
  expect((confirmation as HTMLInputElement).checked).toBe(false);
  fireEvent.click(confirmation);
  expect((screen.getByRole('button', { name: 'I dialed this number by hand' }) as HTMLButtonElement).disabled).toBe(false);
  expect(f.begin).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it('a hand-dialed call sends manual true, consumes the step\'s one handoff and opens the same outcome form', async () => {
  const f = phoneFixture();
  f.begin.mockImplementation(async raw => {
    const request = delegatedPhoneHandoffRequestSchema.parse(raw);
    expect(request.manual).toBe(true);
    f.setHistory(handDialledHistory(request.command));
    return { status: 'handoff', handoffId: 'hand-dialled-handoff', result: { status: 'unavailable', reasonCode: 'manual_dial' } };
  });
  const confirmation = await openHandDialledReview(f);
  fireEvent.click(confirmation);
  fireEvent.click(screen.getByRole('button', { name: 'I dialed this number by hand' }));
  await screen.findByText('Recorded as dialed by hand. This call step\'s one handoff is now used up, and the outcome form below is open for it. Callie placed no call.');
  expect(f.begin).toHaveBeenCalledTimes(1);
  expect(f.begin.mock.calls[0][0]).toMatchObject({ manual: true, command: { expectedAuthorityGeneration: 7, expectedVersion: 19, kind: 'prepare-manual' } });
  // Exactly as after a helper dial: the consumed handoff is what opens the report form.
  expect(await screen.findByRole('group', { name: 'Report an observed phone outcome' })).toBeTruthy();
  expect((await screen.findByRole('combobox', { name: 'Consumed handoff' }) as HTMLSelectElement).value).toBe('hand-dialled-handoff');
  expect(f.submit).not.toHaveBeenCalled();
});

it('refuses a second hand-dialed call on the same step with the existing one-per-step rule', async () => {
  const f = phoneFixture();
  f.begin.mockImplementation(async raw => {
    const request = delegatedPhoneHandoffRequestSchema.parse(raw);
    f.setHistory(handDialledHistory(request.command));
    return { status: 'handoff', handoffId: 'hand-dialled-handoff', result: { status: 'unavailable', reasonCode: 'manual_dial' } };
  });
  const confirmation = await openHandDialledReview(f);
  fireEvent.click(confirmation);
  fireEvent.click(screen.getByRole('button', { name: 'I dialed this number by hand' }));
  await screen.findByRole('group', { name: 'Report an observed phone outcome' });
  // The saved attempt is now in this step's history, so no second review can be prepared at all.
  await waitFor(() => expect((screen.getByRole('button', { name: 'Check owner and review call' }) as HTMLButtonElement).disabled).toBe(true));
  expect(screen.queryByRole('button', { name: 'I dialed this number by hand' })).toBeNull();
  expect(f.begin).toHaveBeenCalledTimes(1);
});
