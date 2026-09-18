// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalliePreloadApi } from '../../shared/preload';
import type { ResearchSetupApi, ResearchSetupStatus } from '../../shared/contracts/researchSetupContract';
import { WorkerSetupSection } from './WorkerSetupSection';

type Api = Pick<CalliePreloadApi['delegation'], 'status' | 'pair'>;
type Status = Awaited<ReturnType<Api['status']>>;
type Receipt = Awaited<ReturnType<Api['pair']>>;
const endpoint = 'https://worker.fixture.invalid';
const workspace = 'fictional-workspace';
const codeA = 'A'.repeat(43);
const codeB = 'B'.repeat(43);
const disclosure = 'Remote owner and mailbox/calendar grants are not established by this local read.';
const empty: Status = { state: 'unconfigured', workspaceId: null, endpoint: null, configuration: null };
const receipt: Receipt = { state: 'paired', workspaceId: workspace, pairingId: 'fictional-pairing' };
function status(state: Status['state'] = 'paused', revision: number | null = null, suffix = ''): Status {
  return { state, workspaceId: `${workspace}${suffix}`, endpoint: `https://worker${suffix}.fixture.invalid`,
    configuration: revision === null ? null : { revision, configuration: { version: 1, state: state === 'active' ? 'active' : 'paused', research: null }, updatedAt: '2026-09-10T23:00:00.000Z' } };
}
function api(initial: Status = empty) {
  return { status: vi.fn<Api['status']>(async () => initial), pair: vi.fn<Api['pair']>(async () => receipt) } satisfies Api;
}
const pendingJoins: Array<() => Promise<void>> = [];
function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  const joined = promise.then((): void => undefined, (): void => undefined);
  pendingJoins.push(async () => { resolve(fallback); await joined; });
  return { promise, resolve, reject, joined, fallback };
}
async function settle<T>(pending: ReturnType<typeof deferred<T>>, value = pending.fallback) {
  await act(async () => { pending.resolve(value); await pending.joined; });
}
async function reject<T>(pending: ReturnType<typeof deferred<T>>) {
  await act(async () => { pending.reject(Error(`private-error ${codeA}`)); await pending.joined; });
}
function field(name: string): HTMLInputElement {
  const input = screen.getByLabelText(name);
  if (!(input instanceof HTMLInputElement)) throw Error('Expected an actual input');
  return input;
}
function button(name: string): HTMLButtonElement {
  const control = screen.getByRole('button', { name });
  if (!(control instanceof HTMLButtonElement)) throw Error('Expected an actual button');
  return control;
}
function fill(code = codeA, target = endpoint, expected = workspace) {
  fireEvent.change(field('Endpoint'), { target: { value: target } });
  fireEvent.change(field('Expected workspace ID'), { target: { value: expected } });
  fireEvent.change(field('Pairing code'), { target: { value: code } });
  expect(field('Pairing code').value).toBe(code);
}
const pair = () => fireEvent.click(button('Pair worker'));
const refresh = () => fireEvent.click(button('Refresh worker status'));
async function observed(label = 'Unconfigured') {
  const region = await screen.findByRole('region', { name: 'Worker connection' });
  await within(region).findByText(label, { exact: true });
  expect(within(region).getByText(disclosure)).toBeTruthy();
  return region;
}
async function ready(a = api()) {
  const view = render(<WorkerSetupSection api={a} />);
  await observed();
  expect(a.status).toHaveBeenCalledWith();
  return view;
}
function safeFeedback() {
  expect(screen.queryByText(/private-error|invalid_type|ZodError/)).toBeNull();
  expect(document.body.textContent).not.toContain(codeA);
  expect(document.body.textContent).not.toContain(codeB);
  expect(document.body.textContent).not.toMatch(/nothing (?:was )?saved|no identity (?:was )?saved/i);
}
let savedStorage: Array<[Storage, Array<[string, string]>]> = [];
beforeEach(() => {
  savedStorage = [localStorage, sessionStorage].map(storage => [storage, Object.keys(storage).map(key => [key, storage.getItem(key) ?? ''])]);
});
afterEach(async () => {
  cleanup();
  // A failed setup assertion still settles every handled deferred. This is not cancellation.
  for (const join of pendingJoins.splice(0)) await join();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const [storage, values] of savedStorage) { storage.clear(); for (const [key, value] of values) storage.setItem(key, value); }
});

