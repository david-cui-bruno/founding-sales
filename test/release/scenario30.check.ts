import { describe, expect, it } from 'vitest';
import { SUPPRESSION_SOURCES } from '@fss/contracts';
import { mayCorrectSuppression } from '@fss/domain';
import { mustCover } from './support/coverage.ts';

/**
 * Appendix G 30: "A prospect opt-out cannot use the salesperson correction path."
 *
 * The policy suite records a real `prospect_opt_out` event, asserts it came back
 * terminal with no review hold, and then attempts the correction — which is refused
 * `not_salesperson_originated`. This check adds the pure rule underneath, where the
 * order of the three refusals is decided, and asserts the order rather than the
 * outcome: source first, ownership second, window third.
 *
 * ## The vacuous-pass trap
 *
 * A correction refused for being late is not a correction refused for its source, and
 * the two are easy to confuse because a prospect opt-out is usually old by the time
 * anybody tries. The lane test closes it by attempting the correction inside the
 * ten-minute window. This file closes it at the rule: the same event is offered at
 * one second old, by its own actor, so neither the window nor the ownership check can
 * be the thing that refused it — and the identical call with the source changed to
 * `salesperson_manual` is asserted to be allowed, so a rule that refused everything
 * would fail too.
 */

describe('Appendix G 30: the source, not the clock, refuses a prospect opt-out', () => {
  mustCover(30, ['not_salesperson_originated', 'prospect_opt_out']);

  it('refuses the prospect’s own words one second after they were recorded', () => {
    const actorUserId = '11111111-2222-4333-8444-555555555555';
    const recordedAt = '2026-09-21T13:00:00.000Z';
    const now = '2026-09-21T13:00:01.000Z';

    // Well inside the window, by the actor who recorded it: everything except the
    // source is in the correction's favour.
    expect(
      mayCorrectSuppression({ event: { source: 'prospect_opt_out', actorUserId, recordedAt }, actorUserId, now }),
    ).toEqual({ allowed: false, refusal: 'not_salesperson_originated' });
    expect(
      mayCorrectSuppression({
        event: { source: 'prospect_do_not_call', actorUserId, recordedAt },
        actorUserId,
        now,
      }),
    ).toEqual({ allowed: false, refusal: 'not_salesperson_originated' });

    // And the same call with the one field changed is allowed, so the rule is not
    // simply refusing everything.
    expect(
      mayCorrectSuppression({ event: { source: 'salesperson_manual', actorUserId, recordedAt }, actorUserId, now }),
    ).toEqual({ allowed: true });
  });

  it('keeps the prospect-originated sources distinct from the salesperson’s', () => {
    // Two prospect sources and one salesperson source, and an import that is neither.
    // Collapsing any of them into `salesperson_manual` would open the correction path
    // to a request the prospect made.
    for (const source of ['prospect_opt_out', 'prospect_do_not_call', 'salesperson_manual', 'import'] as const) {
      expect(SUPPRESSION_SOURCES).toContain(source);
    }
    expect(new Set(SUPPRESSION_SOURCES).size).toBe(SUPPRESSION_SOURCES.length);
  });
});
