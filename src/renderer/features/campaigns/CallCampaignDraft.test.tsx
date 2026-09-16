// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CallCampaignDraft } from './CallCampaignDraft';
import { configuredFixtureStatus, dailyFixture, nativeDeskFixture, nativeDeskReviewFixture } from '../today/nativeDesk.fixture';
import { setDailySessionScope } from '../today/dailySessionScope';
import { ownerCampaignCommandSchema } from '../../../shared/contracts/ownerCommandContract';
import { createCallCampaignDraft, createLinkedInCampaignDraft, describeCallCampaignTemplate } from '../../../shared/contracts/callCampaignDraft';
import type { DailySnapshot } from '../../../shared/contracts/dailyContract';
import type { CampaignVersion } from '../../../shared/contracts/campaignContract';

afterEach(cleanup);
const saved = 'Campaign draft saved. Not approved or enrolled.';
const offer = 'Discuss a short maintenance workflow review.';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture() {
  const snapshot = nativeDeskReviewFixture();
  snapshot.campaigns = [];
  snapshot.ownerStatus.forEach(o => { if (o.authority) o.authority.generation = 7; });
  const f = nativeDeskFixture(snapshot);
  const delegation: { -readonly [K in keyof typeof f.api.delegation]: typeof f.api.delegation[K] } = f.api.delegation;
  const fixtureSync = f.api.delegation.sync;
  delegation.sync = async () => ({ ...await fixtureSync(), ownerFresh: true });
  const submit = vi.fn<typeof f.api.delegation.submit>(async command => ({
    commandId: command.commandId, status: 'applied', authorityGeneration: 7, aggregateVersion: 10, reason: null,
  }));
  delegation.submit = submit;
  const refresh = vi.fn();
  const props = { api: f.api, snapshot, config: configuredFixtureStatus(), readError: false, onRefresh: refresh };
  setDailySessionScope(f.api.delegation, 'ws');
  return { ...f, submit, refresh, props };
}
function fill() {
  fireEvent.click(screen.getByRole('button', { name: 'New call campaign' }));
  fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'a' } });
  fireEvent.change(screen.getByLabelText('Meeting offer'), { target: { value: offer } });
}
function save() { fireEvent.click(screen.getByRole('button', { name: 'Save call campaign draft' })); }
function button() { return screen.getByRole<HTMLButtonElement>('button', { name: 'Save call campaign draft' }); }
function version(f: ReturnType<typeof fixture>): CampaignVersion {
  const command = ownerCampaignCommandSchema.parse(f.submit.mock.calls[0][0]);
  if (command.payload.kind !== 'campaign.version') throw Error('Expected campaign version command');
  return command.payload.version;
}
function projection(snapshot: DailySnapshot, version: CampaignVersion): DailySnapshot {
  return { ...snapshot, campaigns: [{ version, snapshotHash: 'a'.repeat(64), caps: [], enrollments: [] }] };
}

it('starts collapsed and saves an immutable draft despite incomplete call allocation, using fresh owner execution version', async () => {
  const f = fixture();
  f.props.snapshot.freshness.kind = 'incomplete';
  f.props.snapshot.callSettings = { newCallSlots: null, totalCallCapacity: null };
  f.props.snapshot.issues = [{ code: 'call_allocation_unconfigured', count: 1 }];
  const fresh = structuredClone(f.props.snapshot);
  fresh.ownerStatus[0].executionVersion = 9;
  f.setSnapshot(fresh);
  f.submit.mockImplementation(async command => {
    expect(command.kind).toBe('campaign-command');
    if (command.kind !== 'campaign-command' || command.payload.kind !== 'campaign.version') throw Error('Wrong command');
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.payload.version.steps[0])).toBe(true);
    f.setSnapshot(projection(fresh, command.payload.version));
    return { commandId: command.commandId, status: 'applied', authorityGeneration: 7, aggregateVersion: 10, reason: null };
  });
  render(<CallCampaignDraft {...f.props} />);
  expect(screen.queryByLabelText('Meeting offer')).toBeNull();
  expect(f.calls).toEqual([]);
  fill();
  expect(screen.getByText('Saves an unapproved campaign draft. This does not enroll accounts, activate a campaign, or start outreach.')).toBeTruthy();
  save();
  await screen.findByText(saved);
  expect(f.submit).toHaveBeenCalledTimes(1);
  const command = f.submit.mock.calls[0][0];
  const draft = version(f);
  expect(command).toEqual({ commandId: expect.any(String), workspaceId: 'ws', accountId: 'a', expectedAuthorityGeneration: 7,
    expectedVersion: 9, kind: 'campaign-command', payload: { kind: 'campaign.version', version: draft } });
  expect(draft).toEqual(createCallCampaignDraft({ campaignId: draft.campaignId, versionId: draft.id, stepId: draft.steps[0].id, accountId: 'a', offer }));
  expect(draft).toMatchObject({ version: 1, approvedAt: null, cohortAccountIds: ['a'], channelCaps: { call: 1, email: 0, linkedin: 0 },
    steps: [{ channel: 'call', condition: 'initial', delayHours: 0 }] });
  const ids = [command.commandId, draft.id, draft.campaignId, draft.steps[0].id];
  expect(new Set(ids).size).toBe(4);
  ids.forEach(id => expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
  expect(f.calls.map(c => c.method)).toEqual(['delegation.sync', 'daily.get', 'delegation.status', 'delegation.sync', 'daily.get']);
  expect(f.refresh).toHaveBeenCalledTimes(1);
});

it('does not treat HTTP/applied or matching IDs as saved and releases the hold only for full canonical version equivalence', async () => {
  const f = fixture();
  const view = render(<CallCampaignDraft {...f.props} />);
  fill(); save();
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  expect(screen.queryByText(saved)).toBeNull();
  expect(button().disabled).toBe(true);
  const draft = version(f);
  const wrong: CampaignVersion[] = [
    { ...draft, offer: 'Different offer' }, { ...draft, channelCaps: { call: 2, email: 0, linkedin: 0 } },
    { ...draft, approvedAt: '2026-09-09T12:00:00.000Z' }, { ...draft, cohortAccountIds: ['b'] },
    { ...draft, steps: [{ ...draft.steps[0], delayHours: 2 }] }, { ...draft, contentPolicyHash: 'b'.repeat(64) },
  ];
  for (const version of wrong) {
    view.rerender(<CallCampaignDraft {...f.props} snapshot={projection(f.props.snapshot, version)} />);
    expect(screen.queryByText(saved)).toBeNull();
    expect(button().disabled).toBe(true);
  }
  view.rerender(<CallCampaignDraft {...f.props} snapshot={projection({ ...f.props.snapshot, workspaceId: 'foreign' }, draft)} />);
  expect(screen.queryByText(saved)).toBeNull();
  view.rerender(<CallCampaignDraft {...f.props} snapshot={projection(f.props.snapshot, draft)} />);
  expect(screen.getByText(saved)).toBeTruthy();
  expect(f.submit).toHaveBeenCalledTimes(1);
});