describe('Task9 Worker local status and explicit credential exchange', () => {
  it.each([
    ['Unconfigured', empty], ['Paused', status()], ['Paused', status('paused', 7)],
    ['Active', status('active', 19)], ['Locked', status('locked')],
  ] as const)('W01 truthful %s facts and unknown grants', async (label, value) => {
    const a = api(value); render(<WorkerSetupSection api={a} />);
    const region = await observed(label);
    expect(a.status.mock.calls).toEqual([[]]); expect(a.pair).not.toHaveBeenCalled();
    if (value.endpoint) expect(region.textContent).toContain(value.endpoint);
    if (value.workspaceId) expect(region.textContent).toContain(value.workspaceId);
    if (value.configuration) expect(region.textContent).toMatch(new RegExp(`revision[^0-9]*${value.configuration.revision}`, 'i'));
    else expect(region.textContent).not.toMatch(/revision\s*:?\s*0\b/i);
    expect(region.textContent).not.toMatch(/healthy queue|grants established|owner connected/i);
    for (const name of ['Endpoint', 'Expected workspace ID', 'Pairing code']) expect(field(name)).toBeTruthy();
    if (label === 'Locked') { pair(); expect(a.pair).not.toHaveBeenCalled(); }
  }, 10_000);

  it('W02 explicit Refresh changes real local facts without pairing', async () => {
    const a = api(); await ready(a);
    a.status.mockResolvedValueOnce(status('active', 23, '-new')); refresh();
    const region = await observed('Active');
    expect(region.textContent).toContain(`${workspace}-new`);
    expect(region.textContent).toContain('https://worker-new.fixture.invalid');
    expect(region.textContent).toMatch(/revision[^0-9]*23/i);
    expect(a.status.mock.calls).toEqual([[], []]); expect(a.pair).not.toHaveBeenCalled();
  }, 10_000);

  it.each(['missing', 'rejected', 'malformed', 'zero revision', 'extra key', 'null'] as const)('W03 %s status is unavailable, never fake unconfigured', async mode => {
    const a = api();
    if (mode === 'rejected') a.status.mockRejectedValueOnce(Error(`private-error ${codeA}`));
    if (mode === 'malformed') a.status.mockResolvedValueOnce({ state: 'healthy' } as unknown as Status);
    if (mode === 'zero revision') a.status.mockResolvedValueOnce(status('active', 0));
    if (mode === 'extra key') a.status.mockResolvedValueOnce({ ...empty, healthy: true } as unknown as Status);
    if (mode === 'null') a.status.mockResolvedValueOnce(null as unknown as Status);
    render(<WorkerSetupSection api={mode === 'missing' ? undefined : a} />);
    await observed('Unavailable');
    expect(screen.queryByText('Unconfigured', { exact: true })).toBeNull();
    pair(); expect(a.pair).not.toHaveBeenCalled(); safeFeedback();
  }, 10_000);

  it.each(['locked', 'rejected'] as const)('W04 %s Refresh invalidates code and recovery requires fresh explicit input', async mode => {
    const a = api(); await ready(a); fill();
    if (mode === 'locked') a.status.mockResolvedValueOnce(status('locked'));
    else a.status.mockRejectedValueOnce(Error(`private-error ${codeA}`));
    refresh(); await observed(mode === 'locked' ? 'Locked' : 'Unavailable');
    expect(field('Pairing code').value).toBe(''); pair(); expect(a.pair).not.toHaveBeenCalled();
    a.status.mockResolvedValueOnce(empty); refresh(); await observed();
    pair(); expect(a.pair).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(button('Pair worker').disabled).toBe(false);
      expect(button('Refresh worker status').disabled).toBe(false);
      expect(field('Pairing code').disabled).toBe(false);
    });
    expect(a.pair).not.toHaveBeenCalled();
    fill(codeB); pair(); await screen.findByText('Worker paired', { exact: true });
    expect(a.pair.mock.calls).toEqual([[{ endpoint, expectedWorkspaceId: workspace, code: codeB }]]); safeFeedback();
  }, 10_000);

  it.each([
    ['invalid URL', 'not a url', workspace, codeA], ['empty endpoint', '', workspace, codeA],
    ['empty workspace', endpoint, '', codeA], ['oversize workspace', endpoint, 'w'.repeat(201), codeA],
    ['empty code', endpoint, workspace, ''], ['oversize code', endpoint, workspace, 'C'.repeat(129)],
  ])('W05 strict validation %s clears code without pair', async (_name, target, expected, code) => {
    const a = api(); await ready(a); fill(code, target, expected); pair();
    await waitFor(() => expect(field('Pairing code').value).toBe(''));
    expect(a.pair).not.toHaveBeenCalled(); expect(a.status).toHaveBeenCalledTimes(1); safeFeedback();
  }, 10_000);

  it('W06 exact untrimmed shared-schema-valid values reach one frozen request', async () => {
    // Deliberately exercises public schema preservation, not a provider success fixture.
    const a = api(); const pending = deferred(receipt);
    a.pair.mockReturnValueOnce(pending.promise); await ready(a);
    try {
      fill(' '+codeA+' ', endpoint, ' workspace with spaces '); pair();
      await waitFor(() => expect(a.pair).toHaveBeenCalledTimes(1));
      const input = a.pair.mock.calls[0][0];
      expect(input).toEqual({ endpoint, expectedWorkspaceId: ' workspace with spaces ', code: ' '+codeA+' ' });
      // A real edit is attempted only if the product permits editing while pending.
      if (!field('Endpoint').disabled) fireEvent.change(field('Endpoint'), { target: { value: 'https://other.fixture.invalid' } });
      expect(input).toEqual({ endpoint, expectedWorkspaceId: ' workspace with spaces ', code: ' '+codeA+' ' });
      await reject(pending); await waitFor(() => expect(field('Pairing code').value).toBe('')); safeFeedback();
    } finally { await settle(pending); }
  }, 10_000);

  it('W07 same-batch Pair duplicate and pending Refresh are fenced without losing submitted identity', async () => {
    const a = api(); const pending = deferred(receipt); a.pair.mockReturnValueOnce(pending.promise);
    await ready(a);
    try {
      fill(); const submit = button('Pair worker');
      act(() => { fireEvent.click(submit); fireEvent.click(submit); });
      await waitFor(() => expect(a.pair).toHaveBeenCalledTimes(1));
      expect(button('Pair worker').disabled).toBe(true); expect(button('Refresh worker status').disabled).toBe(true);
      refresh(); pair(); expect(a.status).toHaveBeenCalledTimes(1);
      expect(a.pair.mock.calls).toEqual([[{ endpoint, expectedWorkspaceId: workspace, code: codeA }]]);
      await settle(pending); await screen.findByText('Worker paired', { exact: true });
      expect(field('Pairing code').value).toBe(''); expect(a.pair).toHaveBeenCalledTimes(1);
    } finally { await settle(pending); }
  }, 10_000);

  it('W08 pending status fences Pair and duplicate Refresh through public controls', async () => {
    const a = api(); await ready(a); fill(); const pending = deferred(empty); a.status.mockReturnValueOnce(pending.promise);
    try {
      refresh(); await waitFor(() => expect(a.status).toHaveBeenCalledTimes(2));
      expect(button('Pair worker').disabled).toBe(true); expect(button('Refresh worker status').disabled).toBe(true);
      pair(); refresh(); expect(a.pair).not.toHaveBeenCalled(); expect(a.status).toHaveBeenCalledTimes(2);
      await settle(pending); await observed(); fill(codeB); pair();
      await screen.findByText('Worker paired', { exact: true }); expect(a.pair).toHaveBeenCalledTimes(1);
    } finally { await settle(pending); }
  }, 10_000);

  it.each(['unconfigured', 'rejected', 'pending'] as const)('W09 successful receipt survives %s post-pair local status with immediate code clearing', async mode => {
    const a = api(); await ready(a); const followup = deferred(empty);
    if (mode === 'pending') a.status.mockReturnValueOnce(followup.promise);
    if (mode === 'rejected') a.status.mockRejectedValueOnce(Error(`private-error ${codeA}`));
    try {
      fill(); pair(); await screen.findByText('Worker paired', { exact: true });
      expect(a.pair).toHaveBeenCalledTimes(1); expect(a.pair.mock.results[0].type).toBe('return');
      await expect(a.pair.mock.results[0].value).resolves.toEqual(receipt);
      await waitFor(() => expect(a.status).toHaveBeenCalledTimes(2));
      expect(field('Pairing code').value).toBe('');
      expect(screen.queryByText('Active', { exact: true })).toBeNull();
      expect(screen.getByText(disclosure)).toBeTruthy();
      if (mode !== 'pending') await observed(mode === 'rejected' ? 'Unavailable' : 'Unconfigured');
      await settle(followup); expect(screen.getByText('Worker paired', { exact: true })).toBeTruthy();
      expect(a.pair).toHaveBeenCalledTimes(1); safeFeedback();
    } finally { await settle(followup); }
  }, 10_000);

  it.each(['reject', 'sync throw', 'malformed', 'mismatch', 'extra key'] as const)('W10 %s pair outcome is uncertain, clears code, retains nonsecret fields and permits only fresh explicit retry', async mode => {
    const a = api(); await ready(a);
    if (mode === 'reject') a.pair.mockRejectedValueOnce(Error(`private-error ${codeA}`));
    if (mode === 'sync throw') a.pair.mockImplementationOnce(() => { throw Error(`private-error ${codeA}`); });
    if (mode === 'malformed') a.pair.mockResolvedValueOnce({ workspaceId: workspace, pairingId: codeA } as unknown as Receipt);
    if (mode === 'mismatch') a.pair.mockResolvedValueOnce({ ...receipt, workspaceId: 'wrong-workspace' });
    if (mode === 'extra key') a.pair.mockResolvedValueOnce({ ...receipt, diagnostic: codeA } as unknown as Receipt);
    fill(); pair(); await waitFor(() => expect(a.pair).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(field('Pairing code').value).toBe(''));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('Worker paired', { exact: true })).toBeNull();
    expect(field('Endpoint').value).toBe(endpoint); expect(field('Expected workspace ID').value).toBe(workspace);
    safeFeedback();
    // Explicit status review is allowed. It must not retry or restore the old code.
    await waitFor(() => expect(button('Refresh worker status').disabled).toBe(false));
    refresh(); await observed(); expect(a.pair).toHaveBeenCalledTimes(1); expect(field('Pairing code').value).toBe('');
    fill(codeB); pair(); await screen.findByText('Worker paired', { exact: true });
    expect(a.pair.mock.calls).toEqual([[{ endpoint, expectedWorkspaceId: workspace, code: codeA }], [{ endpoint, expectedWorkspaceId: workspace, code: codeB }]]);
  }, 10_000);

  it('W11 no code is persisted or logged or sent through navigation events', async () => {
    const a = api(); await ready(a);
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('Unexpected persistence'); });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    fill(); pair(); await screen.findByText('Worker paired', { exact: true });
    expect(field('Pairing code').value).toBe(''); expect(storage).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled(); safeFeedback();
  }, 10_000);
});

