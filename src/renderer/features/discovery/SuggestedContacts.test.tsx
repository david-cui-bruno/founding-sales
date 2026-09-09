// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { discoveryBriefSchema, discoverySnapshotSchema, type DiscoveryApi, type DiscoveryBrief } from '../../../shared/contracts/discoveryContract';
import { SuggestedContacts } from './SuggestedContacts';

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
it('keeps existing suggestions and an honest error after refresh failure, then clears it on focus recovery', async () => {
  const api = apiFor(); const open = vi.fn(); render(<SuggestedContacts api={api} onOpenPerson={open} />);
  await screen.findByRole('button', { name: 'Example Owner' });
  api.get.mockRejectedValueOnce(new Error('private read'));
  fireEvent(window, new Event('focus')); await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'Example Owner' })).toBeTruthy();
  expect(screen.queryByText(/private read/)).toBeNull();
  fireEvent(window, new Event('focus'));
  await act(async () => undefined);
  expect(screen.queryByRole('alert')).toBeNull(); expect(api.begin).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
});
it('rejects malformed snapshots without inventing suggestions or claiming preparation is running', async () => {
  const api = apiFor(); const malformed = { ...snapshot(), unknownField: true }; api.get.mockResolvedValue(malformed);
  render(<SuggestedContacts api={api} onOpenPerson={vi.fn()} />);
  await screen.findByRole('alert'); expect(screen.queryByRole('button')).toBeNull(); expect(screen.queryByRole('status')).toBeNull();
});
it('labels paused empty suggestions honestly without preparation or lookup', async () => {
  const api = apiFor(); api.get.mockResolvedValue({ ...snapshot([]), processing: 'paused' });
  render(<SuggestedContacts api={api} onOpenPerson={vi.fn()} />);
  await screen.findByText('Contact preparation is paused.');
  expect(screen.getByText('No suggested contacts right now.')).toBeTruthy();
  expect(screen.queryByText(/Checking source evidence/)).toBeNull(); expect(api.begin).not.toHaveBeenCalled();
});
it('bounds polling and removes focus and preparation-event listeners on unmount', async () => {
  vi.useFakeTimers(); const api = apiFor(); api.get.mockResolvedValue(snapshot([]));
  const view = render(<StrictMode><SuggestedContacts api={api} onOpenPerson={vi.fn()} /></StrictMode>);
  await act(async () => undefined);
  expect(screen.getByText('Checking source evidence for suggested contacts…')).toBeTruthy();
  await act(async () => vi.advanceTimersByTimeAsync(600000));
  expect(api.get.mock.calls.length).toBeLessThanOrEqual(13);
  const calls = api.get.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(600000)); expect(api.get).toHaveBeenCalledTimes(calls);
  view.unmount();
  fireEvent(window, new Event('focus')); fireEvent(window, new Event('callie:contact-prepared'));
  await act(async () => undefined); expect(api.get).toHaveBeenCalledTimes(calls); expect(vi.getTimerCount()).toBe(0);
});
it('does not overlap pending reads under StrictMode, focus, preparation events or elapsed polling', async () => {
  vi.useFakeTimers(); const api = apiFor(); api.get.mockImplementation(() => new Promise(() => undefined));
  const view = render(<StrictMode><SuggestedContacts api={api} onOpenPerson={vi.fn()} /></StrictMode>);
  fireEvent(window, new Event('focus')); fireEvent(window, new Event('callie:contact-prepared'));
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(api.get).toHaveBeenCalledOnce(); expect(screen.getByRole('alert')).toBeTruthy(); expect(api.begin).not.toHaveBeenCalled();
  view.unmount(); expect(vi.getTimerCount()).toBe(0);
});