it('retains unsent edits and open state across route remount, isolated by both API namespaces and workspace', () => {
  const f = fixture();
  const view = render(<CallCampaignDraft {...f.props} />);
  fill(); view.unmount();
  const next = render(<CallCampaignDraft {...f.props} />);
  expect(screen.getByLabelText<HTMLTextAreaElement>('Meeting offer').value).toBe(offer);
  expect(screen.getByLabelText<HTMLSelectElement>('Company').value).toBe('a');
  for (const api of [{ ...f.api, daily: { ...f.api.daily } }, { ...f.api, delegation: { ...f.api.delegation } }]) {
    next.rerender(<CallCampaignDraft {...f.props} api={api} />);
    expect(screen.queryByLabelText('Meeting offer')).toBeNull();
  }
  next.rerender(<CallCampaignDraft {...f.props} snapshot={{ ...f.props.snapshot, workspaceId: 'other' }} />);
  expect(screen.queryByLabelText('Meeting offer')).toBeNull();
  next.rerender(<CallCampaignDraft {...f.props} />);
  expect(screen.getByLabelText<HTMLTextAreaElement>('Meeting offer').value).toBe(offer);
  expect(f.submit).not.toHaveBeenCalled();
});

it('retains a possibly queued command on submit error and remount without minting or retrying commands', async () => {
  const f = fixture();
  f.submit.mockRejectedValue(Error('PRIVATE endpoint and token'));
  const view = render(<CallCampaignDraft {...f.props} />);
  fill(); save();
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  const command = f.submit.mock.calls[0][0];
  view.unmount();
  const next = render(<CallCampaignDraft {...f.props} />);
  expect(screen.getByText(/Campaign draft pending/)).toBeTruthy();
  expect(screen.queryByText(/PRIVATE/)).toBeNull();
  expect(screen.getByLabelText<HTMLTextAreaElement>('Meeting offer').disabled).toBe(true);
  expect(screen.getByLabelText<HTMLSelectElement>('Company').disabled).toBe(true);
  save();
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(f.submit.mock.calls[0][0]).toBe(command);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Retry same pending draft' }).disabled).toBe(false);
  next.rerender(<CallCampaignDraft {...f.props} snapshot={projection(f.props.snapshot, version(f))} />);
  expect(screen.getByText(saved)).toBeTruthy();
});

it('synchronously blocks double save before the first await and disables editing while busy', async () => {
  const f = fixture();
  const gate = deferred<Awaited<ReturnType<typeof f.api.delegation.sync>>>();
  const sync = vi.spyOn(f.api.delegation, 'sync').mockReturnValueOnce(gate.promise);
  render(<CallCampaignDraft {...f.props} />);
  fill();
  const form = button().closest('form')!;
  act(() => { fireEvent.submit(form); fireEvent.submit(form); });
  expect(sync).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText<HTMLTextAreaElement>('Meeting offer').disabled).toBe(true);
  expect(screen.getByLabelText<HTMLSelectElement>('Company').disabled).toBe(true);
  await act(async () => gate.resolve({ applied: 0, gaps: 0, cursor: null, ownerFresh: true }));
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  expect(f.submit).toHaveBeenCalledTimes(1);
});

it('holds unconfigured, foreign, read-error, legacy, invalid scope and inactive or unknown account owner states', () => {
  const f = fixture();
  const view = render(<CallCampaignDraft {...f.props} />);
  fill();
  const blocked = [
    { config: null }, { config: { ...f.props.config, state: 'unconfigured' as const } },
    { config: { ...f.props.config, workspaceId: 'foreign' } }, { readError: true },
    { snapshot: { ...f.props.snapshot, workflowMode: 'legacy' as const } },
    { snapshot: { ...f.props.snapshot, issues: [{ code: 'scope_mismatch' as const, count: 1 }] } },
    ...['missing', 'local', 'inactive', 'version', 'pending'].map(kind => {
      const snapshot = structuredClone(f.props.snapshot);
      const owner = snapshot.ownerStatus[0];
      if (kind === 'missing') owner.authority = null;
      if (kind === 'local' && owner.authority) owner.authority.owner = 'local';
      if (kind === 'inactive' && owner.authority) owner.authority.state = 'paused';
      if (kind === 'version') owner.executionVersion = null;
      if (kind === 'pending') owner.pendingCommands = [{ commandId: 'pending-command', status: 'pending', authorityGeneration: 7, aggregateVersion: 1, reason: null }];
      return { snapshot };
    }),
  ];
  for (const change of blocked) {
    view.rerender(<CallCampaignDraft {...f.props} {...change} />);
    expect(button().disabled).toBe(true);
    fireEvent.submit(button().closest('form')!);
  }
  expect(f.calls).toEqual([]);
  expect(f.submit).not.toHaveBeenCalled();
});

it('revalidates fresh workspace, account, authority, pending work and configuration rather than trusting props', async () => {
  for (const change of ['workspace', 'account', 'authority', 'pending', 'config', 'malformed']) {
    const f = fixture();
    const fresh = structuredClone(f.props.snapshot);
    if (change === 'workspace') fresh.workspaceId = 'foreign';
    if (change === 'account') fresh.accounts[0].account.version++;
    if (change === 'authority') fresh.ownerStatus[0].authority!.generation++;
    if (change === 'pending') fresh.ownerStatus[0].pendingCommands = [{ commandId: 'pending', status: 'pending', authorityGeneration: 7, aggregateVersion: 1, reason: null }];
    f.setSnapshot(fresh);
    if (change === 'config') f.setConfiguration({ ...f.props.config, configuration: { ...f.props.config.configuration!, revision: 2 } });
    if (change === 'malformed') vi.spyOn(f.api.delegation, 'status').mockResolvedValue({ state: 'mystery' } as unknown as typeof f.props.config);
    const view = render(<CallCampaignDraft {...f.props} />);
    fill(); save();
    await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
    expect(f.submit).not.toHaveBeenCalled();
    expect(screen.getByText(/Campaign draft could not be saved/)).toBeTruthy();
    expect(screen.queryByText(saved)).toBeNull();
    view.unmount();
  }
});

