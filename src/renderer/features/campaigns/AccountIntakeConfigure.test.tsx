// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountIntakeConfigure } from './AccountIntakeConfigure';
import { nativeDeskFixture } from '../today/nativeDesk.fixture';
import { setDailySessionScope } from '../today/dailySessionScope';
import type { AccountPreparation } from '../../../shared/contracts/accountPreparationContract';
import type { OwnerSourceConfiguration } from '../../../shared/contracts/ownerCommandContract';
import type { RemoteGoogleGrantStatus } from '../../../shared/contracts/remoteGoogleGrantContract';
import type { GoogleConnectionStatusReason } from '../../../shared/contracts/remoteGoogleConnectionsContract';
import type { AccountIntakeConfigureStatus, AccountIntakeHoldReason, ConfigureAccountIntake } from '../../../shared/contracts/accountIntakeConfigureContract';

afterEach(cleanup);
const readonly = 'https://www.googleapis.com/auth/gmail.readonly', owned = 'founder@fixture.invalid';
const activeAuthority: AccountPreparation['authority'] = { accountId: 'a', owner: 'worker', generation: 1, state: 'active' };
function preparation(config: Partial<OwnerSourceConfiguration> | null, authority = activeAuthority): AccountPreparation {
  const configuration: OwnerSourceConfiguration | null = config === null ? null
    : { version: 1, workspaceId: 'ws', accountId: 'a', pairingId: 'fixture-pairing', revision: 3, state: 'active', mailboxSubject: null, calendarId: null, research: null, ...config };
  return { workspaceId: 'ws', accountId: 'a', pairingId: 'fixture-pairing', checkedAt: '2026-09-09T12:00:00.000Z', authority, executionVersion: 4, configuration,
    mailCursor: configuration?.mailboxSubject ? { mailboxSubject: configuration.mailboxSubject, envelopeRevision: 2, scope: null } : null };
}
function grant(options: { state?: RemoteGoogleGrantStatus['state']; scopes?: string[]; calendars?: boolean } = {}): RemoteGoogleGrantStatus {
  const { state = 'ready', scopes = [readonly], calendars = true } = options;
  if (state === 'unconfigured') return { state, grant: null };
  return { state, grant: { provider: 'google', subject: 'mailbox', email: owned, grantedScopes: ['openid', 'email', ...scopes], owner: 'remote', purpose: 'permitted_correspondence',
    capabilities: scopes.includes(readonly) ? ['relevant_read'] : [], ...(calendars ? { calendars: { ownedCalendarId: owned, conflictCalendarIds: [owned], confirmed: true } } : {}) } };
}
type Outcome = 'applied' | 'pending' | 'rejected' | 'throw' | { held: AccountIntakeHoldReason };
/** The fixture bridge plus a recorded grant read and a recorded write whose status is bound to the request. */
const refusals: GoogleConnectionStatusReason[] = ['google_unconfigured', 'worker_scope_denied'];
function fixture(options: { grant?: RemoteGoogleGrantStatus | 'absent' | 'error' | GoogleConnectionStatusReason; outcome?: Outcome } = {}) {
  const f = nativeDeskFixture();
  setDailySessionScope(f.api.delegation, 'ws');
  const forbidden = vi.fn(async (): Promise<never> => { throw Error('PRIVATE forbidden'); });
  // The bridge rethrows the worker's allowlisted status reason as an Error whose message is the reason.
  const status = vi.fn(async () => {
    if (options.grant === 'error') throw Error('PRIVATE grant failure');
    if (typeof options.grant === 'string' && refusals.includes(options.grant as GoogleConnectionStatusReason)) throw Error(options.grant);
    return options.grant === 'absent' ? grant() : options.grant ?? grant();
  });
  if (options.grant !== 'absent') Object.assign(f.api.delegation, { googleConnections: { status, disclosure: forbidden, begin: forbidden, revoke: forbidden } });
  const configure = vi.fn(async (request: ConfigureAccountIntake): Promise<AccountIntakeConfigureStatus> => {
    const outcome = options.outcome ?? 'applied';
    if (outcome === 'throw') throw Error('PRIVATE bridge failure');
    if (typeof outcome === 'object') return { status: 'held', accountId: request.accountId, expectedConfigurationRevision: request.expectedConfigurationRevision, reason: outcome.held };
    const commandId = '00000000-0000-4000-8000-000000000001';
    return { status: 'queued', accountId: request.accountId, commandId, expectedConfigurationRevision: request.expectedConfigurationRevision,
      configuration: { version: 1, workspaceId: 'ws', accountId: 'a', pairingId: 'fixture-pairing', revision: request.expectedConfigurationRevision + 1, state: request.state, mailboxSubject: request.mailboxSubject, calendarId: request.calendarId, research: null },
      mailScope: request.mailSince === null ? null : { expectedEnvelopeRevision: null, since: request.mailSince },
      receipt: { commandId, status: outcome, authorityGeneration: 1, aggregateVersion: 5, reason: outcome === 'rejected' ? 'Stale owner command; explicit fresh action required' : null } };
  });
  Object.assign(f.api.delegation, { configureIntake: configure });
  return { ...f, status, configure, forbidden };
}
function mount(f: ReturnType<typeof fixture>, prepared: AccountPreparation, disabled = false) {
  const view = render(<AccountIntakeConfigure api={f.api.delegation} workspaceId="ws" accountId="a" preparation={prepared} disabled={disabled} />);
  const panel = within(screen.getByRole('region', { name: 'Intake configuration' }));
  return { view, panel, rerender: (next: AccountPreparation) => view.rerender(<AccountIntakeConfigure api={f.api.delegation} workspaceId="ws" accountId="a" preparation={next} disabled={disabled} />) };
}
const button = (panel: ReturnType<typeof within>, name: string | RegExp) => panel.getByRole('button', { name }) as HTMLButtonElement;
const expectNothingRecorded = (f: ReturnType<typeof fixture>) => { expect(f.calls).toEqual([]); expect(f.configure).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled(); };