describe('Task9 Worker generation and lifetime ownership', () => {
  it.each(['old first', 'new first', 'old failure', 'new failure', 'old failure first'] as const)('W12 API replacement status ordering: %s', async order => {
    const a = api(); const b = api(); const old = deferred(status('active', 11, '-old')); const fresh = deferred(status('paused', 29, '-new'));
    a.status.mockReturnValueOnce(old.promise); b.status.mockReturnValueOnce(fresh.promise);
    const view = render(<WorkerSetupSection api={a} />);
    try {
      await waitFor(() => expect(a.status).toHaveBeenCalledTimes(1)); view.rerender(<WorkerSetupSection api={b} />);
      await waitFor(() => expect(b.status).toHaveBeenCalledTimes(1));
      if (order === 'old first' || order === 'old failure first') {
        expect(button('Pair worker').disabled).toBe(true);
        expect(button('Refresh worker status').disabled).toBe(true);
        const pendingText = screen.getByRole('region', { name: 'Worker connection' }).textContent;
        const pendingAlerts = screen.queryAllByRole('alert').map(alert => alert.textContent);
        if (order === 'old first') await settle(old); else await reject(old);
        const pendingRegion = screen.getByRole('region', { name: 'Worker connection' });
        expect(pendingRegion.textContent).toBe(pendingText);
        expect(screen.queryAllByRole('alert').map(alert => alert.textContent)).toEqual(pendingAlerts);
        expect(pendingRegion.textContent).not.toContain(`${workspace}-old`);
        expect(pendingRegion.textContent).not.toContain('https://worker-old.fixture.invalid');
        expect(pendingRegion.textContent).not.toMatch(/revision[^0-9]*11\b/i);
        expect(within(pendingRegion).queryByText('Active', { exact: true })).toBeNull();
        expect(screen.queryByText('Worker paired', { exact: true })).toBeNull();
        expect(button('Pair worker').disabled).toBe(true);
        expect(button('Refresh worker status').disabled).toBe(true);
        expect(a.status.mock.calls).toEqual([[]]);
        expect(b.status.mock.calls).toEqual([[]]);
        expect(a.pair).not.toHaveBeenCalled(); expect(b.pair).not.toHaveBeenCalled(); safeFeedback();
        await settle(fresh);
      }
      else if (order === 'old failure') { await settle(fresh); await reject(old); }
      else if (order === 'new failure') { await reject(fresh); await settle(old); }
      else { await settle(fresh); await settle(old); }
      const region = await observed(order === 'new failure' ? 'Unavailable' : 'Paused');
      expect(region.textContent).not.toContain(`${workspace}-old`);
      if (order !== 'new failure') expect(region.textContent).toContain(`${workspace}-new`);
      expect(a.pair).not.toHaveBeenCalled(); expect(b.pair).not.toHaveBeenCalled(); safeFeedback();
    } finally { await settle(old); await settle(fresh); }
  }, 10_000);

  it.each(['replace', 'remove', 'ABA'] as const)('W13 pending pair %s invalidation clears code and stale settlement starts no reads', async mode => {
    const a = api(); const b = api(); const old = deferred(receipt); a.pair.mockReturnValueOnce(old.promise);
    const view = await ready(a);
    try {
      fill(); pair(); await waitFor(() => expect(a.pair).toHaveBeenCalledTimes(1));
      view.rerender(<WorkerSetupSection api={mode === 'remove' ? undefined : b} />);
      await observed(mode === 'remove' ? 'Unavailable' : 'Unconfigured');
      if (mode !== 'remove') await waitFor(() => expect(b.status).toHaveBeenCalledTimes(1));
      expect(field('Pairing code').value).toBe('');
      if (mode === 'ABA') { view.rerender(<WorkerSetupSection api={a} />); await observed(); await waitFor(() => expect(a.status).toHaveBeenCalledTimes(2)); }
      const aReads = a.status.mock.calls.length; const bReads = b.status.mock.calls.length;
      if (mode !== 'remove') fill(codeB);
      await settle(old);
      expect(a.status).toHaveBeenCalledTimes(aReads); expect(b.status).toHaveBeenCalledTimes(bReads);
      expect(screen.queryByText('Worker paired', { exact: true })).toBeNull();
      if (mode !== 'remove') {
        expect(field('Pairing code').value).toBe(codeB); pair();
        await screen.findByText('Worker paired', { exact: true });
        const current = mode === 'ABA' ? a : b;
        expect(current.pair).toHaveBeenLastCalledWith({ endpoint, expectedWorkspaceId: workspace, code: codeB });
      }
    } finally { await settle(old); }
  }, 10_000);

  it.each(['success', 'reject'] as const)('W14 old pair %s finally cannot unlock or clear B pending Pair', async outcome => {
    const a = api(); const b = api(); const old = deferred(receipt); const fresh = deferred(receipt);
    a.pair.mockReturnValueOnce(old.promise); b.pair.mockReturnValueOnce(fresh.promise); const view = await ready(a);
    try {
      fill(); pair(); await waitFor(() => expect(a.pair).toHaveBeenCalledTimes(1));
      view.rerender(<WorkerSetupSection api={b} />); await observed(); fill(codeB); pair();
      await waitFor(() => expect(b.pair).toHaveBeenCalledTimes(1));
      const currentCode = field('Pairing code').value;
      if (outcome === 'success') await settle(old); else await reject(old);
      expect(field('Pairing code').value).toBe(currentCode);
      expect(button('Pair worker').disabled).toBe(true); expect(button('Refresh worker status').disabled).toBe(true);
      pair(); refresh(); expect(b.pair).toHaveBeenCalledTimes(1); expect(b.status).toHaveBeenCalledTimes(1); expect(a.status).toHaveBeenCalledTimes(1);
      await settle(fresh); await screen.findByText('Worker paired', { exact: true });
      expect(field('Pairing code').value).toBe(''); expect(b.pair.mock.calls).toEqual([[{ endpoint, expectedWorkspaceId: workspace, code: codeB }]]);
    } finally { await settle(old); await settle(fresh); }
  }, 10_000);

  it('W15 A to B to A status reuse ignores first A even with equal timestamps', async () => {
    const a = api(); const b = api(); const old = deferred(status('active', 5, '-old'));
    a.status.mockReturnValueOnce(old.promise).mockResolvedValueOnce(status('paused', 31, '-new'));
    const view = render(<WorkerSetupSection api={a} />);
    try {
      await waitFor(() => expect(a.status).toHaveBeenCalledTimes(1));
      view.rerender(<WorkerSetupSection api={b} />); await observed();
      view.rerender(<WorkerSetupSection api={a} />); await observed('Paused');
      await settle(old); const region = await observed('Paused');
      expect(region.textContent).toContain(`${workspace}-new`); expect(region.textContent).not.toContain(`${workspace}-old`);
      expect(a.status).toHaveBeenCalledTimes(2); expect(b.status).toHaveBeenCalledTimes(1);
    } finally { await settle(old); }
  }, 10_000);

  it.each(['status', 'pair'] as const)('W16 unmount pending %s has no late work and remount starts empty with fresh read', async action => {
    const a = api(); const oldRead = deferred(status('active', 5, '-old')); const oldPair = deferred(receipt);
    if (action === 'status') a.status.mockReturnValueOnce(oldRead.promise); else a.pair.mockReturnValueOnce(oldPair.promise);
    const view = render(<WorkerSetupSection api={a} />);
    try {
      await waitFor(() => expect(a.status).toHaveBeenCalledTimes(1));
      if (action === 'pair') { await observed(); fill(); pair(); await waitFor(() => expect(a.pair).toHaveBeenCalledTimes(1)); }
      view.unmount(); await settle(oldRead); await settle(oldPair);
      expect(a.status).toHaveBeenCalledTimes(1); expect(screen.queryByRole('region', { name: 'Worker connection' })).toBeNull();
      render(<WorkerSetupSection api={a} />); await observed();
      expect(field('Pairing code').value).toBe(''); expect(a.status).toHaveBeenCalledTimes(2);
      expect(screen.queryByText('Worker paired', { exact: true })).toBeNull();
    } finally { await settle(oldRead); await settle(oldPair); }
  }, 10_000);
});


