// @vitest-environment jsdom
import { PresentationRoot } from '../../app/PresentationRoot';
import { act, cleanup, fireEvent, render as testingRender, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { beginDiscoveryReceiptSchema, discoveryBriefSchema, discoverySnapshotSchema, type DiscoveryApi, type DiscoveryBrief } from '../../../shared/contracts/discoveryContract';
import { leadDetailSchema, type LeadDetail } from '../../../shared/contracts/leadDetailContract';
import type { FindContactInfoReceipt } from '../../../shared/contracts/enrichmentRequestContract';
import type { EmailDraft, OutreachApi, OutreachStatus } from '../../../shared/contracts/outreachContract';
import { LeadInspectorProvider } from '../leadInspector/LeadInspectorProvider';
import { useLeadInspector, type LeadDetailApi } from '../leadInspector/useLeadInspector';
import { TodayRoute, type TodayRouteApi } from '../today/TodayRoute';

const render = (ui: Parameters<typeof testingRender>[0], options?: Parameters<typeof testingRender>[1]) => testingRender(ui, { wrapper: PresentationRoot, ...options });

const brief = (id = 'a', overrides: Partial<DiscoveryBrief> = {}): DiscoveryBrief => discoveryBriefSchema.parse({
  personId: id, salesCycleId: `cycle-${id}`, personName: `Owner ${id}`, stale: false, latestOverride: null, pilotNextStep: null,
  assessment: { id: '10000000-0000-4000-8000-000000000001', personId: id, prospectId: `prospect-${id}`, salesCycleId: `cycle-${id}`,
    fingerprint: 'a'.repeat(64), policyVersion: 'discovery-v1', ruleVersionId: 'rules', modelVersion: null,
    evaluatedAt: '2026-09-08T12:00:00.000Z', expiresAt: '2026-09-09T12:00:00.000Z', localDate: '2026-09-08', overrideId: null,
    disposition: 'candidate', reasonCodes: [], axes: { fit: { points: 15, band: 'medium', completeness: 'partial' },
      timing: { milliPoints: 0, band: 'cold', hasSupportedTrigger: false }, reachability: 'none' },
    claims: [], unknowns: [], questions: ['Who handles maintenance?'], identitySupported: true, needsResearch: false,
    ranking: { priority: 'p3', earliestTriggerExpiresAt: null, dataConfidence: 3, lastContactAt: null, latestSourceObservedAt: null } }, ...overrides,
});
const snapshot = (prepared = [brief()]) => discoverySnapshotSchema.parse({ prepared, judgment: [], counts: { unassessed: 0, research: 0, watch: 0, excluded: 0 }, processing: 'idle', researchCapability: 'not_configured', generatedAt: '2026-09-08T12:00:00.000Z', revision: 1 });
const detail = (id = 'a', overrides: Partial<LeadDetail> = {}): LeadDetail => leadDetailSchema.parse({
  personId: id, salesCycleId: `cycle-${id}`, personName: `Owner ${id}`, phones: [], emails: [], organizationLabel: null, propertySummaries: [],
  stage: 'unreviewed', workflowStatus: 'active', sourceLabel: 'parcel', segment: 'cold', priorityContext: null, priorityReasons: [],
  cloudScores: null, cloudLinked: true, findContactEligibility: { eligible: false, refusalReason: 'qualification_required' },
  nextAction: null, optedOut: false, cadence: null, outboundAttempts: [], activities: [], conversations: [], properties: [], history: [], revision: 1, ...overrides,
});
const emailDetail = (id = 'a') => detail(id, { stage: 'ready', findContactEligibility: { eligible: false, refusalReason: 'rate_limited' }, emails: [{
  id: `email-${id}`, kind: 'email', value: `${id}@example.test`, label: null, valid: false, contactSnapshot: 'e'.repeat(64), validationState: 'unverified',
  reachability: 'direct', sourceLabel: 'fixture', vendorRank: 1, phoneKind: null, ownershipState: 'vendor_candidate', evidenceObservedAt: null, compliance: null,
}] });
const receipt = { revision: 2, affectedPersonIds: ['a'], affectedSalesCycleIds: ['cycle-a'] };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture() {
  let current = detail();
  const discovery = {
    get: vi.fn<DiscoveryApi['get']>(async () => snapshot()), getBrief: vi.fn<DiscoveryApi['getBrief']>(async ({ personId }) => brief(personId)),
    begin: vi.fn<DiscoveryApi['begin']>(async request => { current = detail('a', { stage: 'ready', findContactEligibility: { eligible: true, refusalReason: null } }); return {
      personId: request.personId, salesCycleId: request.salesCycleId, assessmentId: request.assessmentId, actionId: 'action-a', mutation: receipt,
    }; }), override: vi.fn<DiscoveryApi['override']>(async () => receipt),
  };
  const api = {
    get: vi.fn<LeadDetailApi['get']>(async ({ personId }) => personId === 'a' ? current : emailDetail(personId)),
    beginOutbound: vi.fn<LeadDetailApi['beginOutbound']>(), getOutboundCapabilities: vi.fn<LeadDetailApi['getOutboundCapabilities']>().mockRejectedValue(new Error('unavailable')),
    confirmTransition: vi.fn<LeadDetailApi['confirmTransition']>(), dismissLead: vi.fn<LeadDetailApi['dismissLead']>(), overrideCloudScore: vi.fn<LeadDetailApi['overrideCloudScore']>(),
    findContactInfo: vi.fn<LeadDetailApi['findContactInfo']>(async () => ({ written: true, refusalReason: null })),
  };
  const mount = (outreachApi?: OutreachApi) => render(<StrictMode><LeadInspectorProvider api={api} discoveryApi={discovery} outreachApi={outreachApi}><Harness /></LeadInspectorProvider></StrictMode>);
  return { api, discovery, mount, setDetail: (value: LeadDetail) => { current = value; } };
}
function Harness() {
  const inspector = useLeadInspector();
  return <><button onClick={() => inspector.openLead('a')}>Open A</button><button onClick={() => inspector.openLead('b')}>Open B</button><button onClick={inspector.closeLead}>Close person</button></>;
}
async function openA() { fireEvent.click(screen.getByRole('button', { name: 'Open A' })); await screen.findByRole('complementary', { name: 'Owner a details' }); }
async function action() { const button = await screen.findByRole('button', { name: 'Find contact info' }); await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false)); return button; }
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('shows at most three applicable suggestions in backend order and selects names without writes', async () => {
  const f = fixture(); const missingFit = brief('missing'); missingFit.assessment!.axes.fit = null; missingFit.assessment!.ranking.priority = null;
  f.discovery.get.mockResolvedValue(snapshot([missingFit, brief('stale', { stale: true }), brief('d'), brief('b'), brief('a'), brief('c')]));
  const today = { get: vi.fn(async () => ({ lanes: [], dialBudget: 40, scheduledDials: 0, conversationTarget: 5, reviewErrorCount: 0, unreviewedBacklogCount: 6, unreviewedCloudSignalCount: 0, conversationsHeld: 0, revision: 1 })) } as unknown as TodayRouteApi;
  const open = vi.fn(); render(<TodayRoute api={today} discoveryApi={f.discovery} onOpenLead={open} />);
  const region = await screen.findByRole('region', { name: 'Suggested contacts' });
  await waitFor(() => expect(within(region).getAllByRole('button').map(button => button.textContent)).toEqual(['Owner d', 'Owner b', 'Owner a']));
  fireEvent.click(within(region).getByRole('button', { name: 'Owner b' }));
  expect(open).toHaveBeenCalledWith('b'); expect(f.discovery.begin).not.toHaveBeenCalled(); expect(f.api.findContactInfo).not.toHaveBeenCalled();
  expect(screen.queryByText('Who handles maintenance?')).toBeNull(); expect(screen.queryByRole('button', { name: /Refresh shortlist|Next|Contact options/ })).toBeNull();
});

