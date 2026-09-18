// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TerritoryCallPolicyPanel, territoryPolicyCopy } from './TerritoryCallPolicyPanel';
import { CallCampaignDraft } from './CallCampaignDraft';
import { configuredFixtureStatus, nativeDeskFixture, nativeDeskReviewFixture } from '../today/nativeDesk.fixture';
import { DEFAULT_TERRITORY_CALL_POLICY_DEFINITION as DEFAULT, territoryCallPolicyId, type TerritoryCallPolicyRequest, type TerritoryCallPolicyStatus } from '../../../shared/contracts/territoryCallPolicyContract';

afterEach(cleanup);
const now = '2026-09-18T12:00:00.000Z';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function fixture() {
  const snapshot = nativeDeskReviewFixture();
  const f = nativeDeskFixture(snapshot);
  const delegation: { -readonly [K in keyof typeof f.api.delegation]: typeof f.api.delegation[K] } = f.api.delegation;
  const worker = { policy: null as TerritoryCallPolicyStatus['policy'], revision: 0, lose: 0 };
  const requests: TerritoryCallPolicyRequest[] = [];
  const bridge = vi.fn(async (request: TerritoryCallPolicyRequest): Promise<TerritoryCallPolicyStatus> => {
    requests.push(request);
    const reply = (receipt: TerritoryCallPolicyStatus['receipt']): TerritoryCallPolicyStatus => ({ workspaceId: 'ws', policy: worker.policy, definition: DEFAULT, receipt });
    if (request.kind === 'read') return reply(null);
    // This fake worker models the call policy only. Adding a state is its own record with its own revision
    // (lane 36), and this panel never sends one, so it is refused here rather than counted against the policy.
    if (request.kind === 'add-state') return reply({ commandId: request.commandId, status: 'rejected', authorityGeneration: 0, aggregateVersion: worker.revision, reason: 'territory_add_state_not_modelled' });
    if (worker.lose > 0) { worker.lose--; throw Error('Lost reply after a durable owner write'); }
    if (request.expectedRevision !== worker.revision) return reply({ commandId: request.commandId, status: 'rejected', authorityGeneration: 0, aggregateVersion: worker.revision, reason: 'policy_revision_conflict' });
    worker.revision++;
    worker.policy = request.kind === 'approve'
      ? { ...DEFAULT, policyId: territoryCallPolicyId('ws'), workspaceId: 'ws', pairingId: 'pair', revision: worker.revision, state: 'active', approvedAt: now, approvedRevision: worker.revision, updatedAt: now }
      : { ...worker.policy!, revision: worker.revision, state: request.state, updatedAt: now };
    return reply({ commandId: request.commandId, status: 'applied', authorityGeneration: 0, aggregateVersion: worker.revision, reason: null });
  });
  delegation.territoryPolicy = bridge;
  const props = { api: f.api, snapshot, config: configuredFixtureStatus(), readError: false };
  return { ...f, snapshot, delegation, worker, requests, bridge, props };
}
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });

