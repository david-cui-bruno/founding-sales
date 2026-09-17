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
function policyStatus(state: 'active' | 'paused' = 'active', revision = 1) {
  const value = status();
  value.remote!.selector = { version: 1, workspaceId: identity.workspaceId, pairingId, revision, state, research: null };
  value.remote!.discoveryLedger = { limitMicros: 2000000, reservedOrSpentMicros: 1000000, remainingMicros: 1000000 };
  return value;
}
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
    expect(a.status).toHaveBeenCalledTimes(4); expect(a.setState).toHaveBeenCalledTimes(1);
    expect(a.approve).not.toHaveBeenCalled(); expect(a.retry).not.toHaveBeenCalled(); expect(a.cancelPending).not.toHaveBeenCalled();
  });
  it.each(['active', 'paused'] as const)('follow-read after %s state command retains stale policy and serializes repeated clicks', async state => {
    const next = state === 'active' ? 'paused' : 'active';
    const a = api(policyStatus(state)); const receipt = deferred<ResearchSetupReceipt>(); const follow = deferred<ResearchSetupStatus>();
    a.setState.mockReturnValue(receipt.promise); a.status.mockResolvedValueOnce(policyStatus(state)).mockReturnValueOnce(follow.promise);
    await mount(a); fireEvent.click(ack()); const command = button(state === 'active' ? 'Pause research' : 'Resume research');
    act(() => { fireEvent.click(command); fireEvent.click(command); fireEvent.click(button('Refresh')); });
    expect(a.setState).toHaveBeenCalledTimes(1); expect(a.status).toHaveBeenCalledTimes(1);
    await act(async () => receipt.resolve({ ...applied, kind: 'set-state', revision: 2, state: next }));
    expect(a.status).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('heading', { name: `Last observed policy (stale, read-only): ${state}` })).toBeTruthy();
    expect(screen.queryByText('First-use research policy')).toBeNull();
    expect(screen.getByText('Discovery balance: cumulative ceiling $2 USD, reserved-or-spent $1 USD, remaining $1 USD.')).toBeTruthy();
    expect(screen.getByText(/Research policy request applied\./)).toBeTruthy(); expect(ack().checked).toBe(false); expect(ack().disabled).toBe(true);
    act(() => { fireEvent.click(command); fireEvent.click(button('Refresh')); });
    expect(a.status).toHaveBeenCalledTimes(2); expect(a.setState).toHaveBeenCalledTimes(1);
    const actual = policyStatus(next, 2); actual.remote!.discoveryLedger!.reservedOrSpentMicros = 2000000; actual.remote!.discoveryLedger!.remainingMicros = 0;
    await act(async () => follow.resolve(actual)); await idle();
    expect(screen.getByRole('heading', { name: `Existing policy (read-only): ${next}` })).toBeTruthy();
    expect(screen.getByText(/Research policy request applied\./)).toBeTruthy();
    expect(screen.getByText('Discovery balance: cumulative ceiling $2 USD, reserved-or-spent $2 USD, remaining $0 USD.')).toBeTruthy();
    expect(button(next === 'active' ? 'Pause research' : 'Resume research').disabled).toBe(true);
    fireEvent.click(ack()); expect(button(next === 'active' ? 'Pause research' : 'Resume research').disabled).toBe(false);
    for (const method of [a.approve, a.retry, a.cancelPending]) expect(method).not.toHaveBeenCalled();
  });
  it('follow-read rejects failed, missing, mismatched, older and equal-revision conflicting status until explicit Refresh', async () => {
    const wrongWorkspace = policyStatus('paused', 2); wrongWorkspace.remote!.workspaceId = 'other-workspace';
    const wrongPairing = policyStatus('paused', 2); wrongPairing.remote!.pairingId = requestId;
    const wrongSelector = policyStatus('paused', 2); wrongSelector.remote!.selector!.pairingId = requestId;
    for (const result of [new Error('offline'), { ...status(), remote: null }, status(), wrongWorkspace, wrongPairing, wrongSelector, policyStatus('paused', 1), policyStatus('active', 2)]) {
      const a = api(policyStatus());
      a.status.mockResolvedValueOnce(policyStatus());
      if (result instanceof Error) a.status.mockRejectedValueOnce(result); else a.status.mockResolvedValueOnce(result);
      await mount(a); fireEvent.click(ack()); fireEvent.click(button('Pause research')); await idle();
      expect(a.status).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('heading', { name: 'Last observed policy (stale, read-only): active' })).toBeTruthy();
      expect(screen.getByText(/Research policy request applied\./)).toBeTruthy(); expect(screen.getByText(/Follow-up status could not be verified/)).toBeTruthy();
      expect(ack().disabled).toBe(true); expect(button('Pause research').disabled).toBe(true);
      expect(screen.queryByRole('button', { name: 'Retry exact pending request' })).toBeNull();
      a.status.mockResolvedValue(policyStatus('paused', 2)); fireEvent.click(button('Refresh')); await idle();
      expect(screen.getByText('Existing policy (read-only): paused')).toBeTruthy(); expect(button('Resume research').disabled).toBe(true);
      expect(a.status).toHaveBeenCalledTimes(3); expect(a.setState).toHaveBeenCalledTimes(1); cleanup();
    }
  });
  it('follow-read accepts later actual state instead of projecting the applied receipt', async () => {
    const a = api(policyStatus()); a.status.mockResolvedValueOnce(policyStatus()).mockResolvedValueOnce(policyStatus('active', 3));
    await mount(a); fireEvent.click(ack()); fireEvent.click(button('Pause research')); await idle();
    expect(a.status).toHaveBeenCalledTimes(2); expect(screen.getByText('Existing policy (read-only): active')).toBeTruthy();
    expect(screen.getByText(/Research policy request applied\./)).toBeTruthy(); expect(button('Pause research').disabled).toBe(true);
  });
  it('follow-read never starts from a stale receipt through API A→B→A or unmount', async () => {
    const a = api(policyStatus()); const b = api(); const receipt = deferred<ResearchSetupReceipt>(); a.setState.mockReturnValue(receipt.promise);
    const view = await mount(a); fireEvent.click(ack()); fireEvent.click(button('Pause research'));
    view.rerender(<ResearchSetupSection api={b} />); await idle(); view.rerender(<ResearchSetupSection api={a} />); await idle();
    await act(async () => receipt.resolve({ ...applied, kind: 'set-state', revision: 2, state: 'paused' }));
    expect(a.status).toHaveBeenCalledTimes(2); expect(screen.queryByText(/Research policy request applied\./)).toBeNull();
    const late = deferred<ResearchSetupReceipt>(); a.setState.mockReturnValue(late.promise); fireEvent.click(ack()); fireEvent.click(button('Pause research')); view.unmount();
    await act(async () => late.resolve({ ...applied, kind: 'set-state', revision: 2, state: 'paused' })); expect(a.status).toHaveBeenCalledTimes(2);
  });
  it('follow-read completion cannot cross API A→B→A or unmount fences', async () => {
    const a = api(policyStatus()); const follow = deferred<ResearchSetupStatus>(); a.status.mockResolvedValueOnce(policyStatus()).mockReturnValueOnce(follow.promise);
    const view = await mount(a); fireEvent.click(ack()); fireEvent.click(button('Pause research'));
    await waitFor(() => expect(a.status).toHaveBeenCalledTimes(2));
    view.rerender(<ResearchSetupSection api={api()} />); await idle(); view.rerender(<ResearchSetupSection api={a} />); await idle();
    await act(async () => follow.resolve(policyStatus('paused', 2)));
    expect(screen.getByText('Existing policy (read-only): active')).toBeTruthy(); expect(screen.queryByText(/Research policy request applied\./)).toBeNull();
    const late = deferred<ResearchSetupStatus>(); a.status.mockReturnValueOnce(late.promise); fireEvent.click(ack()); fireEvent.click(button('Pause research'));
    await waitFor(() => expect(a.status).toHaveBeenCalledTimes(4)); view.unmount(); await act(async () => late.resolve(policyStatus('paused', 2)));
    expect(a.status).toHaveBeenCalledTimes(4); expect(document.body.textContent).not.toContain('Research policy request applied.');
  });

});

