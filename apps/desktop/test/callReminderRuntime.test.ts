import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { ActionableNotificationsResponse, NotificationItem, TodayActionTarget } from '@fss/contracts';
import { createAuthedClient } from '../src/main/authedClient.ts';
import { createNotificationRuntime } from '../src/main/notifications/runtime.ts';
import type { NativeNotificationHandle } from '../src/main/notifications/native.ts';

const stopping: (() => void)[] = [];
afterEach(() => { for (const stop of stopping.splice(0)) stop(); });

class CallAlert implements NativeNotificationHandle {
  shown = 0;
  closed = 0;
  readonly listeners = new Map<string, (() => void)[]>();
  readonly id: string;
  constructor(id: string) { this.id = id; }
  on(event: 'show' | 'click' | 'failed', listener: () => void) { this.listeners.set(event, [...this.listeners.get(event) ?? [], listener]); }
  show() { this.shown++; }
  close() { this.closed++; }
  async emit(event: 'show' | 'click' | 'failed') { for (const listener of this.listeners.get(event) ?? []) await listener(); }
}

function fixture(input: { eventKey?: (meetingId: string, startsAt: string) => string } = {}) {
  const identity = { workspaceId: randomUUID(), userId: randomUUID() }, deviceId = randomUUID();
  const meetingId = randomUUID(), target: TodayActionTarget = { kind: 'meeting', firmId: randomUUID(), meetingId, bookingUid: 'current-calcom-uid', startsAt: '2026-09-15T03:30:00.000Z' };
  let now = '2026-09-15T03:15:00.000Z', online = true, availableTarget: TodayActionTarget | null = target;
  let item: NotificationItem = { actionId: `meeting:${meetingId}`, eventKey: input.eventKey?.(meetingId, target.startsAt) ?? `meeting:${meetingId}:pre_call:current-calcom-uid:${target.startsAt}`, kind: 'call', phase: 'pre_call', reason: 'upcoming_call', subject: 'Northwind Test Holdings', dueAt: target.startsAt, state: 'open', target, receipt: null };
  let current = true, queued = true, replayedAcknowledgement = false;
  const alerts: CallAlert[] = [], targets: TodayActionTarget[] = [], observations: string[] = [], history: CallAlert[] = [];
  const queue = (): ActionableNotificationsResponse => ({ version: 1, ...identity, asOf: now, items: queued ? [structuredClone(item)] : [],
    recoveries: item.receipt === null ? [] : [{ eventKey: item.eventKey, actionId: item.actionId, target: item.target, current, receipt: structuredClone(item.receipt) }] });
  const api = createAuthedClient({ baseUrl: 'https://callie.example.test', clientVersion: '1.0.49', accessToken: async () => ({ token: 'controlled-session', generation: 0 }),
    async send(url, init) {
      if (!online) throw new Error('controlled offline transport');
      const path = new URL(url).pathname;
      if (path === '/notifications/actions') return { status: 200, body: queue() };
      if (path === '/notifications/claim') {
        if (item.receipt !== null) return { status: 200, body: { status: 'accepted', replayed: false, result: { version: 1, item: null } } };
        item = { ...item, receipt: { attemptId: randomUUID(), deviceId, status: 'attempting', attemptedAt: now, nativeShownAt: null, acknowledgedAt: null, failedAt: null, unknownAt: null } };
        return { status: 200, body: { status: 'accepted', replayed: false, result: { version: 1, item: structuredClone(item) } } };
      }
      if (path === '/today/actions/open') return { status: 200, body: { version: 1, target: availableTarget } };
      if (path === '/notifications/observe') {
        const command: { observation: 'native_shown' | 'failed' | 'unknown' } = JSON.parse(init.body ?? '{}');
        observations.push(command.observation);
        if (item.receipt !== null) item.receipt = { ...item.receipt, status: command.observation,
          nativeShownAt: command.observation === 'native_shown' ? now : item.receipt.nativeShownAt,
          failedAt: command.observation === 'failed' ? now : item.receipt.failedAt,
          unknownAt: command.observation === 'unknown' ? now : item.receipt.unknownAt };
        return { status: 200, body: { status: 'accepted', replayed: false, result: { version: 1, recorded: true } } };
      }
      if (path === '/notifications/acknowledge') return { status: 200, body: { status: 'accepted', replayed: replayedAcknowledgement, result: { version: 1, target: replayedAcknowledgement ? target : availableTarget } } };
      throw new Error(`unexpected call reminder route ${path}`);
    },
  });
  const runtime = createNotificationRuntime({ api, native: { supported: () => true, history: async () => history.length === 0 ? null : history, create(options) { const alert = new CallAlert(options.id); alerts.push(alert); return alert; } },
    identity: async () => identity, generation: () => 0, now: () => now, openTarget(value) { targets.push(value); } });
  stopping.push(() => runtime.stop());
  return { runtime, alerts, targets, target, observations, history, identity, setOnline(value: boolean) { online = value; },
    invalidate() { availableTarget = null; current = false; queued = false; },
    replayOldAcknowledgement() { replayedAcknowledgement = true; },
    advance(value: string) { now = value; },
    get receipt() { return item.receipt; },
  };
}

