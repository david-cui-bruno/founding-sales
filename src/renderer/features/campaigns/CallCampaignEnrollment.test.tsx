// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CallCampaignEnrollment } from './CallCampaignEnrollment';
import { configuredFixtureStatus, fixtureNow, nativeDeskFixture, nativeDeskReviewFixture } from '../today/nativeDesk.fixture';
import { setDailySessionScope } from '../today/dailySessionScope';
import { createCallCampaignDraft } from '../../../shared/contracts/callCampaignDraft';
import { ownerCampaignCommandSchema } from '../../../shared/contracts/ownerCommandContract';
import type { DailySnapshot } from '../../../shared/contracts/dailyContract';
import type { Enrollment } from '../../../shared/contracts/campaignContract';
import type { AccountRoute } from '../../../shared/contracts/accountContract';

afterEach(cleanup);
const approvedCopy = 'Call campaign approved. Not enrolled.';
const enrolledCopy = 'Company enrolled for a manual call. No call placed.';
const reviewLabel = 'I reviewed this company, offer, call step and lifetime limits';
const enrollLabel = 'I want this company added to the manual call queue';
const phone: AccountRoute = { id: 'phone', accountId: 'a', personId: null, version: 2, channel: 'phone',
  value: '+1 212 555 0100', purpose: 'business', verification: 'published', evidenceIds: ['source'] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(approved = false) {
  const snapshot = nativeDeskReviewFixture();
  snapshot.answers = [];
  snapshot.meetings = [];
  snapshot.campaigns = [{ version: { ...createCallCampaignDraft({ campaignId: 'campaign', versionId: 'version', stepId: 'step', accountId: 'a', offer: 'Discuss maintenance workflow.' }),
    approvedAt: approved ? fixtureNow : null }, snapshotHash: 'a'.repeat(64), caps: [], enrollments: [] }];
  snapshot.accounts[0].routes = [phone];
  const f = nativeDeskFixture(snapshot);
  const originalSync = f.api.delegation.sync;
  const sync = vi.spyOn(f.api.delegation, 'sync').mockImplementation(async () => ({ ...await originalSync(), ownerFresh: true }));
  const submit = vi.spyOn(f.api.delegation, 'submit').mockImplementation(async command => ({
    commandId: command.commandId, status: 'applied', authorityGeneration: 1, aggregateVersion: 2, reason: null,
  }));
  const refresh = vi.fn();
  const props = { api: f.api, snapshot, campaign: snapshot.campaigns[0], config: configuredFixtureStatus(), readError: false, onRefresh: refresh };
  setDailySessionScope(f.api.delegation, 'ws');
  return { ...f, sync, submit, refresh, props };
}
function approve() {
  fireEvent.click(screen.getByLabelText(reviewLabel));
  fireEvent.click(screen.getByRole('button', { name: 'Approve call campaign' }));
}
function selectRoute() { fireEvent.change(screen.getByLabelText('Business phone route'), { target: { value: 'phone' } }); }
function enroll() {
  selectRoute();
  fireEvent.click(screen.getByLabelText(enrollLabel));
  fireEvent.click(screen.getByRole('button', { name: 'Enroll company for manual call' }));
}
function command(f: ReturnType<typeof fixture>, index = 0) { return ownerCampaignCommandSchema.parse(f.submit.mock.calls[index][0]); }
function enrolled(f: ReturnType<typeof fixture>, index = 0): Enrollment {
  const c = command(f, index);
  if (c.payload.kind !== 'campaign.enroll') throw Error('Expected enrollment');
  return { id: c.payload.enrollmentId, accountId: c.accountId, campaignVersionId: c.payload.campaignVersionId,
    selectedRouteId: c.payload.selectedRouteId, selectedRouteVersion: phone.version, personId: null,
    currentStepId: 'step', version: 1, state: 'active', executionContextId: c.payload.executionContextId,
    contextRevision: c.payload.contextRevision, startedAt: fixtureNow };
}
function projectEnrollment(f: ReturnType<typeof fixture>, enrollment: Enrollment): DailySnapshot {
  const snapshot = structuredClone(f.props.snapshot);
  snapshot.campaigns[0].enrollments = [enrollment];
  return snapshot;
}

it('requires two explicit reviewed requests and confirms exact owner projections, never auto-enrolling or dialing', async () => {
  const f = fixture();
  f.submit.mockImplementation(async raw => {
    const c = ownerCampaignCommandSchema.parse(raw);
    const snapshot = f.snapshot();
    if (c.payload.kind === 'campaign.approve') snapshot.campaigns[0].version.approvedAt = c.payload.approvedAt;
    else if (c.payload.kind === 'campaign.enroll') snapshot.campaigns[0].enrollments = [enrolled(f, 1)];
    else throw Error('Unexpected action');
    snapshot.ownerStatus[0].executionVersion!++;
    f.setSnapshot(snapshot);
    return { commandId: c.commandId, status: 'applied', authorityGeneration: 1, aggregateVersion: 2, reason: null };
  });
  const view = render(<CallCampaignEnrollment {...f.props} />);
  expect(f.calls).toEqual([]);
  expect(f.submit).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Business phone route')).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Approve call campaign' }).disabled).toBe(true);
  approve();
  await screen.findByText(approvedCopy);
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(command(f)).toEqual({ commandId: expect.any(String), workspaceId: 'ws', accountId: 'a', expectedAuthorityGeneration: 1,
    expectedVersion: 1, kind: 'campaign-command', payload: { kind: 'campaign.approve', campaignVersionId: 'version', snapshotHash: 'a'.repeat(64), approvedAt: expect.any(String) } });
  const snapshot = f.snapshot();
  view.rerender(<CallCampaignEnrollment {...f.props} snapshot={snapshot} campaign={snapshot.campaigns[0]} />);
  expect(screen.getByLabelText<HTMLSelectElement>('Business phone route').value).toBe('');
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Enrollment adds a due manual-call item. It does not dial, send messages, or grant contact permission.')).toBeTruthy();
  enroll();
  await screen.findByText(enrolledCopy);
  const c = command(f, 1);
  expect(c).toMatchObject({ workspaceId: 'ws', accountId: 'a', expectedVersion: 2,
    payload: { kind: 'campaign.enroll', campaignVersionId: 'version', selectedRouteId: 'phone', contextRevision: 1 } });
  if (c.payload.kind !== 'campaign.enroll') throw Error('Expected enrollment');
  const ids = [c.commandId, c.payload.enrollmentId, c.payload.executionContextId];
  expect(new Set(ids).size).toBe(3);
  ids.forEach(id => expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
  expect(Object.isFrozen(f.submit.mock.calls[1][0])).toBe(true);
  expect(Object.isFrozen(f.submit.mock.calls[1][0].payload)).toBe(true);
  expect(f.submit).toHaveBeenCalledTimes(2);
  expect(f.calls.every(call => ['delegation.sync', 'daily.get', 'delegation.status'].includes(call.method))).toBe(true);
});

