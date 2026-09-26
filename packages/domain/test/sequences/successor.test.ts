import { describe, expect, it } from 'vitest';
import { EMPTY_HOLIDAY_CALENDAR, type WorkspaceHolidayCalendar } from '../../src/rules/businessDays.ts';
import { type SequenceStep } from '../../src/rules/cadence.ts';
import { COMPLETION_ANCHOR_RULE_SUFFIX, businessDaysAfter, successorDue } from '../../sequences/successor.ts';

/**
 * The successor's anchor (specification 11.2, 12.5, Appendix B; lane g82, audit C11).
 *
 * The plan is start-anchored — "N business days after enrollment" — and stays the
 * answer while steps run on time. A step that ran late keeps the plan's spacing from
 * the instant it actually happened, which for an email is the original dispatch time.
 *
 * Every instant is New York: EDT, UTC-4, for all of September 2026. Monday 21
 * September 2026 09:00 New York is 13:00Z; 08:00 on a business day is 12:00Z.
 */

const ZONE = 'America/New_York';
const MONDAY_START = '2026-09-21T13:00:00.000Z';

function step(ordinal: number, delay: SequenceStep['delay']): SequenceStep {
  return { id: `step-${String(ordinal)}`, ordinal, channel: ordinal === 1 ? 'email' : 'call_task', delay };
}

const EMAIL_NOW = step(1, { unit: 'elapsed', hours: 0 });
const CALL_IN_TWO = step(2, { unit: 'business_days', days: 2 });

function due(
  previous: SequenceStep | undefined,
  next: SequenceStep,
  completedAt: string,
  options: { readonly startedAt?: string; readonly calendar?: WorkspaceHolidayCalendar } = {},
) {
  return successorDue({
    previous,
    next,
    startedAt: options.startedAt ?? MONDAY_START,
    zone: ZONE,
    calendar: options.calendar ?? EMPTY_HOLIDAY_CALENDAR,
    completedAt,
  });
}

describe('the successor is the plan while the previous step ran on time', () => {
  it('an email sent five minutes after its plan leaves the call two business days after enrollment', () => {
    const answer = due(EMAIL_NOW, CALL_IN_TWO, '2026-09-21T13:05:00.000Z');
    expect(answer.anchor).toBe('plan');
    expect(answer.dueAt).toBe('2026-09-23T12:00:00.000Z');
    expect(answer.ruleVersion.endsWith(COMPLETION_ANCHOR_RULE_SUFFIX)).toBe(false);
  });

  it('an enrollment begun on a Saturday does not count the weekend twice when the window moved the email to Monday', () => {
    // The plan: email Saturday (the window sends it Monday 08:00), call two business
    // days after enrollment — Wednesday. The email going Monday is not lateness.
    const answer = due(EMAIL_NOW, CALL_IN_TWO, '2026-09-21T12:00:00.000Z', { startedAt: '2026-09-19T14:00:00.000Z' });
    expect(answer.anchor).toBe('plan');
    expect(answer.dueAt).toBe('2026-09-23T12:00:00.000Z');
  });

  it('a first step has no predecessor and is the plan', () => {
    expect(due(undefined, EMAIL_NOW, '2026-09-30T13:00:00.000Z').dueAt).toBe(MONDAY_START);
  });
});

describe('a late step keeps the spacing from the instant it happened (C11)', () => {
  it('an email that went Thursday is followed by the call two business days later, not the same hour', () => {
    const answer = due(EMAIL_NOW, CALL_IN_TWO, '2026-09-24T14:00:00.000Z');
    expect(answer.anchor).toBe('completion');
    // Thursday, then Friday and Monday: Monday 28 September, 08:00 New York.
    expect(answer.dueAt).toBe('2026-09-28T12:00:00.000Z');
    expect(answer.ruleVersion).toBe(`business-day.1+none.1${COMPLETION_ANCHOR_RULE_SUFFIX}`);
  });

  it('skips a workspace holiday in the gap, as the plan would have', () => {
    const answer = due(EMAIL_NOW, CALL_IN_TWO, '2026-09-24T14:00:00.000Z', {
      calendar: { version: 'test.1', dates: ['2026-09-25'] },
    });
    // Friday is a holiday: Monday is the first business day after Thursday, Tuesday the second.
    expect(answer.dueAt).toBe('2026-09-29T12:00:00.000Z');
  });

  it('counts the business days the plan leaves between two business-day steps', () => {
    const second = step(2, { unit: 'business_days', days: 2 });
    const third = step(3, { unit: 'business_days', days: 4 });
    // Planned Wednesday and Friday: two business days apart. Done Thursday, so Monday.
    const answer = due(second, third, '2026-09-24T14:00:00.000Z');
    expect(answer.dueAt).toBe('2026-09-28T12:00:00.000Z');
  });

  it('an elapsed gap is the planned interval, counted from the completion', () => {
    const later = step(2, { unit: 'elapsed', hours: 72 });
    const answer = due(EMAIL_NOW, later, '2026-09-23T13:00:00.000Z');
    expect(answer.anchor).toBe('completion');
    expect(answer.dueAt).toBe('2026-09-26T13:00:00.000Z');
  });
});

describe('businessDaysAfter', () => {
  it('counts the business days in (from, to]', () => {
    expect(businessDaysAfter('2026-09-21', '2026-09-23', EMPTY_HOLIDAY_CALENDAR)).toBe(2);
    expect(businessDaysAfter('2026-09-25', '2026-09-28', EMPTY_HOLIDAY_CALENDAR)).toBe(1);
    expect(businessDaysAfter('2026-09-23', '2026-09-23', EMPTY_HOLIDAY_CALENDAR)).toBe(0);
    expect(businessDaysAfter('2026-09-23', '2026-09-21', EMPTY_HOLIDAY_CALENDAR)).toBe(0);
  });
});
