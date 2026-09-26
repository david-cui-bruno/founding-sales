import { describe, expect, it } from 'vitest';
import {
  BUSINESS_DAY_RULE_VERSION,
  LocalClockError,
  addBusinessDays,
  addCalendarDays,
  isBusinessDay,
  isKnownTimeZone,
  localDate,
  localInstant,
  localParts,
  placeEmailSend,
  resolveDelay,
  startAnchoredDueAt,
  zoneOffsetMinutes,
  type WorkspaceHolidayCalendar,
} from '../../src/index.ts';

/**
 * Calendar arithmetic. Every case names its zone; none of them reads the host's.
 *
 * The daylight-saving cases are Appendix G 32, and they use the real 2026 United
 * States transitions: forward at 02:00 local on Sunday 8 March, back at 02:00 local
 * on Sunday 1 November.
 */

const NEW_YORK = 'America/New_York';
const PHOENIX = 'America/Phoenix';

describe('local clock', () => {
  it('knows a real zone from an invented one', () => {
    expect(isKnownTimeZone(NEW_YORK)).toBe(true);
    expect(isKnownTimeZone('Eastern Time')).toBe(false);
    expect(() => localParts('2026-09-19T12:00:00Z', 'Eastern Time')).toThrow(LocalClockError);
  });

  it('reads the wall clock in the named zone, not the host zone', () => {
    const parts = localParts('2026-07-04T16:30:00Z', NEW_YORK);
    expect(parts).toMatchObject({ date: '2026-07-04', hour: 12, minute: 30, weekday: 6 });
    expect(localDate('2026-07-04T16:30:00Z', PHOENIX)).toBe('2026-07-04');
    expect(localParts('2026-07-04T16:30:00Z', PHOENIX).hour).toBe(9);
  });

  it('uses the zone\'s own offset at the moment, not a fixed one', () => {
    expect(zoneOffsetMinutes(Date.parse('2026-01-15T12:00:00Z'), NEW_YORK)).toBe(-300);
    expect(zoneOffsetMinutes(Date.parse('2026-07-15T12:00:00Z'), NEW_YORK)).toBe(-240);
    // Phoenix does not observe daylight saving; both readings agree.
    expect(zoneOffsetMinutes(Date.parse('2026-01-15T12:00:00Z'), PHOENIX)).toBe(-420);
    expect(zoneOffsetMinutes(Date.parse('2026-07-15T12:00:00Z'), PHOENIX)).toBe(-420);
  });

  it('resolves a spring-forward gap to the first instant the clock allows', () => {
    // 02:30 on 8 March 2026 does not exist in America/New_York.
    const resolved = localInstant('2026-03-08', { hour: 2, minute: 30 }, NEW_YORK);
    expect(resolved).toBe('2026-03-08T07:30:00.000Z');
    // Which reads as 03:30 local: the work happens once, at the first legal moment.
    expect(localParts(resolved, NEW_YORK)).toMatchObject({ hour: 3, minute: 30, date: '2026-03-08' });
  });

  it('resolves an autumn fold to the first of the two readings, never to both', () => {
    // 01:30 on 1 November 2026 happens twice: 05:30Z on daylight time, 06:30Z on standard.
    const resolved = localInstant('2026-11-01', { hour: 1, minute: 30 }, NEW_YORK);
    expect(resolved).toBe('2026-11-01T05:30:00.000Z');
    expect(localParts(resolved, NEW_YORK)).toMatchObject({ hour: 1, minute: 30 });
    // Calling it twice gives the same instant: a fold is never two due times.
    expect(localInstant('2026-11-01', { hour: 1, minute: 30 }, NEW_YORK)).toBe(resolved);
  });

  it('moves calendar days on the calendar, not by 86 400 000 milliseconds', () => {
    expect(addCalendarDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addCalendarDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('business-day delays', () => {
  // United States federal holidays are workspace configuration, not a fact this
  // module knows. These two dates are configured by the fixture, nothing else.
  const calendar: WorkspaceHolidayCalendar = {
    version: 'callie-2026.1',
    dates: ['2026-11-26', '2026-11-27'],
  };

  it('treats weekends and configured holidays as non-business days', () => {
    expect(isBusinessDay('2026-11-25', calendar)).toBe(true);
    expect(isBusinessDay('2026-11-26', calendar)).toBe(false);
    expect(isBusinessDay('2026-11-28', calendar)).toBe(false);
    expect(isBusinessDay('2026-11-30', calendar)).toBe(true);
  });

  it('skips weekends and holidays when it counts', () => {
    // Wednesday 25 November plus one business day, with Thursday and Friday
    // configured as holidays and the weekend after, is Monday 30 November.
    expect(addBusinessDays('2026-11-25', 1, calendar)).toBe('2026-11-30');
    // Friday plus one business day is Monday.
    expect(addBusinessDays('2026-09-18', 1, calendar)).toBe('2026-09-21');
    // Zero business days from a Saturday is the following Monday, not the Saturday.
    expect(addBusinessDays('2026-09-19', 0, calendar)).toBe('2026-09-21');
    expect(addBusinessDays('2026-09-18', 0, calendar)).toBe('2026-09-18');
  });

  it('refuses a negative delay rather than moving work earlier', () => {
    expect(() => addBusinessDays('2026-09-18', -1, calendar)).toThrow(LocalClockError);
  });

  it('records the zone and the rule version beside every resolved instant', () => {
    const resolved = resolveDelay({
      from: '2026-09-18T20:00:00Z',
      delay: { unit: 'business_days', days: 3 },
      zone: NEW_YORK,
      calendar,
    });
    expect(resolved).toEqual({
      // Friday 18 September 16:00 local, plus three business days, is Wednesday the 23rd at 08:00 local.
      dueAt: '2026-09-23T12:00:00.000Z',
      sourceZone: NEW_YORK,
      ruleVersion: `${BUSINESS_DAY_RULE_VERSION}+callie-2026.1`,
      localDate: '2026-09-23',
    });
  });

  it('leaves an elapsed delay to arithmetic and does not touch the calendar', () => {
    const resolved = resolveDelay({
      from: '2026-09-18T20:00:00Z',
      delay: { unit: 'elapsed', hours: 8 },
      zone: NEW_YORK,
    });
    // Friday evening stays Friday evening; moving it is the send window's job.
    expect(resolved.dueAt).toBe('2026-09-19T04:00:00.000Z');
    expect(resolved.ruleVersion).toBe('elapsed.1');
  });

  it('counts a business-day delay across a spring-forward without losing an hour', () => {
    const resolved = resolveDelay({
      from: '2026-03-06T13:00:00Z',
      delay: { unit: 'business_days', days: 1 },
      zone: NEW_YORK,
    });
    // Friday 6 March plus one business day is Monday 9 March at 08:00 EDT = 12:00Z,
    // not 13:00Z, because the clock moved forward over the weekend.
    expect(resolved.dueAt).toBe('2026-03-09T12:00:00.000Z');
    expect(resolved.localDate).toBe('2026-03-09');
  });

  it('anchors a step\'s delay on the enrollment\'s start', () => {
    expect(startAnchoredDueAt('2026-09-19T12:00:00.000Z', 72)).toBe('2026-09-22T12:00:00.000Z');
    expect(() => startAnchoredDueAt('never', 1)).toThrow(LocalClockError);
  });
});

describe('the email sending window', () => {
  const calendar: WorkspaceHolidayCalendar = { version: 'callie-2026.1', dates: ['2026-11-26'] };

  it('leaves a due instant that is already inside the window where it is', () => {
    // Wednesday 09:30 local.
    const placed = placeEmailSend('2026-09-16T13:30:00Z', NEW_YORK);
    expect(placed).toMatchObject({ sendAt: '2026-09-16T13:30:00.000Z', band: 'morning', inPlace: true });
  });

  it('calls the afternoon overflow rather than morning', () => {
    const placed = placeEmailSend('2026-09-16T18:00:00Z', NEW_YORK);
    expect(placed).toMatchObject({ band: 'overflow', inPlace: true, localDate: '2026-09-16' });
  });

  it('sends a Monday-due email on Monday morning, not Tuesday', () => {
    // Monday 21 September, 02:00 local: before the window, on a sending day.
    const placed = placeEmailSend('2026-09-21T06:00:00Z', NEW_YORK);
    expect(placed.localDate).toBe('2026-09-21');
    expect(placed.band).toBe('morning');
    expect(localParts(placed.sendAt, NEW_YORK)).toMatchObject({ hour: 8, minute: 0, weekday: 1 });
  });

  it('moves weekend-due work to Monday morning', () => {
    for (const dueAt of ['2026-09-19T14:00:00Z', '2026-09-20T14:00:00Z']) {
      const placed = placeEmailSend(dueAt, NEW_YORK);
      expect(placed.localDate, dueAt).toBe('2026-09-21');
      expect(localParts(placed.sendAt, NEW_YORK).hour, dueAt).toBe(8);
    }
  });

  it('moves work due after the window to the next morning', () => {
    // Wednesday 18:00 local is past 17:00.
    const placed = placeEmailSend('2026-09-16T22:00:00Z', NEW_YORK);
    expect(placed.localDate).toBe('2026-09-17');
    expect(placed.inPlace).toBe(false);
  });

  it('skips a configured holiday the way it skips a weekend', () => {
    const placed = placeEmailSend('2026-11-26T14:00:00Z', NEW_YORK, { calendar });
    expect(placed.localDate).toBe('2026-11-27');
  });

  it('resolves the spring-forward Sunday into Monday 08:00 local', () => {
    const placed = placeEmailSend('2026-03-08T07:30:00Z', NEW_YORK);
    expect(placed.localDate).toBe('2026-03-09');
    expect(placed.sendAt).toBe('2026-03-09T12:00:00.000Z');
  });
});
