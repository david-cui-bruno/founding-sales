// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CallCampaignDraft } from './CallCampaignDraft';
import { configuredFixtureStatus, dailyFixture, nativeDeskFixture, nativeDeskReviewFixture } from '../today/nativeDesk.fixture';
import { setDailySessionScope } from '../today/dailySessionScope';
import { ownerCampaignCommandSchema } from '../../../shared/contracts/ownerCommandContract';
import { createCallCampaignDraft } from '../../../shared/contracts/callCampaignDraft';
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
