import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { notificationItemSchema, type ActionableNotificationsResponse, type NotificationRuntimeStatus, type NotificationItem, type TodayActionTarget } from '@fss/contracts';
import { createNotificationRunner, type NotificationApiPort } from '../src/main/notifications/runner.ts';
import type { NativeNotificationHandle, NativeNotificationPort } from '../src/main/notifications/native.ts';
import { createActionableNotificationPump } from '../src/main/notifications/pump.ts';
afterEach(() => { vi.useRealTimers(); });

class ControlledNotification implements NativeNotificationHandle {
  shown = 0;
  closed = 0;
  listeners = new Map<string, (() => void)[]>();
  readonly id: string;
  constructor(id: string) { this.id = id; }
  on(event: 'show' | 'click' | 'failed', listener: () => void) { this.listeners.set(event, [...this.listeners.get(event) ?? [], listener]); }
  show() { this.shown++; }
  close() { this.closed++; }
  async emit(event: string) { for (const listener of this.listeners.get(event) ?? []) await listener(); }
}

function harness() {
  const workspaceId = randomUUID(), userId = randomUUID(), deviceId = randomUUID(), messageId = randomUUID();
  let item = notificationItemSchema.parse({ actionId: `reply-message:${messageId}`, kind: 'reply', reason: 'substantive_reply', subject: 'Northwind', dueAt: '2026-09-11T14:00:00.000Z', state: 'overdue', target: { kind: 'reply', firmId: randomUUID(), messageId }, phase: 'reply_overdue', eventKey: `reply-message:${messageId}:reply_overdue`, receipt: null });
  let online = true;
  let currentTarget: TodayActionTarget | null = item.target;
  let receiptCurrent = true;
  const natives: ControlledNotification[] = [], history: ControlledNotification[] = [], statuses: NotificationRuntimeStatus[] = [], targets: TodayActionTarget[] = [];
  const read = async (): Promise<ActionableNotificationsResponse> => ({ version: 1, workspaceId, userId, asOf: '2026-09-14T03:00:00.000Z', items: [item], recoveries: item.receipt === null ? [] : [{ eventKey: item.eventKey, actionId: item.actionId, target: item.target, receipt: item.receipt, current: receiptCurrent }] });
  const api: NotificationApiPort = {
    async read() { return online ? { ok: true, value: await read() } : { ok: false, reason: 'offline', offline: true }; },
    async claim() { if (item.receipt !== null) return { ok: true, value: null }; item = { ...item, receipt: { attemptId: randomUUID(), deviceId, status: 'attempting', attemptedAt: '2026-09-14T03:00:00.000Z', nativeShownAt: null, acknowledgedAt: null, failedAt: null, unknownAt: null } }; return { ok: true, value: structuredClone(item) }; },
    async observe(_id, observation) { if (!online || item.receipt === null) return false; item.receipt.status = observation; if (observation === 'native_shown') item.receipt.nativeShownAt = '2026-09-14T03:00:00.000Z'; return true; },
    async acknowledge() { if (!online) return { ok: false, reason: 'offline', offline: true }; if (item.receipt !== null) { item.receipt.status = 'acknowledged'; item.receipt.acknowledgedAt = '2026-09-14T03:00:00.000Z'; } return { ok: true, value: currentTarget }; },
  };
  const native: NativeNotificationPort = { supported: () => true, history: async () => history,
    create(options) { const handle = new ControlledNotification(options.id); natives.push(handle); return handle; } };
  const deps = { api, native, identity: () => ({ workspaceId, userId }), now: () => '2026-09-14T03:00:00.000Z', onStatus: (status: NotificationRuntimeStatus) => statuses.push(status), openTarget: (target: TodayActionTarget) => targets.push(target) };
  return { deps, read, natives, history, statuses, targets, resetReceipt() { item = { ...item, receipt: null }; }, setOnline(value: boolean) { online = value; }, setCurrent(value: boolean) { receiptCurrent = value; currentTarget = value ? item.target : null; }, get item(): NotificationItem { return item; } };
}