it('does not submit after delayed preflight when scope or readiness departs, even if the same view returns', async () => {
  for (const change of ['scope', 'read-error', 'pending', 'api']) {
    const f = fixture();
    const gate = deferred<DailySnapshot>();
    vi.spyOn(f.api.daily, 'get').mockReturnValueOnce(gate.promise);
    const view = render(<CallCampaignDraft {...f.props} />);
    fill(); save();
    await waitFor(() => expect(f.api.daily.get).toHaveBeenCalledTimes(1));
    if (change === 'scope') {
      setDailySessionScope(f.api.delegation, null);
      setDailySessionScope(f.api.delegation, 'ws');
    } else if (change === 'read-error') {
      view.rerender(<CallCampaignDraft {...f.props} readError />);
      view.rerender(<CallCampaignDraft {...f.props} />);
    } else if (change === 'pending') {
      const held = structuredClone(f.props.snapshot);
      held.ownerStatus[0].pendingCommands = [{ commandId: 'pending', status: 'pending', authorityGeneration: 7, aggregateVersion: 1, reason: null }];
      view.rerender(<CallCampaignDraft {...f.props} snapshot={held} />);
      view.rerender(<CallCampaignDraft {...f.props} />);
    } else {
      view.rerender(<CallCampaignDraft {...f.props} api={{ ...f.api, daily: { ...f.api.daily } }} />);
      view.rerender(<CallCampaignDraft {...f.props} />);
    }
    await act(async () => gate.resolve(f.props.snapshot));
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
    expect(screen.queryByText(saved)).toBeNull();
    view.unmount();
  }
});

it('invalidates delayed preflight on route unmount even if remounted with the same bridge', async () => {
  const f = fixture();
  const gate = deferred<DailySnapshot>();
  vi.spyOn(f.api.daily, 'get').mockReturnValueOnce(gate.promise);
  const view = render(<CallCampaignDraft {...f.props} />);
  fill(); save();
  await waitFor(() => expect(f.api.daily.get).toHaveBeenCalledTimes(1));
  view.unmount();
  render(<CallCampaignDraft {...f.props} />);
  await act(async () => gate.resolve(f.props.snapshot));
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.refresh).not.toHaveBeenCalled();
  expect(screen.getByLabelText<HTMLTextAreaElement>('Meeting offer').value).toBe(offer);
  expect(button().disabled).toBe(false);
});

it('lets already queued work settle after API replacement without stale success or refresh in the new view', async () => {
  const f = fixture();
  const gate = deferred<Awaited<ReturnType<typeof f.api.delegation.submit>>>();
  f.submit.mockReturnValueOnce(gate.promise);
  const view = render(<CallCampaignDraft {...f.props} />);
  fill(); save();
  await waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1));
  f.setSnapshot(projection(f.props.snapshot, version(f)));
  const other = fixture();
  view.rerender(<CallCampaignDraft {...other.props} />);
  const beforeSettlement = [...f.calls];
  await act(async () => gate.resolve({ commandId: f.submit.mock.calls[0][0].commandId, status: 'applied', authorityGeneration: 7, aggregateVersion: 2, reason: null }));
  expect(f.calls).toEqual(beforeSettlement);
  expect(screen.queryByText(saved)).toBeNull();
  expect(f.refresh).not.toHaveBeenCalled();
  expect(other.refresh).not.toHaveBeenCalled();
  expect(other.submit).not.toHaveBeenCalled();
  view.rerender(<CallCampaignDraft {...f.props} />);
  expect(screen.getByText(/Campaign draft pending/)).toBeTruthy();
  view.rerender(<CallCampaignDraft {...f.props} snapshot={f.snapshot()} />);
  expect(screen.getByText(saved)).toBeTruthy();
});

it.each([{ ownerFresh: false, gaps: 0 }, { ownerFresh: true, gaps: 1 }])('does not queue a new draft when owner synchronization is incomplete: %j', async report => {
  const f = fixture();
  vi.spyOn(f.api.delegation, 'sync').mockResolvedValue({ applied: 0, cursor: null, ...report });
  render(<CallCampaignDraft {...f.props} />);
  fill(); save();
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  expect(f.submit).not.toHaveBeenCalled();
  expect(button().disabled).toBe(false);
  expect(screen.getByText(/Campaign draft could not be saved/)).toBeTruthy();
});

it('keeps the form usable after its exact command is durably rejected, without silently retrying', async () => {
  const f = fixture();
  f.submit.mockImplementationOnce(async command => ({ commandId: command.commandId, status: 'rejected', authorityGeneration: 7, aggregateVersion: 10, reason: 'PRIVATE rejection details' }));
  render(<CallCampaignDraft {...f.props} />);
  fill(); save();
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/Campaign draft pending/)).toBeNull();
  expect(screen.queryByText(/PRIVATE/)).toBeNull();
  expect(screen.getByText(/Campaign draft could not be saved/)).toBeTruthy();
  expect(screen.getByLabelText<HTMLTextAreaElement>('Meeting offer').value).toBe(offer);
  expect(button().disabled).toBe(false);
});

