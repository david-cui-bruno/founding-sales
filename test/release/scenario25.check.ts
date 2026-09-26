import { describe, expect, it } from 'vitest';
import { postureReviewAt, selectApplicablePosture } from '@fss/domain';

/**
 * Appendix G 25: "Policy versions with zero, one and two applicable rows fail, allow and
 * fail respectively."
 *
 * 9.2's sixth check: "exactly one applicable state posture whose effective range contains
 * database time and whose review date has not passed". The database enforces it with an
 * exclusion constraint; `selectApplicablePosture` is the same rule as a pure function,
 * and this is where all four outcomes are asserted beside one another.
 *
 * ## The vacuous-pass trap
 *
 * A suite that tested zero and one would let "two applicable rows" quietly allow, and two
 * rows is the dangerous case: it is the one where the software has a posture to point at
 * and picks the wrong one. Equally, a rule that refused everything would pass a suite made
 * only of refusals.
 *
 * Closed by asserting all four outcomes with the same function at the same instant. The
 * middle case must *allow*, so a rule that always refused fails here, and the two-row case
 * must refuse with `posture_overlapping` rather than with any refusal at all.
 */

const STATE = 'NY';
const NOW = '2026-09-20T15:00:00.000Z';

type Posture = Parameters<typeof selectApplicablePosture>[0][number];

function posture(overrides: Partial<Posture> = {}): Posture {
  return {
    state: STATE,
    revision: 1,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    reviewAt: postureReviewAt(NOW),
    revokedAt: null,
    ...overrides,
  } as Posture;
}

describe('Appendix G 25: zero, one and two applicable postures', () => {
  it('zero applicable rows refuses', () => {
    expect(selectApplicablePosture([], STATE, NOW)).toEqual({ kind: 'refused', reason: 'posture_missing' });
  });

  it('one applicable row allows, so the rule is not simply always refusing', () => {
    expect(selectApplicablePosture([posture()], STATE, NOW).kind).toBe('applies');
  });

  it('two applicable rows refuse, naming the overlap rather than the absence', () => {
    expect(selectApplicablePosture([posture(), posture({ revision: 2 })], STATE, NOW)).toEqual({
      kind: 'refused',
      reason: 'posture_overlapping',
    });
  });

  it('one applicable row whose review date has passed refuses as overdue', () => {
    // 9.2 makes the review date part of "applicable" rather than a warning. A posture
    // nobody has looked at for a year is not one the software may act on.
    expect(selectApplicablePosture([posture({ reviewAt: '2026-09-19T00:00:00.000Z' })], STATE, NOW)).toEqual({
      kind: 'refused',
      reason: 'posture_overdue',
    });
  });

  it('a revoked row is not applicable, so revocation is not a fourth outcome', () => {
    expect(
      selectApplicablePosture([posture({ revokedAt: '2026-09-01T00:00:00.000Z' })], STATE, NOW),
    ).toEqual({ kind: 'refused', reason: 'posture_missing' });
  });
});