it('offers no mail control without grant knowledge in the bridge and says why, calling nothing', () => {
  const f = fixture({ grant: 'absent' });
  const { panel } = mount(f, preparation({}));
  expect(panel.getByText('Grant status is unavailable in this bridge. Relevant mail is not offered.')).toBeTruthy();
  expect(panel.queryByRole('button', { name: 'Switch on relevant mail' })).toBeNull();
  expect(button(panel, 'Pause intake').disabled).toBe(false);
  expect(panel.getByText(/Configuration is not readiness; a configured mailbox is not permission to send\./)).toBeTruthy();
  expect(f.status).not.toHaveBeenCalled();
  expectNothingRecorded(f);
});

it.each([
  ['unconfigured', grant({ state: 'unconfigured' }), 'No Google grant is connected for this pairing. Relevant mail is not offered.'],
  ['revoked', grant({ state: 'revoked' }), 'The connected Google grant is revoked. Relevant mail is not offered.'],
  ['ready without Gmail read scope', grant({ scopes: ['https://www.googleapis.com/auth/calendar.freebusy'] }), 'The connected grant has no Gmail read scope. Relevant mail is not offered.'],
  ['unreadable', 'error' as const, 'The connected grant could not be read. Read intake configuration again to retry. Relevant mail is not offered.'],
] as const)('withholds the mail control when the grant is %s and never claims permission', async (_label, status, hold) => {
  const f = fixture({ grant: status });
  const { panel } = mount(f, preparation({ state: 'paused' }));
  await panel.findByText(hold);
  expect(f.status).toHaveBeenCalledTimes(1);
  expect(f.status).toHaveBeenCalledWith({ purpose: 'permitted_correspondence' });
  expect(panel.queryByRole('button', { name: 'Switch on relevant mail' })).toBeNull();
  expect(panel.queryByText(/PRIVATE/)).toBeNull();
  expect(button(panel, 'Set intake active').disabled).toBe(false);
  expectNothingRecorded(f);
});