it('explicitly retries only the same pending draft and releases an exact later rejection', async () => {
  const f = fixture();
  f.submit.mockImplementationOnce(async command => ({ commandId: command.commandId, status: 'pending', authorityGeneration: 7, aggregateVersion: 10, reason: null }));
  render(<CallCampaignDraft {...f.props} />);
  fill(); save();
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  const original = f.submit.mock.calls[0][0];
  expect(screen.getByText(/Campaign draft pending/)).toBeTruthy();
  f.submit.mockImplementationOnce(async command => ({ commandId: command.commandId, status: 'rejected', authorityGeneration: 7, aggregateVersion: 10, reason: 'PRIVATE owner rejection' }));
  fireEvent.click(screen.getByRole('button', { name: 'Retry same pending draft' }));
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(2));
  expect(f.submit).toHaveBeenCalledTimes(2);
  expect(f.submit.mock.calls[1][0]).toBe(original);
  expect(screen.queryByText(/Campaign draft pending/)).toBeNull();
  expect(screen.queryByText(/PRIVATE/)).toBeNull();
  expect(button().disabled).toBe(false);
  expect(screen.getByLabelText<HTMLTextAreaElement>('Meeting offer').value).toBe(offer);
});

it('does not release a pending identity for another command’s rejection', async () => {
  const f = fixture();
  f.submit.mockResolvedValueOnce({ commandId: 'other-command', status: 'rejected', authorityGeneration: 7, aggregateVersion: 10, reason: null });
  render(<CallCampaignDraft {...f.props} />);
  fill(); save();
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  expect(screen.getByText(/Campaign draft pending/)).toBeTruthy();
  expect(button().disabled).toBe(true);
  expect(f.submit).toHaveBeenCalledTimes(1);
});

it('keeps a known command held when post-submit canonical reads fail and never displays raw errors', async () => {
  const f = fixture();
  vi.spyOn(f.api.daily, 'get').mockResolvedValueOnce(f.props.snapshot).mockRejectedValueOnce(Error('SECRET raw database failure'));
  render(<CallCampaignDraft {...f.props} />);
  fill(); save();
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  expect(screen.getByText(/Campaign draft pending/)).toBeTruthy();
  expect(screen.queryByText(/SECRET/)).toBeNull();
  expect(screen.queryByText(saved)).toBeNull();
  expect(button().disabled).toBe(true);
  expect(f.submit).toHaveBeenCalledTimes(1);
});

it('holds fresh read failures before queue and preserves the editable form', async () => {
  const f = fixture();
  vi.spyOn(f.api.daily, 'get').mockRejectedValue(Error('SECRET raw read failure'));
  render(<CallCampaignDraft {...f.props} snapshot={dailyFixture({ ownerStatus: f.props.snapshot.ownerStatus })} />);
  fill(); save();
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  expect(screen.getByText(/Campaign draft could not be saved/)).toBeTruthy();
  expect(screen.queryByText(/SECRET/)).toBeNull();
  expect(f.submit).not.toHaveBeenCalled();
  expect(screen.getByLabelText<HTMLTextAreaElement>('Meeting offer').value).toBe(offer);
  expect(screen.getByLabelText<HTMLTextAreaElement>('Meeting offer').disabled).toBe(false);
});

const copyLabel = 'Copy selected company to worker';
const delegateLabel = 'Delegate selected company';
const reconcileLabel = 'Reconcile queued preparation';
const retryPreparationLabel = 'Retry same preparation';
function preparationFixture(checkpoint: 'absent' | 'zero' | 'copied' | 'active' = 'absent') {
  const f = fixture();
  const owner = f.props.snapshot.ownerStatus[0];
  owner.pendingCommands = [];
  owner.status = checkpoint === 'active' ? 'owner_applied' : 'unknown';
  owner.authority = checkpoint === 'absent' ? null : { accountId: 'a', generation: checkpoint === 'active' ? 7 : 0,
    owner: checkpoint === 'active' ? 'worker' : 'local', state: checkpoint === 'active' ? 'active' : 'local' };
  owner.executionVersion = checkpoint === 'absent' ? null : checkpoint === 'zero' ? 0 : checkpoint === 'copied' ? 1 : 19;
  f.setSnapshot(f.props.snapshot);
  const bootstrap = vi.spyOn(f.api.delegation, 'bootstrap').mockImplementation(async command => ({
    commandId: command.commandId, status: 'applied', authorityGeneration: 0, aggregateVersion: 1, reason: null,
  }));
  return { ...f, bootstrap };
}
function reviewPreparation() { fireEvent.click(screen.getByRole('button', { name: 'Review worker preparation' })); }
function clickPreparation(name: string) { fireEvent.click(screen.getByRole('button', { name })); }

it.each(['absent', 'zero', 'copied', 'active'] as const)('derives the %s checkpoint without effects on mount, selection, review, refresh or remount', checkpoint => {
  const f = preparationFixture(checkpoint);
  const view = render(<CallCampaignDraft {...f.props} />);
  fill(); reviewPreparation();
  expect(!!screen.queryByRole('button', { name: copyLabel })).toBe(checkpoint === 'absent' || checkpoint === 'zero');
  expect(!!screen.queryByRole('button', { name: delegateLabel })).toBe(checkpoint === 'copied');
  expect(button().disabled).toBe(checkpoint !== 'active');
  expect(screen.getByText(/Unsent local drafts and this meeting offer are not included/)).toBeTruthy();
  expect(screen.getByText(/Synchronization can replay previously queued workspace commands/)).toBeTruthy();
  view.rerender(<CallCampaignDraft {...f.props} snapshot={structuredClone(f.props.snapshot)} />);
  view.unmount();
  render(<CallCampaignDraft {...f.props} />);
  expect(f.calls).toEqual([]);
  expect(f.bootstrap).not.toHaveBeenCalled();
  expect(f.submit).not.toHaveBeenCalled();
});

