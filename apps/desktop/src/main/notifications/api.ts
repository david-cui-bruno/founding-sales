import { actionableNotificationsResponseSchema, claimNotificationResultSchema, observeNotificationResultSchema, acknowledgeNotificationResultSchema, todayActionOpenResponseSchema } from '@fss/contracts';
import type { AuthedClient } from '../authedClient.ts';
import type { NotificationApiPort } from './runner.ts';

/** Each claim is single-use locally. Uncertain transport is recovered by reads, never by repeating show. */
export function createNotificationApiPort(api: AuthedClient, current: () => boolean): NotificationApiPort {
  const changed = { ok: false, reason: 'session_changed', offline: false } as const;
  return {
    async read() {
      if (!current()) return changed;
      const result = await api.read('/notifications/actions', value => actionableNotificationsResponseSchema.parse(value));
      return current() ? result : changed;
    },
    async claim(eventKey) {
      if (!current()) return changed;
      const result = await api.command('/notifications/claim', { eventKey }, value => claimNotificationResultSchema.parse(value));
      return !current() ? changed : result.ok ? { ok: true, value: result.value.item } : result;
    },
    async observe(attemptId, observation) {
      if (!current()) return false;
      const result = await api.command('/notifications/observe', { attemptId, observation }, value => observeNotificationResultSchema.parse(value));
      return current() && result.ok && result.value.recorded;
    },
    async validate(actionId, target) {
      if (!current()) return changed;
      const result = await api.read('/today/actions/open', value => todayActionOpenResponseSchema.parse(value), { actionId, target });
      return !current() ? changed : result.ok ? { ok: true, value: result.value.target !== null } : result;
    },
    async acknowledge(attemptId, actionId) {
      if (!current()) return changed;
      const result = await api.command('/notifications/acknowledge', { attemptId }, value => acknowledgeNotificationResultSchema.parse(value));
      if (!current()) return changed;
      if (!result.ok) return result;
      if (result.value.target === null) return { ok: true, value: null };
      // Command receipts can replay an old answer. Current navigation authority is a fresh read.
      const opened = await api.read('/today/actions/open', value => todayActionOpenResponseSchema.parse(value), { actionId, target: result.value.target });
      return !current() ? changed : opened.ok ? { ok: true, value: opened.value.target } : opened;
    },
  };
}
