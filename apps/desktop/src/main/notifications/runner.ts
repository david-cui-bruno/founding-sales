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
  let epoch = 0;
  const status = (state: NotificationRuntimeStatus['state']) => deps.onStatus?.({ state, lastCheckedAt: deps.now() });
  function nativeId(identity: NotificationIdentity, eventKey: string): string {
    return `callie-action:${identity.workspaceId}:${identity.userId}:${createHash('sha256').update(eventKey).digest('hex')}`;
  }
  function bind(handle: NativeNotificationHandle, item: { actionId: string; receipt: NonNullable<NotificationItem['receipt']> }, current: () => boolean) {
    boundEpoch.set(handle.id, epoch);
    handle.on('show', async () => { if (current()) await deps.api.observe(item.receipt.attemptId, 'native_shown'); });
    handle.on('failed', async () => { if (current()) await deps.api.observe(item.receipt.attemptId, 'failed'); });
    handle.on('click', async () => {
      if (!current()) return;
      if (deps.onActivation !== undefined) { deps.onActivation(handle.id); return; }
      const result = await deps.api.acknowledge(item.receipt.attemptId, item.actionId);
      if (current() && result.ok && result.value !== null) deps.openTarget(result.value);
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
      const recovery = result.value.recoveries.find(item => nativeId(identity, item.eventKey) === identifier);
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
      for (const recovery of queue.recoveries) {
        const id = nativeId(identity, recovery.eventKey), restored = history?.find(handle => handle.id === id);
        if (!recovery.current) {
          try { (handles.get(id) ?? restored)?.close(); } catch { /* No stale native destination is reopened. */ }
          handles.delete(id);
          boundEpoch.delete(id);
          continue;
        }
        const handle = handles.get(id) ?? restored;
        if (handle !== undefined && boundEpoch.get(id) !== generation) { handles.set(id, handle); bind(handle, recovery, current); }
        if (restored !== undefined) {
          if (!handles.has(id)) { handles.set(id, restored); bind(restored, recovery, current); }
          if (recovery.receipt.nativeShownAt === null) await deps.api.observe(recovery.receipt.attemptId, 'native_shown');
        } else if (recovery.receipt.status === 'attempting' && (!handles.has(id) || Date.parse(deps.now()) - Date.parse(recovery.receipt.attemptedAt) >= 120_000)) {
          // Empty/missing history cannot prove failure (dismissed, unsigned or quit).
          // Preserve the durable marker. A later show/history observation may settle it.
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
        const restored = history?.find(handle => handle.id === id);
        if (restored !== undefined) {
          handles.set(id, restored);
          bind(restored, { actionId: item.actionId, receipt: item.receipt }, current);
          await deps.api.observe(item.receipt.attemptId, 'native_shown');
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
        for (const handle of handles.values()) { try { handle.close(); } catch { /* Native removal is best effort. */ } }
        handles.clear(); boundEpoch.clear();
      }
      // Electron requires created handles to stay strongly referenced. Suspend keeps
      // them alive but invalidates callbacks; resume rebinds the current epoch.
      status('stopped');
    },
  };
}