it.each([
  ['google_unconfigured', 'Mail and calendar are not configured on this worker. Call campaigns do not need them.'],
  ['worker_scope_denied', 'This Mac\'s pairing does not include Google access. Mail and calendar are not available from this app.'],
] as const)('offers no mail or calendar control and no retry when the worker refuses the status read with %s, saying why once', async (reason, honest) => {
  const f = fixture({ grant: reason });
  const { panel } = mount(f, preparation(null));
  await panel.findByText(honest);
  expect(f.status).toHaveBeenCalledTimes(1);
  expect(panel.getByText('No intake configuration exists yet. The first change creates revision 1.')).toBeTruthy();
  expect(button(panel, 'Set intake active').disabled).toBe(false);
  for (const absent of [/could not be read/, /Read intake configuration again/, /Relevant mail is not offered/, /A configured mailbox is required/, /google_unconfigured/, /worker_scope_denied/, /Mailbox:/]) expect(panel.queryByText(absent)).toBeNull();
  expect(panel.queryByRole('button', { name: /Use calendar/ })).toBeNull();
  expect(panel.queryByRole('button', { name: 'Switch on relevant mail' })).toBeNull();
  expect(panel.queryByLabelText('Read relevant mail since')).toBeNull();
  expect(panel.getByText(/Configuration is not readiness; a configured mailbox is not permission to send\./)).toBeTruthy();
  expectNothingRecorded(f);
  // Even a revision that names a mailbox offers no calendar control: this app cannot read a grant here.
  cleanup();
  const g = fixture({ grant: reason });
  const other = mount(g, preparation({ mailboxSubject: 'mailbox' }));
  await other.panel.findByText(honest);
  expect(other.panel.queryByRole('button', { name: /Use calendar/ })).toBeNull();
  expect(button(other.panel, 'Pause intake').disabled).toBe(false);
  expectNothingRecorded(g);
});

it('offers the mail control only with a ready readable grant and an explicit non-future start date, sending the grant subject rather than a typed mailbox', async () => {
  const f = fixture();
  const { panel } = mount(f, preparation(null));
  await panel.findByText(/Mailbox: founder@fixture\.invalid\./);
  expect(panel.getByText('No intake configuration exists yet. The first change creates revision 1.')).toBeTruthy();
  const mail = button(panel, 'Switch on relevant mail');
  expect(mail.disabled).toBe(true);
  fireEvent.change(panel.getByLabelText('Read relevant mail since'), { target: { value: '2999-12-31' } });
  expect(mail.disabled).toBe(true);
  fireEvent.change(panel.getByLabelText('Read relevant mail since'), { target: { value: '2026-09-01' } });
  expect(mail.disabled).toBe(false);
  fireEvent.click(mail);
  await panel.findByText('Intake configuration receipt: applied.');
  expect(f.configure).toHaveBeenCalledTimes(1);
  expect(f.configure).toHaveBeenCalledWith({ accountId: 'a', expectedConfigurationRevision: 0, state: 'active', mailboxSubject: 'mailbox', calendarId: null, mailSince: '2026-09-01T00:00:00.000Z' });
  expect(panel.getByText(/The worker applied revision 1\./)).toBeTruthy();
  expect(f.calls).toEqual([]);
});

it('sends one bound command per control and closes every control until a fresh read after an applied receipt', async () => {
  const f = fixture();
  const { panel, rerender } = mount(f, preparation({ mailboxSubject: 'mailbox' }));
  await panel.findByText(/Relevant mail is already on for this company/);
  fireEvent.click(button(panel, 'Pause intake'));
  await panel.findByText('Intake configuration receipt: applied.');
  expect(f.configure).toHaveBeenCalledWith({ accountId: 'a', expectedConfigurationRevision: 3, state: 'paused', mailboxSubject: 'mailbox', calendarId: null, mailSince: null });
  expect(panel.getByText('The worker applied revision 4. Read intake configuration again to see it; this is not a readiness check.')).toBeTruthy();
  expect(button(panel, 'Pause intake').disabled).toBe(true);
  // A fresh read reopens the controls with the new revision bound and clears the settled receipt.
  rerender(preparation({ mailboxSubject: 'mailbox', state: 'paused', revision: 4 }));
  await waitFor(() => expect(button(panel, 'Set intake active').disabled).toBe(false));
  expect(panel.queryByText('Intake configuration receipt: applied.')).toBeNull();
  fireEvent.click(button(panel, 'Set intake active'));
  await panel.findByText('Intake configuration receipt: applied.');
  expect(f.configure).toHaveBeenLastCalledWith({ accountId: 'a', expectedConfigurationRevision: 4, state: 'active', mailboxSubject: 'mailbox', calendarId: null, mailSince: null });
  expect(f.configure).toHaveBeenCalledTimes(2);
  expect(f.calls).toEqual([]);
});

