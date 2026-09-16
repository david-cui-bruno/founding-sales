// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RequestedEmailPreparation } from './RequestedEmailPreparation';
import { dailyFixture, nativeDeskFixture, configuredFixtureStatus, fixtureNow, requestedDraft } from './nativeDesk.fixture';
import { createCallCampaignDraft } from '../../../shared/contracts/callCampaignDraft';
import { delegatedPhoneStateSchema } from '../../../shared/contracts/delegatedPhoneStateContract';
import type { PrepareRequestedFollowup, SavedRequestedFollowup } from '../../../shared/contracts/requestedFollowupContract';
import type { DailySnapshot } from '../../../shared/contracts/dailyContract';
import { setDailySessionScope } from './dailySessionScope';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function fixture() {
  const selector = { accountId: 'a', enrollmentId: 'enrollment', stepId: 'call-step' };
  const prepareId = '11111111-1111-4111-8111-111111111111', commandId = '22222222-2222-4222-8222-222222222222';
  const originalCall = { commandId, handoffId: 'handoff', actionId: 'action', commandFingerprint: 'a'.repeat(64), outcomeEventId: 'outcome', outcomeEventHash: 'b'.repeat(64) };
  const version = { ...createCallCampaignDraft({ campaignId: 'campaign', versionId: 'version', stepId: selector.stepId, accountId: 'a', offer: 'Fictional call purpose' }), approvedAt: fixtureNow };
  const campaign = { campaignId: 'campaign', campaignRevision: 1, enrollmentId: 'enrollment', enrollmentRevision: 1, stepId: 'call-step' };
  const payload = { actionId: 'action', channel: 'call', routeId: 'phone', routeVersion: 1, targetHash: 'c'.repeat(64), contentHash: 'd'.repeat(64), contextRevision: 'context', campaign };
  const outcome = { actionId: 'action', channel: 'call', outcome: 'connected', observedAt: fixtureNow, evidenceRef: 'human-report', replyText: null as null };
  const receipt = (id: string, aggregateVersion: number) => ({ commandId: id, status: 'applied', authorityGeneration: 1, aggregateVersion, reason: null as null });
  const history = delegatedPhoneStateSchema.parse({ ...selector, workspaceId: 'ws', generatedAt: fixtureNow, remote: 'unknown', campaign: { campaignId: 'campaign', campaignRevision: 1, campaignVersionId: 'version' }, completeness: 'complete', issue: null,
    attempts: [{ command: { commandId: prepareId, workspaceId: 'ws', accountId: 'a', kind: 'prepare-manual', expectedAuthorityGeneration: 1, expectedVersion: 1, payload }, queuedAt: fixtureNow, receipt: receipt(prepareId, 2), receiptEvent: { eventId: 'prepared', kind: 'manual.handoff', authorityGeneration: 1, aggregateVersion: 2, appliedAt: fixtureNow }, handoff: { value: { ...payload, handoffId: 'handoff', expiresAt: '2026-09-10T12:00:00.000Z' }, authorityGeneration: 1, consumedAt: fixtureNow } }],
    completions: [{ prepareCommandId: prepareId, command: { commandId, workspaceId: 'ws', accountId: 'a', kind: 'complete-manual', expectedAuthorityGeneration: 1, expectedVersion: 2, payload: { handoffId: 'handoff', targetHash: payload.targetHash, outcome } }, queuedAt: fixtureNow, receipt: receipt(commandId, 3), receiptEvent: { eventId: 'outcome', kind: 'manual.outcome', authorityGeneration: 1, aggregateVersion: 3, appliedAt: fixtureNow }, applied: { outcome, campaignCommandId: commandId, originalCall,
      evidence: { ...selector, campaignVersionId: 'version', routeId: 'phone', routeVersion: 1, outcome: 'connected', observedAt: fixtureNow, observation: 'unknown', source: 'human', executionContextId: 'context', contextRevision: 1, state: 'human_reported_sent', actionId: 'action', channel: 'call' } } }],
  });
  const snapshot = dailyFixture({ answers: [], ownerStatus: [{ accountId: 'a', authority: { accountId: 'a', owner: 'worker', generation: 1, state: 'active' }, executionVersion: 3, pendingCommands: [], status: 'owner_applied' }], campaigns: [{ version, snapshotHash: 'e'.repeat(64), caps: [], enrollments: [{ id: 'enrollment', accountId: 'a', campaignVersionId: 'version', selectedRouteId: 'phone', selectedRouteVersion: 1, personId: null, currentStepId: null, version: 2, state: 'conversation', contextRevision: 1, executionContextId: 'context', startedAt: fixtureNow }] }] });
  let current = snapshot;
  const base = nativeDeskFixture(snapshot).api;
  const result = (input: PrepareRequestedFollowup): SavedRequestedFollowup => ({ draft: { ...requestedDraft(), id: input.draftId ?? requestedDraft().id, originalCall, recipient: input.recipientBinding.email, recipientBinding: structuredClone(input.recipientBinding), subject: '', body: '' }, stale: true, approval: null });
  const prepare = vi.fn(async (input: PrepareRequestedFollowup) => result(input));
  const readHistory = vi.fn(async () => structuredClone(history));
  const api = { ...base, daily: { get: vi.fn(async () => structuredClone(current)) }, delegation: { ...base.delegation, status: vi.fn(async () => configuredFixtureStatus()), prepareRequestedFollowup: prepare, getPhoneHandoffState: readHistory } };
  setDailySessionScope(api.delegation, 'ws');
  const props = { api, snapshot, config: configuredFixtureStatus(), selector, originalCall, onRefresh: vi.fn() };
  const publish = (saved: SavedRequestedFollowup) => { current = { ...current, answers: [{ kind: 'requested_followup', accountId: 'a', draft: saved.draft, approval: saved.approval, capability: 'held', reason: 'requires_owner_preflight' }] }; };
  return { props, api, prepare, readHistory, result, history, publish, setSnapshot(value: DailySnapshot) { current = value; } };
}
function create() {
  fireEvent.change(screen.getByRole('textbox', { name: 'Recipient email' }), { target: { value: 'requested@example.invalid' } });
  const button = screen.getByRole('button', { name: 'Create unsent requested draft' }); fireEvent.click(button); return button;
}
it('does no preparation or context reads on mount, validates recipient, and creates only once for a double click', async () => {
  const f = fixture(); render(<RequestedEmailPreparation {...f.props} />);
  expect(f.api.daily.get).not.toHaveBeenCalled(); expect(f.readHistory).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'Create unsent requested draft' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(create()); await screen.findByText(/Draft saved for requested@example.invalid/);
  expect(f.prepare).toHaveBeenCalledTimes(1); expect(f.prepare).toHaveBeenCalledWith({ draftId: expect.any(String), accountId: 'a', originalCall: f.props.originalCall, expectedAccountVersion: 1, mode: 'manual', recipientBinding: { kind: 'owner_supplied', email: 'requested@example.invalid', originalCall: f.props.originalCall } });
  expect(Object.isFrozen(f.prepare.mock.calls[0][0])).toBe(true);
  expect(Object.isFrozen(f.prepare.mock.calls[0][0].recipientBinding)).toBe(true);
});
it('recovers a lost response from daily saved drafts after remount without replacement preparation', async () => {
  const f = fixture(); f.prepare.mockImplementation(async input => { f.publish(f.result(input)); throw Error('Lost reply'); });
  const view = render(<RequestedEmailPreparation {...f.props} />); create();
  await screen.findByRole('button', { name: 'Refresh saved requested drafts' }); await waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(1));
  view.unmount(); render(<RequestedEmailPreparation {...f.props} />);
  expect((screen.getByRole('button', { name: 'Create unsent requested draft' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh saved requested drafts' }));
  await screen.findByText(/Draft saved for requested@example.invalid/); expect(f.prepare).toHaveBeenCalledTimes(1);
});
it('keeps unresolved creation held across account selection and empty recovery', async () => {
  const f = fixture(); f.prepare.mockRejectedValue(Error('Unknown')); const view = render(<RequestedEmailPreparation {...f.props} />); create();
  await waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(1)); await waitFor(() => expect((screen.getByRole('button', { name: 'Refresh saved requested drafts' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh saved requested drafts' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Refresh saved requested drafts' }) as HTMLButtonElement).disabled).toBe(false));
  expect(f.prepare).toHaveBeenCalledTimes(2); expect(f.prepare.mock.calls[1][0]).toEqual(f.prepare.mock.calls[0][0]);
  view.rerender(<RequestedEmailPreparation {...f.props} originalCall={{ ...f.props.originalCall, outcomeEventId: 'other' }} />);
  expect(screen.getByText(/Another requested draft creation remains unresolved/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Create unsent requested draft' }) as HTMLButtonElement).disabled).toBe(true);
});
it('cancels a pending context read when selection or workspace is held', async () => {
  const f = fixture(); let resolve!: (value: DailySnapshot) => void;
  f.api.daily.get.mockImplementation(() => new Promise(r => { resolve = r; }));
  const view = render(<RequestedEmailPreparation {...f.props} />); create();
  view.rerender(<RequestedEmailPreparation {...f.props} unavailable />);
  await act(async () => resolve(f.props.snapshot));
  expect(f.readHistory).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled(); expect(f.props.onRefresh).not.toHaveBeenCalled();
});
it('does not publish a late create after teardown and recovers its actual saved draft explicitly', async () => {
  const f = fixture(); let resolve!: (value: SavedRequestedFollowup) => void;
  f.prepare.mockImplementation(() => new Promise(r => { resolve = r; }));
  const view = render(<RequestedEmailPreparation {...f.props} />); create(); await waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(1));
  const saved = f.result(f.prepare.mock.calls[0][0]); view.unmount(); f.publish(saved); await act(async () => resolve(saved));
  expect(f.props.onRefresh).not.toHaveBeenCalled(); render(<RequestedEmailPreparation {...f.props} />);
  expect(screen.queryByText(/Draft saved for/)).toBeNull(); fireEvent.click(screen.getByRole('button', { name: 'Refresh saved requested drafts' }));
  await screen.findByText(/Draft saved for/); expect(f.prepare).toHaveBeenCalledTimes(1);
});
it.each(['account', 'owner', 'origin'] as const)('refuses changed fresh %s evidence before preparation', async kind => {
  const f = fixture(), changed = structuredClone(f.props.snapshot);
  if (kind === 'account') changed.accounts[0].account.version++;
  if (kind === 'owner') changed.ownerStatus[0].authority!.state = 'paused';
  if (kind === 'origin') { const h = structuredClone(f.history); delete h.completions[0].applied!.originalCall; f.readHistory.mockResolvedValue(h); }
  f.setSnapshot(changed); render(<RequestedEmailPreparation {...f.props} />); create();
  await screen.findByRole('alert'); expect(f.prepare).not.toHaveBeenCalled();
});
it('continues a preexisting exact saved draft instead of creating another', async () => {
  const f = fixture(); f.publish(f.result({ accountId: 'a', originalCall: f.props.originalCall, recipientBinding: { kind: 'owner_supplied', email: 'requested@example.invalid', originalCall: f.props.originalCall }, expectedAccountVersion: 1, mode: 'manual' }));
  render(<RequestedEmailPreparation {...f.props} />); create(); await screen.findByText(/Draft saved for/);
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.readHistory).not.toHaveBeenCalled();
});
it('holds mismatched saved recipient responses rather than publishing success', async () => {
  const f = fixture(); f.prepare.mockImplementation(async input => { const result = f.result(input); result.draft.recipient = 'other@example.invalid'; result.draft.recipientBinding.email = result.draft.recipient; return result; });
  render(<RequestedEmailPreparation {...f.props} />); create(); await screen.findByRole('alert');
  expect(screen.queryByText(/Draft saved for/)).toBeNull(); expect(f.prepare).toHaveBeenCalledTimes(1);
  expect((screen.getByRole('button', { name: 'Create unsent requested draft' }) as HTMLButtonElement).disabled).toBe(true);
});
it('replacing the read API cannot publish a late result or start another creation on the same bridge', async () => {
  const f = fixture(); let resolve!: (value: SavedRequestedFollowup) => void;
  f.prepare.mockImplementation(() => new Promise(r => { resolve = r; }));
  const view = render(<RequestedEmailPreparation {...f.props} />); create(); await waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(1));
  const replacement = { ...f.api, daily: { get: vi.fn(async () => f.props.snapshot) } };
  view.rerender(<RequestedEmailPreparation {...f.props} api={replacement} />);
  await act(async () => resolve(f.result(f.prepare.mock.calls[0][0])));
  expect(f.props.onRefresh).not.toHaveBeenCalled(); expect(screen.queryByText(/Draft saved for/)).toBeNull();
  expect((screen.getByRole('button', { name: 'Create unsent requested draft' }) as HTMLButtonElement).disabled).toBe(true);
  expect(f.prepare).toHaveBeenCalledTimes(1);
});
it('does not choose among multiple matching saved drafts or create another one', async () => {
  const f = fixture(); const input: PrepareRequestedFollowup = { accountId: 'a', originalCall: f.props.originalCall, recipientBinding: { kind: 'owner_supplied', email: 'requested@example.invalid', originalCall: f.props.originalCall }, expectedAccountVersion: 1, mode: 'manual' };
  const saved = f.result(input); const answer: Extract<DailySnapshot['answers'][number], { kind: 'requested_followup' }> = { kind: 'requested_followup', accountId: 'a', draft: saved.draft, approval: null, capability: 'held', reason: 'requires_owner_preflight' };
  f.setSnapshot({ ...f.props.snapshot, answers: [answer, { ...answer, draft: { ...saved.draft, id: 'second' } }] });
  render(<RequestedEmailPreparation {...f.props} />); create(); await screen.findByText(/Several saved drafts match/);
  expect(f.prepare).not.toHaveBeenCalled(); expect(screen.queryByText(/Draft saved for/)).toBeNull();
});
it.each(['daily', 'status', 'history'] as const)('sanitizes raw %s errors before any preparation request', async stage => {
  const f = fixture(), privateError = Error('private-provider-token@example.invalid');
  if (stage === 'daily') f.api.daily.get.mockRejectedValue(privateError);
  if (stage === 'status') f.api.delegation.status.mockRejectedValue(privateError);
  if (stage === 'history') f.readHistory.mockRejectedValue(privateError);
  render(<RequestedEmailPreparation {...f.props} />); create();
  expect((await screen.findByRole('alert')).textContent).toBe('Requested draft preparation is unavailable. Refresh the current account and try again.');
  expect(screen.queryByText(/private-provider-token/)).toBeNull();
  expect(f.prepare).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'Create unsent requested draft' }) as HTMLButtonElement).disabled).toBe(false);
});