it('does not confuse receipts or matching IDs with exact canonical approval', async () => {
  const f = fixture();
  const view = render(<CallCampaignEnrollment {...f.props} />);
  approve();
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  expect(screen.queryByText(approvedCopy)).toBeNull();
  expect(screen.queryByLabelText('Business phone route')).toBeNull();
  const c = command(f);
  if (c.payload.kind !== 'campaign.approve') throw Error('Expected approval');
  const exact = structuredClone(f.props.snapshot);
  exact.campaigns[0].version.approvedAt = c.payload.approvedAt;
  for (const field of ['offer', 'approvedAt', 'snapshotHash']) {
    const wrong = structuredClone(exact);
    if (field === 'snapshotHash') wrong.campaigns[0].snapshotHash = 'b'.repeat(64);
    else wrong.campaigns[0].version[field === 'offer' ? 'offer' : 'approvedAt'] = field === 'offer' ? 'Another offer' : fixtureNow;
    view.rerender(<CallCampaignEnrollment {...f.props} snapshot={wrong} campaign={wrong.campaigns[0]} />);
    expect(screen.queryByText(approvedCopy)).toBeNull();
    expect(screen.getByText(/Campaign action pending/)).toBeTruthy();
  }
  view.rerender(<CallCampaignEnrollment {...f.props} snapshot={exact} campaign={exact.campaigns[0]} />);
  expect(screen.getByText(approvedCopy)).toBeTruthy();
  expect(screen.queryByText(/Campaign action pending/)).toBeNull();
  expect(f.submit).toHaveBeenCalledTimes(1);
});