it('shows a held reason verbatim with nothing queued and requires a fresh read', async () => {
  const f = fixture({ outcome: { held: 'stale_source_configuration' } });
  const { panel, rerender } = mount(f, preparation({}));
  fireEvent.click(button(panel, 'Pause intake'));
  await panel.findByText('Intake change held: stale_source_configuration.');
  expect(panel.getByText(/The worker holds a different configuration revision than the one you read\. Nothing was queued\. Read intake configuration again before another change\./)).toBeTruthy();
  expect(button(panel, 'Pause intake').disabled).toBe(true);
  expect(panel.queryByRole('button', { name: 'Retry same change' })).toBeNull();
  rerender(preparation({ revision: 4 }));
  await waitFor(() => expect(button(panel, 'Pause intake').disabled).toBe(false));
  expect(panel.queryByText(/Intake change held/)).toBeNull();
  expect(f.configure).toHaveBeenCalledTimes(1);
});

it('shows a rejected receipt with the owner reason verbatim, changes nothing and re-issues nothing', async () => {
  const f = fixture({ outcome: 'rejected' });
  const { panel } = mount(f, preparation({ mailboxSubject: 'mailbox' }));
  fireEvent.click(button(panel, 'Pause intake'));
  await panel.findByText('Intake configuration receipt: rejected.');
  expect(panel.getByText('Stale owner command; explicit fresh action required')).toBeTruthy();
  expect(panel.getByText(/This change was rejected\. Nothing changed locally\./)).toBeTruthy();
  expect(button(panel, 'Pause intake').disabled).toBe(true);
  expect(panel.queryByRole('button', { name: 'Retry same change' })).toBeNull();
  expect(f.configure).toHaveBeenCalledTimes(1);
});

it.each(['throw', 'pending'] as const)('retains the identical request after a %s outcome and retries it without a new binding', async outcome => {
  const f = fixture({ outcome });
  const { panel } = mount(f, preparation({ mailboxSubject: 'mailbox' }));
  fireEvent.click(button(panel, 'Pause intake'));
  if (outcome === 'throw') {
    await panel.findByRole('alert');
    expect(panel.getByText(/The change was not acknowledged\. The exact request is retained; retrying the same change never issues a second command\./)).toBeTruthy();
    expect(panel.queryByText(/PRIVATE/)).toBeNull();
  } else {
    await panel.findByText('Intake configuration receipt: pending.');
    expect(panel.getByText(/Pending owner receipt\./)).toBeTruthy();
  }
  expect(button(panel, 'Pause intake').disabled).toBe(true);
  fireEvent.click(button(panel, 'Retry same change'));
  await waitFor(() => expect(f.configure).toHaveBeenCalledTimes(2));
  expect(f.configure.mock.calls[1]).toEqual(f.configure.mock.calls[0]);
  expect(f.calls).toEqual([]);
});

it('holds every control under revoked worker authority and under the parent’s disabled flag', async () => {
  const f = fixture();
  const { panel } = mount(f, preparation({ mailboxSubject: 'mailbox' }, { ...activeAuthority, state: 'revoked' }));
  expect(panel.getByText('The worker does not hold active or paused authority for this company. Intake configuration is held.')).toBeTruthy();
  await panel.findByText(/Relevant mail is already on for this company/);
  for (const name of ['Pause intake']) expect(button(panel, name).disabled).toBe(true);
  cleanup();
  const g = fixture();
  const held = mount(g, preparation({}), true);
  await held.panel.findByText(/Mailbox: founder@fixture\.invalid\./);
  fireEvent.change(held.panel.getByLabelText('Read relevant mail since'), { target: { value: '2026-09-01' } });
  for (const name of ['Pause intake', 'Switch on relevant mail']) expect(button(held.panel, name).disabled).toBe(true);
  expectNothingRecorded(f); expectNothingRecorded(g);
});

it('states that changes are unavailable when the bridge has no intake write, queuing nothing', () => {
  const f = nativeDeskFixture();
  setDailySessionScope(f.api.delegation, 'ws');
  Object.assign(f.api.delegation, { configureIntake: undefined });
  render(<AccountIntakeConfigure api={f.api.delegation} workspaceId="ws" accountId="a" preparation={preparation({})} disabled={false} />);
  const panel = within(screen.getByRole('region', { name: 'Intake configuration' }));
  expect(panel.getByText('Intake configuration changes are unavailable in this bridge. Nothing was queued.')).toBeTruthy();
  expect(panel.queryAllByRole('button')).toEqual([]);
  expect(f.calls).toEqual([]);
});