describe('Google Places territory batches in Cloud research settings', () => {
  function placesStatus(): ResearchSetupStatus {
    const value = status();
    value.remote!.descriptor!.placesSearchCostMicros = 35000;
    value.remote!.placesCredentialParameterDeclared = true;
    value.remote!.placesBlockers = [];
    return value;
  }
  const provider = () => screen.getByLabelText('Discovery provider') as HTMLSelectElement;
  function fillTerritory(companies = '20') {
    const values: [RegExp, string][] = [[/Residential regions/, 'Providence, RI\nBoston, MA\nDallas, TX'], [/Targeting terms/, 'property management company\nresidential property management'],
      [/Companies per batch/, companies], [/Maximum pages/, '1'], [/Maximum bytes/, '10000'], [/Discovery cumulative/, '3.5'], [/Research cumulative/, '2']];
    values.forEach(([name, value]) => fireEvent.change(input(name), { target: { value } }));
  }
  it('offers Places without hand-typed websites, states the cost per call and the source of listed phones, and sends the Places shape', async () => {
    const a = api(placesStatus()); await mount(a);
    expect(provider().value).toBe('responses_cited');
    expect([...provider().options].map(option => option.text)).toEqual(['Cited web search (one company)', 'Google Places (territory batches)']);
    fireEvent.change(provider(), { target: { value: 'places' } });
    expect(screen.queryByLabelText(/Official website URLs/)).toBeNull();
    expect(screen.getByLabelText('Companies per batch (1–20)')).toBeTruthy();
    expect(screen.getByText(/Each Google Places text-search call reserves \$0\.035 USD \(Enterprise SKU\) against the discovery ceiling before it is made\./)).toBeTruthy();
    expect(screen.getByText(/Listed phone numbers come from Google Business Profiles/)).toBeTruthy();
    fillTerritory(); fireEvent.click(ack());
    expect(button('Approve research').disabled).toBe(false);
    fireEvent.click(button('Approve research')); await idle();
    expect(a.approve).toHaveBeenCalledWith({ expectedRevision: 0, descriptorFingerprint: fingerprint, discoveryProvider: 'places',
      audience: { residential: true, regions: ['Providence, RI', 'Boston, MA', 'Dallas, TX'], terms: ['property management company', 'residential property management'] },
      permittedSources: [], maxCompanies: 20, maxPages: 1, maxBytes: 10000, discoveryCeilingMicros: 3500000, researchCeilingMicros: 2000000, disclosureAcknowledged: true });
  });
  it('caps a Places batch at one page, requires the ceiling to cover one call, and restores the cited fields when switched back', async () => {
    await mount(api(placesStatus()));
    fireEvent.change(provider(), { target: { value: 'places' } }); fillTerritory('21'); fireEvent.click(ack());
    expect(button('Approve research').disabled).toBe(true);
    fireEvent.change(input(/Companies per batch/), { target: { value: '20' } }); fireEvent.click(ack()); expect(button('Approve research').disabled).toBe(false);
    fireEvent.change(input(/Discovery cumulative/), { target: { value: '0.034999' } }); fireEvent.click(ack()); expect(button('Approve research').disabled).toBe(true);
    fireEvent.change(provider(), { target: { value: 'responses_cited' } });
    expect(screen.getByLabelText('Official website URLs, one per line')).toBeTruthy(); expect(screen.getByLabelText('Maximum companies (1–50)')).toBeTruthy();
    expect(screen.queryByText(/Google Business Profiles/)).toBeNull();
  });
  it.each(['old-worker', 'credential', 'cost'] as const)('blocks a Places approval when readiness is %s while cited approval stays available', async gap => {
    const value = placesStatus();
    if (gap === 'old-worker') { delete value.remote!.placesBlockers; delete value.remote!.placesCredentialParameterDeclared; }
    if (gap === 'credential') { value.remote!.placesCredentialParameterDeclared = false; value.remote!.placesBlockers = ['places_credential_parameter_missing']; }
    if (gap === 'cost') { delete value.remote!.descriptor!.placesSearchCostMicros; value.remote!.placesBlockers = ['places_cost_missing']; }
    const a = api(value); await mount(a);
    fireEvent.change(provider(), { target: { value: 'places' } }); fillTerritory(); fireEvent.click(ack());
    expect(button('Approve research').disabled).toBe(true);
    if (gap === 'credential') expect(screen.getByText(/Google Places credential parameter is not declared/)).toBeTruthy();
    if (gap === 'cost') expect(screen.getByText(/carry no Places cost per call/)).toBeTruthy();
    fireEvent.change(provider(), { target: { value: 'responses_cited' } }); fill(); fireEvent.click(ack());
    expect(button('Approve research').disabled).toBe(false); expect(a.approve).not.toHaveBeenCalled();
  });
  it('shows an existing Places policy read-only with its provider and no website list', async () => {
    const value = placesStatus();
    value.remote!.selector = { version: 1, workspaceId: identity.workspaceId, pairingId, revision: 1, state: 'active', research: {
      workspaceId: identity.workspaceId, budgetId: 'guided-research-v1', audience: { residential: true, regions: ['Providence, RI'], terms: ['property management company'] }, audienceRevision: 1, sourceRevision: 1, budgetRevision: 1,
      discoveryLimits: { maxCompanies: 20, maxPages: 1, maxBytes: 10000, maxCostMicros: 35000 }, researchLimits: { maxCompanies: 20, maxPages: 1, maxBytes: 10000, maxCostMicros: 200000 },
      capability: { model: 'fictional-reviewed-model', webSearch: true, searchCostMicros: 100000, modelCostMicros: 100000 }, maxAccountBudgetMicros: 200000, permittedSources: [], preparationCommandId: requestId, discoveryProvider: 'places' } };
    await mount(api(value));
    expect(screen.getByText('Discovery provider: Google Places (territory batches). Companies per batch: 20.')).toBeTruthy();
    expect(screen.queryByText(/Official websites:/)).toBeNull();
    // The replace form is prefilled from the Places policy: its provider is selected and no website list is offered.
    expect(provider().value).toBe('places'); expect(input(/Companies per batch/).value).toBe('20'); expect(screen.queryByLabelText(/Official website URLs/)).toBeNull();
  });
});

