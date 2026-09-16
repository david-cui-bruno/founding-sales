// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { dailySnapshotSchema, type DailySnapshot } from '../../../shared/contracts/dailyContract';
import { sha256Utf8 } from '../../../shared/crypto/sha256';
import { configuredFixtureStatus, fixtureNow, linkedInFixture, nativeDeskFixture, nativeDeskReviewFixture } from '../today/nativeDesk.fixture';
import { setDailySessionScope } from '../today/dailySessionScope';
import { ManualLinkedInPreparation, type ManualLinkedInPreparationProps } from './ManualLinkedInPreparation';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture() {
  const input = nativeDeskReviewFixture();
  input.answers = []; input.meetings = [];
  const campaign = input.campaigns[0];
  campaign.version.approvedAt = fixtureNow;
  campaign.version.steps = [{ id: 'li-step', channel: 'linkedin', condition: 'initial', delayHours: 0 }];
  campaign.enrollments = [{ id: 'enrollment', accountId: 'a', selectedRouteId: 'li-route', selectedRouteVersion: 1,
    personId: null, campaignVersionId: 'version', currentStepId: 'li-step', version: 1, state: 'active', executionContextId: 'context', contextRevision: 1, startedAt: fixtureNow }];
  input.accounts[0].routes = [{ id: 'li-route', accountId: 'a', personId: null, version: 1, channel: 'linkedin',
    value: 'https://www.linkedin.com/in/fictional-contact', purpose: 'business', verification: 'published', evidenceIds: ['source'] }];
  const snapshot = dailySnapshotSchema.parse(input);
  const f = nativeDeskFixture(snapshot);
  const item = linkedInFixture();
  item.draft.contentHash = sha256Utf8(item.draft.body);
  item.draft.targetHash = sha256Utf8(snapshot.accounts[0].routes[0].value);
  const persist = () => { const next = f.snapshot(); next.answers = [structuredClone(item)]; f.setSnapshot(next); };
  const prepare = vi.spyOn(f.api.linkedin, 'prepare').mockImplementation(async () => { persist(); return structuredClone(item.draft); });
  const forbidden = vi.fn(async (): Promise<never> => { throw Error('Forbidden outreach side effect'); });
  vi.spyOn(f.api.delegation, 'sync').mockImplementation(forbidden);
  vi.spyOn(f.api.delegation, 'submit').mockImplementation(forbidden);
  f.api.linkedin.begin = forbidden; f.api.linkedin.copy = forbidden; f.api.linkedin.open = forbidden; f.api.linkedin.reportOutcome = forbidden;
  const get = vi.spyOn(f.api.daily, 'get');
  const refresh = vi.fn();
  setDailySessionScope(f.api.linkedin, 'ws'); setDailySessionScope(f.api.delegation, 'ws');
  const props: ManualLinkedInPreparationProps = { api: f.api, snapshot, campaign: snapshot.campaigns[0], config: configuredFixtureStatus(), readError: false, onRefresh: refresh };
  return { ...f, item, prepare, forbidden, get, refresh, props, persist };
}
const clickPrepare = () => fireEvent.click(screen.getByRole('button', { name: 'Prepare LinkedIn note' }));