it('shows the fixed sequence, caps, objective and audience without any call, then approves once behind the disclosure and pauses and resumes with the revision on each receipt', async () => {
  const f = fixture();
  render(<TerritoryCallPolicyPanel {...f.props} />);
  expect(f.calls).toEqual([]);
  expect(f.bridge).not.toHaveBeenCalled();
  const panel = within(screen.getByRole('region', { name: territoryPolicyCopy.region }));
  expect(panel.getByRole('heading', { name: 'Territory call policy' })).toBeTruthy();
  expect(panel.getAllByRole('listitem').map(item => item.textContent)).toEqual(['Day 0 · Call', 'Day 3 · Call', 'Day 7 · Email T4 · held: mailbox not connected', 'Day 12 · Call', 'Day 21 · Email T5 · held: mailbox not connected']);
  expect(panel.getByText(/^3 calls and 3 emails per firm\. 30 new firms a day/)).toBeTruthy();
  expect(panel.getByText('Objective: meeting.')).toBeTruthy();
  expect(panel.getByText('Audience: every firm the Places discovery creates in this workspace.')).toBeTruthy();
  expect(panel.getByText(territoryPolicyCopy.unread)).toBeTruthy();
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.queryByRole('button', { name: territoryPolicyCopy.approve })).toBeNull();
  fireEvent.click(button(territoryPolicyCopy.read));
  await screen.findByText(territoryPolicyCopy.none);
  expect(f.requests).toEqual([{ kind: 'read' }]);
  const approve = button(territoryPolicyCopy.approve);
  expect(approve.disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: territoryPolicyCopy.disclosure }));
  expect(approve.disabled).toBe(false);
  fireEvent.click(approve);
  await screen.findByText(/^Active · revision 1 · approved 2026-09-18T12:00:00\.000Z as revision 1\./);
  expect(screen.getByText('Receipt: applied · revision 1')).toBeTruthy();
  expect(f.requests[1]).toEqual({ kind: 'approve', commandId: expect.stringMatching(uuid), expectedRevision: 0 });
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.queryByRole('button', { name: territoryPolicyCopy.approve })).toBeNull();
  fireEvent.click(button(territoryPolicyCopy.pause));
  await screen.findByText(/^Paused · revision 2\./);
  expect(screen.getByText('Receipt: applied · revision 2')).toBeTruthy();
  expect(f.requests[2]).toEqual({ kind: 'set-state', commandId: expect.stringMatching(uuid), expectedRevision: 1, state: 'paused' });
  fireEvent.click(button(territoryPolicyCopy.resume));
  await screen.findByText(/^Active · revision 3 · approved 2026-09-18T12:00:00\.000Z as revision 1\./);
  expect(f.requests[3]).toEqual({ kind: 'set-state', commandId: expect.stringMatching(uuid), expectedRevision: 2, state: 'active' });
  expect(f.bridge).toHaveBeenCalledTimes(4);
  expect(new Set(f.requests.flatMap(request => 'commandId' in request ? [request.commandId] : [])).size).toBe(3);
  expect(f.calls).toEqual([]);
});
it('keeps the pending command identity across a lost reply and retries the identical command instead of minting another', async () => {
  const f = fixture();
  render(<TerritoryCallPolicyPanel {...f.props} />);
  fireEvent.click(button(territoryPolicyCopy.read));
  await screen.findByText(territoryPolicyCopy.none);
  f.worker.lose = 1;
  fireEvent.click(screen.getByRole('checkbox', { name: territoryPolicyCopy.disclosure }));
  fireEvent.click(button(territoryPolicyCopy.approve));
  await screen.findByText(territoryPolicyCopy.pending);
  const first = f.requests[1];
  if (!first || first.kind !== 'approve') throw Error('approve expected');
  expect(screen.getByText(`Policy command: ${first.commandId}`)).toBeTruthy();
  expect(screen.queryByRole('button', { name: territoryPolicyCopy.approve })).toBeNull();
  expect(button(territoryPolicyCopy.read).disabled).toBe(true);
  fireEvent.click(button(territoryPolicyCopy.retry));
  await screen.findByText(/^Active · revision 1/);
  expect(f.requests[2]).toEqual(first);
  expect(f.worker.revision).toBe(1);
  expect(screen.queryByText(territoryPolicyCopy.pending)).toBeNull();
});
it('reports a stale revision as the worker\'s rejected receipt and shows the policy the reply carried', async () => {
  const f = fixture();
  render(<TerritoryCallPolicyPanel {...f.props} />);
  fireEvent.click(button(territoryPolicyCopy.read));
  await screen.findByText(territoryPolicyCopy.none);
  // Another device approved in between: the worker's policy stands at revision 1.
  f.worker.revision = 1;
  f.worker.policy = { ...DEFAULT, policyId: territoryCallPolicyId('ws'), workspaceId: 'ws', pairingId: 'other', revision: 1, state: 'active', approvedAt: now, approvedRevision: 1, updatedAt: now };
  fireEvent.click(screen.getByRole('checkbox', { name: territoryPolicyCopy.disclosure }));
  fireEvent.click(button(territoryPolicyCopy.approve));
  await screen.findByText('Receipt: rejected · revision 1 · policy_revision_conflict');
  expect(screen.getByText('policy_revision_conflict', { selector: 'span' })).toBeTruthy();
  expect(screen.getByText(/^Active · revision 1/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: territoryPolicyCopy.approve })).toBeNull();
  expect(button(territoryPolicyCopy.pause).disabled).toBe(false);
});
it('holds without the bridge or an inactive configuration, keeps the folded definition readable and never calls', async () => {
  const f = fixture();
  f.delegation.territoryPolicy = undefined;
  const { unmount } = render(<TerritoryCallPolicyPanel {...f.props} />);
  expect(screen.getByText(territoryPolicyCopy.bridge)).toBeTruthy();
  expect(screen.queryByRole('button', { name: territoryPolicyCopy.read })).toBeNull();
  expect(screen.getByText(territoryPolicyCopy.details)).toBeTruthy();
  expect(screen.getAllByRole('listitem')).toHaveLength(5);
  unmount();
  f.delegation.territoryPolicy = f.bridge;
  // Unpaired or paused workspace: one line, no region, no folded definition, nothing to click.
  render(<TerritoryCallPolicyPanel {...f.props} config={{ ...configuredFixtureStatus(), state: 'paused' }} />);
  expect(screen.getByRole('status').textContent).toBe(`${territoryPolicyCopy.region}: ${territoryPolicyCopy.held}`);
  expect(screen.queryByRole('region')).toBeNull();
  expect(screen.queryByText(territoryPolicyCopy.details)).toBeNull();
  expect(screen.queryByRole('button', { name: territoryPolicyCopy.read })).toBeNull();
  expect(screen.queryByText(territoryPolicyCopy.unread)).toBeNull();
  await waitFor(() => expect(f.bridge).not.toHaveBeenCalled());
  expect(f.calls).toEqual([]);
});
it('mounts above the manual one-company drafts inside CallCampaignDraft without adding a call or a checkbox before a read', () => {
  const f = fixture();
  render(<CallCampaignDraft api={f.api} snapshot={f.snapshot} config={configuredFixtureStatus()} readError={false} onRefresh={() => undefined} />);
  const regions = screen.getAllByRole('region').map(region => region.getAttribute('aria-label'));
  expect(regions.indexOf(territoryPolicyCopy.region)).toBeLessThan(regions.indexOf('New call campaign'));
  expect(screen.getByRole('button', { name: 'New call campaign' })).toBeTruthy();
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(f.calls).toEqual([]);
  expect(f.bridge).not.toHaveBeenCalled();
});