describe('Task9 additional lifetime positive controls', () => {
  it.each(['replace', 'remove'] as const)('W17 unsubmitted code clears on API %s before any pair', async mode => {
    const a = api(); const b = api(); const view = await ready(a); fill();
    view.rerender(<WorkerSetupSection api={mode === 'replace' ? b : undefined} />);
    await observed(mode === 'replace' ? 'Unconfigured' : 'Unavailable');
    expect(field('Pairing code').value).toBe(''); expect(a.pair).not.toHaveBeenCalled(); expect(b.pair).not.toHaveBeenCalled();
    if (mode === 'replace') {
      await waitFor(() => expect(b.status).toHaveBeenCalledTimes(1)); fill(codeB); pair();
      await screen.findByText('Worker paired', { exact: true }); expect(b.pair).toHaveBeenCalledTimes(1);
    }
  }, 10_000);

  it.each(['resolve', 'reject'] as const)('W18 current B successful receipt survives obsolete A pair %s', async outcome => {
    const a = api(); const b = api(); const old = deferred(receipt); a.pair.mockReturnValueOnce(old.promise);
    const view = await ready(a);
    try {
      fill(); pair(); await waitFor(() => expect(a.pair).toHaveBeenCalledTimes(1));
      view.rerender(<WorkerSetupSection api={b} />); await observed();
      await waitFor(() => expect(b.status).toHaveBeenCalledTimes(1)); fill(codeB); pair();
      await screen.findByText('Worker paired', { exact: true });
      await waitFor(() => expect(b.status).toHaveBeenCalledTimes(2));
      if (outcome === 'resolve') await settle(old); else await reject(old);
      expect(screen.getByText('Worker paired', { exact: true })).toBeTruthy(); expect(field('Pairing code').value).toBe('');
      expect(a.status).toHaveBeenCalledTimes(1); expect(b.status).toHaveBeenCalledTimes(2); expect(b.pair).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('alert')).toBeNull(); safeFeedback();
    } finally { await settle(old); }
  }, 10_000);

  it.each(['resolve', 'reject'] as const)('W19 removed API ignores pending Refresh %s and never falls back', async outcome => {
    const a = api(); const view = await ready(a); fill(); const old = deferred(status('active', 41, '-old'));
    a.status.mockReturnValueOnce(old.promise);
    try {
      refresh(); await waitFor(() => expect(a.status).toHaveBeenCalledTimes(2));
      view.rerender(<WorkerSetupSection />); await observed('Unavailable'); expect(field('Pairing code').value).toBe('');
      if (outcome === 'resolve') await settle(old); else await reject(old);
      await observed('Unavailable'); expect(screen.queryByText('Active', { exact: true })).toBeNull();
      expect(a.status).toHaveBeenCalledTimes(2); expect(a.pair).not.toHaveBeenCalled(); safeFeedback();
    } finally { await settle(old); }
  }, 10_000);

  it('W20 obsolete status cannot replace new B pair receipt or post-pair status', async () => {
    const a = api(); const b = api(); const old = deferred(status('active', 41, '-old')); a.status.mockReturnValueOnce(old.promise);
    const view = render(<WorkerSetupSection api={a} />);
    try {
      await waitFor(() => expect(a.status).toHaveBeenCalledTimes(1));
      view.rerender(<WorkerSetupSection api={b} />); await observed(); fill(codeB); pair();
      await screen.findByText('Worker paired', { exact: true }); await waitFor(() => expect(b.status).toHaveBeenCalledTimes(2));
      await settle(old); await observed(); expect(screen.getByText('Worker paired', { exact: true })).toBeTruthy();
      expect(screen.queryByText('Active', { exact: true })).toBeNull(); expect(document.body.textContent).not.toContain(`${workspace}-old`);
      expect(b.pair).toHaveBeenCalledTimes(1); expect(b.status).toHaveBeenCalledTimes(2); expect(a.status).toHaveBeenCalledTimes(1);
    } finally { await settle(old); }
  }, 10_000);
});