it('copies only the selected saved identity, delegates on a separate click and leaves save separate', async () => {
  const f = preparationFixture();
  const view = render(<CallCampaignDraft {...f.props} />);
  fill(); reviewPreparation();
  f.bootstrap.mockImplementation(async command => {
    const next = structuredClone(f.props.snapshot);
    next.ownerStatus[0] = { accountId: 'a', authority: { accountId: 'a', owner: 'local', state: 'local', generation: 0 },
      executionVersion: 1, pendingCommands: [], status: 'unknown' };
    f.setSnapshot(next);
    return { commandId: command.commandId, status: 'applied', authorityGeneration: 0, aggregateVersion: 1, reason: null };
  });
  clickPreparation(copyLabel);
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  expect(f.bootstrap).toHaveBeenCalledTimes(1);
  expect(f.bootstrap.mock.calls[0][0]).toEqual({ commandId: expect.any(String), accountId: 'a' });
  expect(Object.isFrozen(f.bootstrap.mock.calls[0][0])).toBe(true);
  expect(f.submit).not.toHaveBeenCalled();
  view.rerender(<CallCampaignDraft {...f.props} snapshot={f.snapshot()} />);
  expect(screen.queryByRole('button', { name: copyLabel })).toBeNull();
  f.submit.mockImplementation(async command => {
    const next = structuredClone(f.snapshot());
    next.ownerStatus[0] = { accountId: 'a', authority: { accountId: 'a', owner: 'worker', state: 'active', generation: 1 },
      executionVersion: 2, pendingCommands: [], status: 'owner_applied' };
    f.setSnapshot(next);
    return { commandId: command.commandId, status: 'applied', authorityGeneration: 1, aggregateVersion: 2, reason: null };
  });
  clickPreparation(delegateLabel);
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(2));
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(f.submit.mock.calls[0][0]).toEqual({ commandId: expect.any(String), accountId: 'a', workspaceId: 'ws',
    kind: 'delegate', expectedAuthorityGeneration: 0, expectedVersion: 1,
    payload: { delegationId: expect.any(String), approvedAt: expect.any(String) } });
  expect(Object.isFrozen(f.submit.mock.calls[0][0].payload)).toBe(true);
  view.rerender(<CallCampaignDraft {...f.props} snapshot={f.snapshot()} />);
  expect(screen.queryByRole('button', { name: delegateLabel })).toBeNull();
  expect(button().disabled).toBe(false);
  expect(screen.getByLabelText<HTMLTextAreaElement>('Meeting offer').value).toBe(offer);
});

it.each(['missing', 'duplicate', 'inconsistent', 'paused', 'revoked', 'delegating', 'version', 'pending', 'pending-status'])('holds preparation for %s ownership', kind => {
  const f = preparationFixture('copied');
  const owner = f.props.snapshot.ownerStatus[0];
  if (kind === 'missing') f.props.snapshot.ownerStatus = [];
  if (kind === 'duplicate') f.props.snapshot.ownerStatus.push(structuredClone(owner));
  if (kind === 'inconsistent') owner.authority = null;
  if (kind === 'paused' || kind === 'revoked' || kind === 'delegating') owner.authority!.state = kind;
  if (kind === 'version') owner.executionVersion = 2;
  if (kind === 'pending') owner.pendingCommands = [{ commandId: 'any-command-kind', status: 'pending', authorityGeneration: 0, aggregateVersion: 1, reason: null }];
  if (kind === 'pending-status') owner.status = 'pending';
  render(<CallCampaignDraft {...f.props} />);
  fill(); reviewPreparation();
  expect(screen.queryByRole('button', { name: copyLabel })).toBeNull();
  expect(screen.queryByRole('button', { name: delegateLabel })).toBeNull();
  expect(button().disabled).toBe(true);
  expect(f.calls).toEqual([]);
});

it.each(['record', 'fingerprint', 'owner', 'checkpoint', 'config', 'malformed', 'gaps', 'stale'])('holds new preparation when fresh %s changes', async change => {
  const f = preparationFixture();
  const fresh = structuredClone(f.props.snapshot);
  if (change === 'record') fresh.accounts[0].unknowns.push('new reviewed fact');
  if (change === 'fingerprint') fresh.accounts[0].fingerprint = 'b'.repeat(64);
  if (change === 'owner') fresh.ownerStatus.push(structuredClone(fresh.ownerStatus[0]));
  if (change === 'checkpoint') fresh.ownerStatus[0] = { accountId: 'a', authority: { accountId: 'a', owner: 'local', state: 'local', generation: 0 }, executionVersion: 1, pendingCommands: [], status: 'unknown' };
  f.setSnapshot(fresh);
  if (change === 'config') f.setConfiguration({ ...f.props.config, configuration: { ...f.props.config.configuration!, revision: 2 } });
  if (change === 'malformed') vi.spyOn(f.api.daily, 'get').mockResolvedValue({} as DailySnapshot);
  if (change === 'gaps' || change === 'stale') vi.spyOn(f.api.delegation, 'sync').mockResolvedValue({ applied: 0, cursor: null, gaps: change === 'gaps' ? 1 : 0, ownerFresh: change !== 'stale' });
  render(<CallCampaignDraft {...f.props} />);
  fill(); reviewPreparation(); clickPreparation(copyLabel);
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  expect(f.bootstrap).not.toHaveBeenCalled();
  expect(f.submit).not.toHaveBeenCalled();
});

it.each(['copy', 'delegate'] as const)('shares synchronous latch for double %s and save/reconcile', async kind => {
  const f = preparationFixture(kind === 'copy' ? 'absent' : 'copied');
  const gate = deferred<Awaited<ReturnType<typeof f.api.delegation.sync>>>();
  const sync = vi.spyOn(f.api.delegation, 'sync').mockReturnValueOnce(gate.promise);
  render(<CallCampaignDraft {...f.props} />);
  fill(); reviewPreparation();
  const action = screen.getByRole('button', { name: kind === 'copy' ? copyLabel : delegateLabel });
  act(() => { fireEvent.click(action); fireEvent.click(action); fireEvent.submit(button().closest('form')!); clickPreparation(reconcileLabel); });
  expect(sync).toHaveBeenCalledTimes(1);
  await act(async () => gate.resolve({ applied: 0, gaps: 0, cursor: null, ownerFresh: true }));
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  expect(f.bootstrap).toHaveBeenCalledTimes(kind === 'copy' ? 1 : 0);
  expect(f.submit).toHaveBeenCalledTimes(kind === 'delegate' ? 1 : 0);
});