it('exposes exactly one overview action and prepares before lookup only after explicit click', async () => {
  const f = fixture(); f.mount(); await openA(); const button = await action();
  expect(f.discovery.begin).not.toHaveBeenCalled(); expect(f.api.findContactInfo).not.toHaveBeenCalled();
  expect(screen.queryByText('Who handles maintenance?')).toBeNull();
  fireEvent.click(button); fireEvent.click(button);
  await screen.findByText(/Contact info requested/);
  expect(f.discovery.begin).toHaveBeenCalledTimes(1); expect(f.api.findContactInfo).toHaveBeenCalledTimes(1); expect(f.api.findContactInfo).toHaveBeenCalledWith({ personId: 'a' });
  expect(f.discovery.begin.mock.invocationCallOrder[0]).toBeLessThan(f.api.findContactInfo.mock.invocationCallOrder[0]);
  expect(f.api.confirmTransition).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Details', { selector: 'summary' }));
  expect(screen.getAllByRole('button', { name: 'Find contact info' })).toHaveLength(1);
});

it.each(['stale', 'research', 'low-fit', 'unknown-fit', 'unsupported', 'excluded'] as const)('does not prepare or lookup a %s candidate', async reason => {
  const f = fixture(); const value = brief();
  if (reason === 'stale') value.stale = true;
  if (reason === 'research') { value.assessment!.disposition = 'research'; value.assessment!.ranking.priority = null; }
  if (reason === 'low-fit') { value.assessment!.axes.fit = { points: 0, band: 'low', completeness: 'partial' }; value.assessment!.ranking.priority = null; }
  if (reason === 'unknown-fit') { value.assessment!.axes.fit = null; value.assessment!.ranking.priority = null; }
  if (reason === 'unsupported') { value.assessment!.identitySupported = false; value.assessment!.disposition = 'research'; value.assessment!.ranking.priority = null; }
  if (reason === 'excluded') value.latestOverride = { id: '20000000-0000-4000-8000-000000000001', assessmentId: value.assessment!.id, decision: 'exclude', reason: 'Not suitable', createdAt: '2026-09-08T12:00:00.000Z', evidenceChanged: false };
  f.discovery.getBrief.mockResolvedValue(value); f.mount(); await openA();
  const button = await screen.findByRole('button', { name: 'Find contact info' });
  await act(async () => undefined); expect((button as HTMLButtonElement).disabled).toBe(true); fireEvent.click(button);
  expect(f.discovery.begin).not.toHaveBeenCalled(); expect(f.api.findContactInfo).not.toHaveBeenCalled();
});