it('requires exact enrollment, campaign, account, initial step, route version and fresh binding identity for success', async () => {
  const f = fixture(true);
  const view = render(<CallCampaignEnrollment {...f.props} />);
  enroll();
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  const exact = enrolled(f);
  const changed: Partial<Enrollment>[] = [{ id: 'other' }, { accountId: 'b' }, { campaignVersionId: 'other' },
    { currentStepId: 'other' }, { selectedRouteId: 'other' }, { selectedRouteVersion: 1 }, { executionContextId: 'other' },
    { contextRevision: 2 }, { state: 'held' }, { version: 2 }];
  for (const change of changed) {
    const snapshot = projectEnrollment(f, { ...exact, ...change });
    view.rerender(<CallCampaignEnrollment {...f.props} snapshot={snapshot} campaign={snapshot.campaigns[0]} />);
    expect(screen.queryByText(enrolledCopy)).toBeNull();
  }
  const snapshot = projectEnrollment(f, exact);
  view.rerender(<CallCampaignEnrollment {...f.props} snapshot={snapshot} campaign={snapshot.campaigns[0]} />);
  expect(screen.getByText(enrolledCopy)).toBeTruthy();
  expect(f.submit).toHaveBeenCalledTimes(1);
});

it('offers only latest distinct verified business phones and blocks nonterminal enrollment across campaigns', () => {
  const f = fixture(true);
  const snapshot = structuredClone(f.props.snapshot);
  snapshot.accounts[0].routes = [phone, { ...phone, version: 1, value: 'old' }, { ...phone },
    { ...phone, id: 'confirmed', verification: 'confirmed' }, { ...phone, id: 'email', channel: 'email' },
    { ...phone, id: 'emergency', purpose: 'tenant_emergency' }, { ...phone, id: 'unknown', purpose: 'unknown' },
    { ...phone, id: 'unverified', verification: 'unverified' }, { ...phone, id: 'withdrawn' },
    { ...phone, id: 'withdrawn', version: 3, verification: 'unverified' }];
  const view = render(<CallCampaignEnrollment {...f.props} snapshot={snapshot} />);
  const select = screen.getByLabelText<HTMLSelectElement>('Business phone route');
  expect([...select.options].map(option => option.value)).toEqual(['', 'phone', 'confirmed']);
  expect(select.options[1].text).toBe(`${phone.value} (published)`);
  expect(select.options[2].text).toBe(`${phone.value} (confirmed)`);
  selectRoute();
  fireEvent.click(screen.getByLabelText(enrollLabel));
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Enroll company for manual call' }).disabled).toBe(false);
  const existing: Enrollment = { id: 'existing', accountId: 'a', selectedRouteId: 'phone', selectedRouteVersion: 2, personId: null,
    campaignVersionId: 'other-version', currentStepId: 'step', version: 1, state: 'active', executionContextId: 'existing-context', contextRevision: 1, startedAt: fixtureNow };
  for (const state of ['active', 'held', 'paused', 'conversation'] as const) {
    const held = structuredClone(snapshot);
    held.campaigns.push({ ...held.campaigns[0], version: { ...held.campaigns[0].version, id: 'other-version', campaignId: 'other-campaign' }, enrollments: [{ ...existing, state }] });
    view.rerender(<CallCampaignEnrollment {...f.props} snapshot={held} />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Enroll company for manual call' }).disabled).toBe(true);
  }
  expect(f.submit).not.toHaveBeenCalled();
});

it('holds unavailable or malformed props, opaque templates and inactive or pending authority without API calls', () => {
  const f = fixture();
  const view = render(<CallCampaignEnrollment {...f.props} />);
  const blocked = [{ config: null }, { readError: true }, { config: { ...f.props.config, endpoint: null as string | null } },
    { config: { ...f.props.config, workspaceId: 'foreign' } }, { snapshot: {} as DailySnapshot },
    ...['legacy', 'owner', 'version', 'pending', 'template'].map(kind => {
      const snapshot = structuredClone(f.props.snapshot);
      if (kind === 'legacy') snapshot.workflowMode = 'legacy';
      if (kind === 'owner') snapshot.ownerStatus[0].authority!.state = 'paused';
      if (kind === 'version') snapshot.ownerStatus[0].executionVersion = null;
      if (kind === 'pending') snapshot.ownerStatus[0].pendingCommands = [{ commandId: 'pending', status: 'pending', authorityGeneration: 1, aggregateVersion: 1, reason: null }];
      if (kind === 'template') snapshot.campaigns[0].version.contentPolicyHash = 'b'.repeat(64);
      return { snapshot, campaign: snapshot.campaigns[0] };
    })];
  for (const change of blocked) {
    view.rerender(<CallCampaignEnrollment {...f.props} {...change} />);
    fireEvent.click(screen.getByLabelText(reviewLabel));
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Approve call campaign' });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
  }
  expect(f.calls).toEqual([]);
  expect(f.submit).not.toHaveBeenCalled();
});

it('rereads exact campaign hash, account/routes, config and current authority/execution version before creating a command', async () => {
  for (const kind of ['hash', 'account', 'route', 'config', 'authority', 'execution', 'pending', 'workspace']) {
    const f = fixture(true);
    const fresh = structuredClone(f.props.snapshot);
    if (kind === 'hash') fresh.campaigns[0].snapshotHash = 'b'.repeat(64);
    if (kind === 'account') fresh.accounts[0].account.version++;
    if (kind === 'route') fresh.accounts[0].routes[0].version++;
    if (kind === 'config') f.setConfiguration({ ...f.props.config, configuration: { ...f.props.config.configuration!, revision: 2 } });
    if (kind === 'authority') fresh.ownerStatus[0].authority!.generation++;
    if (kind === 'execution') fresh.ownerStatus[0].executionVersion!++;
    if (kind === 'pending') fresh.ownerStatus[0].pendingCommands = [{ commandId: 'pending', status: 'pending', authorityGeneration: 1, aggregateVersion: 1, reason: null }];
    if (kind === 'workspace') fresh.workspaceId = 'foreign';
    f.setSnapshot(fresh);
    const view = render(<CallCampaignEnrollment {...f.props} />);
    enroll();
    await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
    expect(f.submit).not.toHaveBeenCalled();
    expect(screen.queryByText(enrolledCopy)).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>(enrollLabel).checked).toBe(false);
    view.unmount();
  }
});