it('shows actionable work at night but records native show only after the native event, then opens the exact acknowledged context', async () => {
  const h = harness(), runner = createNotificationRunner(h.deps);
  await runner.tick(() => true);
  expect(h.natives).toHaveLength(1);
  expect(h.natives[0]?.shown).toBe(1);
  expect((await h.read()).items[0]?.receipt).toMatchObject({ status: 'attempting', nativeShownAt: null, acknowledgedAt: null });
  await h.natives[0]!.emit('show');
  expect((await h.read()).items[0]?.receipt).toMatchObject({ status: 'native_shown', acknowledgedAt: null });
  await h.natives[0]!.emit('click');
  expect(h.targets).toEqual([h.item.target]);
  expect((await h.read()).items[0]?.receipt?.status).toBe('acknowledged');
  await runner.tick(() => true);
  expect(h.natives).toHaveLength(1);
});

it('recovers an observed native history item without showing it again and revalidates its clicked context', async () => {
  const h = harness();
  await createNotificationRunner(h.deps).tick(() => true);
  const restored = h.natives[0]!;
  h.history.push(restored);
  const restarted = createNotificationRunner(h.deps);
  await restarted.tick(() => true);
  expect((await h.read()).items[0]?.receipt?.status).toBe('native_shown');
  expect(h.natives).toHaveLength(1);
  expect(restored.shown).toBe(1);
  h.setCurrent(false);
  await restored.emit('click');
  expect(h.targets).toEqual([]);
  await restarted.tick(() => true);
  expect(restored.closed).toBeGreaterThan(0);
  expect(restored.shown).toBe(1);
});

it('leaves a restart attempt without native evidence unknown, and offline recovery never replays the alert', async () => {
  const h = harness();
  await createNotificationRunner(h.deps).tick(() => true);
  const restarted = createNotificationRunner(h.deps);
  await restarted.tick(() => true);
  expect((await h.read()).items[0]?.receipt?.status).toBe('unknown');
  h.setOnline(false);
  await restarted.tick(() => true);
  expect(h.statuses.at(-1)?.state).toBe('offline');
  h.setOnline(true);
  await restarted.tick(() => true);
  expect(h.natives).toHaveLength(1);
  expect(h.natives[0]?.shown).toBe(1);
  expect((await h.read()).items[0]?.receipt?.status).toBe('unknown');
});

it('recognizes a stable event in native history after a database restore loses the attempt marker', async () => {
  const h = harness();
  await createNotificationRunner(h.deps).tick(() => true);
  h.history.push(h.natives[0]!);
  h.resetReceipt();
  await createNotificationRunner(h.deps).tick(() => true);
  expect(h.natives).toHaveLength(1);
  expect(h.natives[0]?.shown).toBe(1);
  expect((await h.read()).items[0]?.receipt?.status).toBe('native_shown');
});

it('preserves a created native handle through suspend and rebinds clicks on resume even when native history is unavailable', async () => {
  const h = harness();
  h.deps.native.history = async () => null;
  const runner = createNotificationRunner(h.deps);
  await runner.tick(() => true);
  const native = h.natives[0]!;
  await native.emit('show');
  runner.stop({ clear: false });
  expect(native.closed).toBe(0);
  await native.emit('click');
  expect(h.targets).toEqual([]);
  await runner.tick(() => true);
  await native.emit('click');
  expect(h.targets).toEqual([h.item.target]);
  expect(native.shown).toBe(1);
  runner.stop();
  expect(native.closed).toBe(1);
});

it('records a throwing native submission as unknown, while an observed native failed event is a failure', async () => {
  const h = harness(), create = h.deps.native.create;
  h.deps.native.create = options => { const handle = create(options), show = handle.show.bind(handle); handle.show = () => { show(); throw new Error('uncertain native boundary'); }; return handle; };
  await createNotificationRunner(h.deps).tick(() => true);
  expect(h.item.receipt?.status).toBe('unknown');
  await h.natives[0]!.emit('failed');
  expect(h.item.receipt?.status).toBe('failed');
  expect(h.natives[0]?.shown).toBe(1);
});