it('retains the exact uncertain preparation request across person switches and explicit retry', async () => {
  const f = fixture(); f.discovery.begin.mockRejectedValueOnce(new Error('private failure')); f.mount(); await openA(); fireEvent.click(await action());
  await screen.findByText(/Preparation response unavailable/); const request = { ...f.discovery.begin.mock.calls[0][0] };
  expect(f.api.findContactInfo).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Open B' }));
  await screen.findByRole('complementary', { name: 'Owner b details' }); await openA();
  const changed = brief(); changed.assessment!.fingerprint = 'b'.repeat(64); f.discovery.getBrief.mockResolvedValue(changed);
  fireEvent.click(await action()); await screen.findByText(/Contact info requested/);
  expect(f.discovery.begin.mock.calls[1][0]).toEqual(request); expect(f.api.findContactInfo).toHaveBeenCalledTimes(1);
});

it('does not continue a valid late preparation until the owner explicitly retries the retained request', async () => {
  const f = fixture(); const result = deferred<Awaited<ReturnType<DiscoveryApi['begin']>>>(); f.discovery.begin.mockReturnValue(result.promise);
  f.mount(); await openA(); fireEvent.click(await action()); await waitFor(() => expect(f.discovery.begin).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Open B' })); await screen.findByRole('complementary', { name: 'Owner b details' });
  const request = f.discovery.begin.mock.calls[0][0];
  const validReceipt = { personId: request.personId, salesCycleId: request.salesCycleId, assessmentId: request.assessmentId, actionId: 'action-a', mutation: receipt };
  expect(beginDiscoveryReceiptSchema.safeParse(validReceipt).success).toBe(true);
  await act(async () => result.resolve(validReceipt));
  expect(f.api.findContactInfo).not.toHaveBeenCalled(); expect(screen.getByRole('complementary', { name: 'Owner b details' })).toBeTruthy();
  f.setDetail(detail('a', { stage: 'ready', findContactEligibility: { eligible: true, refusalReason: null } }));
  await openA(); fireEvent.click(await action()); await screen.findByText(/Contact info requested/);
  // The same resolved receipt must now traverse the real successful parse path.
  expect(f.discovery.begin).toHaveBeenCalledTimes(2); expect(f.discovery.begin.mock.calls[1][0]).toEqual(request);
  expect(f.api.findContactInfo).toHaveBeenCalledOnce(); expect(f.api.findContactInfo).toHaveBeenCalledWith({ personId: 'a' });
});

it('honors the current detail gate after successful preparation', async () => {
  const f = fixture(); const begin = f.discovery.begin.getMockImplementation()!;
  f.discovery.begin.mockImplementation(async request => { const result = await begin(request); f.setDetail(detail('a', { stage: 'ready', findContactEligibility: { eligible: false, refusalReason: 'suppression_blocked' } })); return result; });
  f.mount(); await openA(); fireEvent.click(await action()); await screen.findByText(/Opt-out or suppression/);
  expect(f.discovery.begin).toHaveBeenCalledOnce(); expect(f.api.findContactInfo).not.toHaveBeenCalled();
});

it('refreshes requested contacts beyond a minute and retains an open editor during focus refresh', async () => {
  const f = fixture(); f.mount(); await openA(); const find = await action();
  vi.useFakeTimers(); await act(async () => { fireEvent.click(find); });
  expect(screen.getByText(/Contact info requested/)).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(65_000); }); f.setDetail(emailDetail());
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  fireEvent.click(screen.getByRole('button', { name: 'Email' }));
  const message = screen.getByLabelText('Message') as HTMLTextAreaElement;
  fireEvent.change(message, { target: { value: 'Keep this exact unsent prose' } }); message.focus();
  const pending = deferred<LeadDetail>(); f.api.get.mockReturnValueOnce(pending.promise);
  fireEvent(window, new Event('focus')); expect(screen.getByLabelText('Message')).toBe(message);
  await act(async () => pending.resolve(emailDetail())); expect(screen.getByLabelText('Message')).toBe(message);
  expect(document.activeElement).toBe(message); expect(message.value).toBe('Keep this exact unsent prose');
  expect(f.api.findContactInfo).toHaveBeenCalledOnce(); expect(f.api.beginOutbound).not.toHaveBeenCalled();
});

