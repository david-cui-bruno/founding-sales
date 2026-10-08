import type { ActionableNotificationsResponse, NotificationItem, NotificationRuntimeStatus, TodayActionTarget } from '@fss/contracts';
import type { ApiOutcome } from '../apiClient.ts';
import type { NativeNotificationPort } from './native.ts';
import type { NativeNotificationHandle } from './native.ts';
import { createHash } from 'node:crypto';

export interface NotificationIdentity { workspaceId: string; userId: string }
export interface NotificationApiPort {
  read(): Promise<ApiOutcome<ActionableNotificationsResponse>>;
  claim(eventKey: string): Promise<ApiOutcome<NotificationItem | null>>;
  validate(actionId: string, target: TodayActionTarget): Promise<ApiOutcome<boolean>>;
  observe(attemptId: string, observation: 'native_shown' | 'failed' | 'unknown'): Promise<boolean>;
  acknowledge(attemptId: string, actionId: string): Promise<ApiOutcome<TodayActionTarget | null>>;
}
export interface NotificationRunnerDeps {
  api: NotificationApiPort;
  native: NativeNotificationPort;
  identity(): NotificationIdentity | null;
  now(): string;
  onStatus?(status: NotificationRuntimeStatus): void;
  onActivation?(identifier: string): void;
  openTarget(target: TodayActionTarget): void;
}
export function createNotificationRunner(deps: NotificationRunnerDeps) {
  const handles = new Map<string, NativeNotificationHandle>();
  const boundEpoch = new Map<string, number>();
  const bindings = new WeakMap<NativeNotificationHandle, { item: { actionId: string; receipt: NonNullable<NotificationItem['receipt']> }; current(): boolean; shownObservation: 'native_shown' | 'unknown' }>();
  const boundHandles = new WeakSet<NativeNotificationHandle>();
  let epoch = 0;
  const status = (state: NotificationRuntimeStatus['state']) => deps.onStatus?.({ state, lastCheckedAt: deps.now() });
  function nativeId(identity: NotificationIdentity, eventKey: string): string {
    return `callie-action:${identity.workspaceId}:${identity.userId}:${createHash('sha256').update(eventKey).digest('hex')}`;
  }
  function legacyId(identity: NotificationIdentity, item: { actionId: string; target: TodayActionTarget }): string | null {
    return item.target.kind === 'meeting' && item.target.bookingUid !== undefined
      ? nativeId(identity, `${item.actionId}:pre_call:${item.target.startsAt}`) : null;
  }
  function matchingHandle(identity: NotificationIdentity, item: { eventKey: string; actionId: string; target: TodayActionTarget }, history: NativeNotificationHandle[] | null) {
    const id = nativeId(identity, item.eventKey), legacy = legacyId(identity, item);
    const handle = handles.get(id) ?? history?.find(handle => handle.id === id)
      ?? (legacy === null ? undefined : handles.get(legacy) ?? history?.find(handle => handle.id === legacy));
    return handle === undefined ? null : { handle, inHistory: history?.some(retained => retained.id === handle.id) === true, observation: handle.id === id ? 'native_shown' as const : 'unknown' as const };
  }
  function bind(handle: NativeNotificationHandle, item: { actionId: string; receipt: NonNullable<NotificationItem['receipt']> }, current: () => boolean, shownObservation: 'native_shown' | 'unknown' = 'native_shown') {
    boundEpoch.set(handle.id, epoch);
    bindings.set(handle, { item, current, shownObservation });
    if (boundHandles.has(handle)) return;
    boundHandles.add(handle);
    const active = () => { const binding = bindings.get(handle); return binding?.current() ? binding : null; };
    handle.on('show', async () => { const binding = active(); if (binding) await deps.api.observe(binding.item.receipt.attemptId, binding.shownObservation); });
    handle.on('failed', async () => { const binding = active(); if (binding) await deps.api.observe(binding.item.receipt.attemptId, binding.shownObservation === 'unknown' ? 'unknown' : 'failed'); });
    handle.on('click', async () => {
      const binding = active();
      if (!binding) return;
      if (deps.onActivation !== undefined) { deps.onActivation(handle.id); return; }
      const result = await deps.api.acknowledge(binding.item.receipt.attemptId, binding.item.actionId);
      if (binding.current() && result.ok && result.value !== null) deps.openTarget(result.value);
    });
  }
  return {
    async activate(identifier: string, isCurrent: () => boolean): Promise<'acknowledged' | 'ignored' | 'unavailable'> {
      const identity = deps.identity(), generation = epoch;
      const current = () => isCurrent() && epoch === generation && deps.identity()?.workspaceId === identity?.workspaceId && deps.identity()?.userId === identity?.userId;
      if (identity === null || !current() || !identifier.startsWith(`callie-action:${identity.workspaceId}:${identity.userId}:`)) return 'ignored';
      const result = await deps.api.read();
      if (!current()) return 'ignored';
      if (!result.ok) { status(result.offline ? 'offline' : 'unavailable'); return 'unavailable'; }
      if (result.value.workspaceId !== identity.workspaceId || result.value.userId !== identity.userId) return 'ignored';
      const recovery = result.value.recoveries.find(item => nativeId(identity, item.eventKey) === identifier || item.current && legacyId(identity, item) === identifier);
      if (recovery === undefined) return 'ignored';
      const acknowledged = await deps.api.acknowledge(recovery.receipt.attemptId, recovery.actionId);
      if (!current()) return 'ignored';
      if (!acknowledged.ok) { status(acknowledged.offline ? 'offline' : 'unavailable'); return 'unavailable'; }
      if (acknowledged.value !== null) deps.openTarget(acknowledged.value);
      return 'acknowledged';
    },
    async tick(isCurrent: () => boolean): Promise<void> {
      const identity = deps.identity(), generation = epoch;
      const current = () => isCurrent() && epoch === generation && deps.identity()?.workspaceId === identity?.workspaceId && deps.identity()?.userId === identity?.userId;
      if (identity === null || !current()) return;
      if (!deps.native.supported()) { status('unsupported'); return; }
      const result = await deps.api.read();
      if (!current()) return;
      if (!result.ok) { status(result.offline ? 'offline' : 'unavailable'); return; }
      const queue = result.value;
      if (queue.workspaceId !== identity.workspaceId || queue.userId !== identity.userId) { status('unavailable'); return; }
      const history = await deps.native.history();
      if (!current()) return;
      // Candidates are complete current show authority, including marker loss after
      // restore. Current recoveries also protect earlier phases of still-open work.
      // Obsolete receipts may fall outside the presentation window; their known
      // native handles must still close without deleting any durable marker.
      const currentNativeIds = new Set([
        ...queue.items.filter(item => item.receipt === null).flatMap(item => [nativeId(identity, item.eventKey), legacyId(identity, item)].filter(id => id !== null)),
        ...queue.recoveries.filter(item => item.current).flatMap(item => [nativeId(identity, item.eventKey), legacyId(identity, item)].filter(id => id !== null)),
      ]);
      const known = new Map([...(history ?? []).map(handle => [handle.id, handle] as const), ...handles]);
      for (const [id, handle] of known) {
        if (!id.startsWith(`callie-action:${identity.workspaceId}:${identity.userId}:`) || currentNativeIds.has(id)) continue;
        bindings.delete(handle);
        try { handle.close(); } catch { /* Stale removal is best effort. */ }
        handles.delete(id); boundEpoch.delete(id);
      }
      for (const recovery of queue.recoveries) {
        if (!recovery.current) continue;
        const restored = matchingHandle(identity, recovery, history);
        if (restored !== null) {
          const { handle, observation } = restored;
          handles.set(handle.id, handle);
          if (boundEpoch.get(handle.id) !== generation) bind(handle, recovery, current, observation);
          if (restored.inHistory && (observation === 'unknown' ? recovery.receipt.status === 'attempting' : recovery.receipt.nativeShownAt === null)) {
            // An old unversioned native handle proves no delivery of this booking UID.
            await deps.api.observe(recovery.receipt.attemptId, observation);
          } else if (!restored.inHistory && recovery.receipt.status === 'attempting' && Date.parse(deps.now()) - Date.parse(recovery.receipt.attemptedAt) >= 120_000) {
            await deps.api.observe(recovery.receipt.attemptId, 'unknown');
          }
        } else if (recovery.receipt.status === 'attempting') {
          // Empty/missing history cannot prove failure (dismissed, unsigned or quit).
          await deps.api.observe(recovery.receipt.attemptId, 'unknown');
        }
      }
      if (!current()) return;
      status('ready');
      for (const candidate of queue.items) {
        if (!current()) return;
        if (candidate.receipt !== null) continue;
        const claim = await deps.api.claim(candidate.eventKey);
        if (!current()) return;
        if (!claim.ok) { status(claim.offline ? 'offline' : 'unavailable'); return; }
        const item = claim.value;
        if (item?.receipt == null || item.eventKey !== candidate.eventKey || item.receipt.status !== 'attempting') continue;
        // A source can change while a successful claim response is in flight.
        // Reuse Today's exact current target read immediately before a new native call.
        const validated = await deps.api.validate(item.actionId, item.target);
        if (!current()) return;
        if (!validated.ok || !validated.value) {
          if (!validated.ok) status(validated.offline ? 'offline' : 'unavailable');
          continue;
        }
        const id = nativeId(identity, item.eventKey);
        if (handles.has(id)) continue;
        const restored = matchingHandle(identity, item, history);
        if (restored !== null) {
          handles.set(restored.handle.id, restored.handle);
          bind(restored.handle, { actionId: item.actionId, receipt: item.receipt }, current, restored.observation);
          await deps.api.observe(item.receipt.attemptId, restored.observation);
          continue;
        }
        let submissionStarted = false;
        try {
          const handle = deps.native.create({ id, title: 'Callie', body: item.phase === 'pre_call' ? 'A confirmed call starts soon. Open Callie for its current context.' : item.phase === 'reply_overdue' ? 'A reply still needs your attention. Open Callie to review it.' : 'You have work that needs attention. Open Callie to review it.', silent: false });
          handles.set(id, handle);
          bind(handle, { actionId: item.actionId, receipt: item.receipt }, current);
          if (current()) { submissionStarted = true; handle.show(); }
        } catch { if (current()) await deps.api.observe(item.receipt.attemptId, submissionStarted ? 'unknown' : 'failed'); }
      }
    },
    stop(options: { clear?: boolean } = {}) {
      epoch++;
      if (options.clear !== false) {
        for (const handle of handles.values()) { bindings.delete(handle); try { handle.close(); } catch { /* Native removal is best effort. */ } }
        handles.clear(); boundEpoch.clear();
      }
      // Electron requires created handles to stay strongly referenced. Suspend keeps
      // them alive but invalidates callbacks; resume rebinds the current epoch.
      status('stopped');
    },
  };
}
