import type { NotificationRuntimeStatus } from '@fss/contracts';
import { createNotificationRunner, type NotificationRunnerDeps } from './runner.ts';

/** Runs only while the authenticated desktop is awake. No hour filter or quit-app delivery claim. */
export function createActionableNotificationPump(deps: NotificationRunnerDeps) {
  let status: NotificationRuntimeStatus = { state: 'stopped', lastCheckedAt: null };
  const activations = new Set<string>();
  function enqueue(identifier: string) {
    if (!/^callie-action:[0-9a-f-]{36}:[0-9a-f-]{36}:[0-9a-f]{64}$/u.test(identifier) || activations.size >= 25) return;
    activations.add(identifier);
    void tick();
  }
  const runner = createNotificationRunner({ ...deps, onActivation: enqueue, onStatus(next) { status = next; deps.onStatus?.(next); } });
  let enabled = false, running = false, again = false, epoch = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  async function tick() {
    if (!enabled) return;
    if (running) { again = true; return; }
    running = true;
    const generation = epoch, current = () => enabled && epoch === generation;
    try {
      await runner.tick(current);
      for (const identifier of activations) {
        if (!current()) break;
        const result = await runner.activate(identifier, current);
        if (current() && result !== 'unavailable') activations.delete(identifier);
      }
    }
    catch { if (current()) { status = { state: 'unavailable', lastCheckedAt: deps.now() }; deps.onStatus?.(status); } }
    finally { running = false; if (again && enabled) { again = false; void tick(); } }
  }
  return {
    activate: enqueue,
    start() { if (enabled) return; enabled = true; epoch++; timer = setInterval(() => void tick(), 30_000); void tick(); },
    wake() { void tick(); },
    stop(options: { clear?: boolean } = {}) { enabled = false; epoch++; again = false; if (timer !== null) clearInterval(timer); timer = null; if (options.clear !== false) activations.clear(); runner.stop(options); },
    status(): NotificationRuntimeStatus { return structuredClone(status); },
  };
}