it('preserves the API-backed email editor on focus refresh and reopens its saved unsent draft', async () => {
  const f = fixture(); f.setDetail(emailDetail());
  const status: OutreachStatus = { model: 'ready', modelName: 'fixture-model', gmail: 'ready', accountEmail: 'founder@example.test', senderName: 'Fixture Founder', postalAddress: '123 Fixture St' };
  let saved: EmailDraft = { id: 'draft-a', personId: 'a', contactMethodId: 'email-a', salesCycleId: 'cycle-a', recipient: 'a@example.test', subject: 'Initial subject', body: 'Initial saved draft', revision: 1, status: 'draft', generation: 'model', messageId: null, notice: null, updatedAt: '2026-09-08T12:00:00.000Z' };
  const outreachApi: OutreachApi = {
    status: vi.fn(async () => status), configure: vi.fn(), connectGmail: vi.fn(), disconnectGmail: vi.fn(),
    openDraft: vi.fn(async () => ({ ...saved })),
    saveDraft: vi.fn(async input => {
      expect(input.draftId).toBe(saved.id); expect(input.expectedRevision).toBe(saved.revision);
      saved = { ...saved, subject: input.subject, body: input.body, generation: 'edited', revision: saved.revision + 1 };
      return { ...saved };
    }),
    generateDraft: vi.fn(), sendDraft: vi.fn(),
  };
  f.mount(outreachApi); await openA(); fireEvent.click(screen.getByRole('button', { name: 'Email' }));
  await waitFor(() => expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Initial saved draft'));
  expect(outreachApi.openDraft).toHaveBeenCalledWith({ personId: 'a', contactMethodId: 'email-a' });
  const opens = vi.mocked(outreachApi.openDraft).mock.calls.length;
  const message = screen.getByLabelText('Message') as HTMLTextAreaElement;
  const subject = screen.getByLabelText('Subject') as HTMLInputElement;
  fireEvent.change(subject, { target: { value: 'Exact unsent subject' } });
  fireEvent.change(message, { target: { value: 'Exact unsent API-backed prose' } }); message.focus();
  const pending = deferred<LeadDetail>(); f.api.get.mockReturnValueOnce(pending.promise);
  await act(async () => { fireEvent(window, new Event('focus')); });
  expect(screen.getByLabelText('Message')).toBe(message); expect(document.activeElement).toBe(message);
  await act(async () => pending.resolve({ ...emailDetail(), revision: 2 }));
  expect(screen.getByLabelText('Message')).toBe(message); expect(screen.getByLabelText('Subject')).toBe(subject);
  expect(document.activeElement).toBe(message); expect(message.value).toBe('Exact unsent API-backed prose'); expect(subject.value).toBe('Exact unsent subject');
  expect(outreachApi.openDraft).toHaveBeenCalledTimes(opens); expect(outreachApi.saveDraft).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Close draft' }));
  await waitFor(() => expect(screen.queryByLabelText('Message')).toBeNull());
  expect(saved.body).toBe('Exact unsent API-backed prose'); expect(saved.subject).toBe('Exact unsent subject'); expect(saved.status).toBe('draft');
  fireEvent.click(screen.getByRole('button', { name: 'Email' }));
  await waitFor(() => expect(outreachApi.openDraft).toHaveBeenCalledTimes(opens + 1));
  await waitFor(() => expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe(saved.body));
  expect(outreachApi.sendDraft).not.toHaveBeenCalled(); expect(outreachApi.generateDraft).not.toHaveBeenCalled();
  expect(f.api.beginOutbound).not.toHaveBeenCalled(); expect(f.discovery.begin).not.toHaveBeenCalled(); expect(f.api.findContactInfo).not.toHaveBeenCalled();
});

it('never retries an uncertain lookup, bounds pending reads, and stops them on teardown', async () => {
  const f = fixture(); const lookup = deferred<FindContactInfoReceipt>(); f.api.findContactInfo.mockReturnValue(lookup.promise);
  const mounted = f.mount(); await openA(); const find = await action();
  vi.useFakeTimers(); await act(async () => { fireEvent.click(find); });
  expect(f.api.findContactInfo).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(65_000); });
  expect(screen.getByText(/It may have been submitted/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Find contact info' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(36 * 60_000); });
  expect(screen.getByText(/Contact results are still unconfirmed/)).toBeTruthy();
  const readsAtExpiry = f.api.get.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(f.api.get).toHaveBeenCalledTimes(readsAtExpiry);
  await act(async () => { fireEvent(window, new Event('focus')); });
  expect(f.api.get).toHaveBeenCalledTimes(readsAtExpiry + 1);
  mounted.unmount();
  await act(async () => { fireEvent(window, new Event('focus')); await vi.advanceTimersByTimeAsync(60_000); lookup.resolve({ written: true, refusalReason: null }); });
  expect(f.api.get).toHaveBeenCalledTimes(readsAtExpiry + 1);
  expect(f.api.findContactInfo).toHaveBeenCalledOnce(); expect(f.discovery.begin).toHaveBeenCalledOnce();
});

it('does not lookup after preparation returns into a different current sales cycle', async () => {
  const f = fixture(); const begin = f.discovery.begin.getMockImplementation()!;
  f.discovery.begin.mockImplementation(async request => {
    const result = await begin(request);
    f.setDetail(detail('a', { salesCycleId: 'cycle-a-new', stage: 'ready', findContactEligibility: { eligible: true, refusalReason: null } }));
    return result;
  });
  f.mount(); await openA(); fireEvent.click(await action());
  await waitFor(() => expect(f.api.get).toHaveBeenCalledTimes(2));
  await act(async () => undefined);
  expect(f.discovery.begin).toHaveBeenCalledOnce(); expect(f.api.findContactInfo).not.toHaveBeenCalled();
});

it.each([{ written: false, refusalReason: 'credentials_unavailable' }, { written: false, refusalReason: 'rate_limited' }] satisfies FindContactInfoReceipt[])('keeps lookup refusal $refusalReason truthful', async result => {
  const f = fixture(); f.api.findContactInfo.mockResolvedValue(result); f.mount(); await openA(); fireEvent.click(await action());
  await screen.findByText(result.refusalReason === 'credentials_unavailable' ? /credentials are not provisioned/ : /last 30 days/);
  expect(screen.queryByText(/Contact info requested/)).toBeNull(); expect(f.api.findContactInfo).toHaveBeenCalledOnce();
});

it('opens exactly one selected suggestion workspace and discloses evidence only on demand', async () => {
  const f = fixture();
  f.discovery.get.mockResolvedValue(snapshot([brief('a'), brief('b')]));
  const today = { get: vi.fn(async () => ({ lanes: [], dialBudget: 40, scheduledDials: 0, conversationTarget: 5, reviewErrorCount: 0, unreviewedBacklogCount: 6, unreviewedCloudSignalCount: 0, conversationsHeld: 0, revision: 1 })) } as unknown as TodayRouteApi;
  function SuggestedRoute() { const inspector = useLeadInspector(); return <TodayRoute api={today} discoveryApi={f.discovery} onOpenLead={inspector.openLead} />; }
  render(<StrictMode><LeadInspectorProvider api={f.api} discoveryApi={f.discovery}><SuggestedRoute /></LeadInspectorProvider></StrictMode>);
  const region = await screen.findByRole('region', { name: 'Suggested contacts' });
  expect(screen.queryByRole('complementary')).toBeNull();
  fireEvent.click(await within(region).findByRole('button', { name: 'Owner a' }));
  await screen.findByRole('complementary', { name: 'Owner a details' });
  expect(screen.queryByText('Who handles maintenance?')).toBeNull();
  fireEvent.click(screen.getByText('Details', { selector: 'summary' }));
  expect(await screen.findByRole('region', { name: 'Discovery evidence for Owner a' })).toBeTruthy();
  expect(screen.getByText('Who handles maintenance?')).toBeTruthy();
  fireEvent.click(within(region).getByRole('button', { name: 'Owner b' }));
  await screen.findByRole('complementary', { name: 'Owner b details' });
  expect(screen.getAllByRole('complementary')).toHaveLength(1);
  expect(screen.queryByRole('region', { name: 'Discovery evidence for Owner a' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Review unreviewed|Contact options|Refresh shortlist/ })).toBeNull();
  expect(f.discovery.begin).not.toHaveBeenCalled(); expect(f.discovery.override).not.toHaveBeenCalled();
  expect(f.api.findContactInfo).not.toHaveBeenCalled(); expect(f.api.beginOutbound).not.toHaveBeenCalled();
});

it('rejects another persons preparation receipt and retries only the retained explicit request', async () => {
  const f = fixture();
  f.discovery.begin.mockResolvedValueOnce({ personId: 'b', salesCycleId: 'cycle-b', assessmentId: brief().assessment!.id, actionId: 'wrong-owner', mutation: { revision: 2, affectedPersonIds: ['b'], affectedSalesCycleIds: ['cycle-b'] } });
  f.mount(); await openA(); fireEvent.click(await action());
  await screen.findByText(/Preparation response unavailable/);
  expect(f.api.findContactInfo).not.toHaveBeenCalled();
  const request = { ...f.discovery.begin.mock.calls[0][0] };
  fireEvent.click(await action()); await screen.findByText(/Contact info requested/);
  expect(f.discovery.begin.mock.calls[1][0]).toEqual(request);
  expect(f.api.findContactInfo).toHaveBeenCalledOnce();
});

it('refreshes stale preparation evidence without automatically replaying the command', async () => {
  const f = fixture(); f.discovery.begin.mockRejectedValueOnce(new Error('DISCOVERY_STALE_ASSESSMENT'));
  f.mount(); await openA(); fireEvent.click(await action());
  await screen.findByText(/Evidence changed. Check current evidence/);
  await waitFor(() => expect(f.discovery.getBrief.mock.calls.length).toBeGreaterThanOrEqual(3));
  expect(f.discovery.begin).toHaveBeenCalledOnce(); expect(f.api.findContactInfo).not.toHaveBeenCalled();
});

it('retains successful preparation when the subsequent contact read fails', async () => {
  const f = fixture(); f.mount(); await openA();
  f.api.get.mockRejectedValueOnce(new Error('private read failure'));
  fireEvent.click(await action()); await screen.findByText(/Current contact evidence could not load/);
  expect(screen.queryByText(/private read failure/)).toBeNull();
  fireEvent.click(await action()); await screen.findByText(/Contact info requested/);
  expect(f.discovery.begin).toHaveBeenCalledOnce(); expect(f.api.findContactInfo).toHaveBeenCalledOnce();
});

Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