it.each(['scope', 'unmount', 'bridge', 'lock', 'selection', 'record'])('invalidates delayed preparation on %s change and return', async change => {
  const f = preparationFixture();
  const gate = deferred<DailySnapshot>();
  vi.spyOn(f.api.daily, 'get').mockReturnValueOnce(gate.promise);
  const view = render(<CallCampaignDraft {...f.props} />);
  fill(); reviewPreparation(); clickPreparation(copyLabel);
  await waitFor(() => expect(f.api.daily.get).toHaveBeenCalledTimes(1));
  if (change === 'scope') { setDailySessionScope(f.api.delegation, null); setDailySessionScope(f.api.delegation, 'ws'); }
  if (change === 'unmount') { view.unmount(); render(<CallCampaignDraft {...f.props} />); }
  if (change === 'bridge') { view.rerender(<CallCampaignDraft {...f.props} api={{ ...f.api, daily: { ...f.api.daily } }} />); view.rerender(<CallCampaignDraft {...f.props} />); }
  if (change === 'lock') { view.rerender(<CallCampaignDraft {...f.props} config={{ ...f.props.config, state: 'locked' }} />); view.rerender(<CallCampaignDraft {...f.props} />); }
  if (change === 'selection') { fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'b' } }); fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'a' } }); }
  if (change === 'record') { const changed = structuredClone(f.props.snapshot); changed.accounts[0].unknowns.push('changed'); view.rerender(<CallCampaignDraft {...f.props} snapshot={changed} />); view.rerender(<CallCampaignDraft {...f.props} />); }
  await act(async () => gate.resolve(f.props.snapshot));
  expect(f.bootstrap).not.toHaveBeenCalled();
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.refresh).not.toHaveBeenCalled();
});

it.each(['throw', 'wrong-id'])('retains uncertain preparation on %s and remount, recovering only through explicit sync', async outcome => {
  const f = preparationFixture();
  if (outcome === 'throw') f.bootstrap.mockRejectedValue(Error('PRIVATE HTTP refusal after queue'));
  else f.bootstrap.mockImplementation(async command => ({ commandId: outcome === 'wrong-id' ? 'other' : command.commandId,
    status: 'rejected', authorityGeneration: 0, aggregateVersion: 0, reason: 'PRIVATE' }));
  const view = render(<CallCampaignDraft {...f.props} />);
  fill(); reviewPreparation(); clickPreparation(copyLabel);
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  const original = f.bootstrap.mock.calls[0][0];
  expect(screen.getByText(`Preparation command: ${original.commandId}`)).toBeTruthy();
  expect(screen.queryByText(/PRIVATE/)).toBeNull();
  view.unmount();
  const next = render(<CallCampaignDraft {...f.props} />);
  expect(f.bootstrap).toHaveBeenCalledTimes(1);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: copyLabel }).disabled).toBe(true);
  const recovered = structuredClone(f.props.snapshot);
  recovered.ownerStatus[0] = { accountId: 'a', authority: { accountId: 'a', owner: 'local', state: 'local', generation: 0 }, executionVersion: 1, pendingCommands: [], status: 'unknown' };
  f.setSnapshot(recovered);
  clickPreparation(reconcileLabel);
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(2));
  next.rerender(<CallCampaignDraft {...f.props} snapshot={recovered} />);
  expect(screen.queryByText(`Preparation command: ${original.commandId}`)).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: delegateLabel }).disabled).toBe(false);
  expect(f.bootstrap).toHaveBeenCalledTimes(1);
  expect(f.submit).not.toHaveBeenCalled();
});

it('recovers unchanged-record prequeue bootstrap failure by explicitly retrying the same frozen identity', async () => {
  const f = preparationFixture();
  f.bootstrap.mockRejectedValueOnce(Error('export failed before queue'));
  render(<CallCampaignDraft {...f.props} />);
  fill(); reviewPreparation(); clickPreparation(copyLabel);
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  const original = f.bootstrap.mock.calls[0][0];
  clickPreparation(retryPreparationLabel);
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(2));
  expect(f.bootstrap).toHaveBeenCalledTimes(2);
  expect(f.bootstrap.mock.calls[1][0]).toBe(original);
  expect(f.submit).not.toHaveBeenCalled();
});

it('releases only a schema-valid exact preparation rejection so the form is not permanently locked', async () => {
  const f = preparationFixture();
  f.bootstrap.mockImplementation(async command => ({ commandId: command.commandId, status: 'rejected',
    authorityGeneration: 0, aggregateVersion: 0, reason: 'durable rejection' }));
  render(<CallCampaignDraft {...f.props} />);
  fill(); reviewPreparation(); clickPreparation(copyLabel);
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText<HTMLTextAreaElement>('Meeting offer').disabled).toBe(false);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: copyLabel }).disabled).toBe(false);
  expect(screen.queryByText(/Preparation command:/)).toBeNull();
  expect(f.bootstrap).toHaveBeenCalledTimes(1);
});

it('retries a delegate using the identical frozen command and complete approval payload', async () => {
  const f = preparationFixture('copied');
  f.submit.mockRejectedValueOnce(Error('queue outcome uncertain'));
  render(<CallCampaignDraft {...f.props} />);
  fill(); reviewPreparation(); clickPreparation(delegateLabel);
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  const original = f.submit.mock.calls[0][0];
  const originalPayload = original.payload;
  clickPreparation(retryPreparationLabel);
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(2));
  expect(f.submit).toHaveBeenCalledTimes(2);
  expect(f.submit.mock.calls[1][0]).toBe(original);
  expect(f.submit.mock.calls[1][0].payload).toBe(originalPayload);
  expect(Object.isFrozen(originalPayload)).toBe(true);
  expect(f.bootstrap).not.toHaveBeenCalled();
});

it('holds a malformed exact-ID rejected receipt rather than treating transport output as durable rejection', async () => {
  const f = preparationFixture();
  f.bootstrap.mockImplementation(async command => ({ commandId: command.commandId, status: 'rejected' }) as Awaited<ReturnType<typeof f.api.delegation.bootstrap>>);
  render(<CallCampaignDraft {...f.props} />);
  fill(); reviewPreparation(); clickPreparation(copyLabel);
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  expect(screen.getByText(`Preparation command: ${f.bootstrap.mock.calls[0][0].commandId}`)).toBeTruthy();
  expect(screen.getByLabelText<HTMLTextAreaElement>('Meeting offer').disabled).toBe(true);
});