describe('a worker David can see', () => {
  type ResearchApi = Pick<ResearchSetupApi, 'status'>;
  const researchStatus = (lastTickAt: string | null, remote = true): ResearchSetupStatus => ({ pending: null, blockers: [], remote: remote ? { workspaceId: workspace, pairingId: '11111111-1111-4111-8111-111111111111', selector: null,
    discoveryLedger: null, researchLedger: null, descriptor: null, descriptorFingerprint: null, credentialParameterDeclared: true, blockers: [], checkedAt: '2026-09-18T12:00:00.000Z', receipt: null, lastTickAt } : null });
  const withResearch = (research: ResearchApi, initial: Status = status('active', 3)) => ({ ...api(initial), researchSetup: research });
  it('W30 shows when the worker last ran from the cloud research status and warns after twenty minutes of silence', async () => {
    const fresh = vi.fn(async () => researchStatus(new Date(Date.now() - 5 * 60_000).toISOString()));
    render(<WorkerSetupSection api={withResearch({ status: fresh })} />);
    const region = await observed('Active');
    await within(region).findByText(/Worker last ran/);
    expect(region.textContent).toMatch(/Worker last ran 5 minutes ago\./);
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(within(region).queryByRole('alert')).toBeNull();
    cleanup();
    const stale = vi.fn(async () => researchStatus(new Date(Date.now() - 25 * 60_000).toISOString()));
    render(<WorkerSetupSection api={withResearch({ status: stale })} />);
    const staleRegion = await observed('Active');
    const alert = await within(staleRegion).findByRole('alert');
    expect(alert.textContent).toMatch(/has not run for more than 20 minutes/);
    expect(staleRegion.textContent).toMatch(/Worker last ran 25 minutes ago\./);
  }, 10_000);
  it('W31 distinguishes a worker that never recorded a tick, an unreadable cloud status and a connection without cloud research', async () => {
    const never = vi.fn(async () => researchStatus(null));
    render(<WorkerSetupSection api={withResearch({ status: never })} />);
    let region = await observed('Active');
    await within(region).findByText(/Worker last run: not recorded yet/);
    expect(within(region).queryByRole('alert')).toBeNull();
    cleanup();
    const failing = vi.fn(async () => { throw Error(`private-error ${codeA}`); });
    render(<WorkerSetupSection api={withResearch({ status: failing })} />);
    region = await observed('Active');
    await within(region).findByText(/Worker last run: not available/);
    safeFeedback();
    cleanup();
    const missingRemote = vi.fn(async () => researchStatus(null, false));
    render(<WorkerSetupSection api={withResearch({ status: missingRemote })} />);
    region = await observed('Active');
    await within(region).findByText(/Worker last run: not available/);
    cleanup();
    const a = api(status('active', 3)); render(<WorkerSetupSection api={a} />);
    region = await observed('Active');
    expect(region.textContent).not.toMatch(/Worker last r/);
  }, 10_000);
});

it('W21 status state and nested configuration state are separate schema-valid facts', async () => {
  const value: Status = { ...status('paused', 47), configuration: {
    revision: 47, configuration: { version: 1, state: 'active', research: null }, updatedAt: '2026-09-10T23:00:00.000Z',
  } };
  const a = api(value); render(<WorkerSetupSection api={a} />);
  const region = await observed('Paused');
  expect(region.textContent).toMatch(/configuration[\s\S]*active/i);
  expect(region.textContent).toMatch(/revision[^0-9]*47/i);
  expect(a.status).toHaveBeenCalledTimes(1); expect(a.pair).not.toHaveBeenCalled();
}, 10_000);
