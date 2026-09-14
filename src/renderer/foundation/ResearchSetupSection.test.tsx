// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResearchSetupApi as Api, ResearchSetupStatus, ResearchSetupReceipt } from '../../shared/contracts/researchSetupContract';
import { ResearchSetupSection } from './ResearchSetupSection';

const pairingId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const fingerprint = 'a'.repeat(64);
const identity = { workspaceId: 'test-workspace', pairingId, requestId, fingerprint, kind: 'approve' as const };
const applied: ResearchSetupReceipt = { ...identity, status: 'applied', revision: 1, state: 'active' };
const cancelled: ResearchSetupReceipt = { ...identity, status: 'cancelled', revision: null, state: null };
function status(): ResearchSetupStatus {
  return { pending: null, blockers: [], remote: { workspaceId: identity.workspaceId, pairingId, selector: null,
    discoveryLedger: null, researchLedger: null, descriptorFingerprint: fingerprint, credentialParameterDeclared: true, blockers: [],
    checkedAt: '2026-09-14T00:00:00.000Z', receipt: null,
    descriptor: { currency: 'USD', reviewedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', provenance: 'Fictional operator review', researchReservationMicros: 200000,
      capability: { model: 'fictional-reviewed-model', webSearch: true, searchCostMicros: 100000, modelCostMicros: 100000 } } } };
}
function api(value = status()) {
  return { status: vi.fn<Api['status']>(async () => value), approve: vi.fn<Api['approve']>(async () => applied),
    setState: vi.fn<Api['setState']>(async () => ({ ...applied, status: 'applied', kind: 'set-state', state: 'paused', revision: 2 })),
    retry: vi.fn<Api['retry']>(async () => applied), cancelPending: vi.fn<Api['cancelPending']>(async () => cancelled) } satisfies Api;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const input = (name: RegExp) => screen.getByLabelText(name) as HTMLInputElement;
const ack = () => screen.getByRole('checkbox') as HTMLInputElement;
async function idle() { await waitFor(() => expect(button('Refresh').disabled).toBe(false)); }
async function mount(a = api()) { const result = render(<ResearchSetupSection api={a} />); await idle(); return result; }
function fill() {
  const values: [RegExp, string][] = [[/Residential regions/, 'Boston\nCambridge'], [/Targeting terms/, 'residential\nproperty management'], [/Official website URLs/, 'https://example.com/\nhttps://example.org/'],
    [/Maximum companies/, '2'], [/Maximum pages/, '3'], [/Maximum bytes/, '10000'], [/Discovery cumulative/, '1.000001'], [/Research cumulative/, '2']];
  values.forEach(([name, value]) => fireEvent.change(input(name), { target: { value } }));
}
function pendingStatus() { const value = status(); value.pending = { requestId, kind: 'approve', createdAt: '2026-09-14T00:00:00.000Z', state: 'unknown' }; value.blockers = ['local_pending']; return value; }
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('bounded Cloud research settings', () => {
  it('mount and Refresh only read status, have no monetary defaults or exposed IDs, retain same-API inputs', async () => {
    const a = api(); const storage = vi.spyOn(Storage.prototype, 'setItem'); await mount(a);
    expect(input(/Discovery cumulative/).value).toBe(''); expect(input(/Research cumulative/).value).toBe('');
    fill(); fireEvent.click(ack()); fireEvent.click(button('Refresh')); await idle();
    expect(input(/Residential regions/).value).toBe('Boston\nCambridge'); expect(ack().checked).toBe(false);
    expect(a.status).toHaveBeenCalledTimes(2);
    for (const method of [a.approve, a.setState, a.retry, a.cancelPending, storage]) expect(method).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(pairingId); expect(document.body.textContent).not.toContain(identity.workspaceId);
    expect(screen.getByText(/Operator assertions, not live connectivity proof/)).toBeTruthy();
  });
  it('requires explicit review and sends exact human multiline targeting and cumulative micros', async () => {
    const a = api(); await mount(a); fill();
    expect(input(/Residential regions/).tagName).toBe('TEXTAREA'); expect(button('Approve research').disabled).toBe(true);
    fireEvent.click(ack()); expect(button('Approve research').disabled).toBe(false);
    fireEvent.click(button('Approve research')); await idle();
    expect(a.approve).toHaveBeenCalledWith({ expectedRevision: 0, descriptorFingerprint: fingerprint,
      audience: { residential: true, regions: ['Boston', 'Cambridge'], terms: ['residential', 'property management'] },
      permittedSources: ['https://example.com/', 'https://example.org/'], maxCompanies: 2, maxPages: 3, maxBytes: 10000,
      discoveryCeilingMicros: 1000001, researchCeilingMicros: 2000000, disclosureAcknowledged: true });
    expect(a.status).toHaveBeenCalledTimes(1); expect(button('Approve research').disabled).toBe(true);
    expect(input(/Residential regions/).value).toBe('Boston\nCambridge');
  });
  it.each(['operator_descriptor_missing', 'operator_descriptor_expired', 'credential_parameter_missing', 'local_journal_unavailable'] as const)('blocks approval for %s', async blocker => {
    const value = status(); value.blockers = [blocker]; const a = api(value); await mount(a); fill(); fireEvent.click(ack());
    expect(button('Approve research').disabled).toBe(true); expect(a.approve).not.toHaveBeenCalled();
  });
  it('rejects an expired descriptor even if the remote reports no blockers', async () => {
    const value = status(); value.remote!.descriptor!.expiresAt = '2021-01-01T00:00:00.000Z'; await mount(api(value)); fill(); fireEvent.click(ack());
    expect(button('Approve research').disabled).toBe(true); expect(screen.getByText(/Operator review is not current/)).toBeTruthy();
  });
  it.each(['0', '0.000001', '1.0000001', '9007199254740992', '-1', '1e2'])('rejects invalid or insufficient ceiling %s', async value => {
    await mount(); fill(); fireEvent.change(input(/Discovery cumulative/), { target: { value } }); fireEvent.click(ack()); expect(button('Approve research').disabled).toBe(true);
  });
  it('locks uncertain edits, retains inputs after failure and failed refresh, and retries without payload', async () => {
    const a = api(); a.approve.mockRejectedValue(new Error('private error')); await mount(a); fill(); fireEvent.click(ack());
    fireEvent.click(button('Approve research')); await idle();
    expect((input(/Residential regions/).closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
    expect(input(/Residential regions/).value).toBe('Boston\nCambridge'); expect(button('Approve research').disabled).toBe(true);
    a.status.mockRejectedValue(new Error('offline')); fireEvent.click(button('Refresh')); await idle();
    expect(button('Retry exact pending request').disabled).toBe(false); expect(document.body.textContent).not.toContain('private error');
    fireEvent.click(button('Retry exact pending request')); await idle(); expect(a.retry.mock.calls).toEqual([[]]); expect(a.approve).toHaveBeenCalledTimes(1);
  });
  it.each(['cancelled', 'applied'] as const)('handles cancellation outcome %s without claiming rollback or automatic refresh', async outcome => {
    const a = api(pendingStatus()); a.cancelPending.mockResolvedValue(outcome === 'cancelled' ? cancelled : applied); await mount(a);
    expect(button('Approve research').disabled).toBe(true); expect(a.retry).not.toHaveBeenCalled();
    fireEvent.click(button('Cancel pending request')); await idle();
    expect(a.cancelPending.mock.calls).toEqual([[]]); expect(a.status).toHaveBeenCalledTimes(1);
    expect(screen.getByText(outcome === 'cancelled' ? /Pending request cancelled\./ : /Request was already applied\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel pending request' })).toBeNull(); expect(button('Approve research').disabled).toBe(true);
  });
  it('keeps uncertainty after failed cancellation and rejects a mismatched receipt', async () => {
    const a = api(pendingStatus()); a.cancelPending.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ...cancelled, requestId: pairingId }); await mount(a);
    fireEvent.click(button('Cancel pending request')); await idle(); fireEvent.click(button('Cancel pending request')); await idle();
    expect(screen.queryByText(/Pending request cancelled\./)).toBeNull(); expect(button('Cancel pending request').disabled).toBe(false);
  });
  it('serializes refresh and mutations including repeated same-tick clicks', async () => {
    const a = api(); const pending = deferred<ResearchSetupReceipt>(); a.approve.mockReturnValue(pending.promise); await mount(a); fill(); fireEvent.click(ack());
    const approve = button('Approve research'); act(() => { fireEvent.click(approve); fireEvent.click(approve); fireEvent.click(button('Refresh')); });
    expect(a.approve).toHaveBeenCalledTimes(1); expect(a.status).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(applied)); await idle();
  });
  it('ignores old success through API A→B→A replacement and clears cross-workspace targeting', async () => {
    const a = api(); const b = api(); const pending = deferred<ResearchSetupReceipt>(); a.approve.mockReturnValue(pending.promise);
    const view = await mount(a); fill(); fireEvent.click(ack()); fireEvent.click(button('Approve research'));
    view.rerender(<ResearchSetupSection api={b} />); await idle(); expect(input(/Residential regions/).value).toBe('');
    view.rerender(<ResearchSetupSection api={a} />); await idle(); await act(async () => pending.resolve(applied));
    expect(screen.queryByText(/Research policy request applied\./)).toBeNull(); expect(a.status).toHaveBeenCalledTimes(2); expect(ack().checked).toBe(false);
  });
  it('ignores stale status on API replacement and late receipts after unmount', async () => {
    const a = api(); const old = deferred<ResearchSetupStatus>(); a.status.mockReturnValue(old.promise);
    const view = render(<ResearchSetupSection api={a} />); const b = api(pendingStatus()); view.rerender(<ResearchSetupSection api={b} />); await idle();
    await act(async () => old.resolve(status())); expect(button('Cancel pending request').disabled).toBe(false);
    const pending = deferred<ResearchSetupReceipt>(); b.cancelPending.mockReturnValue(pending.promise); fireEvent.click(button('Cancel pending request')); view.unmount();
    await act(async () => pending.resolve(cancelled)); expect(document.body.textContent).not.toContain('Pending request cancelled.');
  });
  it('offers explicit pause despite expired descriptor and blocks resume, with read-only policy', async () => {
    const value = status(); value.remote!.descriptor!.expiresAt = '2021-01-01T00:00:00.000Z'; value.blockers = ['operator_descriptor_expired'];
    value.remote!.selector = { version: 1, workspaceId: identity.workspaceId, pairingId, revision: 1, state: 'active', research: null };
    const a = api(value); await mount(a); expect(screen.queryByLabelText(/Residential regions/)).toBeNull(); expect(button('Pause research').disabled).toBe(true);
    fireEvent.click(ack()); fireEvent.click(button('Pause research')); await idle();
    expect(a.setState).toHaveBeenCalledWith({ state: 'paused', expectedRevision: 1, disclosureAcknowledged: true });
    value.remote!.selector.state = 'paused'; fireEvent.click(button('Refresh')); await idle(); fireEvent.click(ack()); expect(button('Resume research').disabled).toBe(true);
    expect(screen.getByText(/Pause cannot recall in-flight work/)).toBeTruthy();
  });
  it('honestly reports missing API and never enables mutation', () => {
    render(<ResearchSetupSection />); expect(screen.getByText(/unavailable in this app connection/)).toBeTruthy(); expect(button('Approve research').disabled).toBe(true);
  });
  it('shows an amended cumulative ceiling without refunding retained uncertainty or resuming on refresh', async () => {
    const value = status(); const remote = value.remote!;
    remote.selector = { version: 1, workspaceId: identity.workspaceId, pairingId, revision: 2, state: 'paused', research: null };
    remote.discoveryLedger = { limitMicros: 1000000, reservedOrSpentMicros: 1000000, remainingMicros: 0 };
    remote.researchLedger = { limitMicros: 10000, reservedOrSpentMicros: 0, remainingMicros: 10000 };
    const a = api(value); await mount(a);
    expect(screen.getByText('Discovery balance: cumulative ceiling $1 USD, reserved-or-spent $1 USD, remaining $0 USD.')).toBeTruthy();
    remote.discoveryLedger = { limitMicros: 2000000, reservedOrSpentMicros: 1000000, remainingMicros: 1000000 };
    fireEvent.click(button('Refresh')); await idle();
    expect(screen.getByText('Discovery balance: cumulative ceiling $2 USD, reserved-or-spent $1 USD, remaining $1 USD.')).toBeTruthy();
    expect(screen.getByText('Research balance: cumulative ceiling $0.01 USD, reserved-or-spent $0 USD, remaining $0.01 USD.')).toBeTruthy();
    expect(screen.getByText('Existing policy (read-only): paused')).toBeTruthy();
    expect(screen.getByText(/not verified invoice spend/)).toBeTruthy();
    for (const method of [a.approve, a.setState, a.retry, a.cancelPending]) expect(method).not.toHaveBeenCalled();
    expect(button('Resume research').disabled).toBe(true);
    a.setState.mockResolvedValue({ ...applied, kind: 'set-state', revision: 3, state: 'active' });
    fireEvent.click(ack()); fireEvent.click(button('Resume research')); await idle();
    expect(a.setState).toHaveBeenCalledTimes(1);
    expect(a.setState).toHaveBeenCalledWith({ state: 'active', expectedRevision: 2, disclosureAcknowledged: true });
    remote.selector = { ...remote.selector, revision: 3, state: 'active' };
    remote.discoveryLedger = { limitMicros: 2000000, reservedOrSpentMicros: 2000000, remainingMicros: 0 };
    fireEvent.click(button('Refresh')); await idle();
    expect(screen.getByText('Discovery balance: cumulative ceiling $2 USD, reserved-or-spent $2 USD, remaining $0 USD.')).toBeTruthy();
    expect(a.status).toHaveBeenCalledTimes(3); expect(a.setState).toHaveBeenCalledTimes(1);
    expect(a.approve).not.toHaveBeenCalled(); expect(a.retry).not.toHaveBeenCalled(); expect(a.cancelPending).not.toHaveBeenCalled();
  });
});
