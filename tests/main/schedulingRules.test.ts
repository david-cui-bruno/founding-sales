import { describe, expect, it } from 'vitest';
import { validateMeetingIntent, overlapsWithBuffers, resolveLocalTime, matchOfferedReply } from '../../src/shared/meetings/schedulingRules';
import type { MeetingIntent, SchedulingRules } from '../../src/shared/contracts/meetingContract';

export const rules: SchedulingRules = { revision: 1, confirmed: true, timezone: 'America/New_York',
  weeklyWindows: [{ weekday: 2, start: '09:00', end: '17:00' }], durationMinutes: 30, bufferBeforeMinutes: 10,
  bufferAfterMinutes: 10, minimumNoticeMinutes: 60, horizonDays: 30, conflictCalendarIds: ['founder@example.test', 'other@example.test'],
  ownedCalendarId: 'founder@example.test', location: { kind: 'text', value: 'Fictional office' }, allowReschedule: true, allowCancel: true };
export const intent: MeetingIntent = { workspaceId: 'ws-fiction', accountId: 'acct-fiction', commandId: 'cmd-fiction', meetingId: 'meeting-fiction',
  operation: 'create', expectedAuthorityGeneration: 1, expectedVersion: 1, rulesRevision: 1, threadId: 'thread-fiction', threadRevision: 1,
  contextRevision: 'context-fiction', mailboxSubject: 'subject-fiction', pairingId: '00000000-0000-4000-8000-000000000001',
  start: '2026-09-15T14:00:00.000Z', end: '2026-09-15T14:30:00.000Z', localStart: '2026-09-15T10:00:00', offset: '-04:00', timezone: 'America/New_York',
  agreementEvidenceId: 'message-fiction', agreement: { kind: 'explicit_slot', start: '2026-09-15T14:00:00.000Z', end: '2026-09-15T14:30:00.000Z', quote: 'Tuesday at 10 works.' },
  mixedReply: false, approvalId: null, attendeeEmails: ['prospect@example.test'], inviteAttendees: true, summary: 'Fictional meeting', etag: null };