describe('replacing an existing research configuration', () => {
  const providerSelect = () => screen.getByLabelText('Discovery provider') as HTMLSelectElement;
  const research = (provider?: 'places') => ({ workspaceId: identity.workspaceId, budgetId: provider ? 'places-territory-v1' : 'guided-research-v1',
    audience: { residential: true as const, regions: ['Providence, RI', 'Boston, MA'], terms: ['property management company'] }, audienceRevision: 1, sourceRevision: 1, budgetRevision: 1,
    discoveryLimits: { maxCompanies: provider ? 20 : 1, maxPages: 2, maxBytes: 20000, maxCostMicros: provider ? 35000 : 200000 }, researchLimits: { maxCompanies: provider ? 20 : 1, maxPages: 2, maxBytes: 20000, maxCostMicros: 200000 },
    capability: { model: 'fictional-reviewed-model', webSearch: true as const, searchCostMicros: 100000, modelCostMicros: 100000 }, maxAccountBudgetMicros: 200000,
    permittedSources: provider ? [] : ['https://example.com/'], preparationCommandId: requestId, ...(provider ? { discoveryProvider: 'places' as const } : {}) });
  function configured(revision = 8, provider?: 'places'): ResearchSetupStatus {
    const value = status();
    value.remote!.descriptor!.placesSearchCostMicros = 35000; value.remote!.placesCredentialParameterDeclared = true; value.remote!.placesBlockers = [];
    value.remote!.selector = { version: 1, workspaceId: identity.workspaceId, pairingId, revision, state: 'active', research: research(provider) };
    value.remote!.discoveryLedger = { limitMicros: 2000000, reservedOrSpentMicros: 1000000, remainingMicros: 1000000 };
    value.remote!.researchLedger = { limitMicros: 3000000, reservedOrSpentMicros: 0, remainingMicros: 3000000 };
    return value;
  }
  it('prefills the current policy and ceilings, explains what replacing keeps, and sends the current revision with the new shape', async () => {
    const a = api(configured()); a.approve.mockResolvedValue({ ...applied, revision: 9 }); await mount(a);
    expect(screen.getByRole('heading', { name: 'Existing policy (read-only): active' })).toBeTruthy();
    expect(screen.queryByText('First-use research policy')).toBeNull(); expect(screen.queryByRole('button', { name: 'Approve research' })).toBeNull();
    expect(providerSelect().value).toBe('responses_cited');
    expect(input(/Residential regions/).value).toBe('Providence, RI\nBoston, MA'); expect(input(/Targeting terms/).value).toBe('property management company');
    expect(input(/Official website URLs/).value).toBe('https://example.com/'); expect(input(/Maximum companies/).value).toBe('1');
    expect(input(/Maximum pages/).value).toBe('2'); expect(input(/Maximum bytes/).value).toBe('20000');
    expect(input(/Discovery cumulative/).value).toBe('2'); expect(input(/Research cumulative/).value).toBe('3');
    expect(screen.getByText('Replacing keeps spent budget and the admission fence; it changes what the worker discovers next.')).toBeTruthy();
    const replace = button('Replace configuration'); expect(replace.disabled).toBe(true);
    fireEvent.change(providerSelect(), { target: { value: 'places' } }); fireEvent.change(input(/Companies per batch/), { target: { value: '20' } });
    fireEvent.change(input(/Discovery cumulative/), { target: { value: '2.5' } });
    expect(replace.disabled).toBe(true); fireEvent.click(ack()); expect(replace.disabled).toBe(false); expect(button('Pause research').disabled).toBe(false);
    fireEvent.click(replace); await idle();
    expect(a.approve).toHaveBeenCalledWith({ expectedRevision: 8, descriptorFingerprint: fingerprint, discoveryProvider: 'places',
      audience: { residential: true, regions: ['Providence, RI', 'Boston, MA'], terms: ['property management company'] }, permittedSources: [],
      maxCompanies: 20, maxPages: 2, maxBytes: 20000, discoveryCeilingMicros: 2500000, researchCeilingMicros: 3000000, disclosureAcknowledged: true });
    expect(a.setState).not.toHaveBeenCalled(); expect(a.status).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Research policy request applied\. Refresh for current policy/)).toBeTruthy();
  });
  it('treats a receipt that is not the next revision as unknown, and blocks replacing when the proposal provider is not ready', async () => {
    const a = api(configured()); a.approve.mockResolvedValue({ ...applied, revision: 1 }); await mount(a);
    fireEvent.click(ack()); fireEvent.click(button('Replace configuration')); await idle();
    expect(a.approve).toHaveBeenCalledTimes(1); expect(screen.getByText(/Request outcome unknown/)).toBeTruthy();
    cleanup();
    const blocked = configured(); blocked.remote!.placesBlockers = ['places_cost_missing']; delete blocked.remote!.descriptor!.placesSearchCostMicros;
    const b = api(blocked); await mount(b);
    fireEvent.click(ack()); expect(button('Replace configuration').disabled).toBe(false);
    fireEvent.change(providerSelect(), { target: { value: 'places' } }); fireEvent.change(input(/Companies per batch/), { target: { value: '20' } }); fireEvent.click(ack());
    expect(button('Replace configuration').disabled).toBe(true); expect(screen.getByText(/carry no Places cost per call/)).toBeTruthy();
    expect(button('Pause research').disabled).toBe(false); expect(b.approve).not.toHaveBeenCalled();
  });
  it('keeps in-progress edits across a same-revision Refresh and re-prefills only when the policy revision changes', async () => {
    const a = api(configured()); await mount(a);
    fireEvent.change(input(/Residential regions/), { target: { value: 'Dallas, TX' } });
    fireEvent.click(button('Refresh')); await idle();
    expect(input(/Residential regions/).value).toBe('Dallas, TX');
    const next = configured(9); next.remote!.selector!.research!.audience.regions = ['Fort Worth, TX'];
    a.status.mockResolvedValue(next); fireEvent.click(button('Refresh')); await idle();
    expect(input(/Residential regions/).value).toBe('Fort Worth, TX'); expect(a.approve).not.toHaveBeenCalled();
  });
  it('offers no replace action without a stored policy and keeps first-use approval at revision 0', async () => {
    const a = api(); await mount(a); fill(); fireEvent.click(ack());
    expect(screen.queryByRole('button', { name: 'Replace configuration' })).toBeNull();
    fireEvent.click(button('Approve research')); await idle();
    expect(a.approve.mock.calls[0]![0].expectedRevision).toBe(0);
    cleanup();
    const bare = policyStatus(); await mount(api(bare));
    expect(screen.queryByRole('button', { name: 'Replace configuration' })).toBeNull(); expect(screen.queryByLabelText(/Residential regions/)).toBeNull();
  });
});
