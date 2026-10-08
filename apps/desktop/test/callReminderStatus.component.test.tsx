/** @vitest-environment jsdom */
import { randomUUID } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { ActionableNotificationsResponse } from '@fss/contracts';
import { NotificationStatus, type NotificationStatusPort } from '../src/renderer/today/NotificationStatus.tsx';

afterEach(cleanup);
function reminder(): ActionableNotificationsResponse {
  const meetingId = randomUUID(), startsAt = '2026-09-15T03:30:00.000Z';
  return { version: 1, workspaceId: randomUUID(), userId: randomUUID(), asOf: '2026-09-15T03:17:01.000Z', recoveries: [], items: [{
    actionId: `meeting:${meetingId}`, eventKey: `meeting:${meetingId}:pre_call:current-calcom-uid:${startsAt}`, kind: 'call', phase: 'pre_call', reason: 'upcoming_call', subject: 'Northwind Test Holdings', dueAt: startsAt, state: 'open',
    target: { kind: 'meeting', firmId: randomUUID(), meetingId, bookingUid: 'current-calcom-uid', startsAt },
    receipt: { attemptId: randomUUID(), deviceId: randomUUID(), status: 'unknown', attemptedAt: '2026-09-15T03:15:00.000Z', nativeShownAt: null, acknowledgedAt: null, failedAt: null, unknownAt: '2026-09-15T03:17:01.000Z' },
  }] };
}

it('shows the current call reminder as unknown and offline without inventing native show or delivery', async () => {
  const pending = reminder();
  const port: NotificationStatusPort = { read: async () => ({ ok: true, value: pending }), runtime: async () => ({ state: 'ready', lastCheckedAt: pending.asOf }) };
  const view = render(<NotificationStatus port={port} />);
  expect(await screen.findByText('Native outcome unknown')).toBeDefined();
  expect(screen.getByText('Northwind Test Holdings')).toBeDefined();
  expect(screen.queryByText(/show observed|delivered/i)).toBeNull();
  view.rerender(<NotificationStatus port={{ read: async () => ({ ok: false, reason: 'offline', offline: true }), runtime: async () => ({ state: 'offline', lastCheckedAt: pending.asOf }) }} />);
  expect(await screen.findByText('Alerts are unavailable while offline.')).toBeDefined();
  expect(screen.queryByText('Northwind Test Holdings')).toBeNull();
});

it('does not restore a cancelled call reminder when an older read arrives after the current empty result', async () => {
  const old = reminder();
  let releaseOld: ((value: Awaited<ReturnType<NotificationStatusPort['read']>>) => void) | undefined;
  let first = true;
  const port: NotificationStatusPort = {
    read: async () => {
      if (first) { first = false; return await new Promise(resolve => { releaseOld = resolve; }); }
      return { ok: true, value: { ...old, items: [], recoveries: [] } };
    },
    runtime: async () => ({ state: 'ready', lastCheckedAt: old.asOf }),
  };
  render(<NotificationStatus port={port} />);
  await act(async () => { fireEvent(window, new Event('focus')); });
  expect(screen.queryByRole('region', { name: 'Desktop alert status' })).toBeNull();
  await act(async () => { releaseOld?.({ ok: true, value: old }); });
  expect(screen.queryByText('Northwind Test Holdings')).toBeNull();
  expect(screen.queryByText('Native outcome unknown')).toBeNull();
});
