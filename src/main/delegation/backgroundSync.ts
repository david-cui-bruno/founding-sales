import type { SyncReport } from './delegationSync';

/** Why a background sync ran. `manual` is reserved for a caller that already owns a button. */
export type BackgroundSyncReason = 'launch' | 'focus' | 'interval' | 'manual';
export type BackgroundSyncOutcome = 'applied' | 'no_change' | 'failed';

/** What the footer may show. Every field is a local observation, never proof of worker freshness. */
export type BackgroundSyncStatus = Readonly<{
  enabled: boolean;
  running: boolean;
  runs: number;
  lastReason: BackgroundSyncReason | null;
  lastStartedAt: string | null;
  lastSyncAt: string | null;
  lastSyncResult: BackgroundSyncOutcome | null;
  lastApplied: number;
}>;

export type BackgroundSync = Readonly<{
  /** Arms the interval and runs the launch sync. Idempotent. */
  start(): void;
  /** Runs one sync now unless one is in flight, in which case the in-flight run is returned. Never rejects. */
  trigger(reason: BackgroundSyncReason): Promise<BackgroundSyncStatus>;
  status(): BackgroundSyncStatus;
  /** Stops the interval, drops future triggers and lets an in-flight run finish silently. */
  dispose(): void;
}>;

export const BACKGROUND_SYNC_INTERVAL_MS = 5 * 60_000;

type Timers = Pick<typeof globalThis, 'setInterval' | 'clearInterval'>;

/**
 * D3 (17 Sep 2026): the one owner of automatic worker synchronization in the
 * main process. It calls the same `sync()` the buttons call, so the 15-second
 * timeout and the cursor guards are unchanged; it only decides *when*. Two
 * syncs never overlap, a disposed owner never publishes a late result, and a
 * failed run is recorded as failed rather than hidden. Nothing here grants,
 * calls, sends or books; it reads worker events that already happened.
 */
export function createBackgroundSync(input: {
  enabled: boolean;
  sync(): Promise<SyncReport>;
  clock: { now(): string };
  intervalMs?: number;
  timers?: Timers;
  /** Called after a run that applied at least one event, so the renderer can re-read Today. */
  onApplied?(status: BackgroundSyncStatus): void;
}): BackgroundSync {
  const intervalMs = input.intervalMs ?? BACKGROUND_SYNC_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new Error('Background sync interval must be a positive integer of milliseconds.');
  const timers: Timers = input.timers ?? globalThis;
  let state: BackgroundSyncStatus = Object.freeze({
    enabled: input.enabled, running: false, runs: 0, lastReason: null,
    lastStartedAt: null, lastSyncAt: null, lastSyncResult: null, lastApplied: 0,
  });
  let disposed = false;
  let started = false;
  let handle: ReturnType<Timers['setInterval']> | undefined;
  let inFlight: Promise<BackgroundSyncStatus> | null = null;
  const publish = (next: Partial<BackgroundSyncStatus>) => { state = Object.freeze({ ...state, ...next }); return state; };

  async function run(reason: BackgroundSyncReason): Promise<BackgroundSyncStatus> {
    const startedAt = input.clock.now();
    publish({ running: true, lastReason: reason, lastStartedAt: startedAt, runs: state.runs + 1 });
    let outcome: BackgroundSyncOutcome = 'failed';
    let applied = 0;
    try {
      const report = await input.sync();
      applied = report.applied;
      // An incomplete replay is not a current owner proof; say so.
      outcome = !report.ownerFresh || report.gaps > 0 ? 'failed' : report.applied > 0 ? 'applied' : 'no_change';
    } catch {
      outcome = 'failed';
    }
    if (disposed) return state;
    const finished = publish({ running: false, lastSyncAt: input.clock.now(), lastSyncResult: outcome, lastApplied: applied });
    if (outcome === 'applied') {
      try { input.onApplied?.(finished); } catch { /* A renderer notification failure never changes the sync record. */ }
    }
    return finished;
  }

  const trigger: BackgroundSync['trigger'] = reason => {
    if (disposed || !state.enabled) return Promise.resolve(state);
    if (inFlight) return inFlight;
    const running = run(reason).finally(() => { if (inFlight === running) inFlight = null; });
    inFlight = running;
    return running;
  };

  return Object.freeze({
    start() {
      if (started || disposed || !state.enabled) return;
      started = true;
      handle = timers.setInterval(() => { void trigger('interval'); }, intervalMs);
      (handle as { unref?(): unknown }).unref?.();
      void trigger('launch');
    },
    trigger,
    status: () => state,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (handle !== undefined) timers.clearInterval(handle);
      handle = undefined;
      // The in-flight run may still be awaiting the runtime; its result is dropped above.
      publish({ running: false });
    },
  });
}
