import { describe, expect, it } from 'vitest';
import {
  LONG_HOLD_REVIEW_DAYS,
  LONG_HOLD_REVIEW_MILLISECONDS,
  composeHolds,
  decideResume,
  mergeIntervals,
  shiftDueInstant,
  shiftSchedule,
  unionDuration,
  type HoldRecord,
  type Interval,
} from '../../src/index.ts';

/**
 * Hold composition (specification 4.3, Appendix G 28 and 31).
 *
 * The property tests use a small deterministic pseudo-random generator rather than a
 * library, so a failure is reproducible from the seed printed in the message.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const START = Date.parse('2026-09-01T00:00:00.000Z');
const at = (offsetHours: number): string => new Date(START + offsetHours * HOUR).toISOString();

function hold(id: string, fromHour: number, toHour: number | null, overrides: Partial<HoldRecord> = {}): HoldRecord {
  return {
    id,
    reasonCode: 'uncertain_reply',
    blockedActionKinds: ['email_send'],
    startedAt: at(fromHour),
    releasedAt: toHour === null ? null : at(toHour),
    ...overrides,
  };
}

/** A 32-bit xorshift, so a property failure can be replayed from its seed. */
function randoms(seed: number): () => number {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return Math.abs(state) / 2 ** 31;
  };
}

