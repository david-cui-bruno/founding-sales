import { describe, expect, it } from 'vitest';
import { nextMeetingFollowThroughAction } from '../../meetings/followThroughSchedule.ts';
import type { MeetingFollowThroughScope } from '@fss/contracts';
const scope: MeetingFollowThroughScope = { contactId: 'contact', meetingId: 'meeting', bookingReference: 'booking', purposes: ['recap','nudge'], maxMessages: 3, expiresAt: '2026-11-04T00:00:00Z', agreedReminder: null, reminderEvidence: [] };
const input = { plan: { scope, maxMessages: 3 }, deliveryHistory: [{ ordinal: 1, sentAt: '2026-10-05T15:00:00Z' }], at: '2026-10-05T15:00:00Z', calendar: { version: 'test', dates: [] as string[] }, zone: 'America/New_York' };
describe('meeting timing follows delivery and the existing calendar', () => {
  it('uses local calendar days seven and fourteen after delivery', () => {
    expect(nextMeetingFollowThroughAction(input)).toMatchObject({ kind: 'nudge', ordinal: 2, dueAt: '2026-10-12T15:00:00.000Z' });
    expect(nextMeetingFollowThroughAction({ ...input, deliveryHistory: [...input.deliveryHistory, { ordinal: 2, sentAt: '2026-10-12T15:00:00Z' }] })).toMatchObject({ kind: 'nudge', ordinal: 3, dueAt: '2026-10-19T15:00:00.000Z' });
  });
  it('preserves local time over DST and moves holidays into a permitted window', () => {
    expect(nextMeetingFollowThroughAction({ ...input, deliveryHistory: [{ ordinal: 1, sentAt: '2026-10-26T15:00:00Z' }], calendar: { version: 'holiday', dates: ['2026-11-02'] } })).toMatchObject({ kind: 'nudge', dueAt: '2026-11-03T13:00:00.000Z' });
  });
  it('keeps a single agreed reminder to one message at the agreed date', () => {
    const plan = { ...input.plan, scope: { ...scope, maxMessages: 1, purposes: ['reminder'] as ['reminder'], agreedReminder: { precision: 'date' as const, localDate: '2026-10-13', zone: input.zone } } };
    expect(nextMeetingFollowThroughAction({ ...input, plan, deliveryHistory: [] })).toMatchObject({ kind: 'nudge', ordinal: 1, dueAt: '2026-10-13T12:00:00.000Z' });
    expect(nextMeetingFollowThroughAction({ ...input, plan })).toMatchObject({ kind: 'complete' });
  });
  it('omits a second nudge colliding with a delayed first and makes one task two business days later', () => {
    expect(nextMeetingFollowThroughAction({ ...input, at: '2026-10-19T15:00:00Z', deliveryHistory: [...input.deliveryHistory, { ordinal: 2, sentAt: '2026-10-19T15:00:00Z' }] })).toMatchObject({ kind: 'task', dueAt: '2026-10-21T12:00:00.000Z', deadline: { localDate: '2026-10-21' } });
  });
  it('refuses obsolete nudges and dates outside the original permission', () => {
    expect(nextMeetingFollowThroughAction({ ...input, at: '2026-10-20T15:00:00Z' })).toMatchObject({ kind: 'review', reason: 'nudge_obsolete' });
    expect(nextMeetingFollowThroughAction({ ...input, plan: { ...input.plan, scope: { ...scope, expiresAt: '2026-10-11T00:00:00Z' } } })).toMatchObject({ kind: 'review', reason: 'follow_up_expired' });
  });
});