it('does nothing on mount and opens the existing editor only after explicit preparation and exact saved projection', async () => {
  const f = fixture(); render(<ManualLinkedInPreparation {...f.props} />);
  expect(f.get).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
  clickPrepare();
  await screen.findByLabelText('LinkedIn note');
  expect(f.prepare).toHaveBeenCalledTimes(1);
  expect(f.prepare).toHaveBeenCalledWith({ enrollmentId: 'enrollment', stepId: 'li-step', expectedVersion: 1 });
  expect(f.get).toHaveBeenCalledTimes(2);
  expect(f.refresh).toHaveBeenCalledTimes(1);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('reopens a durably saved human edit before invoking generation, even from a stale empty snapshot', async () => {
  const f = fixture(); f.item.draft.body = 'Human edit retained'; f.item.draft.revision = 2;
  f.item.draft.contentHash = sha256Utf8(f.item.draft.body); f.item.recovery.revision = 2; f.persist();
  render(<ManualLinkedInPreparation {...f.props} />); clickPrepare();
  expect((await screen.findByLabelText('LinkedIn note') as HTMLTextAreaElement).value).toBe('Human edit retained');
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled();
});

it('uses the freshly confirmed revision instead of an older displayed saved draft', async () => {
  const f = fixture(); f.props.snapshot.answers = [structuredClone(f.item)];
  f.item.draft.body = 'Newer saved edit'; f.item.draft.revision = 2;
  f.item.draft.contentHash = sha256Utf8(f.item.draft.body); f.item.recovery.revision = 2; f.persist();
  render(<ManualLinkedInPreparation {...f.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open saved LinkedIn note' }));
  expect((await screen.findByLabelText('LinkedIn note') as HTMLTextAreaElement).value).toBe('Newer saved edit');
  expect(f.prepare).not.toHaveBeenCalled();
});

it('ignores a second activation while checking the local snapshot', async () => {
  const f = fixture(); const pending = deferred<DailySnapshot>(); f.get.mockImplementationOnce(() => pending.promise);
  render(<ManualLinkedInPreparation {...f.props} />);
  const button = screen.getByRole('button', { name: 'Prepare LinkedIn note' });
  fireEvent.click(button); fireEvent.click(button);
  await act(async () => pending.resolve(f.props.snapshot));
  await screen.findByLabelText('LinkedIn note'); expect(f.prepare).toHaveBeenCalledTimes(1);
});

it('does not expose a late generation response after the workspace scope changes', async () => {
  const f = fixture(); const pending = deferred<typeof f.item.draft>();
  f.prepare.mockImplementation(() => pending.promise);
  render(<ManualLinkedInPreparation {...f.props} />); clickPrepare();
  await waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(1));
  setDailySessionScope(f.api.linkedin, null);
  f.persist(); await act(async () => pending.resolve(f.item.draft));
  expect(screen.queryByLabelText('LinkedIn note')).toBeNull();
  expect(f.refresh).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled();
});

it('recovers a lost post-save response after close/reopen without another preparation', async () => {
  const f = fixture(); f.prepare.mockImplementation(async () => { f.persist(); throw Error('Lost response after saving'); });
  const view = render(<ManualLinkedInPreparation {...f.props} />); clickPrepare();
  await screen.findByRole('alert'); view.unmount();
  render(<ManualLinkedInPreparation {...f.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Recover saved LinkedIn note' }));
  await screen.findByLabelText('LinkedIn note');
  expect(f.prepare).toHaveBeenCalledTimes(1); expect(f.forbidden).not.toHaveBeenCalled();
});

it('requires separate explicit retry after recovery finds no saved projection', async () => {
  const f = fixture(); f.prepare.mockRejectedValue(Error('Unknown preparation response'));
  render(<ManualLinkedInPreparation {...f.props} />); clickPrepare(); await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Recover saved LinkedIn note' }));
  await screen.findByText(/no new generation was attempted/);
  expect(f.prepare).toHaveBeenCalledTimes(1); expect(f.forbidden).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Retry LinkedIn note generation' })).toBeTruthy();
});

it('rechecks durable projection before an explicit retry and never regenerates a late saved note', async () => {
  const f = fixture(); f.prepare.mockRejectedValueOnce(Error('Uncertain response'));
  render(<ManualLinkedInPreparation {...f.props} />); clickPrepare(); await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Recover saved LinkedIn note' }));
  const retry = await screen.findByRole('button', { name: 'Retry LinkedIn note generation' });
  f.persist(); fireEvent.click(retry);
  await screen.findByLabelText('LinkedIn note');
  expect(f.prepare).toHaveBeenCalledTimes(1); expect(f.forbidden).not.toHaveBeenCalled();
});

it.each(['prepare', 'read', 'status'] as const)('sanitizes external %s failure details', async boundary => {
  const f = fixture(); const failure = Error('SECRET-CREDENTIAL https://private.invalid/raw-provider-detail');
  if (boundary === 'prepare') f.prepare.mockRejectedValue(failure);
  if (boundary === 'read') f.get.mockRejectedValue(failure);
  if (boundary === 'status') vi.spyOn(f.api.delegation, 'status').mockRejectedValue(failure);
  render(<ManualLinkedInPreparation {...f.props} />); clickPrepare();
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('LinkedIn preparation unavailable');
  expect(document.body.textContent).not.toContain('SECRET-CREDENTIAL');
  expect(document.body.textContent).not.toContain('private.invalid');
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('shares a synchronous in-flight latch across close/reopen and recovers late durable completion', async () => {
  const f = fixture(); const pending = deferred<typeof f.item.draft>();
  f.prepare.mockImplementation(() => pending.promise);
  const view = render(<ManualLinkedInPreparation {...f.props} />); clickPrepare();
  await waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(1));
  view.unmount(); render(<ManualLinkedInPreparation {...f.props} />);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: /Checking saved/ }).disabled).toBe(true);
  f.persist(); await act(async () => pending.resolve(f.item.draft));
  fireEvent.click(screen.getByRole('button', { name: 'Recover saved LinkedIn note' }));
  await screen.findByLabelText('LinkedIn note'); expect(f.prepare).toHaveBeenCalledTimes(1);
});

it.each(['scope', 'api', 'read-error'] as const)('does not continue after %s changes during a read', async kind => {
  const f = fixture(); const pending = deferred<DailySnapshot>(); f.get.mockImplementationOnce(() => pending.promise);
  const view = render(<ManualLinkedInPreparation {...f.props} />); clickPrepare();
  if (kind === 'scope') { setDailySessionScope(f.api.linkedin, null); setDailySessionScope(f.api.linkedin, 'ws'); }
  if (kind === 'api') { view.rerender(<ManualLinkedInPreparation {...f.props} api={{ ...f.api, daily: { ...f.api.daily } }} />); view.rerender(<ManualLinkedInPreparation {...f.props} />); }
  if (kind === 'read-error') { view.rerender(<ManualLinkedInPreparation {...f.props} readError />); view.rerender(<ManualLinkedInPreparation {...f.props} />); }
  await act(async () => pending.resolve(f.props.snapshot));
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.refresh).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled();
});

it.each(['enrollment', 'route', 'owner', 'config'] as const)('rejects changed %s on the fresh local read', async kind => {
  const f = fixture(); const changed = f.snapshot();
  if (kind === 'enrollment') changed.campaigns[0].enrollments[0].version++;
  if (kind === 'route') changed.accounts[0].routes[0].value = 'https://www.linkedin.com/in/other-person';
  if (kind === 'owner') changed.ownerStatus[0].pendingCommands = [{ commandId: 'pending', status: 'pending', authorityGeneration: 1, aggregateVersion: 2, reason: null }];
  if (kind === 'config') f.setConfiguration({ ...configuredFixtureStatus(), state: 'locked' });
  f.setSnapshot(changed); render(<ManualLinkedInPreparation {...f.props} />); clickPrepare();
  await screen.findByRole('alert'); expect(f.prepare).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled();
});

it.each(['workspaceId', 'routeId', 'executionContextId', 'contentHash'] as const)('rejects a preparation response with wrong %s and requires recovery', async field => {
  const f = fixture(); f.prepare.mockImplementation(async () => { f.persist(); return { ...f.item.draft, [field]: field === 'contentHash' ? 'b'.repeat(64) : 'other' }; });
  render(<ManualLinkedInPreparation {...f.props} />); clickPrepare(); await screen.findByRole('alert');
  expect(screen.queryByLabelText('LinkedIn note')).toBeNull(); expect(f.refresh).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Recover saved LinkedIn note' }));
  await screen.findByLabelText('LinkedIn note'); expect(f.prepare).toHaveBeenCalledTimes(1);
});

it('never starts preparation when local read fails', async () => {
  const f = fixture(); f.get.mockRejectedValue(Error('Local read failed'));
  render(<ManualLinkedInPreparation {...f.props} />); clickPrepare(); await screen.findByRole('alert');
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled();
});

it.each(['paused', 'route', 'pending', 'read-error'] as const)('holds the %s starting state', kind => {
  const f = fixture(); const snapshot = structuredClone(f.props.snapshot);
  if (kind === 'paused') snapshot.campaigns[0].enrollments[0].state = 'paused';
  if (kind === 'route') snapshot.accounts[0].routes[0].verification = 'unverified';
  if (kind === 'pending') snapshot.ownerStatus[0].pendingCommands = [{ commandId: 'pending', status: 'pending', authorityGeneration: 1, aggregateVersion: 2, reason: null }];
  render(<ManualLinkedInPreparation {...f.props} snapshot={snapshot} campaign={snapshot.campaigns[0]} readError={kind === 'read-error'} />);
  const button = screen.queryByRole<HTMLButtonElement>('button', { name: 'Prepare LinkedIn note' });
  if (kind === 'paused') expect(button).toBeNull(); else expect(button?.disabled).toBe(true);
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled();
});