it('latches before sync and rejects incomplete or malformed synchronization before any new command', async () => {
  const f = fixture();
  const gate = deferred<Awaited<ReturnType<typeof f.api.delegation.sync>>>();
  f.sync.mockReturnValueOnce(gate.promise);
  const view = render(<CallCampaignEnrollment {...f.props} />);
  fireEvent.click(screen.getByLabelText(reviewLabel));
  const button = screen.getByRole('button', { name: 'Approve call campaign' });
  act(() => { fireEvent.click(button); fireEvent.click(button); });
  expect(f.sync).toHaveBeenCalledTimes(1);
  await act(async () => gate.resolve({ applied: 0, gaps: 1, cursor: null, ownerFresh: true }));
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  expect(f.submit).not.toHaveBeenCalled();
  view.unmount();
  for (const report of [{ applied: 0, gaps: 0, cursor: null, ownerFresh: false }, {}]) {
    const held = fixture();
    held.sync.mockResolvedValue(report as Awaited<ReturnType<typeof held.api.delegation.sync>>);
    const next = render(<CallCampaignEnrollment {...held.props} />);
    approve();
    await waitFor(() => expect(held.refresh).toHaveBeenCalledTimes(1));
    expect(held.submit).not.toHaveBeenCalled();
    expect(held.calls).toEqual([]);
    next.unmount();
  }
});

it('fences delayed preflight across scope round trips, API changes, selection changes and read errors with no departed calls', async () => {
  for (const kind of ['scope', 'api', 'selection', 'read-error', 'unmount']) {
    const f = fixture();
    const gate = deferred<DailySnapshot>();
    vi.spyOn(f.api.daily, 'get').mockReturnValueOnce(gate.promise);
    const status = vi.spyOn(f.api.delegation, 'status');
    const view = render(<CallCampaignEnrollment {...f.props} />);
    approve();
    await waitFor(() => expect(f.api.daily.get).toHaveBeenCalledTimes(1));
    if (kind === 'scope') { setDailySessionScope(f.api.delegation, null); setDailySessionScope(f.api.delegation, 'ws'); }
    if (kind === 'api') { view.rerender(<CallCampaignEnrollment {...f.props} api={{ ...f.api, daily: { ...f.api.daily } }} />); view.rerender(<CallCampaignEnrollment {...f.props} />); }
    if (kind === 'selection') {
      const other = structuredClone(f.props.snapshot);
      other.campaigns[0].version.id = 'another-version';
      view.rerender(<CallCampaignEnrollment {...f.props} snapshot={other} campaign={other.campaigns[0]} />);
      view.rerender(<CallCampaignEnrollment {...f.props} />);
    }
    if (kind === 'read-error') { view.rerender(<CallCampaignEnrollment {...f.props} readError />); view.rerender(<CallCampaignEnrollment {...f.props} />); }
    if (kind === 'unmount') view.unmount();
    await act(async () => gate.resolve(f.props.snapshot));
    expect(status).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
    view.unmount();
  }
});

