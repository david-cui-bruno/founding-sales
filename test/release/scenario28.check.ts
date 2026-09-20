import { describe, expect, it } from 'vitest';
import { LONG_HOLD_REVIEW_DAYS, composeHolds, decideResume, unionDuration } from '@fss/domain';
import { mustCover } from './support/coverage.ts';

/**
 * Appendix G 28: "Two overlapping holds clear in both orders; automation remains blocked
 * until both clear and schedule shift counts only the union."
 *
 * 4.3: "When the final applicable hold clears, unfinished due times shift by the union of
 * all blocking intervals, so overlapping holds are not double-counted."
 *
 * ## The vacuous-pass trap
 *
 * Two intervals that do not overlap have a union equal to their sum, so a shift that
 * added durations would pass every test written with tidy consecutive holds. This is the
 * single easiest way for this scenario to be green and wrong, and the consequence is a
 * prospect contacted days later than the cadence intended.
 *
 * Closed by using intervals that genuinely overlap and asserting the union is *strictly
 * less* than the sum, and by presenting the holds in both orders and requiring the same
 * answer.
 */

const HOUR = 60 * 60 * 1000;
const FIRST = { start: '2026-09-14T09:00:00.000Z', end: '2026-09-14T12:00:00.000Z' };
const SECOND = { start: '2026-09-14T11:00:00.000Z', end: '2026-09-14T14:00:00.000Z' };

function hold(
  id: string,
  reasonCode: 'uncertain_reply' | 'scoped_pause',
  interval: { start: string; end: string },
  released: boolean,
) {
  return {
    id,
    reasonCode,
    blockedActionKinds: ['email_send'] as const,
    startedAt: interval.start,
    releasedAt: released ? interval.end : null,
  };
}

describe('Appendix G 28: two overlapping holds, in both orders', () => {
  mustCover(28, ['unionMilliseconds', 'composeHolds', 'decideResume']);

  it('counts the union, which is strictly less than the sum', () => {
    const union = unionDuration([
      { start: Date.parse(FIRST.start), end: Date.parse(FIRST.end) },
      { start: Date.parse(SECOND.start), end: Date.parse(SECOND.end) },
    ]);
    expect(union).toBe(5 * HOUR);
    expect(union).toBeLessThan(3 * HOUR + 3 * HOUR);
  });

  it('gives the same union whichever order the intervals arrive in', () => {
    const a = { start: Date.parse(FIRST.start), end: Date.parse(FIRST.end) };
    const b = { start: Date.parse(SECOND.start), end: Date.parse(SECOND.end) };
    expect(unionDuration([a, b])).toBe(unionDuration([b, a]));
  });

  it('stays blocked while either hold is open, in both clearing orders', () => {
    const now = SECOND.end;
    const bothOpen = composeHolds({
      holds: [hold('a', 'uncertain_reply', FIRST, false), hold('b', 'scoped_pause', SECOND, false)],
      now,
    });
    const firstCleared = composeHolds({
      holds: [hold('a', 'uncertain_reply', FIRST, true), hold('b', 'scoped_pause', SECOND, false)],
      now,
    });
    const secondCleared = composeHolds({
      holds: [hold('a', 'uncertain_reply', FIRST, false), hold('b', 'scoped_pause', SECOND, true)],
      now,
    });
    expect(bothOpen.blocked).toBe(true);
    expect(firstCleared.blocked).toBe(true);
    expect(secondCleared.blocked).toBe(true);
  });

  it('shifts by the union once both have cleared, in either order', () => {
    const now = SECOND.end;
    const forwards = composeHolds({
      holds: [hold('a', 'uncertain_reply', FIRST, true), hold('b', 'scoped_pause', SECOND, true)],
      now,
    });
    const backwards = composeHolds({
      holds: [hold('b', 'scoped_pause', SECOND, true), hold('a', 'uncertain_reply', FIRST, true)],
      now,
    });
    expect(forwards.blocked).toBe(false);
    expect(forwards.unionMilliseconds).toBe(5 * HOUR);
    expect(backwards.unionMilliseconds).toBe(forwards.unionMilliseconds);
    expect(decideResume(forwards)).toEqual({ kind: 'resume', shiftMilliseconds: 5 * HOUR });
    expect(LONG_HOLD_REVIEW_DAYS).toBe(7);
  });
});