it.each(['copy', 'delegate'] as const)('stops a %s retry when synchronization already completed its checkpoint', async kind => {
  const f = preparationFixture(kind === 'copy' ? 'absent' : 'copied');
  if (kind === 'copy') f.bootstrap.mockRejectedValueOnce(Error('uncertain copy'));
  else f.submit.mockRejectedValueOnce(Error('uncertain delegate'));
  render(<CallCampaignDraft {...f.props} />);
  fill(); reviewPreparation(); clickPreparation(kind === 'copy' ? copyLabel : delegateLabel);
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  const recovered = structuredClone(f.props.snapshot);
  recovered.ownerStatus[0] = kind === 'copy'
    ? { accountId: 'a', authority: { accountId: 'a', owner: 'local', state: 'local', generation: 0 }, executionVersion: 1, pendingCommands: [], status: 'unknown' }
    : { accountId: 'a', authority: { accountId: 'a', owner: 'worker', state: 'active', generation: 1 }, executionVersion: 2, pendingCommands: [], status: 'owner_applied' };
  f.setSnapshot(recovered);
  clickPreparation(retryPreparationLabel);
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(2));
  expect(f.bootstrap).toHaveBeenCalledTimes(kind === 'copy' ? 1 : 0);
  expect(f.submit).toHaveBeenCalledTimes(kind === 'delegate' ? 1 : 0);
  expect(screen.queryByText(/Preparation command:/)).toBeNull();
});

it.each(['evidence', 'config', 'owner', 'pending'])('does not retry under changed original %s facts, while explicit sync remains available', async change => {
  const f = preparationFixture();
  f.bootstrap.mockRejectedValueOnce(Error('uncertain original export'));
  const view = render(<CallCampaignDraft {...f.props} />);
  fill(); reviewPreparation(); clickPreparation(copyLabel);
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  const original = f.bootstrap.mock.calls[0][0];
  const changed = structuredClone(f.props.snapshot);
  let config = f.props.config;
  if (change === 'evidence') { changed.accounts[0].unknowns.push('new local evidence'); changed.accounts[0].fingerprint = 'c'.repeat(64); }
  if (change === 'config') config = { ...config, configuration: { ...config.configuration!, revision: 2 } };
  if (change === 'owner') changed.ownerStatus[0] = { accountId: 'a', authority: { accountId: 'a', owner: 'local', state: 'local', generation: 1 }, executionVersion: 0, pendingCommands: [], status: 'unknown' };
  if (change === 'pending') { changed.ownerStatus[0].status = 'pending'; changed.ownerStatus[0].pendingCommands = [{ commandId: 'generic-other-intent', status: 'pending', authorityGeneration: 0, aggregateVersion: 0, reason: null }]; }
  f.setSnapshot(changed); f.setConfiguration(config);
  view.rerender(<CallCampaignDraft {...f.props} snapshot={changed} config={config} />);
  clickPreparation(retryPreparationLabel);
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(2));
  expect(f.bootstrap).toHaveBeenCalledTimes(1);
  expect(screen.getByText(`Preparation command: ${original.commandId}`)).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: reconcileLabel }).disabled).toBe(false);
  const recovered = structuredClone(changed);
  recovered.ownerStatus[0] = { accountId: 'a', authority: { accountId: 'a', owner: 'local', state: 'local', generation: 0 }, executionVersion: 1, pendingCommands: [], status: 'unknown' };
  f.setSnapshot(recovered);
  clickPreparation(reconcileLabel);
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(3));
  expect(screen.queryByText(/Preparation command:/)).toBeNull();
  expect(f.bootstrap).toHaveBeenCalledTimes(1);
  expect(f.submit).not.toHaveBeenCalled();
});

it.each(['scope', 'unmount', 'bridge', 'lock', 'selection'])('invalidates delayed same-ID retry on %s departure and return', async change => {
  const f = preparationFixture();
  f.bootstrap.mockRejectedValueOnce(Error('prequeue failure'));
  const view = render(<CallCampaignDraft {...f.props} />);
  fill(); reviewPreparation(); clickPreparation(copyLabel);
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  const gate = deferred<DailySnapshot>();
  const daily = vi.spyOn(f.api.daily, 'get').mockReturnValueOnce(gate.promise);
  clickPreparation(retryPreparationLabel);
  await waitFor(() => expect(daily).toHaveBeenCalledTimes(1));
  if (change === 'scope') { setDailySessionScope(f.api.delegation, null); setDailySessionScope(f.api.delegation, 'ws'); }
  if (change === 'unmount') { view.unmount(); render(<CallCampaignDraft {...f.props} />); }
  if (change === 'bridge') { view.rerender(<CallCampaignDraft {...f.props} api={{ ...f.api, daily: { ...f.api.daily } }} />); view.rerender(<CallCampaignDraft {...f.props} />); }
  if (change === 'lock') { view.rerender(<CallCampaignDraft {...f.props} config={{ ...f.props.config, state: 'locked' }} />); view.rerender(<CallCampaignDraft {...f.props} />); }
  if (change === 'selection') { fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'b' } }); fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'a' } }); }
  await act(async () => gate.resolve(f.props.snapshot));
  expect(f.bootstrap).toHaveBeenCalledTimes(1);
  expect(f.refresh).toHaveBeenCalledTimes(1);
});

it.each([false, true])('retries the same retained absent-authority copy after exact local g0v0 initialization, refreshed=%s', async refreshed => {
  const f = preparationFixture();
  const placeholder = structuredClone(f.props.snapshot);
  placeholder.ownerStatus[0] = { accountId: 'a', authority: { accountId: 'a', owner: 'local', state: 'local', generation: 0 },
    executionVersion: 0, pendingCommands: [], status: 'unknown' };
  f.bootstrap.mockImplementationOnce(async () => { f.setSnapshot(placeholder); throw Error('after initializeLocalAuthority, before queue'); });
  const view = render(<CallCampaignDraft {...f.props} />);
  fill(); reviewPreparation(); clickPreparation(copyLabel);
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  const original = f.bootstrap.mock.calls[0][0];
  if (refreshed) view.rerender(<CallCampaignDraft {...f.props} snapshot={placeholder} />);
  expect(screen.getByText(`Preparation command: ${original.commandId}`)).toBeTruthy();
  expect(f.snapshot().ownerStatus[0]).toMatchObject({ executionVersion: 0, pendingCommands: [] });
  f.bootstrap.mockImplementationOnce(async command => {
    const applied = structuredClone(placeholder);
    applied.ownerStatus[0].executionVersion = 1;
    f.setSnapshot(applied);
    return { commandId: command.commandId, status: 'applied', authorityGeneration: 0, aggregateVersion: 1, reason: null };
  });
  clickPreparation(retryPreparationLabel);
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(2));
  expect(f.bootstrap).toHaveBeenCalledTimes(2);
  expect(f.bootstrap.mock.calls[1][0]).toBe(original);
  expect(Object.isFrozen(original)).toBe(true);
  expect(screen.queryByText(/Preparation command:/)).toBeNull();
  expect(screen.getByLabelText<HTMLTextAreaElement>('Meeting offer').value).toBe(offer);
  expect(f.submit).not.toHaveBeenCalled();
  view.rerender(<CallCampaignDraft {...f.props} snapshot={f.snapshot()} />);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: delegateLabel }).disabled).toBe(false);
  expect(button().disabled).toBe(true);
});

