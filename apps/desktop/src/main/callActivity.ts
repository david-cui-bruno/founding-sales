/**
 * Whether a call placed from Callie is live on this Mac (slice C1).
 *
 * The call itself runs in the page — WebRTC does — so the page says when one starts and
 * when it ends (`calling.setActive`). The main process keeps the flag for the one thing
 * that must not happen during a call: the updater swapping the app and relaunching it,
 * which would hang up on the prospect. When the call ends the listeners are told, and
 * the updater installs whatever it deferred.
 *
 * A page that dies mid-call never says "ended", so the flag also lapses on its own after
 * the longest call Callie reserves for (240 minutes) — an update is late, never lost.
 */

export const CALL_ACTIVITY_LAPSE_MS = 240 * 60 * 1000;

export interface CallActivity {
  active(): boolean;
  set(active: boolean): void;
  onEnded(listener: () => void): void;
}

export function createCallActivity(options: { readonly now?: () => number; readonly lapseMs?: number } = {}): CallActivity {
  const now = options.now ?? (() => Date.now());
  const lapse = options.lapseMs ?? CALL_ACTIVITY_LAPSE_MS;
  let since: number | null = null;
  const listeners: (() => void)[] = [];
  const active = (): boolean => since !== null && now() - since < lapse;
  return {
    active,
    set(next) {
      const was = since !== null;
      since = next ? now() : null;
      if (was && !next) for (const listener of listeners) listener();
    },
    onEnded(listener) {
      listeners.push(listener);
    },
  };
}

/** The one this process uses: the Today bridge sets it, the updater reads it (`main.ts`). */
export const processCallActivity: CallActivity = createCallActivity();