const now = '2026-09-14T12:00:00.000Z';
describe('scheduling rules', () => {
  it('refuses interest without slot agreement', () => {
    expect(validateMeetingIntent({ ...intent, agreementEvidenceId: null }, rules, now)).toEqual({ allowed: false, reason: 'slot_not_agreed' });
    expect(validateMeetingIntent(intent, rules, now)).toEqual({ allowed: true });
  });
  it.each([
    [{ ...rules, confirmed: false }, intent, 'rules_unconfirmed'],
    [rules, { ...intent, rulesRevision: 2 }, 'rules_changed'],
    [rules, { ...intent, mixedReply: true }, 'mixed_reply_requires_approval'],
    [rules, { ...intent, end: '2026-09-15T15:00:00.000Z' }, 'duration_mismatch'],
    [{ ...rules, minimumNoticeMinutes: 10000 }, intent, 'minimum_notice'],
    [{ ...rules, horizonDays: 1 }, intent, 'outside_horizon'],
    [{ ...rules, weeklyWindows: [{ weekday: 2, start: '11:00', end: '17:00' }] }, intent, 'outside_window'],
  ] as const)('holds invalid rules or evidence %#', (r, i, reason) => {
    expect(validateMeetingIntent(i, r, now)).toEqual({ allowed: false, reason });
  });
  it('validates chosen slots against delegated constraints, not sentiment', () => {
    expect(validateMeetingIntent({ ...intent, agreement: { kind: 'delegated_choice', notBefore: '2026-09-15T15:00:00.000Z', notAfter: '2026-09-15T17:00:00.000Z', quote: 'Choose after 11.' } }, rules, now)).toEqual({ allowed: false, reason: 'outside_agreement' });
  });
  it('requires clarification for spring gaps and autumn folds unless a valid offset resolves the fold', () => {
    expect(resolveLocalTime('2026-03-08T02:30:00', 'America/New_York', null)).toEqual({ kind: 'clarification' });
    expect(resolveLocalTime('2026-11-01T01:30:00', 'America/New_York', null)).toEqual({ kind: 'clarification' });
    expect(resolveLocalTime('2026-11-01T01:30:00', 'America/New_York', '-04:00')).toEqual({ kind: 'resolved', instant: '2026-11-01T05:30:00.000Z' });
    expect(resolveLocalTime('2026-11-01T01:30:00', 'America/New_York', '-05:00')).toEqual({ kind: 'resolved', instant: '2026-11-01T06:30:00.000Z' });
    expect(resolveLocalTime('2026-03-08T02:30:00', 'America/New_York', '-05:00')).toEqual({ kind: 'clarification' });
    expect(resolveLocalTime('2026-09-15T10:00:00', 'America/New_York', '+03:00')).toEqual({ kind: 'clarification' });
  });
  it('rejects quoted refusal or ambiguity even with an explicit-slot label', () => {
    for (const quote of ['Tuesday at 10 does not work.', 'Maybe Tuesday at 10?', 'Not interested, Tuesday is unavailable.']) {
      expect(validateMeetingIntent({ ...intent, agreement: { ...intent.agreement, quote } }, rules, now)).toEqual({ allowed: false, reason: 'agreement_unclear' });
    }
  });
  it('cannot relabel a fixed-slot quote as delegated choice or cancellation permission', () => {
    expect(validateMeetingIntent({ ...intent, agreement: { kind: 'delegated_choice', notBefore: intent.start, notAfter: intent.end, quote: 'Tuesday at 10 works.' } }, rules, now)).toEqual({ allowed: false, reason: 'agreement_unclear' });
    expect(validateMeetingIntent({ ...intent, operation: 'cancel', etag: '"v1"' }, rules, now)).toEqual({ allowed: false, reason: 'cancellation_not_agreed' });
  });
  it('includes buffers and treats touching intervals as non-overlapping', () => {
    expect(overlapsWithBuffers(intent, [{ start: '2026-09-15T13:40:00Z', end: '2026-09-15T13:51:00Z' }], rules)).toBe(true);
    expect(overlapsWithBuffers(intent, [{ start: '2026-09-15T14:40:00Z', end: '2026-09-15T15:00:00Z' }], rules)).toBe(false);
  });
});

describe('ordinary reply matched to exact offered slots', () => {
  const slot = { id: 'slot-one', start: '2026-09-15T18:00:00.000Z', end: '2026-09-15T18:30:00.000Z', timezone: 'America/New_York' };
  const offer = { rfcMessageId: '<offer-fiction@callie.invalid>', slots: [slot] };
  it('resolves normal Eastern-time acceptance and single-offer that works without requiring ISO tokens', () => {
    expect(matchOfferedReply('Tuesday at 2 pm Eastern works for me', ['<offer-fiction@callie.invalid>'], offer)).toEqual(['slot-one']);
    expect(matchOfferedReply('That works!', ['<offer-fiction@callie.invalid>'], offer)).toEqual(['slot-one']);
  });
  it('rejects missing reference, conflicting options, negation and substantive mixed text', () => {
    expect(matchOfferedReply('That works', [], offer)).toEqual([]);
    expect(matchOfferedReply('That works', [offer.rfcMessageId], { ...offer, slots: [slot, { ...slot, id: 'slot-two', start: '2026-09-22T18:00:00.000Z', end: '2026-09-22T18:30:00.000Z' }] })).toEqual([]);
    for (const text of ['Tuesday at 2 pm Eastern does not work', 'Tuesday at 2 pm Eastern works, what is the price?', 'Maybe Tuesday at 2 pm Eastern']) expect(matchOfferedReply(text, [offer.rfcMessageId], offer)).toEqual([]);
  });
  it('supports explicit permission to choose only among offered slots', () => {
    expect(matchOfferedReply('Any of those works, you choose.', [offer.rfcMessageId], { ...offer, slots: [slot, { ...slot, id: 'slot-two' }] })).toEqual(['slot-one', 'slot-two']);
  });
});