it('drops a claimed alert and a late clicked target when the session changes, and leaves routine empty work quiet', async () => {
  const h = harness(), claim = h.deps.api.claim;
  let active = true;
  h.deps.api.claim = async eventKey => { const result = await claim(eventKey); active = false; return result; };
  await createNotificationRunner(h.deps).tick(() => active);
  expect(h.natives).toEqual([]);
  expect(h.item.receipt?.status).toBe('attempting');
  const restarted = createNotificationRunner(h.deps);
  active = true;
  await restarted.tick(() => active);
  expect(h.item.receipt?.status).toBe('unknown');
  expect(h.natives).toEqual([]);

  const clickable = harness(), runner = createNotificationRunner(clickable.deps);
  await runner.tick(() => true);
  let resolve: ((value: Awaited<ReturnType<NotificationApiPort['acknowledge']>>) => void) | undefined;
  clickable.deps.api.acknowledge = async () => await new Promise(done => { resolve = done; });
  const click = clickable.natives[0]!.emit('click');
  runner.stop();
  resolve?.({ ok: true, value: clickable.item.target });
  await click;
  expect(clickable.targets).toEqual([]);
  const quiet = harness(), queue = await quiet.read();
  quiet.deps.api.read = async () => ({ ok: true, value: { ...queue, items: [], recoveries: [] } });
  await createNotificationRunner(quiet.deps).tick(() => true);
  expect(quiet.natives).toEqual([]);
});

it('acknowledges a cold-start native identifier only through the current authenticated receipt and exact Today target', async () => {
  const h = harness();
  await createNotificationRunner(h.deps).tick(() => true);
  const identifier = h.natives[0]!.id, restarted = createNotificationRunner(h.deps);
  expect(await restarted.activate(identifier.replace(h.deps.identity().userId, randomUUID()), () => true)).toBe('ignored');
  h.setOnline(false);
  expect(await restarted.activate(identifier, () => true)).toBe('unavailable');
  h.setOnline(true);
  expect(await restarted.activate(identifier, () => true)).toBe('acknowledged');
  expect(h.targets).toEqual([h.item.target]);
  expect(h.item.receipt?.status).toBe('acknowledged');
  h.targets.length = 0;
  h.setCurrent(false);
  expect(await restarted.activate(identifier, () => true)).toBe('acknowledged');
  expect(h.targets).toEqual([]);
  expect(h.natives[0]?.shown).toBe(1);
});

it('retains cold-start activation through a late identity start and offline recovery without repeating the alert', async () => {
  const h = harness();
  await createNotificationRunner(h.deps).tick(() => true);
  const identifier = h.natives[0]!.id;
  vi.useFakeTimers();
  const pump = createActionableNotificationPump(h.deps);
  pump.activate(identifier);
  h.setOnline(false);
  pump.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(pump.status().state).toBe('offline');
  expect(h.targets).toEqual([]);
  h.setOnline(true);
  pump.wake();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.item.receipt?.status).toBe('acknowledged');
  expect(h.targets).toEqual([h.item.target]);
  expect(h.natives[0]?.shown).toBe(1);
  pump.stop();
});

it('retains an offline native click until recovery can durably acknowledge and open its current context', async () => {
  const h = harness();
  vi.useFakeTimers();
  const pump = createActionableNotificationPump(h.deps);
  pump.start();
  await vi.advanceTimersByTimeAsync(0);
  await h.natives[0]!.emit('show');
  h.setOnline(false);
  await h.natives[0]!.emit('click');
  await vi.advanceTimersByTimeAsync(0);
  expect(h.item.receipt?.status).toBe('native_shown');
  expect(h.targets).toEqual([]);
  h.setOnline(true);
  pump.wake();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.item.receipt?.status).toBe('acknowledged');
  expect(h.targets).toEqual([h.item.target]);
  expect(h.natives[0]?.shown).toBe(1);
  pump.stop();
});
