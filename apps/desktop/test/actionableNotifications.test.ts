import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { notificationItemSchema, type ActionableNotificationsResponse, type NotificationRuntimeStatus, type NotificationItem, type TodayActionTarget } from '@fss/contracts';
import { createNotificationRunner, type NotificationApiPort } from '../src/main/notifications/runner.ts';
import type { NativeNotificationHandle, NativeNotificationPort } from '../src/main/notifications/native.ts';

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
    async acknowledge() { if (item.receipt !== null) { item.receipt.status = 'acknowledged'; item.receipt.acknowledgedAt = '2026-09-14T03:00:00.000Z'; } return { ok: true, value: currentTarget }; },
  };
  const native: NativeNotificationPort = { supported: () => true, history: async () => history,
    create(options) { const handle = new ControlledNotification(options.id); natives.push(handle); return handle; } };
  const deps = { api, native, identity: () => ({ workspaceId, userId }), now: () => '2026-09-14T03:00:00.000Z', onStatus: (status: NotificationRuntimeStatus) => statuses.push(status), openTarget: (target: TodayActionTarget) => targets.push(target) };
  return { deps, read, natives, history, statuses, targets, setOnline(value: boolean) { online = value; }, setCurrent(value: boolean) { receiptCurrent = value; currentTarget = value ? item.target : null; }, get item(): NotificationItem { return item; } };
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