describe('interval union', () => {
  it('merges overlapping and touching intervals and drops empty ones', () => {
    expect(
      mergeIntervals([
        { start: 0, end: 10 },
        { start: 5, end: 12 },
        { start: 12, end: 20 },
        { start: 30, end: 30 },
        { start: 40, end: 45 },
      ]),
    ).toEqual([
      { start: 0, end: 20 },
      { start: 40, end: 45 },
    ]);
  });

  it('counts two overlapping day-long holds as one day, not two', () => {
    const composition = composeHolds({
      holds: [hold('a', 0, 24), hold('b', 12, 36)],
      now: at(48),
    });
    expect(composition.unionMilliseconds).toBe(36 * HOUR);
    expect(composition.blocked).toBe(false);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('is order-independent and never exceeds the sum (seed %i)', seed => {
    const next = randoms(seed * 7919);
    for (let round = 0; round < 40; round += 1) {
      const intervals: Interval[] = Array.from({ length: 1 + Math.floor(next() * 6) }, () => {
        const start = Math.floor(next() * 1000);
        return { start, end: start + Math.floor(next() * 400) };
      });
      const union = unionDuration(intervals);
      const sum = intervals.reduce((total, interval) => total + Math.max(interval.end - interval.start, 0), 0);
      const longest = intervals.reduce((most, interval) => Math.max(most, interval.end - interval.start), 0);

      expect(union, `seed ${String(seed)} round ${String(round)}: union above sum`).toBeLessThanOrEqual(sum);
      expect(union, `seed ${String(seed)} round ${String(round)}: union below longest`).toBeGreaterThanOrEqual(longest);
      expect(unionDuration([...intervals].reverse()), `seed ${String(seed)}: order changed the union`).toBe(union);
      // Adding an interval already contained in another changes nothing.
      const contained = intervals[0];
      if (contained !== undefined && contained.end > contained.start) {
        const inside = { start: contained.start, end: contained.start + 1 };
        expect(unionDuration([...intervals, inside]), `seed ${String(seed)}: contained interval changed the union`).toBe(union);
      }
    }
  });
});

describe('composing the holds that apply to a piece of work', () => {
  it('is blocked while any hold is open and lists every blocked action kind', () => {
    const composition = composeHolds({
      holds: [
        hold('a', 0, 4),
        hold('b', 2, null, { reasonCode: 'mailbox_disconnected', blockedActionKinds: ['email_send', 'enrollment_advance'] }),
      ],
      now: at(6),
    });
    expect(composition.blocked).toBe(true);
    expect(composition.openHoldIds).toEqual(['b']);
    expect(composition.blockedActionKinds).toEqual(['email_send', 'enrollment_advance']);
    expect(composition.openReasonCodes).toEqual(['mailbox_disconnected']);
    expect(composition.recoverableReasonCodes).toEqual(['mailbox_disconnected']);
  });

  it('applies only the holds that block the action kind being asked about', () => {
    const holds = [
      hold('email', 0, null, { blockedActionKinds: ['email_send'] }),
      hold('dial', 0, null, { blockedActionKinds: ['dial_authorization'] }),
    ];
    expect(composeHolds({ holds, now: at(1), actionKinds: ['dial_authorization'] }).openHoldIds).toEqual(['dial']);
    // No action kind named means every hold applies, not none.
    expect(composeHolds({ holds, now: at(1), actionKinds: [] }).openHoldIds).toEqual(['dial', 'email']);
  });

  it('never lists an unrecoverable reason as something a control may clear', () => {
    const composition = composeHolds({
      holds: [hold('s', 0, null, { reasonCode: 'firm_suppressed' }), hold('u', 0, null)],
      now: at(1),
    });
    expect(composition.openReasonCodes).toEqual(['firm_suppressed', 'uncertain_reply']);
    expect(composition.recoverableReasonCodes).toEqual(['uncertain_reply']);
  });
});

describe('resuming after the holds clear', () => {
  it('stays held while any hold is open, in both clearing orders', () => {
    // Appendix G 28: two overlapping holds clear in both orders and automation
    // remains blocked until both clear; the shift counts only the union.
    const both = [hold('a', 0, null), hold('b', 6, null)];
    expect(decideResume(composeHolds({ holds: both, now: at(12) })).kind).toBe('still_held');

    const aFirst = [hold('a', 0, 8), hold('b', 6, null)];
    const bFirst = [hold('a', 0, null), hold('b', 6, 10)];
    expect(decideResume(composeHolds({ holds: aFirst, now: at(12) })).kind).toBe('still_held');
    expect(decideResume(composeHolds({ holds: bFirst, now: at(12) })).kind).toBe('still_held');

    const cleared = [hold('a', 0, 8), hold('b', 6, 10)];
    expect(decideResume(composeHolds({ holds: cleared, now: at(12) }))).toEqual({
      kind: 'resume',
      shiftMilliseconds: 10 * HOUR,
    });
    // The other clearing order produces the same shift.
    expect(decideResume(composeHolds({ holds: [...cleared].reverse(), now: at(12) }))).toEqual({
      kind: 'resume',
      shiftMilliseconds: 10 * HOUR,
    });
  });

  it('requires review when the union exceeds seven days and resumes when it does not', () => {
    const short = [hold('a', 0, 7 * 24)];
    expect(decideResume(composeHolds({ holds: short, now: at(200) }))).toEqual({
      kind: 'resume',
      shiftMilliseconds: LONG_HOLD_REVIEW_MILLISECONDS,
    });

    const long = [hold('a', 0, 7 * 24 + 1)];
    expect(decideResume(composeHolds({ holds: long, now: at(300) }))).toEqual({
      kind: 'review_required',
      unionMilliseconds: LONG_HOLD_REVIEW_MILLISECONDS + HOUR,
      reviewDays: LONG_HOLD_REVIEW_DAYS,
    });
  });

  it('does not let two overlapping holds add up to a review that neither earned', () => {
    // Two five-day holds that ran side by side delayed the work by six days, not ten.
    const composition = composeHolds({ holds: [hold('a', 0, 120), hold('b', 24, 144)], now: at(200) });
    expect(composition.unionMilliseconds).toBe(6 * DAY);
    expect(composition.requiresReview).toBe(false);
  });
});

describe('shifting the schedule', () => {
  it('moves unexecuted work and leaves executed history alone', () => {
    const shifted = shiftSchedule(
      [
        { id: 'one', dueAt: '2026-09-01T12:00:00.000Z', executed: true },
        { id: 'two', dueAt: '2026-09-04T12:00:00.000Z', executed: false },
      ],
      2 * DAY,
    );
    expect(shifted).toEqual([
      { id: 'one', dueAt: '2026-09-01T12:00:00.000Z', shifted: false },
      { id: 'two', dueAt: '2026-09-06T12:00:00.000Z', shifted: true },
    ]);
  });

  it('refuses to move work earlier', () => {
    expect(() => shiftDueInstant('2026-09-01T12:00:00.000Z', -1)).toThrow(RangeError);
  });

  it('is a no-op when nothing was ever held', () => {
    const composition = composeHolds({ holds: [], now: at(1) });
    expect(decideResume(composition)).toEqual({ kind: 'resume', shiftMilliseconds: 0 });
    expect(shiftDueInstant('2026-09-01T12:00:00.000Z', 0)).toBe('2026-09-01T12:00:00.000Z');
  });
});