it.each(['reverse', 'generation', 'state', 'status', 'version', 'pending', 'duplicate', 'identity', 'record', 'config'])('does not normalize %s changes into a retained copy placeholder', async change => {
  const f = preparationFixture(change === 'reverse' ? 'zero' : 'absent');
  f.bootstrap.mockRejectedValueOnce(Error('copy failed before queue'));
  const view = render(<CallCampaignDraft {...f.props} />);
  fill(); reviewPreparation(); clickPreparation(copyLabel);
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  const original = f.bootstrap.mock.calls[0][0];
  const changed = structuredClone(f.props.snapshot);
  const owner = changed.ownerStatus[0] = { accountId: 'a', authority: { accountId: 'a', owner: 'local', state: 'local', generation: 0 },
    executionVersion: 0, pendingCommands: [], status: 'unknown' } as DailySnapshot['ownerStatus'][number];
  let config = f.props.config;
  if (change === 'reverse') { owner.authority = null; owner.executionVersion = null; }
  if (change === 'generation') owner.authority!.generation = 1;
  if (change === 'state') owner.authority!.state = 'delegating';
  if (change === 'status') owner.status = 'owner_applied';
  if (change === 'version') owner.executionVersion = null;
  if (change === 'pending') owner.pendingCommands = [{ commandId: 'any-pending', status: 'pending', authorityGeneration: 0, aggregateVersion: 0, reason: null }];
  if (change === 'duplicate') changed.ownerStatus.push(structuredClone(owner));
  if (change === 'identity') owner.authority!.accountId = 'b';
  if (change === 'record') { changed.accounts[0].fingerprint = 'd'.repeat(64); changed.accounts[0].unknowns.push('changed evidence'); }
  if (change === 'config') config = { ...config, configuration: { ...config.configuration!, revision: 2 } };
  f.setSnapshot(changed); f.setConfiguration(config);
  view.rerender(<CallCampaignDraft {...f.props} snapshot={changed} config={config} />);
  clickPreparation(retryPreparationLabel);
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(2));
  expect(f.bootstrap).toHaveBeenCalledTimes(1);
  expect(f.submit).not.toHaveBeenCalled();
  expect(screen.getByText(`Preparation command: ${original.commandId}`)).toBeTruthy();
  expect(screen.getByLabelText<HTMLTextAreaElement>('Meeting offer').value).toBe(offer);
});

it('saves the exact one-step LinkedIn template only after an explicit channel choice, defaulting to the call template', async () => {
  const f = fixture();
  f.submit.mockImplementation(async command => {
    if (command.kind !== 'campaign-command' || command.payload.kind !== 'campaign.version') throw Error('Wrong command');
    f.setSnapshot(projection(f.props.snapshot, command.payload.version));
    return { commandId: command.commandId, status: 'applied', authorityGeneration: 7, aggregateVersion: 10, reason: null };
  });
  render(<CallCampaignDraft {...f.props} />);
  fill();
  const channel = screen.getByLabelText<HTMLSelectElement>('Channel');
  expect(channel.value).toBe('call');
  expect([...channel.options].map(option => option.value)).toEqual(['call', 'linkedin']);
  expect(button().disabled).toBe(false);
  fireEvent.change(channel, { target: { value: 'linkedin' } });
  expect(screen.queryByRole('button', { name: 'Save call campaign draft' })).toBeNull();
  expect(screen.getByText('Saves an unapproved LinkedIn campaign draft. This does not enroll accounts, prepare or send a note, or start outreach.')).toBeTruthy();
  const saveLinkedIn = screen.getByRole<HTMLButtonElement>('button', { name: 'Save LinkedIn campaign draft' });
  expect(saveLinkedIn.disabled).toBe(false);
  fireEvent.click(saveLinkedIn);
  await screen.findByText(saved);
  expect(f.submit).toHaveBeenCalledTimes(1);
  const draft = version(f);
  expect(draft).toEqual(createLinkedInCampaignDraft({ campaignId: draft.campaignId, versionId: draft.id, stepId: draft.steps[0].id, accountId: 'a', offer }));
  expect(draft).toMatchObject({ approvedAt: null, channelCaps: { call: 0, email: 0, linkedin: 1 }, steps: [{ channel: 'linkedin', condition: 'initial', delayHours: 0 }] });
  expect(describeCallCampaignTemplate(draft)).toBeNull();
  expect(f.calls.map(c => c.method)).toEqual(['delegation.sync', 'daily.get', 'delegation.status', 'delegation.sync', 'daily.get']);
});

it('drops a saved confirmation when the channel changes and locks the channel while a draft is pending', async () => {
  const f = fixture();
  const gate = deferred<Awaited<ReturnType<typeof f.api.delegation.submit>>>();
  f.submit.mockReturnValueOnce(gate.promise);
  render(<CallCampaignDraft {...f.props} />);
  fill();
  fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'linkedin' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save LinkedIn campaign draft' }));
  await waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText<HTMLSelectElement>('Channel').disabled).toBe(true);
  const command = f.submit.mock.calls[0][0];
  if (command.kind !== 'campaign-command' || command.payload.kind !== 'campaign.version') throw Error('Wrong command');
  f.setSnapshot(projection(f.props.snapshot, command.payload.version));
  await act(async () => gate.resolve({ commandId: command.commandId, status: 'applied', authorityGeneration: 7, aggregateVersion: 10, reason: null }));
  await screen.findByText(saved);
  expect(screen.getByLabelText<HTMLSelectElement>('Channel').disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'call' } });
  expect(screen.queryByText(saved)).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save call campaign draft' }).disabled).toBe(false);
  expect(f.submit).toHaveBeenCalledTimes(1);
});
