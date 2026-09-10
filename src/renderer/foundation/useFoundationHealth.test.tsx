// @vitest-environment jsdom

import { act, cleanup, render, renderHook } from '@testing-library/react';
import { StrictMode, useLayoutEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppHealth } from '../../shared/healthContract';
import { useFoundationHealth } from './useFoundationHealth';

const readyHealth: AppHealth = {
  appVersion: '1.0.0',
  schemaVersion: 2,
  databasePath: '/fixture/health-refresh.sqlite3',
  databaseEncrypted: true,
  cipherVersion: 'SQLite3 Multiple Ciphers 2.3.5',
  fts5Available: true,
  pendingJobs: 2,
  interruptedJobsRecovered: 1,
  domainStatus: 'ready',
  domainReady: true,
  domainBlockingViolationCount: 0,
  domainRepairableIssueCount: 0,
  domainProjectionRefreshCandidateCount: 0,
  pendingProjectionRebuilds: 0,
  domainStartupEvaluatedAt: '2026-08-30T12:00:00.000Z',
  operationalStatus: 'ready',
  sourcing: {
    status: 'healthy', reasons: [], lastSuccessAgeMs: null,
    state: {
      state: 'idle', pollId: null, startedAt: null, lastCompletedAt: null,
      consecutiveFailures: 0, lastFailureAt: null, lastFailureCode: null,
      backlogCount: null,
    },
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function visibleDocument() {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  return {
    hide() {
      visibility.mockReturnValue('hidden');
      hidden.mockReturnValue(true);
      document.dispatchEvent(new Event('visibilitychange'));
    },
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useFoundationHealth readonly refresh', () => {
  it('keeps a pending refresh deadline running while hidden and admits a later explicit hidden read', async () => {
    vi.useFakeTimers();
    const visibility = visibleDocument();
    const pending = deferred<AppHealth>();
    const api = { get: vi.fn<() => Promise<AppHealth>>().mockResolvedValueOnce(readyHealth).mockReturnValueOnce(pending.promise).mockResolvedValue(readyHealth) };
    const view = renderHook(() => useFoundationHealth(api));
    await act(async () => undefined);
    const checkedAt = view.result.current.observation?.checkedAt;
    act(() => view.result.current.retry());
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    act(() => visibility.hide());
    await act(async () => vi.advanceTimersByTimeAsync(13_999));
    expect(view.result.current).toMatchObject({ status: 'ready', observation: { checkedAt, refreshing: true, refreshFailed: false } });
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(view.result.current).toMatchObject({ status: 'ready', observation: { checkedAt, refreshing: false, refreshFailed: true } });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(api.get).toHaveBeenCalledTimes(2);
    await act(async () => view.result.current.retry());
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(view.result.current.observation?.refreshFailed).toBe(false);
    expect(view.result.current.observation?.checkedAt).not.toBe(checkedAt);
    await act(async () => pending.resolve({ ...readyHealth, pendingJobs: 99 }));
    expect(view.result.current).toMatchObject({ status: 'ready', health: readyHealth });
  });

  it.each(['success', 'rejection'] as const)('ignores expired %s while a newer read is still pending without clearing its deadline', async outcome => {
    vi.useFakeTimers();
    const visibility = visibleDocument();
    const expired = deferred<AppHealth>();
    const newer = deferred<AppHealth>();
    const api = { get: vi.fn<() => Promise<AppHealth>>().mockResolvedValueOnce(readyHealth).mockReturnValueOnce(expired.promise).mockReturnValueOnce(newer.promise).mockResolvedValue({ ...readyHealth, pendingJobs: 7 }) };
    const view = renderHook(() => useFoundationHealth(api));
    await act(async () => undefined);
    const checkedAt = view.result.current.observation?.checkedAt;
    act(() => visibility.hide());
    act(() => view.result.current.retry());
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    act(() => view.result.current.retry());
    await act(async () => {
      if (outcome === 'success') expired.resolve({ ...readyHealth, pendingJobs: 99 });
      else expired.reject(new Error('expired private error'));
    });
    expect(view.result.current).toMatchObject({ status: 'ready', health: readyHealth, observation: { checkedAt, refreshing: true, refreshFailed: true } });
    expect(vi.getTimerCount()).toBe(1);
    act(() => view.result.current.retry());
    expect(api.get).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(14_999));
    expect(view.result.current.observation?.refreshing).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(view.result.current).toMatchObject({ status: 'ready', health: readyHealth, observation: { checkedAt, refreshing: false, refreshFailed: true } });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => newer.resolve({ ...readyHealth, pendingJobs: 88 }));
    expect(view.result.current).toMatchObject({ status: 'ready', health: readyHealth, observation: { checkedAt } });
    await act(async () => view.result.current.retry());
    expect(view.result.current).toMatchObject({ status: 'ready', health: { pendingJobs: 7 }, observation: { refreshFailed: false } });
  });

  it('keeps exactly one live same-API timer and listener generation after StrictMode replay', async () => {
    vi.useFakeTimers(); visibleDocument();
    const addWindow = vi.spyOn(window, 'addEventListener');
    const removeWindow = vi.spyOn(window, 'removeEventListener');
    const addDocument = vi.spyOn(document, 'addEventListener');
    const removeDocument = vi.spyOn(document, 'removeEventListener');
    const old = deferred<AppHealth>(), current = deferred<AppHealth>(), focused = deferred<AppHealth>(), timed = deferred<AppHealth>();
    const api = { get: vi.fn<() => Promise<AppHealth>>().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise).mockReturnValueOnce(focused.promise).mockReturnValue(timed.promise) };
    const view = renderHook(() => useFoundationHealth(api), { wrapper: StrictMode });
    const windowAdds = addWindow.mock.calls.filter(([name]) => name === 'focus').map(([, handler]) => handler);
    const documentAdds = addDocument.mock.calls.filter(([name]) => name === 'visibilitychange').map(([, handler]) => handler);
    expect(windowAdds).toHaveLength(2); expect(documentAdds).toHaveLength(2);
    expect(removeWindow.mock.calls.filter(([name]) => name === 'focus').map(([, handler]) => handler)).toEqual([windowAdds[0]]);
    expect(removeDocument.mock.calls.filter(([name]) => name === 'visibilitychange').map(([, handler]) => handler)).toEqual([documentAdds[0]]);
    expect(api.get).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(2);
    await act(async () => old.resolve({ ...readyHealth, pendingJobs: 99 }));
    expect(view.result.current.status).toBe('loading');
    act(() => { window.dispatchEvent(new Event('focus')); view.result.current.retry(); });
    expect(api.get).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve(readyHealth));
    expect(vi.getTimerCount()).toBe(1);
    act(() => { window.dispatchEvent(new Event('focus')); view.result.current.retry(); });
    expect(api.get).toHaveBeenCalledTimes(3);
    await act(async () => focused.resolve(readyHealth));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(api.get).toHaveBeenCalledTimes(4); expect(vi.getTimerCount()).toBe(2);
    act(() => { window.dispatchEvent(new Event('focus')); view.result.current.retry(); });
    expect(api.get).toHaveBeenCalledTimes(4);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(removeWindow.mock.calls.filter(([name]) => name === 'focus').map(([, handler]) => handler)).toEqual(windowAdds);
    expect(removeDocument.mock.calls.filter(([name]) => name === 'visibilitychange').map(([, handler]) => handler)).toEqual(documentAdds);
    act(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => timed.resolve(readyHealth));
    expect(api.get).toHaveBeenCalledTimes(4);
  });

  it('does not revive an old retry callback when the same API returns after replacement', async () => {
    const a = { get: vi.fn(async () => readyHealth) };
    const b = { get: vi.fn(async () => readyHealth) };
    const view = renderHook(({ api }) => useFoundationHealth(api), { initialProps: { api: a } });
    await act(async () => undefined);
    const departedRetry = view.result.current.retry;
    view.rerender({ api: b });
    await act(async () => undefined);
    view.rerender({ api: a });
    await act(async () => undefined);
    expect(a.get).toHaveBeenCalledTimes(2);
    act(() => departedRetry());
    expect(a.get).toHaveBeenCalledTimes(2);
  });

  it('timestamps only validated observations and keeps the successful time stale after refresh failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-09-10T16:00:00.000Z');
    const api = { get: vi.fn<() => Promise<AppHealth>>().mockResolvedValue(readyHealth) };
    const { result } = renderHook(() => useFoundationHealth(api));
    await act(async () => undefined);
    expect(result.current).toMatchObject({ observation: { checkedAt: '2026-09-10T16:00:00.000Z', refreshing: false, refreshFailed: false } });
    vi.setSystemTime('2026-09-10T16:01:00.000Z');
    api.get.mockRejectedValueOnce(new Error('private failure'));
    await act(async () => result.current.retry());
    expect(result.current).toMatchObject({ status: 'ready', health: readyHealth, observation: { checkedAt: '2026-09-10T16:00:00.000Z', refreshing: false, refreshFailed: true } });
    await act(async () => result.current.retry());
    expect(result.current).toMatchObject({ health: { domainStartupEvaluatedAt: '2026-08-30T12:00:00.000Z' }, observation: { checkedAt: '2026-09-10T16:01:00.000Z', refreshFailed: false } });
  });

  it.each([null, { ...readyHealth, privatePath: '/secret' }, { ...readyHealth, domainStatus: 'invalid' }])('rejects an invalid initial wire response without manufacturing readiness: %j', async (invalid) => {
    const api = { get: vi.fn(async () => invalid as AppHealth) };
    const { result } = renderHook(() => useFoundationHealth(api));
    await act(async () => undefined);
    expect(result.current).toMatchObject({ status: 'failed', observation: { checkedAt: null, refreshing: false, refreshFailed: true } });
    expect(JSON.stringify(result.current)).not.toContain('/secret');
  });

  it('retains accepted health when refresh validation fails or invocation throws synchronously', async () => {
    const api = { get: vi.fn<() => Promise<AppHealth>>().mockResolvedValue(readyHealth) };
    const { result } = renderHook(() => useFoundationHealth(api));
    await act(async () => undefined);
    api.get.mockResolvedValueOnce({ ...readyHealth, databaseEncrypted: false } as unknown as AppHealth);
    await act(async () => result.current.retry());
    expect(result.current).toMatchObject({ status: 'ready', health: readyHealth, observation: { refreshFailed: true } });
    api.get.mockImplementationOnce(() => { throw new Error('private synchronous failure'); });
    await act(async () => result.current.retry());
    expect(result.current).toMatchObject({ status: 'ready', health: readyHealth, observation: { refreshing: false, refreshFailed: true } });
  });

  it('allows explicit hidden reads but deduplicates visibility and focus, and cleans every timer on teardown', async () => {
    vi.useFakeTimers();
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => visible.getMockImplementation()?.() !== 'visible');
    const refresh = deferred<AppHealth>();
    const api = { get: vi.fn<() => Promise<AppHealth>>().mockResolvedValueOnce(readyHealth).mockReturnValue(refresh.promise) };
    const view = renderHook(() => useFoundationHealth(api));
    await act(async () => undefined);
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    act(() => window.dispatchEvent(new Event('focus')));
    expect(api.get).toHaveBeenCalledTimes(1);
    act(() => view.result.current.retry());
    expect(api.get).toHaveBeenCalledTimes(2);
    act(() => {
      visible.mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    expect(api.get).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => refresh.resolve(readyHealth));
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('ignores a replaced API and a StrictMode disposed flight after newer health succeeds', async () => {
    const old = deferred<AppHealth>();
    const next = { ...readyHealth, pendingJobs: 8 };
    const a = { get: vi.fn(() => old.promise) };
    const b = { get: vi.fn(async () => next) };
    const view = renderHook(({ api }) => useFoundationHealth(api), { initialProps: { api: a }, wrapper: StrictMode });
    const oldRetry = view.result.current.retry;
    view.rerender({ api: b });
    await act(async () => undefined);
    expect(view.result.current).toMatchObject({ status: 'ready', health: next });
    const calls = a.get.mock.calls.length;
    act(() => oldRetry());
    await act(async () => old.resolve(readyHealth));
    expect(a.get).toHaveBeenCalledTimes(calls);
    expect(view.result.current).toMatchObject({ status: 'ready', health: next });
  });

  it('keeps accepted health ready while a manual refresh is unresolved', async () => {
    const refresh = deferred<AppHealth>();
    const api = { get: vi.fn<() => Promise<AppHealth>>()
      .mockResolvedValueOnce(readyHealth).mockReturnValue(refresh.promise) };
    const { result } = renderHook(() => useFoundationHealth(api));
    await act(async () => undefined);
    expect(result.current.status).toBe('ready');

    act(() => result.current.retry());

    expect(api.get).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({ status: 'ready', health: readyHealth });
  });

  it('retains the last accepted health after a manual refresh rejects', async () => {
    const refresh = deferred<AppHealth>();
    const api = { get: vi.fn<() => Promise<AppHealth>>()
      .mockResolvedValueOnce(readyHealth).mockReturnValue(refresh.promise) };
    const { result } = renderHook(() => useFoundationHealth(api));
    await act(async () => undefined);
    expect(result.current.status).toBe('ready');
    act(() => result.current.retry());

    await act(async () => refresh.reject(new Error('private refresh failure')));

    expect(result.current).toMatchObject({ status: 'ready', health: readyHealth });
  });

  it('deduplicates repeated manual refreshes while one logical read is pending', async () => {
    const refresh = deferred<AppHealth>();
    const api = { get: vi.fn<() => Promise<AppHealth>>()
      .mockResolvedValueOnce(readyHealth).mockReturnValue(refresh.promise) };
    const { result } = renderHook(() => useFoundationHealth(api));
    await act(async () => undefined);
    expect(result.current.status).toBe('ready');

    act(() => {
      result.current.retry();
      result.current.retry();
    });

    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('reads at sixty visible seconds but not during hidden interval ticks', async () => {
    vi.useFakeTimers();
    const visibility = visibleDocument();
    const api = { get: vi.fn(async () => readyHealth) };
    renderHook(() => useFoundationHealth(api));
    await act(async () => undefined);
    expect(api.get).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(59_999));
    expect(api.get).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(api.get).toHaveBeenCalledTimes(2);

    act(() => visibility.hide());
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('refreshes on visible focus and coalesces a simultaneous manual trigger', async () => {
    visibleDocument();
    const refresh = deferred<AppHealth>();
    const api = { get: vi.fn<() => Promise<AppHealth>>()
      .mockResolvedValueOnce(readyHealth).mockReturnValue(refresh.promise) };
    const { result } = renderHook(() => useFoundationHealth(api));
    await act(async () => undefined);
    expect(result.current.status).toBe('ready');

    act(() => window.dispatchEvent(new Event('focus')));
    expect(api.get).toHaveBeenCalledTimes(2);
    act(() => result.current.retry());
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('ends a hung initial logical read at fifteen seconds and ignores its late result', async () => {
    vi.useFakeTimers();
    const initial = deferred<AppHealth>();
    const newer = { ...readyHealth, pendingJobs: 7 };
    const api = { get: vi.fn<() => Promise<AppHealth>>()
      .mockReturnValueOnce(initial.promise).mockResolvedValue(newer) };
    const { result } = renderHook(() => useFoundationHealth(api));
    await act(async () => vi.advanceTimersByTimeAsync(14_999));
    expect(result.current.status).toBe('loading');

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(result.current.status).toBe('failed');
    await act(async () => result.current.retry());
    expect(result.current).toMatchObject({ status: 'ready', health: newer });
    await act(async () => initial.resolve(readyHealth));
    expect(result.current).toMatchObject({ status: 'ready', health: newer });
  });

  it('does not expose old ready health in the first layout for a replacement API', async () => {
    const replacement = deferred<AppHealth>();
    const oldApi = { get: vi.fn(async () => readyHealth) };
    const newApi = { get: vi.fn(() => replacement.promise) };
    const layouts: string[] = [];
    function Probe({ api }: { api: { get(): Promise<AppHealth> } }) {
      const health = useFoundationHealth(api);
      useLayoutEffect(() => { layouts.push(health.status); });
      return <output>{health.status}</output>;
    }
    const view = render(<Probe api={oldApi} />);
    await act(async () => undefined);
    expect(layouts.at(-1)).toBe('ready');
    layouts.length = 0;

    view.rerender(<Probe api={newApi} />);

    expect(layouts[0]).toBe('loading');
  });
});
