import { describe, expect, it } from 'vitest';
import { LONG_HOLD_REVIEW_MILLISECONDS, composeHolds, decideResume } from '@fss/domain';

/**
 * Appendix G 31: "Long hold of more than seven days never resumes without review; a
 * seven-day-or-shorter hold shifts and resumes after fresh eligibility."
 *
 * 4.3: "If the union exceeds seven calendar days, the enrollment remains held for
 * salesperson review and explicit resume."
 *
 * ## The vacuous-pass trap
 *
 * Testing only the long case cannot show that the short case still resumes, and a rule
 * that demanded review for everything would pass it while stopping the product working.
 * A boundary tested only well inside each side never shows where the boundary is, so
 * "more than seven days" and "seven days or more" would be indistinguishable.
 *
 * Closed by asserting both sides and the boundary instant itself.
 */

const START = '2026-09-01T00:00:00.000Z';

function unionOf(milliseconds: number) {
  const end = new Date(Date.parse(START) + milliseconds).toISOString();
  return composeHolds({
    holds: [
      {
        id: 'hold-1',
        reasonCode: 'scoped_pause',
        blockedActionKinds: ['email_send'],
        startedAt: START,
        releasedAt: end,
      },
    ],
    now: end,
  });
}

describe('Appendix G 31: the seven-day review boundary', () => {
  it('a hold shorter than seven days shifts and resumes', () => {
    const composition = unionOf(LONG_HOLD_REVIEW_MILLISECONDS - 1000);
    expect(composition.blocked).toBe(false);
    expect(composition.requiresReview).toBe(false);
    expect(decideResume(composition)).toEqual({
      kind: 'resume',
      shiftMilliseconds: composition.unionMilliseconds,
    });
  });

  it('a hold of exactly seven days still resumes, because the rule says "exceeds"', () => {
    const composition = unionOf(LONG_HOLD_REVIEW_MILLISECONDS);
    expect(composition.requiresReview).toBe(false);
    expect(decideResume(composition).kind).toBe('resume');
  });

  it('a hold longer than seven days needs review and never resumes on its own', () => {
    const composition = unionOf(LONG_HOLD_REVIEW_MILLISECONDS + 1000);
    expect(composition.requiresReview).toBe(true);
    const decision = decideResume(composition);
    expect(decision.kind).toBe('review_required');
    expect(decision).toMatchObject({ reviewDays: 7 });
  });

  it('an open hold is still held rather than reviewed, so the two answers are distinct', () => {
    const composition = composeHolds({
      holds: [
        {
          id: 'hold-2',
          reasonCode: 'scoped_pause',
          blockedActionKinds: ['email_send'],
          startedAt: START,
          releasedAt: null,
        },
      ],
      now: new Date(Date.parse(START) + LONG_HOLD_REVIEW_MILLISECONDS * 2).toISOString(),
    });
    expect(decideResume(composition).kind).toBe('still_held');
  });
});
