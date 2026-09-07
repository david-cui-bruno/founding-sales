// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { discoveryBriefSchema, discoverySnapshotSchema, type DiscoveryApi, type DiscoveryBrief, type BeginDiscoveryReceipt } from '../../../shared/contracts/discoveryContract';
import { DiscoverySection } from './DiscoverySection';

const brief = (personId = 'owner-person'): DiscoveryBrief => discoveryBriefSchema.parse({
  personId, salesCycleId: `cycle-${personId}`, personName: personId === 'owner-person' ? 'Example Owner' : 'Other Owner', stale: false, latestOverride: null, pilotNextStep: null,
  assessment: { id: personId === 'owner-person' ? '10000000-0000-4000-8000-000000000001' : '10000000-0000-4000-8000-000000000002', personId, prospectId: `prospect-${personId}`, salesCycleId: `cycle-${personId}`, fingerprint: (personId === 'owner-person' ? 'a' : 'b').repeat(64), policyVersion: 'discovery-v1', ruleVersionId: 'rules-v1', modelVersion: null, evaluatedAt: '2026-09-06T12:00:00.000Z', expiresAt: '2026-09-07T12:00:00.000Z', localDate: '2026-09-06', overrideId: null, disposition: 'candidate', reasonCodes: [], axes: { fit: { points: 15, band: 'medium', completeness: 'partial' }, timing: { milliPoints: 0, band: 'cold', hasSupportedTrigger: false }, reachability: 'none' }, claims: [{ id: 'owner', label: 'Owner', value: personId === 'owner-person' ? 'Example Owner' : 'Other Owner', certainty: 'fact', refs: [{ kind: 'source', sourceEventId: 'source-owner', field: 'ownerName', observedAt: '2026-09-05T12:00:00.000Z' }] }], unknowns: ['Management style unknown'], questions: ['How is maintenance handled?'], identitySupported: true, needsResearch: false, ranking: { priority: 'p3', earliestTriggerExpiresAt: null, dataConfidence: 3, lastContactAt: null, latestSourceObservedAt: '2026-09-05T12:00:00.000Z' } },
});
const snapshot = (prepared = [brief()]) => discoverySnapshotSchema.parse({ prepared, judgment: [], counts: { unassessed: 2881, research: 4, watch: 0, excluded: 0 }, processing: 'running', researchCapability: 'not_configured', generatedAt: '2026-09-06T12:00:00.000Z', revision: 1 });
function apiFor() {
  const api = {
    get: vi.fn<DiscoveryApi['get']>(async () => snapshot()),
    getBrief: vi.fn<DiscoveryApi['getBrief']>(async ({ personId }) => brief(personId)),
    begin: vi.fn<DiscoveryApi['begin']>(async (request) => ({ personId: request.personId, salesCycleId: request.salesCycleId, assessmentId: request.assessmentId, actionId: 'action-owner', mutation: { revision: 2, affectedPersonIds: [request.personId], affectedSalesCycleIds: [request.salesCycleId] } })),
    override: vi.fn<DiscoveryApi['override']>(async () => ({ revision: 2, affectedPersonIds: ['owner-person'], affectedSalesCycleIds: ['cycle-owner-person'] })),
  } satisfies DiscoveryApi;
  return api;
}
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('renders evidence/questions without beginning and prepares only the explicitly selected Person once', async () => {
  const api = apiFor(); const open = vi.fn();
  api.get.mockResolvedValue(snapshot([brief(), brief('other')]));
  render(<DiscoverySection api={api} onOpenPerson={open} />);
  await screen.findByRole('heading', { name: 'Prepared conversations' });
  expect(await screen.findByText('Additional research not configured')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'View evidence for Example Owner' }));
  expect(open).toHaveBeenCalledWith('owner-person'); expect(api.begin).not.toHaveBeenCalled();
  const button = screen.getByRole('button', { name: 'Contact options for Other Owner' });
  button.focus(); expect(document.activeElement).toBe(button);
  fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(open).toHaveBeenLastCalledWith('other'));
  expect(api.begin).toHaveBeenCalledTimes(1);
  expect(api.begin.mock.calls[0][0]).toEqual({ commandId: expect.stringMatching(/^[a-f0-9-]{36}$/), personId: 'other', salesCycleId: 'cycle-other', assessmentId: '10000000-0000-4000-8000-000000000002', expectedFingerprint: 'b'.repeat(64) });
});
it('retains exact lost-reply request even when a refresh removes the prepared Person', async () => {
  const api = apiFor(); const open = vi.fn();
  api.begin.mockRejectedValueOnce(new Error('private transport failure'));
  render(<DiscoverySection api={api} onOpenPerson={open} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Contact options for Example Owner' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByText(/private transport/)).toBeNull();
  const first = api.begin.mock.calls[0][0];
  api.get.mockResolvedValue(snapshot([]));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh shortlist' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'View evidence for Example Owner' })).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Retry contact options for Example Owner' }));
  await waitFor(() => expect(open).toHaveBeenCalledWith('owner-person'));
  expect(api.begin.mock.calls[1][0]).toEqual(first);
});
it('does not turn a successful preparation into a failed command when the subsequent refresh fails', async () => {
  const api = apiFor(); const open = vi.fn();
  render(<DiscoverySection api={api} onOpenPerson={open} />);
  await screen.findByRole('button', { name: 'Contact options for Example Owner' });
  api.get.mockRejectedValue(new Error('private read failure'));
  fireEvent.click(screen.getByRole('button', { name: 'Contact options for Example Owner' }));
  await waitFor(() => expect(open).toHaveBeenCalledWith('owner-person'));
  expect(screen.queryByRole('button', { name: /Retry contact options/ })).toBeNull();
  expect(api.begin).toHaveBeenCalledTimes(1);
});
it('refreshes stale evidence without automatically replaying a changed assessment', async () => {
  const api = apiFor(); const open = vi.fn();
  api.begin.mockRejectedValueOnce(new Error("Error invoking remote method 'discovery:begin': Error: DISCOVERY_STALE_ASSESSMENT"));
  render(<DiscoverySection api={api} onOpenPerson={open} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Contact options for Example Owner' }));
  expect(await screen.findByText(/Evidence changed/)).toBeTruthy();
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  expect(open).not.toHaveBeenCalled(); expect(api.begin).toHaveBeenCalledTimes(1);
});
it('rejects a valid-shaped receipt bound to another Person and retains retry identity', async () => {
  const api = apiFor(); const open = vi.fn();
  api.begin.mockResolvedValueOnce({ personId: 'other', salesCycleId: 'cycle-other', assessmentId: brief().assessment!.id, actionId: 'other-action', mutation: { revision: 2, affectedPersonIds: ['other'], affectedSalesCycleIds: ['cycle-other'] } });
  render(<DiscoverySection api={api} onOpenPerson={open} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Contact options for Example Owner' }));
  expect(await screen.findByRole('alert')).toBeTruthy(); expect(open).not.toHaveBeenCalled();
});
it('ignores late navigation after evidence selection changes or unmount', async () => {
  const api = apiFor(); const open = vi.fn(); let resolve!: (value: BeginDiscoveryReceipt) => void;
  api.get.mockResolvedValue(snapshot([brief(), brief('other')]));
  api.begin.mockImplementation(() => new Promise(done => { resolve = done; }));
  const view = render(<DiscoverySection api={api} onOpenPerson={open} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Contact options for Example Owner' }));
  fireEvent.click(screen.getByRole('button', { name: 'View evidence for Other Owner' }));
  view.unmount();
  await act(async () => resolve({ personId: 'owner-person', salesCycleId: 'cycle-owner-person', assessmentId: brief().assessment!.id, actionId: 'action-owner', mutation: { revision: 2, affectedPersonIds: ['owner-person'], affectedSalesCycleIds: ['cycle-owner-person'] } }));
  expect(open).toHaveBeenCalledTimes(1); expect(open).toHaveBeenCalledWith('other');
});
it('times out without auto-replay, retains one UUID for explicit retry and cancels timers on unmount', async () => {
  vi.useFakeTimers(); const api = apiFor(); const open = vi.fn();
  api.begin.mockImplementation(() => new Promise(() => undefined));
  const view = render(<DiscoverySection api={api} onOpenPerson={open} />);
  await act(async () => undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Contact options for Example Owner' }));
  await act(async () => vi.advanceTimersByTimeAsync(16000));
  expect(screen.getByRole('alert')).toBeTruthy(); expect(api.begin).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Retry contact options for Example Owner' }));
  expect(api.begin.mock.calls[1][0]).toEqual(api.begin.mock.calls[0][0]);
  view.unmount(); expect(vi.getTimerCount()).toBe(0);
});
it('bounds mounted polling without overlap and labels an empty pending shortlist honestly', async () => {
  vi.useFakeTimers(); const api = apiFor(); api.get.mockResolvedValue(snapshot([]));
  const view = render(<DiscoverySection api={api} onOpenPerson={vi.fn()} />);
  await act(async () => undefined);
  expect(screen.getByText('Preparing your shortlist')).toBeTruthy();
  await act(async () => vi.advanceTimersByTimeAsync(600000));
  expect(api.get.mock.calls.length).toBeLessThanOrEqual(13);
  const calls = api.get.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(600000));
  expect(api.get).toHaveBeenCalledTimes(calls);
  view.unmount(); expect(vi.getTimerCount()).toBe(0);
});

it('never overlaps pending reads under StrictMode, manual refresh or elapsed polling time', async () => {
  vi.useFakeTimers(); const api = apiFor();
  api.get.mockImplementation(() => new Promise(() => undefined));
  const view = render(<StrictMode><DiscoverySection api={api} onOpenPerson={vi.fn()} /></StrictMode>);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh shortlist' }));
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(api.get).toHaveBeenCalledTimes(1);
  view.unmount(); expect(vi.getTimerCount()).toBe(0);
});
it('clears a read error on a successful explicit refresh without retrying a command', async () => {
  const api = apiFor(); api.get.mockRejectedValueOnce(new Error('private read'));
  render(<DiscoverySection api={api} onOpenPerson={vi.fn()} />);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh shortlist' }));
  await screen.findByRole('button', { name: 'Contact options for Example Owner' });
  expect(screen.queryByRole('alert')).toBeNull(); expect(api.begin).not.toHaveBeenCalled();
});
it('does not read again after a command resolves following unmount', async () => {
  const api = apiFor(); let resolve!: (value: BeginDiscoveryReceipt) => void;
  api.begin.mockImplementation(() => new Promise(done => { resolve = done; }));
  const view = render(<DiscoverySection api={api} onOpenPerson={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Contact options for Example Owner' }));
  view.unmount();
  await act(async () => resolve({ personId: 'owner-person', salesCycleId: 'cycle-owner-person', assessmentId: brief().assessment!.id, actionId: 'action-owner', mutation: { revision: 2, affectedPersonIds: ['owner-person'], affectedSalesCycleIds: ['cycle-owner-person'] } }));
  expect(api.get).toHaveBeenCalledTimes(1);
});
it('does not abandon a lost reply merely because the founder views another Person evidence', async () => {
  const api = apiFor(); api.get.mockResolvedValue(snapshot([brief(), brief('other')]));
  api.begin.mockRejectedValueOnce(new Error('lost reply'));
  render(<DiscoverySection api={api} onOpenPerson={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Contact options for Example Owner' }));
  await screen.findByRole('button', { name: 'Retry contact options for Example Owner' });
  const first = api.begin.mock.calls[0][0];
  fireEvent.click(screen.getByRole('button', { name: 'View evidence for Other Owner' }));
  fireEvent.click(screen.getByRole('button', { name: 'Retry contact options for Example Owner' }));
  await waitFor(() => expect(api.begin).toHaveBeenCalledTimes(2));
  expect(api.begin.mock.calls[1][0]).toEqual(first);
});
it('renders judgment and paused processing honestly without offering preparation for a conflicted identity', async () => {
  const api = apiFor(); const conflicted = brief();
  conflicted.assessment = { ...conflicted.assessment!, disposition: 'judgment', identitySupported: false, reasonCodes: ['conflicting_identity'], ranking: { ...conflicted.assessment!.ranking, priority: null } };
  api.get.mockResolvedValue({ ...snapshot([]), judgment: [conflicted], processing: 'paused' });
  render(<DiscoverySection api={api} onOpenPerson={vi.fn()} />);
  expect(await screen.findByText(/Preparation paused/)).toBeTruthy();
  expect(screen.getByText('conflicting identity')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Contact options for Example Owner' })).toBeNull();
  expect(api.begin).not.toHaveBeenCalled();
});
it('rejects malformed snapshots rather than rendering invented facts', async () => {
  const api = apiFor(); const invalid = { ...snapshot(), unknownField: 'not accepted' }; api.get.mockResolvedValue(invalid);
  render(<DiscoverySection api={api} onOpenPerson={vi.fn()} />);
  await screen.findByRole('alert'); expect(screen.queryByRole('button', { name: /Contact options for/ })).toBeNull();
});
it('opens successfully prepared contact options after a bounded hung refresh without overlapping reads or a new command', async () => {
  vi.useFakeTimers(); const api = apiFor(); const open = vi.fn();
  api.get.mockResolvedValueOnce(snapshot()).mockImplementation(() => new Promise(() => undefined));
  const view = render(<DiscoverySection api={api} onOpenPerson={open} />);
  await act(async () => undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Contact options for Example Owner' }));
  await act(async () => vi.advanceTimersByTimeAsync(16000));
  expect(open).toHaveBeenCalledWith('owner-person');
  expect(api.begin).toHaveBeenCalledTimes(1); expect(api.get).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('button', { name: /Retry contact options/ })).toBeNull();
  view.unmount(); expect(vi.getTimerCount()).toBe(0);
});

it.each(['success', 'stale'] as const)('refreshes a mounted override %s without repeating the mutation under StrictMode', async outcome => {
  vi.useFakeTimers(); const api = apiFor(); let settle!: () => void;
  api.override.mockImplementation(() => new Promise((resolve, reject) => {
    settle = () => outcome === 'success'
      ? resolve({ revision: 2, affectedPersonIds: ['owner-person'], affectedSalesCycleIds: ['cycle-owner-person'] })
      : reject(new Error('DISCOVERY_STALE_ASSESSMENT'));
  }));
  const view = render(<StrictMode><DiscoverySection api={api} onOpenPerson={vi.fn()} /></StrictMode>);
  await act(async () => undefined);
  expect(api.get).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Adjust discovery' }));
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Existing relationship' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save discovery decision' }));
  await act(async () => { settle(); await vi.advanceTimersByTimeAsync(0); });
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(screen.getByText(outcome === 'success' ? /Discovery decision saved/ : /Evidence changed\. Refresh/)).toBeTruthy();
  expect(api.override).toHaveBeenCalledTimes(1); expect(api.begin).not.toHaveBeenCalled();
  view.unmount(); expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ['success', 'unmount'], ['stale', 'unmount'],
  ['success', 'replace-api'], ['stale', 'replace-api'],
  ['success', 'return-api'], ['stale', 'return-api'],
] as const)('does not restart Today reads or timers after late override %s and %s', async (outcome, change) => {
  vi.useFakeTimers(); const api = apiFor(); const replacement = apiFor(); let settle!: () => void;
  api.override.mockImplementation(() => new Promise((resolve, reject) => {
    settle = () => outcome === 'success'
      ? resolve({ revision: 2, affectedPersonIds: ['owner-person'], affectedSalesCycleIds: ['cycle-owner-person'] })
      : reject(new Error('DISCOVERY_STALE_ASSESSMENT'));
  }));
  const tree = (current: DiscoveryApi) => <StrictMode><DiscoverySection api={current} onOpenPerson={vi.fn()} /></StrictMode>;
  const view = render(tree(api));
  await act(async () => undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Adjust discovery' }));
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Original decision' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save discovery decision' }));
  expect(api.override).toHaveBeenCalledTimes(1);
  if (change === 'unmount') view.unmount();
  else {
    view.rerender(tree(replacement)); await act(async () => undefined);
    if (change === 'return-api') { view.rerender(tree(api)); await act(async () => undefined); }
  }
  // Drain jsdom's zero-delay focus work before observing discovery timers.
  await act(async () => vi.advanceTimersByTimeAsync(0));
  // A forbidden late read would remain pending and expose its leaked timeout.
  api.get.mockImplementation(() => new Promise(() => undefined));
  const reads = api.get.mock.calls.length; const replacementReads = replacement.get.mock.calls.length;
  const timers = vi.getTimerCount(); const html = view.container.innerHTML;
  await act(async () => settle());
  expect.soft(api.get).toHaveBeenCalledTimes(reads);
  expect.soft(replacement.get).toHaveBeenCalledTimes(replacementReads);
  expect.soft(vi.getTimerCount()).toBe(timers);
  expect.soft(view.container.innerHTML).toBe(html);
  expect(api.override).toHaveBeenCalledTimes(1); expect(replacement.override).not.toHaveBeenCalled();
  expect(api.begin).not.toHaveBeenCalled();
  view.unmount(); expect(vi.getTimerCount()).toBe(0);
});