it('shows one pre-call alert while awake, preserves its original attempt through resume and opens the authorized current brief target', async () => {
  const h = fixture();
  h.runtime.start();
  await vi.waitFor(() => expect(h.alerts[0]?.shown).toBe(1));
  expect(h.receipt).toMatchObject({ status: 'attempting', nativeShownAt: null });
  h.runtime.stop({ clear: false });
  await h.alerts[0]!.emit('click');
  expect(h.targets).toEqual([]);
  h.runtime.start();
  await vi.waitFor(() => expect(h.runtime.status().state).toBe('ready'));
  await h.alerts[0]!.emit('click');
  await vi.waitFor(() => expect(h.targets).toEqual([h.target]));
  expect(h.alerts).toHaveLength(1);
  expect(h.alerts[0]?.shown).toBe(1);
});

it('recognizes a retained native pre-UID call alert after restore without showing another alert under the current occurrence key', async () => {
  const h = fixture({ eventKey: (meetingId, startsAt) => `meeting:${meetingId}:pre_call:current-calcom-uid:${startsAt}` });
  const legacyKey = `meeting:${h.target.kind === 'meeting' ? h.target.meetingId : ''}:pre_call:${h.target.kind === 'meeting' ? h.target.startsAt : ''}`;
  const legacy = new CallAlert(`callie-action:${h.identity.workspaceId}:${h.identity.userId}:${createHash('sha256').update(legacyKey).digest('hex')}`);
  h.history.push(legacy);
  h.runtime.start();
  await vi.waitFor(() => expect(h.runtime.status().state).toBe('ready'));
  expect(h.alerts).toEqual([]);
  expect(legacy.shown).toBe(0);
  expect(legacy.closed).toBe(0);
  expect(h.observations).toEqual(['unknown']);
  await legacy.emit('click');
  await vi.waitFor(() => expect(h.targets).toEqual([h.target]));
  expect(h.alerts).toEqual([]);
  expect(h.receipt).toMatchObject({ status: 'unknown', nativeShownAt: null });
});

it('does not attribute an old unversioned native failure to a current booking that was never submitted', async () => {
  const h = fixture();
  if (h.target.kind !== 'meeting') throw new Error('meeting fixture missing');
  const legacyKey = `meeting:${h.target.meetingId}:pre_call:${h.target.startsAt}`;
  const legacy = new CallAlert(`callie-action:${h.identity.workspaceId}:${h.identity.userId}:${createHash('sha256').update(legacyKey).digest('hex')}`);
  h.history.push(legacy);
  h.runtime.start();
  await vi.waitFor(() => expect(h.receipt?.status).toBe('unknown'));
  await legacy.emit('failed');
  expect(h.receipt).toMatchObject({ status: 'unknown', nativeShownAt: null, failedAt: null });
  expect(h.alerts).toEqual([]);
});

it('invalidates a visible reminder after Cal.com cancellation or changed ownership, so a clicked old alert opens no brief', async () => {
  const h = fixture();
  h.runtime.start();
  await vi.waitFor(() => expect(h.alerts[0]?.shown).toBe(1));
  h.invalidate();
  await h.alerts[0]!.emit('click');
  await vi.waitFor(() => expect(h.alerts[0]?.closed).toBeGreaterThan(0));
  expect(h.targets).toEqual([]);
  expect(h.alerts).toHaveLength(1);
});

it('revalidates a replayed old acknowledgement before opening a call that has since been cancelled or rescheduled', async () => {
  const h = fixture();
  h.runtime.start();
  await vi.waitFor(() => expect(h.alerts[0]?.shown).toBe(1));
  h.invalidate();
  h.replayOldAcknowledgement();
  await h.alerts[0]!.emit('click');
  await vi.waitFor(() => expect(h.alerts[0]?.closed).toBeGreaterThan(0));
  expect(h.targets).toEqual([]);
  expect(h.alerts[0]?.shown).toBe(1);
});

it('reports an offline current read and resumes without submitting another pre-call alert when the native result is unknown', async () => {
  const h = fixture();
  h.runtime.start();
  await vi.waitFor(() => expect(h.alerts[0]?.shown).toBe(1));
  h.setOnline(false);
  h.runtime.wake();
  await vi.waitFor(() => expect(h.runtime.status().state).toBe('offline'));
  expect(h.targets).toEqual([]);
  h.setOnline(true);
  h.advance('2026-09-15T03:17:01.000Z');
  h.runtime.wake();
  await vi.waitFor(() => expect(h.runtime.status().state).toBe('ready'));
  expect(h.observations).toEqual(['unknown']);
  expect(h.alerts).toHaveLength(1);
  expect(h.alerts[0]?.shown).toBe(1);
});
