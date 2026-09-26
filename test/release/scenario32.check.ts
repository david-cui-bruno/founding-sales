import { describe, expect, it } from 'vitest';
import { EMAIL_WINDOW, EMAIL_WINDOW_WEEKDAYS, localParts, placeEmailSend } from '@fss/domain';

/**
 * Appendix G 32: "Monday-due email sends Monday morning; weekend due work moves to
 * Monday; DST gap and fold resolve deterministically."
 *
 * 11.2: "Email may send only Monday-Friday from 08:00 through 17:00 in the firm's actual
 * IANA zone. The scheduler prefers 08:00-12:00 ... A Monday-due email sends Monday
 * morning rather than waiting for Tuesday."
 *
 * ## The vacuous-pass trap
 *
 * This is the scenario that already had the bug. G7-2's suite searched for a live sending
 * window and returned early when it found none, so on a Sunday sixteen of seventeen tests
 * reported green while testing nothing (COMMON-G, 20 September). Anything here that read
 * the wall clock would do the same on the same day of the week.
 *
 * Closed by making every instant a literal, so there is no branch that can return early,
 * and by keeping a positive control: mail already inside a window must stay where it is,
 * which a rule that moved everything to next Monday would fail.
 */

const NEW_YORK = 'America/New_York';

describe('Appendix G 32: Monday mornings, weekends and DST', () => {
  it('places Monday-due mail on Monday morning, not on Tuesday', () => {
    // Monday 21 September 2026, 02:00 New York: due, and before the window opens.
    const placement = placeEmailSend('2026-09-21T06:00:00.000Z', NEW_YORK);
    const local = localParts(placement.sendAt, NEW_YORK);
    expect(local.date).toBe('2026-09-21');
    expect(local.weekday).toBe(1);
    expect(local.minuteOfDay).toBe(EMAIL_WINDOW.openMinute);
    expect(placement.band).toBe('morning');
  });

  it('moves weekend work to Monday rather than sending it on Saturday', () => {
    // Saturday 19 September 2026, 10:00 New York.
    const placement = placeEmailSend('2026-09-19T14:00:00.000Z', NEW_YORK);
    const local = localParts(placement.sendAt, NEW_YORK);
    expect(local.date).toBe('2026-09-21');
    expect(EMAIL_WINDOW_WEEKDAYS).toContain(local.weekday);
    expect(placement.inPlace).toBe(false);
  });

  it('keeps mail that is already inside the window exactly where it is', () => {
    // The positive control. Without it, a rule that moved everything to next Monday
    // would pass the two tests above.
    const placement = placeEmailSend('2026-09-21T13:30:00.000Z', NEW_YORK);
    expect(placement.inPlace).toBe(true);
    expect(placement.sendAt).toBe('2026-09-21T13:30:00.000Z');
    expect(localParts(placement.sendAt, NEW_YORK).date).toBe('2026-09-21');
  });

  it('resolves the spring gap deterministically and inside the window', () => {
    // 08 March 2026 is the spring transition in New York; 02:00-03:00 local does not
    // exist. Whatever the arithmetic does with it, the answer must be the same every
    // time and must land inside a real sending window.
    const first = placeEmailSend('2026-03-08T07:30:00.000Z', NEW_YORK);
    const second = placeEmailSend('2026-03-08T07:30:00.000Z', NEW_YORK);
    expect(first.sendAt).toBe(second.sendAt);
    const local = localParts(first.sendAt, NEW_YORK);
    expect(EMAIL_WINDOW_WEEKDAYS).toContain(local.weekday);
    expect(local.minuteOfDay).toBeGreaterThanOrEqual(EMAIL_WINDOW.openMinute);
    expect(local.minuteOfDay).toBeLessThan(EMAIL_WINDOW.closeMinute);
  });

  it('resolves the autumn fold deterministically and inside the window', () => {
    // 01 November 2026 is the autumn transition; 01:00-02:00 local happens twice. Both
    // instants are a Sunday, so both move to Monday morning, and neither may land
    // outside the window because the offset changed under it.
    for (const instant of ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']) {
      const placement = placeEmailSend(instant, NEW_YORK);
      const local = localParts(placement.sendAt, NEW_YORK);
      expect(local.weekday).toBe(1);
      expect(local.minuteOfDay).toBeGreaterThanOrEqual(EMAIL_WINDOW.openMinute);
      expect(local.minuteOfDay).toBeLessThan(EMAIL_WINDOW.closeMinute);
    }
  });
});