it('retains queued identity after submit departs and never calls or refreshes the departed API', async () => {
  const f = fixture();
  const gate = deferred<Awaited<ReturnType<typeof f.api.delegation.submit>>>();
  f.submit.mockReturnValueOnce(gate.promise);
  const view = render(<CallCampaignEnrollment {...f.props} />);
  approve();
  await waitFor(() => expect(f.submit).toHaveBeenCalledTimes(1));
  const original = f.submit.mock.calls[0][0];
  const other = fixture();
  view.rerender(<CallCampaignEnrollment {...other.props} />);
  const before = [...f.calls];
  await act(async () => gate.resolve({ commandId: original.commandId, status: 'applied', authorityGeneration: 1, aggregateVersion: 2, reason: null }));
  expect(f.calls).toEqual(before);
  expect(f.refresh).not.toHaveBeenCalled();
  expect(other.refresh).not.toHaveBeenCalled();
  expect(screen.queryByText(approvedCopy)).toBeNull();
  view.rerender(<CallCampaignEnrollment {...f.props} />);
  expect(screen.getByText(/Campaign action pending/)).toBeTruthy();
  expect(f.submit).toHaveBeenCalledTimes(1);
});

it('retains lost-reply enrollment on remount, retries the exact object only explicitly, and releases only exact terminal rejection', async () => {
  const f = fixture(true);
  f.submit.mockRejectedValueOnce(Error('PRIVATE transport data'));
  const view = render(<CallCampaignEnrollment {...f.props} />);
  enroll();
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  const original = f.submit.mock.calls[0][0];
  view.unmount();
  render(<CallCampaignEnrollment {...f.props} />);
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/PRIVATE/)).toBeNull();
  f.submit.mockResolvedValueOnce({ commandId: 'unrelated', status: 'rejected', authorityGeneration: 1, aggregateVersion: 2, reason: null });
  fireEvent.click(screen.getByRole('button', { name: 'Retry same campaign action' }));
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(2));
  expect(f.submit.mock.calls[1][0]).toBe(original);
  expect(screen.getByText(/Campaign action pending/)).toBeTruthy();
  f.submit.mockImplementationOnce(async c => ({ commandId: c.commandId, status: 'rejected', authorityGeneration: 1, aggregateVersion: 2, reason: 'PRIVATE rejection' }));
  fireEvent.click(screen.getByRole('button', { name: 'Retry same campaign action' }));
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(3));
  expect(f.submit.mock.calls[2][0]).toBe(original);
  expect(screen.queryByText(/Campaign action pending/)).toBeNull();
  expect(screen.getByLabelText<HTMLInputElement>(enrollLabel).checked).toBe(false);
  expect(screen.queryByText(/PRIVATE/)).toBeNull();
  expect(f.submit).toHaveBeenCalledTimes(3);
});

it('resets review acknowledgement on changed company, route, campaign and owner data and never carries route choice across workspaces', () => {
  const f = fixture(true);
  const view = render(<CallCampaignEnrollment {...f.props} />);
  selectRoute();
  fireEvent.click(screen.getByLabelText(enrollLabel));
  expect(screen.getByLabelText<HTMLInputElement>(enrollLabel).checked).toBe(true);
  for (const kind of ['account', 'route', 'campaign', 'owner']) {
    const next = structuredClone(f.props.snapshot);
    if (kind === 'account') next.accounts[0].account.version++;
    if (kind === 'route') next.accounts[0].routes[0].version++;
    if (kind === 'campaign') next.campaigns[0].version.offer = 'A revised offer';
    if (kind === 'owner') next.ownerStatus[0].authority!.generation++;
    view.rerender(<CallCampaignEnrollment {...f.props} snapshot={next} campaign={next.campaigns[0]} />);
    expect(screen.getByLabelText<HTMLInputElement>(enrollLabel).checked).toBe(false);
    fireEvent.click(screen.getByLabelText(enrollLabel));
  }
  const foreign = { ...f.props.snapshot, workspaceId: 'foreign' };
  view.rerender(<CallCampaignEnrollment {...f.props} snapshot={foreign} config={{ ...f.props.config, workspaceId: 'foreign' }} />);
  expect(screen.getByLabelText<HTMLSelectElement>('Business phone route').value).toBe('');
  expect(screen.getByLabelText<HTMLInputElement>(enrollLabel).checked).toBe(false);
  expect(f.submit).not.toHaveBeenCalled();
});

