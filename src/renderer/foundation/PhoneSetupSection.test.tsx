// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PhoneSetupApi, PhoneSetupStatus } from '../../shared/contracts/phoneSetupContract';
import { PhoneSetupSection } from './PhoneSetupSection';

const timestamp = '2026-09-10T23:00:00.000Z';
const candidate = (fingerprint = 'candidate_A'): PhoneSetupStatus => ({ state: 'needs_confirmation', candidateFingerprint: fingerprint, confirmedAt: null });
const configured = (fingerprint = 'candidate_A'): PhoneSetupStatus => ({ state: 'configured', candidateFingerprint: fingerprint, confirmedAt: timestamp });
const empty: PhoneSetupStatus = { state: 'unconfigured', candidateFingerprint: null, confirmedAt: null };
const unavailable: PhoneSetupStatus = { state: 'unavailable', candidateFingerprint: null, confirmedAt: null };
function fixture(initial: PhoneSetupStatus = candidate()) {
  return {
    status: vi.fn<PhoneSetupApi['status']>(async () => initial),
    confirm: vi.fn<PhoneSetupApi['confirm']>(async input => configured(input.expectedFingerprint)),
    clear: vi.fn<PhoneSetupApi['clear']>(async () => empty),
  } satisfies PhoneSetupApi;
}
function deferred() {
  let resolve!: (value: PhoneSetupStatus) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<PhoneSetupStatus>((yes, no) => { resolve = yes; reject = no; });
  // Attach before exposing reject. Join is fulfilled even when the tested operation rejects.
  const joined = promise.then((): void => undefined, (): void => undefined);
  return { promise, resolve, reject, joined };
}
async function settle(d: ReturnType<typeof deferred>, value = empty) {
  await act(async () => { d.resolve(value); await d.joined; });
}
const button = (action: 'Confirm' | 'Clear' | 'Refresh') => screen.getByRole('button', { name: `${action} phone setup` });
const enabled = (action: 'Confirm' | 'Clear' | 'Refresh') => expect(button(action).hasAttribute('disabled')).toBe(false);
const held = (action: 'Confirm' | 'Clear' | 'Refresh') => expect(button(action).hasAttribute('disabled')).toBe(true);
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Task8 Phone setup public controls', () => {
  it('reads exact initial candidate without confirming or clearing', async () => {
    const api = fixture(); render(<PhoneSetupSection api={api} />);
    await screen.findByText('candidate_A');
    expect(screen.getByRole('region', { name: 'Phone handoff' })).toBeTruthy();
    enabled('Confirm'); enabled('Clear'); enabled('Refresh');
    expect(api.status).toHaveBeenCalledTimes(1); expect(api.status).toHaveBeenCalledWith();
    expect(api.confirm).not.toHaveBeenCalled(); expect(api.clear).not.toHaveBeenCalled();
  }, 10_000);

  it.each([
    { status: empty, label: 'Unconfigured' }, { status: unavailable, label: 'Unavailable' },
    { status: candidate(), label: 'Needs confirmation' }, { status: configured(), label: 'Configured' },
  ])('renders truthful $label evidence without mutation', async ({ status, label }) => {
    const api = fixture(status); render(<PhoneSetupSection api={api} />);
    await screen.findByText(label, { exact: true });
    if (status.candidateFingerprint) await screen.findByText(status.candidateFingerprint, { exact: true });
    else {
      expect(screen.queryByText('candidate_A')).toBeNull();
      held('Confirm'); fireEvent.click(button('Confirm'));
    }
    if (status.confirmedAt) {
      expect(screen.getByText(timestamp, { exact: true })).toBeTruthy();
      const copy = screen.getByRole('region', { name: 'Phone handoff' }).textContent ?? '';
      expect(copy).toMatch(/(?:does not|not|never)[^.]*recording consent/i);
      expect(copy).toMatch(/(?:does not|not|never)[^.]*call permission/i);
      expect(copy).toMatch(/(?:does not|not|never)[^.]*connected/i);
    }
    else expect(screen.queryByText(timestamp, { exact: true })).toBeNull();
    expect(screen.queryByText(/^(Connected|Recording consent granted|Call permission granted)$/i)).toBeNull();
    expect(api.confirm).not.toHaveBeenCalled(); expect(api.clear).not.toHaveBeenCalled();
  }, 10_000);

  it('missing optional API is unavailable and never reads window.callie', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'callie');
    const fallback = vi.fn(() => { throw Error('Global fallback forbidden'); });
    Object.defineProperty(window, 'callie', { configurable: true, get: fallback });
    try {
      render(<PhoneSetupSection />);
      await screen.findByText('Unavailable', { exact: true });
      expect(fallback).not.toHaveBeenCalled();
      const confirm = screen.queryByRole('button', { name: 'Confirm phone setup' });
      expect(confirm === null || confirm.hasAttribute('disabled')).toBe(true);
    } finally {
      cleanup();
      if (original) Object.defineProperty(window, 'callie', original); else Reflect.deleteProperty(window, 'callie');
    }
  }, 10_000);

  it.each(['rejected', 'inconsistent', 'invalid fingerprint', 'invalid timestamp', 'extra key'] as const)(
    'holds %s status and recovers only on explicit Refresh', async kind => {
      const api = fixture();
      const malformed: Record<string, unknown> = kind === 'inconsistent' ? { ...configured(), candidateFingerprint: null }
        : kind === 'invalid fingerprint' ? { ...candidate(), candidateFingerprint: 'not a fingerprint' }
        : kind === 'invalid timestamp' ? { ...configured(), confirmedAt: 'yesterday' }
        : { ...candidate(), privatePath: '/private/secret' };
      if (kind === 'rejected') api.status.mockRejectedValueOnce(Error('/private/secret'));
      else api.status.mockResolvedValueOnce(malformed as unknown as PhoneSetupStatus);
      render(<PhoneSetupSection api={api} />);
      await screen.findByText('Unavailable', { exact: true });
      expect(screen.queryByText(/private\/secret/)).toBeNull();
      expect(screen.queryByText('candidate_A')).toBeNull();
      const confirm = screen.queryByRole('button', { name: 'Confirm phone setup' });
      expect(confirm === null || confirm.hasAttribute('disabled')).toBe(true);
      enabled('Refresh'); fireEvent.click(button('Refresh'));
      await screen.findByText('candidate_A'); enabled('Confirm');
      expect(api.status).toHaveBeenCalledTimes(2);
      fireEvent.click(button('Confirm'));
      await screen.findByText(timestamp);
      expect(api.confirm).toHaveBeenCalledTimes(1); expect(api.confirm).toHaveBeenCalledWith({ expectedFingerprint: 'candidate_A' });
      expect(api.clear).not.toHaveBeenCalled();
    }, 10_000,
  );

  it.each(['Confirm', 'Clear'] as const)('synchronously fences double %s and cross-action attempts, then permits new work', async action => {
    const api = fixture(); const pending = deferred();
    if (action === 'Confirm') api.confirm.mockReturnValueOnce(pending.promise);
    else api.clear.mockReturnValueOnce(pending.promise);
    try {
      render(<PhoneSetupSection api={api} />); await screen.findByText('candidate_A');
      act(() => { fireEvent.click(button(action)); fireEvent.click(button(action)); fireEvent.click(button(action === 'Confirm' ? 'Clear' : 'Confirm')); fireEvent.click(button('Refresh')); });
      expect(api.confirm).toHaveBeenCalledTimes(action === 'Confirm' ? 1 : 0);
      expect(api.clear).toHaveBeenCalledTimes(action === 'Clear' ? 1 : 0);
      expect(api.status).toHaveBeenCalledTimes(1);
      held('Confirm'); held('Clear'); held('Refresh');
      if (action === 'Confirm') expect(api.confirm).toHaveBeenLastCalledWith({ expectedFingerprint: 'candidate_A' });
      else expect(api.clear).toHaveBeenLastCalledWith();
      await settle(pending, action === 'Confirm' ? configured() : empty);
      await screen.findByText(action === 'Confirm' ? 'Configured' : 'Unconfigured', { exact: true });
      expect(api.status).toHaveBeenCalledTimes(1); // Clear's returned state must survive: no implicit read.
      if (action === 'Clear') {
        expect(screen.queryByText('candidate_A')).toBeNull(); held('Confirm');
        fireEvent.click(button('Confirm')); expect(api.confirm).not.toHaveBeenCalled();
      }
      enabled('Refresh'); fireEvent.click(button('Refresh'));
      await screen.findByText('Needs confirmation', { exact: true }); enabled('Confirm');
      fireEvent.click(button('Confirm')); await screen.findByText(timestamp);
      expect(api.confirm).toHaveBeenCalledTimes(action === 'Confirm' ? 2 : 1);
    } finally { await settle(pending); }
  }, 10_000);

  it('rejects stale exact A, explicitly refreshes B, and requires another explicit Confirm B', async () => {
    const api = fixture(); const pending = deferred(); api.confirm.mockReturnValueOnce(pending.promise);
    api.status.mockResolvedValueOnce(candidate()).mockResolvedValue(candidate('candidate_B'));
    try {
      render(<PhoneSetupSection api={api} />); await screen.findByText('candidate_A');
      fireEvent.click(button('Confirm'));
      expect(api.confirm).toHaveBeenCalledTimes(1); expect(api.confirm).toHaveBeenCalledWith({ expectedFingerprint: 'candidate_A' });
      await act(async () => { pending.reject(Error('PHONE_SETUP_FAILED')); await pending.joined; });
      await screen.findByRole('alert');
      expect(screen.queryByText('Configured', { exact: true })).toBeNull();
      expect(screen.queryByText(/PHONE_SETUP_FAILED/)).toBeNull();
      expect(api.status).toHaveBeenCalledTimes(1); expect(api.confirm).toHaveBeenCalledTimes(1);
      fireEvent.click(button('Refresh')); await screen.findByText('candidate_B');
      expect(api.confirm).toHaveBeenCalledTimes(1);
      fireEvent.click(button('Confirm')); await screen.findByText(timestamp);
      expect(api.confirm.mock.calls).toEqual([[{ expectedFingerprint: 'candidate_A' }], [{ expectedFingerprint: 'candidate_B' }]]);
      expect(api.clear).not.toHaveBeenCalled();
    } finally { await settle(pending); }
  }, 10_000);

  it('failed Clear is not removal and explicit retry can succeed', async () => {
    const api = fixture(configured()); api.clear.mockRejectedValueOnce(Error('/private/clear-failure'));
    render(<PhoneSetupSection api={api} />); await screen.findByText(timestamp);
    fireEvent.click(button('Clear')); await screen.findByRole('alert');
    expect(screen.queryByText('Unconfigured', { exact: true })).toBeNull();
    expect(screen.queryByText(/private\/clear-failure/)).toBeNull();
    expect(api.status).toHaveBeenCalledTimes(1); fireEvent.click(button('Refresh'));
    await screen.findByText('Configured', { exact: true }); await waitFor(() => enabled('Clear'));
    fireEvent.click(button('Clear')); await screen.findByText('Unconfigured', { exact: true });
    expect(api.clear.mock.calls).toEqual([[], []]); expect(api.confirm).not.toHaveBeenCalled();
  }, 10_000);

  it.each(['old-first', 'new-first'] as const)('API replacement status ordering %s cannot restore old evidence', async order => {
    const old = fixture(); const current = fixture(); const a = deferred(); const b = deferred();
    old.status.mockReturnValueOnce(a.promise); current.status.mockReturnValueOnce(b.promise);
    try {
      const view = render(<PhoneSetupSection api={old} />);
      expect(old.status).toHaveBeenCalledTimes(1);
      view.rerender(<PhoneSetupSection api={current} />);
      expect(current.status).toHaveBeenCalledTimes(1);
      if (order === 'old-first') { await settle(a, configured()); expect(screen.queryByText('candidate_A')).toBeNull(); await settle(b, candidate('candidate_B')); }
      else { await settle(b, candidate('candidate_B')); await settle(a, configured()); }
      await screen.findByText('candidate_B'); expect(screen.queryByText('candidate_A')).toBeNull();
      enabled('Confirm'); fireEvent.click(button('Confirm')); await screen.findByText(timestamp);
      expect(current.confirm).toHaveBeenCalledTimes(1); expect(current.confirm).toHaveBeenCalledWith({ expectedFingerprint: 'candidate_B' });
      expect(old.confirm).not.toHaveBeenCalled();
    } finally { await settle(a); await settle(b); }
  }, 10_000);

  it.each(['Confirm', 'Clear'] as const)('old %s finally cannot release a newer API mutation fence', async action => {
    const old = fixture(); const current = fixture(candidate('candidate_B')); const a = deferred(); const b = deferred();
    if (action === 'Confirm') old.confirm.mockReturnValueOnce(a.promise); else old.clear.mockReturnValueOnce(a.promise);
    current.confirm.mockReturnValueOnce(b.promise);
    try {
      const view = render(<PhoneSetupSection api={old} />); await screen.findByText('candidate_A');
      fireEvent.click(button(action)); view.rerender(<PhoneSetupSection api={current} />);
      await screen.findByText('candidate_B'); fireEvent.click(button('Confirm'));
      await settle(a, action === 'Confirm' ? configured() : empty);
      expect(screen.queryByText('candidate_A')).toBeNull();
      held('Confirm'); held('Clear'); held('Refresh');
      act(() => { fireEvent.click(button('Confirm')); fireEvent.click(button('Clear')); fireEvent.click(button('Refresh')); });
      expect(current.confirm).toHaveBeenCalledTimes(1); expect(current.confirm).toHaveBeenCalledWith({ expectedFingerprint: 'candidate_B' });
      expect(current.clear).not.toHaveBeenCalled(); expect(current.status).toHaveBeenCalledTimes(1);
      await settle(b, configured('candidate_B')); await screen.findByText(timestamp); enabled('Clear');
      fireEvent.click(button('Clear')); await screen.findByText('Unconfigured', { exact: true });
      expect(current.clear).toHaveBeenCalledTimes(1);
    } finally { await settle(a); await settle(b); }
  }, 10_000);

  it.each(['Confirm', 'Clear'] as const)('late old %s after current success cannot overwrite new API evidence', async action => {
    const old = fixture(); const current = fixture(candidate('candidate_B')); const a = deferred();
    if (action === 'Confirm') old.confirm.mockReturnValueOnce(a.promise); else old.clear.mockReturnValueOnce(a.promise);
    try {
      const view = render(<PhoneSetupSection api={old} />); await screen.findByText('candidate_A');
      fireEvent.click(button(action)); view.rerender(<PhoneSetupSection api={current} />);
      await screen.findByText('candidate_B'); fireEvent.click(button('Confirm')); await screen.findByText(timestamp);
      await settle(a, action === 'Confirm' ? configured() : empty);
      expect(screen.getByText('candidate_B')).toBeTruthy(); expect(screen.getByText('Configured', { exact: true })).toBeTruthy();
      expect(current.confirm).toHaveBeenCalledTimes(1); expect(current.confirm).toHaveBeenCalledWith({ expectedFingerprint: 'candidate_B' });
    } finally { await settle(a); }
  }, 10_000);
  it('failed explicit Refresh invalidates formerly usable evidence and a later Refresh recovers', async () => {
    const api = fixture();
    api.status.mockResolvedValueOnce(candidate()).mockRejectedValueOnce(Error('/private/stale-status')).mockResolvedValue(candidate('candidate_B'));
    render(<PhoneSetupSection api={api} />); await screen.findByText('candidate_A');
    fireEvent.click(button('Refresh')); await screen.findByText('Unavailable', { exact: true });
    expect(screen.queryByText('candidate_A')).toBeNull(); expect(screen.queryByText(/private\/stale-status/)).toBeNull();
    const confirm = screen.queryByRole('button', { name: 'Confirm phone setup' });
    expect(confirm === null || confirm.hasAttribute('disabled')).toBe(true);
    expect(api.confirm).not.toHaveBeenCalled(); expect(api.clear).not.toHaveBeenCalled();
    fireEvent.click(button('Refresh')); await screen.findByText('candidate_B');
    enabled('Confirm'); fireEvent.click(button('Confirm')); await screen.findByText(timestamp);
    expect(api.confirm.mock.calls).toEqual([[{ expectedFingerprint: 'candidate_B' }]]);
  }, 10_000);

  it('API removal fences a pending observation and restoration performs a fresh read', async () => {
    const old = fixture(); const fresh = fixture(candidate('candidate_B')); const pending = deferred(); old.status.mockReturnValueOnce(pending.promise);
    try {
      const view = render(<PhoneSetupSection api={old} />); view.rerender(<PhoneSetupSection />);
      await screen.findByText('Unavailable', { exact: true }); await settle(pending, configured());
      expect(screen.queryByText('candidate_A')).toBeNull(); expect(screen.queryByText(timestamp)).toBeNull();
      view.rerender(<PhoneSetupSection api={fresh} />); await screen.findByText('candidate_B'); enabled('Confirm');
      expect(fresh.status).toHaveBeenCalledTimes(1); expect(old.confirm).not.toHaveBeenCalled();
    } finally { await settle(pending); }
  }, 10_000);

  it('pending explicit status read fences conflicting actions and enables them after current evidence arrives', async () => {
    const api = fixture(); const read = deferred(); api.status.mockResolvedValueOnce(candidate()).mockReturnValueOnce(read.promise);
    try {
      render(<PhoneSetupSection api={api} />); await screen.findByText('candidate_A'); fireEvent.click(button('Refresh'));
      held('Confirm'); held('Clear'); held('Refresh');
      act(() => { fireEvent.click(button('Confirm')); fireEvent.click(button('Clear')); fireEvent.click(button('Refresh')); });
      expect(api.status).toHaveBeenCalledTimes(2); expect(api.confirm).not.toHaveBeenCalled(); expect(api.clear).not.toHaveBeenCalled();
      await settle(read, candidate('candidate_B')); await screen.findByText('candidate_B');
      enabled('Confirm'); enabled('Clear'); enabled('Refresh');
      fireEvent.click(button('Confirm')); await screen.findByText(timestamp);
      expect(api.confirm.mock.calls).toEqual([[{ expectedFingerprint: 'candidate_B' }]]);
    } finally { await settle(read); }
  }, 10_000);

  it.each(['Confirm', 'Clear'] as const)('malformed %s reply is a safe failure, not success, and explicit retry recovers', async action => {
    const api = fixture(action === 'Clear' ? configured() : candidate());
    if (action === 'Confirm') api.confirm.mockResolvedValueOnce({ state: 'configured', candidateFingerprint: null, confirmedAt: timestamp });
    else api.clear.mockResolvedValueOnce({ state: 'unconfigured', candidateFingerprint: 'candidate_A', confirmedAt: null });
    render(<PhoneSetupSection api={api} />); await screen.findByText('candidate_A');
    fireEvent.click(button(action)); await screen.findByRole('alert');
    expect(screen.queryByText(action === 'Confirm' ? 'Configured' : 'Unconfigured', { exact: true })).toBeNull();
    expect(api.status).toHaveBeenCalledTimes(1); fireEvent.click(button('Refresh'));
    await screen.findByText(action === 'Clear' ? 'Configured' : 'Needs confirmation', { exact: true });
    await waitFor(() => enabled(action)); fireEvent.click(button(action));
    await screen.findByText(action === 'Confirm' ? 'Configured' : 'Unconfigured', { exact: true });
    if (action === 'Confirm') expect(api.confirm.mock.calls).toEqual([[{ expectedFingerprint: 'candidate_A' }], [{ expectedFingerprint: 'candidate_A' }]]);
    else expect(api.clear.mock.calls).toEqual([[], []]);
  }, 10_000);
});


