import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BACKGROUND_SYNC_INTERVAL_MS, createBackgroundSync } from '../../src/main/delegation/backgroundSync';
import type { SyncReport } from '../../src/main/delegation/delegationSync';

const fresh = (applied = 0): SyncReport => ({ applied, gaps: 0, cursor: null, ownerFresh: true, failure: null });
const stopped = (failure: SyncReport['failure'], cursor: string | null = null): SyncReport => ({ applied: 0, gaps: 0, cursor, ownerFresh: false, failure });
const deferred = () => {
  let resolve!: (value: SyncReport) => void; let reject!: (error: Error) => void;
  const promise = new Promise<SyncReport>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let tick = 0;
const clock = { now: () => new Date(Date.UTC(2026, 8, 18, 9, 0, tick++)).toISOString() };

describe('createBackgroundSync', () => {
  beforeEach(() => { tick = 0; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('syncs on launch and then every five minutes through the same runtime.sync the buttons call', async () => {
    const sync = vi.fn(async () => fresh(0));
    const owner = createBackgroundSync({ enabled: true, sync, clock });
    expect(sync).not.toHaveBeenCalled();
    owner.start(); owner.start();
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(owner.status()).toMatchObject({ enabled: true, running: false, runs: 1, lastReason: 'launch', lastSyncResult: 'no_change', lastApplied: 0 });
    await vi.advanceTimersByTimeAsync(BACKGROUND_SYNC_INTERVAL_MS - 1);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(owner.status()).toMatchObject({ runs: 2, lastReason: 'interval' });
    await vi.advanceTimersByTimeAsync(BACKGROUND_SYNC_INTERVAL_MS);
    expect(sync).toHaveBeenCalledTimes(3);
    expect(BACKGROUND_SYNC_INTERVAL_MS).toBe(300_000);
    owner.dispose();
  });

  it('never overlaps two syncs: a focus during a run joins the run instead of starting another', async () => {
    const first = deferred();
    const sync = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(fresh(2));
    const owner = createBackgroundSync({ enabled: true, sync, clock });
    const launch = owner.trigger('launch');
    const focus = owner.trigger('focus');
    expect(sync).toHaveBeenCalledTimes(1);
    expect(owner.status()).toMatchObject({ running: true, runs: 1, lastReason: 'launch' });
    // The interval firing mid-run is also absorbed.
    owner.start();
    await vi.advanceTimersByTimeAsync(BACKGROUND_SYNC_INTERVAL_MS);
    expect(sync).toHaveBeenCalledTimes(1);
    first.resolve(fresh(1));
    expect(await focus).toBe(await launch);
    expect(owner.status()).toMatchObject({ running: false, runs: 1, lastSyncResult: 'applied', lastApplied: 1 });
    await owner.trigger('focus');
    expect(sync).toHaveBeenCalledTimes(2);
    expect(owner.status()).toMatchObject({ runs: 2, lastReason: 'focus', lastSyncResult: 'applied', lastApplied: 2 });
    owner.dispose();
  });

  it('records a failed transport as failed and keeps the previous applied count out of it', async () => {
    const onApplied = vi.fn();
    const sync = vi.fn().mockResolvedValueOnce(fresh(3)).mockRejectedValueOnce(new Error('/Users/founder/private transport failure'))
      .mockResolvedValueOnce({ ...stopped('gap'), gaps: 1 }).mockResolvedValueOnce({ ...stopped('timeout', 'c'), applied: 4 });
    const owner = createBackgroundSync({ enabled: true, sync, clock, onApplied });
    await owner.trigger('launch');
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onApplied.mock.calls[0]![0]).toMatchObject({ lastSyncResult: 'applied', lastApplied: 3, lastFailure: null });
    const failed = await owner.trigger('interval');
    // A rejected run has no report to read a reason from, so it says only that the transport failed.
    expect(failed).toMatchObject({ running: false, lastSyncResult: 'failed', lastApplied: 0, runs: 2, lastFailure: 'transport' });
    expect(failed.lastSyncAt).not.toBeNull();
    // An incomplete replay (gap, or owner not fresh) is not a current owner proof: failed, even when events applied.
    expect(await owner.trigger('focus')).toMatchObject({ lastSyncResult: 'failed', lastFailure: 'gap' });
    expect(await owner.trigger('focus')).toMatchObject({ lastSyncResult: 'failed', lastApplied: 4, lastFailure: 'timeout' });
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(owner.status())).not.toContain('private');
    owner.dispose();
  });

  it('stops on dispose: the interval is cleared, later triggers are no-ops and an in-flight result is dropped', async () => {
    const inFlight = deferred();
    const onApplied = vi.fn();
    const sync = vi.fn().mockReturnValueOnce(inFlight.promise).mockResolvedValue(fresh(9));
    const owner = createBackgroundSync({ enabled: true, sync, clock, onApplied });
    owner.start();
    expect(owner.status().running).toBe(true);
    owner.dispose(); owner.dispose();
    expect(owner.status().running).toBe(false);
    inFlight.resolve(fresh(5));
    await vi.advanceTimersByTimeAsync(BACKGROUND_SYNC_INTERVAL_MS * 3);
    await owner.trigger('focus');
    expect(sync).toHaveBeenCalledTimes(1);
    expect(owner.status()).toMatchObject({ running: false, lastSyncResult: null, lastApplied: 0 });
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('stays idle when disabled (no pairing): no timer, no sync, an honest status', async () => {
    const sync = vi.fn(async () => fresh(1));
    const owner = createBackgroundSync({ enabled: false, sync, clock });
    owner.start();
    expect(await owner.trigger('focus')).toMatchObject({ enabled: false, running: false, runs: 0, lastSyncResult: null });
    await vi.advanceTimersByTimeAsync(BACKGROUND_SYNC_INTERVAL_MS * 2);
    expect(sync).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    owner.dispose();
  });

  it('rejects a non-positive interval and accepts injected timers', async () => {
    expect(() => createBackgroundSync({ enabled: true, sync: async () => fresh(), clock, intervalMs: 0 })).toThrow('interval');
    const timers = { setInterval: vi.fn(() => ({ unref: vi.fn() })), clearInterval: vi.fn() };
    const owner = createBackgroundSync({ enabled: true, sync: async () => fresh(), clock, intervalMs: 1000, timers: timers as unknown as Pick<typeof globalThis, 'setInterval' | 'clearInterval'> });
    owner.start();
    expect(timers.setInterval).toHaveBeenCalledWith(expect.any(Function), 1000);
    owner.dispose();
    expect(timers.clearInterval).toHaveBeenCalledTimes(1);
  });
});