it('never bypasses malformed/unavailable current gates for an exact pending retry', async () => {
  const f = fixture();
  f.submit.mockRejectedValueOnce(Error('lost reply'));
  const view = render(<CallCampaignEnrollment {...f.props} />);
  approve();
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  for (const change of [{ readError: true }, { config: null }, { config: {} as typeof f.props.config }, { snapshot: {} as DailySnapshot }]) {
    view.rerender(<CallCampaignEnrollment {...f.props} {...change} />);
    const retry = screen.queryByRole<HTMLButtonElement>('button', { name: 'Retry same campaign action' });
    if (retry) { expect(retry.disabled).toBe(true); fireEvent.click(retry); }
  }
  expect(f.submit).toHaveBeenCalledTimes(1);
});

it('does not keep claiming not enrolled after a later canonical enrollment, including completed history', async () => {
  const f = fixture();
  const view = render(<CallCampaignEnrollment {...f.props} />);
  approve();
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  const c = command(f);
  if (c.payload.kind !== 'campaign.approve') throw Error('Expected approval');
  const approved = structuredClone(f.props.snapshot);
  approved.campaigns[0].version.approvedAt = c.payload.approvedAt;
  view.rerender(<CallCampaignEnrollment {...f.props} snapshot={approved} campaign={approved.campaigns[0]} />);
  expect(screen.getByText(approvedCopy)).toBeTruthy();
  for (const state of ['active', 'completed'] as const) {
    const next = structuredClone(approved);
    next.campaigns[0].enrollments = [{id:'external-enrollment',accountId:'a',selectedRouteId:'phone',selectedRouteVersion:2,personId:null,
      campaignVersionId:'version',currentStepId:'step',version:1,state,executionContextId:'external-context',contextRevision:1,startedAt:fixtureNow}];
    view.rerender(<CallCampaignEnrollment {...f.props} snapshot={next} campaign={next.campaigns[0]} />);
    expect(screen.queryByText(approvedCopy)).toBeNull();
    expect(screen.queryByText(/Campaign action pending/)).toBeNull();
  }
  expect(f.submit).toHaveBeenCalledTimes(1);
});


it.each(['published', 'confirmed'] as const)('does not offer %s person-specific routes for the company-only call continuation', verification => {
  const f = fixture(true);
  const snapshot = structuredClone(f.props.snapshot);
  snapshot.accounts[0].routes = [{ ...phone, personId: 'person-a', verification }];
  render(<CallCampaignEnrollment {...f.props} snapshot={snapshot} />);
  const select = screen.getByLabelText<HTMLSelectElement>('Business phone route');
  expect([...select.options].map(option => option.value)).toEqual(['']);
  expect(screen.getByText('This call queue supports company-level phone routes only. Person-specific routes are not available here.')).toBeTruthy();
  fireEvent.change(select, { target: { value: 'phone' } });
  fireEvent.click(screen.getByLabelText(enrollLabel));
  const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Enroll company for manual call' });
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(f.calls).toEqual([]);
  expect(f.submit).not.toHaveBeenCalled();
});

it('does not revive an older company route when its latest revision is person-specific', () => {
  const f = fixture(true);
  const snapshot = structuredClone(f.props.snapshot);
  snapshot.accounts[0].routes = [phone, { ...phone, version: 3, personId: 'person-a' },
    { ...phone, id: 'supported-company', verification: 'confirmed' }];
  render(<CallCampaignEnrollment {...f.props} snapshot={snapshot} />);
  expect([...screen.getByLabelText<HTMLSelectElement>('Business phone route').options].map(option => option.value))
    .toEqual(['', 'supported-company']);
  expect(f.calls).toEqual([]);
  expect(f.submit).not.toHaveBeenCalled();
});

it('keeps company enrollment available but rejects a person-binding change during the fresh read', async () => {
  const f = fixture(true);
  const fresh = structuredClone(f.props.snapshot);
  fresh.accounts[0].routes[0].personId = 'person-a';
  f.setSnapshot(fresh);
  render(<CallCampaignEnrollment {...f.props} />);
  selectRoute();
  fireEvent.click(screen.getByLabelText(enrollLabel));
  const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Enroll company for manual call' });
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  expect(f.sync).toHaveBeenCalledTimes(1);
  expect(f.submit).not.toHaveBeenCalled();
  expect(screen.getByText('Campaign action could not be completed. Review current data before trying again.')).toBeTruthy();
});
