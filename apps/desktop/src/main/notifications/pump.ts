import type { NotificationRuntimeStatus } from '@fss/contracts';
import { createNotificationRunner, type NotificationRunnerDeps } from './runner.ts';

/** Runs only while the authenticated desktop is awake. No hour filter or quit-app delivery claim. */
export function createActionableNotificationPump(deps: NotificationRunnerDeps) {
  let status: NotificationRuntimeStatus = { state: 'stopped', lastCheckedAt: null };
  const runner = createNotificationRunner({ ...deps, onStatus(next) { status = next; deps.onStatus?.(next); } });
  let enabled = false, running = false, again = false, epoch = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  async function tick() {
    if (!enabled) return;
    if (running) { again = true; return; }
    running = true;
    const generation = epoch, current = () => enabled && epoch === generation;
    try { await runner.tick(current); }
    catch { if (current()) { status = { state: 'unavailable', lastCheckedAt: deps.now() }; deps.onStatus?.(status); } }
    finally { running = false; if (again && enabled) { again = false; void tick(); } }
  }
  return {
    start() { if (enabled) return; enabled = true; epoch++; timer = setInterval(() => void tick(), 30_000); void tick(); },
    wake() { void tick(); },
    stop(options: { clear?: boolean } = {}) { enabled = false; epoch++; again = false; if (timer !== null) clearInterval(timer); timer = null; runner.stop(options); },
    status(): NotificationRuntimeStatus { return structuredClone(status); },
  };
}
