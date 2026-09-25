import type { TodaySnoozeResult } from '@fss/contracts';

/**
 * `/today/snooze`'s two answers as the API sends them (lane g78), typed as
 * `@fss/contracts`' result so a missing key is a compile error. The unit suite used to
 * answer `{ outcome }` alone, which is the shape the desktop's inline parser declared;
 * the route's own test holds the real answer to the same contract.
 */
export function snoozedAnswer(itemKey = 'due-work:fixture'): TodaySnoozeResult {
  return {
    outcome: 'snoozed',
    snooze: {
      id: '12121212-1212-4121-8121-121212121212',
      firmId: '33333333-3333-4333-8333-333333333333',
      contactId: null,
      itemKey,
      reason: 'Out this week',
      returnAt: '2026-09-24T13:00:00.000Z',
      createdByUserId: '77777777-7777-4777-8777-777777777777',
      createdAt: '2026-09-21T13:00:00.000Z',
      cancelledAt: null,
    },
  };
}

export function heldAnswer(): TodaySnoozeResult {
  return { outcome: 'held', holdId: '13131313-1313-4131-8131-131313131313', blockedActionKind: 'email_send' };
}
