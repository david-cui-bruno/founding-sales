/** @vitest-environment jsdom */
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { actionableNotificationsResponseSchema, type NotificationRuntimeStatus } from '@fss/contracts';
import { NotificationStatus, type NotificationStatusPort } from '../src/renderer/today/NotificationStatus.tsx';

afterEach(cleanup);
function queue(status: 'attempting' | 'native_shown' | 'acknowledged' | 'failed' | 'unknown') {
  const messageId = randomUUID();
  return actionableNotificationsResponseSchema.parse({ version: 1, workspaceId: randomUUID(), userId: randomUUID(), asOf: '2026-09-14T03:00:00.000Z', recoveries: [], items: [{ actionId: `reply-message:${messageId}`, eventKey: `reply-message:${messageId}:reply_overdue`, kind: 'reply', phase: 'reply_overdue', reason: 'substantive_reply', subject: 'Northwind', dueAt: '2026-09-11T14:00:00.000Z', state: 'overdue', target: { kind: 'reply', messageId, firmId: randomUUID() }, receipt: { status, attemptId: randomUUID(), deviceId: randomUUID(), attemptedAt: '2026-09-14T03:00:00.000Z', nativeShownAt: status === 'native_shown' ? '2026-09-14T03:00:01.000Z' : null, acknowledgedAt: status === 'acknowledged' ? '2026-09-14T03:01:00.000Z' : null, failedAt: status === 'failed' ? '2026-09-14T03:00:01.000Z' : null, unknownAt: status === 'unknown' ? '2026-09-14T03:02:00.000Z' : null } }] });
}
function port(status: Parameters<typeof queue>[0], runtime: NotificationRuntimeStatus['state'] = 'ready'): NotificationStatusPort {
  return { read: async () => ({ ok: true, value: queue(status) }), runtime: async () => ({ state: runtime, lastCheckedAt: '2026-09-14T03:00:00.000Z' }) };
}
it('shows unknown native outcome without claiming delivery or clearing the overdue action', async () => {
  render(<NotificationStatus port={port('unknown')} />);
  expect(await screen.findByText('Native outcome unknown')).toBeDefined();
  expect(screen.getByText('Northwind')).toBeDefined();
  expect(screen.getByText('Today work stays open until it is resolved.')).toBeDefined();
  expect(screen.queryByText(/delivered/i)).toBeNull();
});
it.each([
  ['attempting', 'Native alert attempted; no show observed'],
  ['native_shown', 'Native show observed; awaiting acknowledgement'],
  ['acknowledged', 'Acknowledged'],
  ['failed', 'Native alert failed'],
] as const)('distinguishes %s from other notification receipts', async (state, label) => {
  render(<NotificationStatus port={port(state)} />);
  expect(await screen.findByText(label)).toBeDefined();
  expect(screen.queryByText('Native outcome unknown')).toBeNull();
});
it('distinguishes an offline read from an empty healthy queue and suppresses a late previous-session result', async () => {
  let resolveOld: ((value: Awaited<ReturnType<NotificationStatusPort['read']>>) => void) | undefined;
  const old: NotificationStatusPort = { read: () => new Promise(resolve => { resolveOld = resolve; }), runtime: async () => ({ state: 'ready', lastCheckedAt: null }) };
  const view = render(<NotificationStatus port={old} />);
  const offline: NotificationStatusPort = { read: async () => ({ ok: false, reason: 'offline', offline: true }), runtime: async () => ({ state: 'offline', lastCheckedAt: null }) };
  view.rerender(<NotificationStatus port={offline} />);
  expect(await screen.findByText('Alerts are unavailable while offline.')).toBeDefined();
  resolveOld?.({ ok: true, value: queue('native_shown') });
  expect(screen.queryByText('Northwind')).toBeNull();
  const healthy: NotificationStatusPort = { read: async () => ({ ok: true, value: { ...queue('native_shown'), items: [] } }), runtime: async () => ({ state: 'ready', lastCheckedAt: null }) };
  view.rerender(<NotificationStatus port={healthy} />);
  expect(screen.queryByText('Northwind')).toBeNull();
});