describe('Task8 valid empty observations revoke the displayed confirmation candidate', () => {
  it.each([{ status: empty, label: 'Unconfigured' }, { status: unavailable, label: 'Unavailable' }])(
    'holds cached A after valid $label until explicit fresh B observation', async ({ status, label }) => {
      const api = fixture();
      api.status.mockResolvedValueOnce(candidate()).mockResolvedValueOnce(status).mockResolvedValue(candidate('candidate_B'));
      render(<PhoneSetupSection api={api} />); await screen.findByText('candidate_A'); enabled('Confirm');
      fireEvent.click(button('Refresh')); await screen.findByText(label, { exact: true });
      expect(screen.queryByText('candidate_A')).toBeNull(); held('Confirm'); fireEvent.click(button('Confirm'));
      expect(api.confirm).not.toHaveBeenCalled(); expect(api.clear).not.toHaveBeenCalled();
      expect(api.status).toHaveBeenCalledTimes(2);
      fireEvent.click(button('Refresh')); await screen.findByText('candidate_B'); enabled('Confirm');
      expect(api.confirm).not.toHaveBeenCalled(); fireEvent.click(button('Confirm')); await screen.findByText(timestamp);
      expect(api.confirm.mock.calls).toEqual([[{ expectedFingerprint: 'candidate_B' }]]);
      expect(api.status).toHaveBeenCalledTimes(3); expect(api.clear).not.toHaveBeenCalled();
    }, 10_000,
  );
});
