// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteGoogleConnectionsApi as Api } from '../../shared/contracts/remoteGoogleConnectionsContract';
import { googleGrantDisclosure, personalGoogleGrantDisclosure, googleScopes, type GoogleGrantPurpose } from '../../shared/contracts/googleGrantCapabilities';
import { RemoteGoogleConnectionsSection } from './RemoteGoogleConnectionsSection';

type Status = Awaited<ReturnType<Api['status']>>;
const work = 'permitted_correspondence';
const personal = 'personal_availability';
const empty: Status = { state: 'unconfigured', grant: null };
function readyStatus(purpose: GoogleGrantPurpose = work): Status {
  return { state: 'ready', grant: purpose === work ? {
    provider: 'google', subject: 'private-subject', email: 'founder@usecali.com', owner: 'remote', purpose,
    capabilities: ['send', 'relevant_read'], grantedScopes: [googleScopes.send, googleScopes.relevant_read],
  } : { provider: 'google', subject: 'private-subject', email: 'person@example.com', owner: 'remote', purpose,
    capabilities: ['availability'], grantedScopes: ['openid', 'email', googleScopes.availability],
    availabilityCalendars: { calendarIds: ['person@example.com'], confirmed: true } } };
}
function api(connected = false) {
  return {
    status: vi.fn<Api['status']>(async ({ purpose }) => connected ? readyStatus(purpose) : empty),
    disclosure: vi.fn<Api['disclosure']>(async ({ purpose }) => purpose === personal ? personalGoogleGrantDisclosure : googleGrantDisclosure),
    begin: vi.fn<Api['begin']>(async input => ({ state: 'consent_opened', purpose: input.purpose ?? work })),
    revoke: vi.fn<Api['revoke']>(async () => ({ state: 'revoked', grant: null, providerRevocation: 'confirmed' })),
  } satisfies Api;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const panel = (purpose: GoogleGrantPurpose = work) => within(screen.getByRole('region', { name: purpose === work ? 'Work email' : 'Personal calendar availability' }));
const button = (name: string, purpose: GoogleGrantPurpose = work) => panel(purpose).getByRole('button', { name }) as HTMLButtonElement;
const input = (purpose: GoogleGrantPurpose = work) => panel(purpose).getByLabelText(purpose === work ? 'Named work email (@usecali.com)' : 'Calendar IDs, one per line') as HTMLInputElement;
const ack = (purpose: GoogleGrantPurpose = work) => panel(purpose).getByLabelText('I have reviewed and acknowledge this disclosure') as HTMLInputElement;
const confirm = (purpose: GoogleGrantPurpose = work) => panel(purpose).getByLabelText(purpose === work ? 'I confirm this named work mailbox' : 'I confirm these exact calendar IDs') as HTMLInputElement;
function fill(purpose: GoogleGrantPurpose = work, value = purpose === work ? 'founder@usecali.com' : 'person@example.com\nteam@group.calendar.google.com') {
  fireEvent.change(input(purpose), { target: { value } });
}
function consent(purpose: GoogleGrantPurpose = work) {
  fireEvent.click(confirm(purpose)); fireEvent.click(ack(purpose));
}
async function idle() { await waitFor(() => expect(button('Refresh').disabled).toBe(false)); }
async function mount(a = api()) { const result = render(<RemoteGoogleConnectionsSection api={a} />); await idle(); return result; }
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('remote Google purpose-specific explicit UI', () => {
  it('mount and refresh read only status plus disclosure, with no browser or storage commands', async () => {
    const a = api(); const open = vi.spyOn(window, 'open'); const storage = vi.spyOn(Storage.prototype, 'setItem');
    await mount(a);
    expect(a.status.mock.calls).toEqual([[{ purpose: work }], [{ purpose: personal }]]);
    expect(a.disclosure.mock.calls).toEqual(a.status.mock.calls);
    expect(panel().getByText(googleGrantDisclosure.text)).toBeTruthy();
    expect(panel(personal).getByText(personalGoogleGrantDisclosure.text)).toBeTruthy();
    expect(input().value).toBe(''); expect(input().required).toBe(true);
    expect(button('Continue to Google').disabled).toBe(true);
    fireEvent.click(button('Refresh')); await idle();
    expect(a.status).toHaveBeenCalledTimes(3); expect(a.disclosure).toHaveBeenCalledTimes(3);
    expect(a.begin).not.toHaveBeenCalled(); expect(a.revoke).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
  });
  it('uses two distinct minimal purpose requests and consent receipt is not connected', async () => {
    const a = api(); await mount(a);
    fill(); consent(); fireEvent.click(button('Continue to Google')); await idle();
    expect(a.begin).toHaveBeenNthCalledWith(1, { purpose: work, expectedEmail: 'founder@usecali.com',
      capabilities: ['send', 'relevant_read'], disclosureVersion: googleGrantDisclosure.version });
    expect(panel().getByText(/Google consent opened\. This is not a connected grant/)).toBeTruthy();
    expect(panel().queryByText(/Cloud grant ready/)).toBeNull();
    expect(button('Continue to Google').disabled).toBe(true);
    fill(personal); consent(personal); fireEvent.click(button('Continue to Google', personal)); await idle();
    expect(a.begin).toHaveBeenNthCalledWith(2, { purpose: personal, capabilities: ['availability'],
      disclosureVersion: personalGoogleGrantDisclosure.version,
      availabilityCalendars: { calendarIds: ['person@example.com', 'team@group.calendar.google.com'], confirmed: true } });
    expect(a.status).toHaveBeenCalledTimes(2); expect(a.revoke).not.toHaveBeenCalled();
  });
  it.each(['', 'founder@gmail.com', '@usecali.com', 'Founder@usecali.com', 'a@usecali.com.evil', 'a b@usecali.com'])('rejects invalid work address %s', async value => {
    const a = api(); await mount(a); fill(work, value); consent(); fireEvent.click(button('Continue to Google'));
    expect(button('Continue to Google').disabled).toBe(true); expect(a.begin).not.toHaveBeenCalled();
  });
  it.each(['', 'primary', 'person@example.com\nperson@example.com', 'PERSON@example.com', 'person@example.com\n', Array.from({ length: 21 }, (_, i) => `a${i}@example.com`).join('\n')])('rejects invalid explicit calendar selection %s', async value => {
    const a = api(); await mount(a); fill(personal, value); consent(personal);
    expect(button('Continue to Google', personal).disabled).toBe(true); expect(a.begin).not.toHaveBeenCalled();
  });
  it('requires separate selection and disclosure acknowledgments, resets both on edit/read, preserves input', async () => {
    await mount(); fill(); fireEvent.click(ack()); expect(button('Continue to Google').disabled).toBe(true);
    fireEvent.click(confirm()); expect(ack().checked).toBe(false); fireEvent.click(ack());
    expect(button('Continue to Google').disabled).toBe(false);
    fill(work, 'other@usecali.com'); expect(ack().checked).toBe(false); expect(confirm().checked).toBe(false);
    consent(); fireEvent.click(button('Refresh')); await idle();
    expect(input().value).toBe('other@usecali.com'); expect(ack().checked).toBe(false); expect(confirm().checked).toBe(false);
  });
  it('synchronously locks duplicate clicks and cross-panel operations until begin settles', async () => {
    const a = api(); const pending = deferred<Awaited<ReturnType<Api['begin']>>>(); a.begin.mockReturnValue(pending.promise);
    await mount(a); fill(); consent(); fill(personal); consent(personal);
    const start = button('Continue to Google'); const other = button('Continue to Google', personal);
    act(() => { start.click(); start.click(); other.click(); });
    expect(a.begin).toHaveBeenCalledTimes(1); expect(other.disabled).toBe(true); expect(input(personal).disabled).toBe(true);
    expect(button('Refresh', personal).disabled).toBe(true);
    expect(panel().getByText(/Outcome pending/)).toBeTruthy();
    await act(async () => pending.resolve({ state: 'consent_opened', purpose: work })); await idle();
    expect(a.status).toHaveBeenCalledTimes(2);
  });
  it('unknown begin is static, never retries or reconnects, and explicit refresh recovers', async () => {
    const a = api(); a.begin.mockRejectedValue(Error('private-token https://secret.example'));
    await mount(a); fill(); consent(); fireEvent.click(button('Continue to Google')); await idle();
    expect(panel().getByText(/Consent outcome unknown/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/private-token|https:\/\/secret/);
    expect(button('Continue to Google').disabled).toBe(true); expect(a.begin).toHaveBeenCalledTimes(1);
    a.status.mockImplementation(async ({ purpose }) => readyStatus(purpose));
    fireEvent.click(button('Refresh')); await idle();
    expect(panel().getByText('founder@usecali.com')).toBeTruthy(); expect(input().value).toBe('founder@usecali.com');
    expect(ack().checked).toBe(false); expect(a.begin).toHaveBeenCalledTimes(1);
  });
  it.each(['wrong-purpose', 'wrong-disclosure', 'malformed'] as const)('fails closed on %s and recovers without losing input', async kind => {
    const a = api(); await mount(a); fill(); consent();
    if (kind === 'wrong-purpose') a.status.mockResolvedValueOnce(readyStatus(personal));
    if (kind === 'wrong-disclosure') a.disclosure.mockResolvedValueOnce(personalGoogleGrantDisclosure);
    if (kind === 'malformed') a.status.mockResolvedValueOnce({ state: 'ready', grant: null });
    fireEvent.click(button('Refresh')); await idle();
    expect(panel().getByText(/Status and disclosure could not be verified/)).toBeTruthy();
    expect(button('Continue to Google').disabled).toBe(true); expect(input().value).toBe('founder@usecali.com');
    fireEvent.click(button('Refresh')); await idle(); expect(panel().getByText(googleGrantDisclosure.text)).toBeTruthy();
    expect(ack().checked).toBe(false); expect(a.begin).not.toHaveBeenCalled();
  });
  it('missing API and failed unpaired read explain Worker connection without pretending ready', async () => {
    const view = render(<RemoteGoogleConnectionsSection />);
    expect(screen.getByText(/Connect or pair your Worker/)).toBeTruthy(); expect(button('Refresh').disabled).toBe(true);
    const a = api(); a.status.mockRejectedValue(Error('not-paired-secret')); view.rerender(<RemoteGoogleConnectionsSection api={a} />); await idle();
    expect(screen.getAllByText(/Connect or pair your Worker/)).toHaveLength(2);
    expect(screen.queryByText(/Cloud grant ready/)).toBeNull(); expect(document.body.textContent).not.toContain('not-paired-secret');
  });
  it('shows verified identity and grant facts, not resource readiness or private metadata', async () => {
    await mount(api(true));
    expect(panel().getByText('founder@usecali.com')).toBeTruthy(); expect(panel().getByText('send, relevant_read')).toBeTruthy();
    expect(panel(personal).getByText('availability')).toBeTruthy();
    expect(panel(personal).getByText('Confirmed calendar IDs (not access proof)')).toBeTruthy();
    expect(screen.getByText(/does not authorize campaigns or prove live mailbox/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/private-subject|https:\/\/www.googleapis.com/);
  });
  it.each(['pending', 'confirmed', 'unknown'] as const)('revoke requires its own acknowledgement and handles %s honestly', async outcome => {
    const a = api(true); const pending = deferred<Status>(); a.revoke.mockReturnValue(pending.promise); await mount(a);
    expect(button('Revoke cloud grant').disabled).toBe(true); fill(); consent(); expect(button('Revoke cloud grant').disabled).toBe(true);
    fireEvent.click(panel().getByLabelText('I acknowledge this revocation request may affect other Google grants for the same account and app'));
    const revoke = button('Revoke cloud grant'); act(() => { revoke.click(); revoke.click(); });
    expect(a.revoke).toHaveBeenCalledTimes(1); expect(a.revoke).toHaveBeenCalledWith({ purpose: work });
    expect(panel().getByText(/Revocation requested.*Outcome pending/)).toBeTruthy(); expect(button('Refresh', personal).disabled).toBe(true);
    await act(async () => {
      if (outcome === 'unknown') pending.reject(Error('private-error'));
      else pending.resolve({ state: 'revoked', grant: null, providerRevocation: outcome });
    }); await idle();
    expect(panel().getByText(outcome === 'unknown' ? /Revocation outcome unknown/ : outcome === 'pending' ? /Provider revocation pending or unconfirmed/ : 'Provider revocation confirmed.')).toBeTruthy();
    expect(button('Revoke cloud grant').disabled).toBe(true); expect(button('Continue to Google').disabled).toBe(true);
    expect(a.status).toHaveBeenCalledTimes(2); expect(a.begin).not.toHaveBeenCalled();
    fireEvent.click(button('Refresh')); await idle(); expect(a.revoke).toHaveBeenCalledTimes(1);
    expect(button('Revoke cloud grant').disabled).toBe(true);
  });
  it('ignores old read results across API ABA replacement', async () => {
    const a = api(); const b = api(); const pending = deferred<Status>();
    a.status.mockReturnValueOnce(pending.promise); const view = render(<RemoteGoogleConnectionsSection api={a} />);
    await waitFor(() => expect(a.status).toHaveBeenCalledTimes(2));
    view.rerender(<RemoteGoogleConnectionsSection api={b} />); await idle();
    view.rerender(<RemoteGoogleConnectionsSection api={a} />); await idle(); fill(); consent();
    await act(async () => pending.resolve(readyStatus()));
    expect(panel().queryByText('Cloud grant ready (last verified status)')).toBeNull();
    expect(input().value).toBe('founder@usecali.com'); expect(ack().checked).toBe(true);
  });
  it.each(['begin', 'revoke'] as const)('ignores stale %s result on API replacement and unmount, without claiming cancellation', async action => {
    const a = api(true); const b = api(); const pending = deferred<never>(); a[action].mockReturnValue(pending.promise);
    const view = await mount(a);
    if (action === 'begin') { fill(); consent(); fireEvent.click(button('Continue to Google')); }
    else { fireEvent.click(panel().getByLabelText('I acknowledge this revocation request may affect other Google grants for the same account and app')); fireEvent.click(button('Revoke cloud grant')); }
    view.rerender(<RemoteGoogleConnectionsSection api={b} />); await idle();
    expect(document.body.textContent).not.toMatch(/cancelled|canceled/);
    view.unmount(); await act(async () => pending.reject(Error('private-old-result')));
    expect(b.begin).not.toHaveBeenCalled(); expect(b.revoke).not.toHaveBeenCalled();
  });
  it('rejects a mismatched consent receipt as unknown', async () => {
    const a = api(); a.begin.mockResolvedValue({ state: 'consent_opened', purpose: personal });
    await mount(a); fill(); consent(); fireEvent.click(button('Continue to Google')); await idle();
    expect(panel().getByText(/Consent outcome unknown/)).toBeTruthy(); expect(a.status).toHaveBeenCalledTimes(2);
  });
  it('keeps both panels locked until all read requests settle after one fails', async () => {
    const a = api(); const pending = deferred<Awaited<ReturnType<Api['disclosure']>>>();
    a.status.mockRejectedValueOnce(Error('private-read'));
    a.disclosure.mockReturnValueOnce(pending.promise);
    render(<RemoteGoogleConnectionsSection api={a} />);
    await waitFor(() => expect(a.disclosure).toHaveBeenCalledTimes(2));
    expect(button('Refresh').disabled).toBe(true); expect(button('Refresh', personal).disabled).toBe(true);
    expect(panel().getByText('Checking cloud grant status and disclosure…')).toBeTruthy();
    await act(async () => pending.resolve(googleGrantDisclosure)); await idle();
    expect(panel().getByText(/Status and disclosure could not be verified/)).toBeTruthy();
    expect(a.begin).not.toHaveBeenCalled();
  });
  it.each(['begin', 'revoke'] as const)('old %s cannot publish or unlock a replacement operation after ABA', async action => {
    const a = api(true); const b = api(); const old = deferred<never>(); a[action].mockReturnValueOnce(old.promise);
    const view = await mount(a);
    if (action === 'begin') { fill(); consent(); fireEvent.click(button('Continue to Google')); }
    else { fireEvent.click(panel().getByLabelText('I acknowledge this revocation request may affect other Google grants for the same account and app')); fireEvent.click(button('Revoke cloud grant')); }
    view.rerender(<RemoteGoogleConnectionsSection api={b} />); await idle();
    view.rerender(<RemoteGoogleConnectionsSection api={a} />); await idle();
    const fresh = deferred<Awaited<ReturnType<Api['begin']>>>(); a.begin.mockReturnValueOnce(fresh.promise);
    fill(); consent(); fireEvent.click(button('Continue to Google'));
    await act(async () => old.reject(Error('private-old')));
    expect(button('Refresh').disabled).toBe(true);
    expect(panel().getByText(/Opening Google consent.*Outcome pending/)).toBeTruthy();
    expect(panel().queryByText(/outcome unknown/)).toBeNull();
    await act(async () => fresh.resolve({ state: 'consent_opened', purpose: work })); await idle();
    expect(panel().getByText(/Google consent opened/)).toBeTruthy();
  });
  it.each(['begin', 'revoke'] as const)('handles synchronous %s throws without leaking exceptions', async action => {
    const a = api(true); a[action].mockImplementation(() => { throw Error('private-sync'); });
    await mount(a);
    if (action === 'begin') { fill(); consent(); fireEvent.click(button('Continue to Google')); }
    else { fireEvent.click(panel().getByLabelText('I acknowledge this revocation request may affect other Google grants for the same account and app')); fireEvent.click(button('Revoke cloud grant')); }
    await idle(); expect(panel().getByText(/outcome unknown/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('private-sync'); expect(a.status).toHaveBeenCalledTimes(2);
  });
  it('does not accept a wrong-purpose revoke response or claim access removed', async () => {
    const a = api(true); a.revoke.mockResolvedValue({ ...readyStatus(personal), state: 'revoked' });
    await mount(a); fireEvent.click(panel().getByLabelText('I acknowledge this revocation request may affect other Google grants for the same account and app'));
    fireEvent.click(button('Revoke cloud grant')); await idle();
    expect(panel().getByText(/Revocation outcome unknown/)).toBeTruthy();
    expect(panel().queryByText('Cloud grant revocation requested')).toBeNull();
  });

  it('fresh pending revocation allows only acknowledged explicit cleanup retry, never automatic reconnect', async () => {
    const a = api(); const revoked: Status = { state: 'revoked', grant: null, providerRevocation: 'pending' };
    a.status.mockResolvedValue(revoked); a.revoke.mockResolvedValue(revoked);
    await mount(a); fill(); consent();
    expect(button('Continue to Google').disabled).toBe(true);
    expect(button('Revoke cloud grant').disabled).toBe(true);
    expect(a.revoke).not.toHaveBeenCalled(); expect(a.begin).not.toHaveBeenCalled();
    fireEvent.click(panel().getByLabelText('I acknowledge this revocation request may affect other Google grants for the same account and app'));
    fireEvent.click(button('Revoke cloud grant')); await idle();
    expect(a.revoke).toHaveBeenCalledTimes(1); expect(button('Revoke cloud grant').disabled).toBe(true);
    expect(panel().getByText(/Cleanup may remain held for operational reconciliation/)).toBeTruthy();
    fireEvent.click(button('Refresh')); await idle();
    expect(a.revoke).toHaveBeenCalledTimes(1); expect(button('Revoke cloud grant').disabled).toBe(true);
    fireEvent.click(panel().getByLabelText('I acknowledge this revocation request may affect other Google grants for the same account and app'));
    expect(button('Revoke cloud grant').disabled).toBe(false);
    expect(button('Continue to Google').disabled).toBe(true); expect(a.begin).not.toHaveBeenCalled();
  });

});
