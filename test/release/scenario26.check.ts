import { describe, expect, it } from 'vitest';
import { callOutcomeEffects } from '@fss/domain/dial';
import { SEQUENCE_STOP_CONDITIONS } from '@fss/domain/sequences';
import { mustCover } from './support/coverage.ts';

/**
 * Appendix G 26: "An engaged call outcome after handoff prevents every successor."
 *
 * The policy suite logs `interested` against a real opportunity and asserts the
 * control mode moved to manual and the `opportunity.manual_mode` event was emitted;
 * the sequences suite consumes that event and asserts the enrollments stop. The join
 * between the two is an outbox row, so neither suite alone shows the rule that
 * decides whether there is anything to emit. That rule is a pure table, and this
 * check reads it.
 *
 * ## The vacuous-pass trap
 *
 * An enrollment with no remaining steps has no successor to prevent, so the whole
 * scenario can be satisfied by a fixture that had run out of work anyway. The lane
 * test closes it by asserting unexecuted steps existed before the outcome was
 * recorded. The trap here is the opposite over-reach: a rule that set every call
 * outcome to manual would "prevent every successor" for `no_answer` too, quietly
 * ending sequences that should have carried on. Closed by asserting the engaged
 * outcomes set manual and the unengaged ones do not, from the same table.
 */

describe('Appendix G 26: an engaged outcome, and only an engaged outcome, ends the plan', () => {
  mustCover(26, ['scenario 26', 'complete_and_advance', 'opportunity.manual_mode']);

  it('sets manual for the engaged outcomes and leaves the rest alone', () => {
    for (const outcome of ['interested', 'referral_or_wrong_person', 'callback_requested', 'not_interested'] as const) {
      expect(callOutcomeEffects(outcome).setsManual, `${outcome} should set manual`).toBe(true);
    }
    // A voicemail and a missed call are not engagement. If these set manual, an
    // ordinary unanswered cadence would end itself on the first attempt.
    for (const outcome of ['voicemail_left', 'no_answer', 'busy', 'wrong_number'] as const) {
      expect(callOutcomeEffects(outcome).setsManual, `${outcome} should not set manual`).toBe(false);
    }
    expect(SEQUENCE_STOP_CONDITIONS).toContain('engaged_call');
  });

  it('cannot be turned back into a retry by the step’s configuration', () => {
    // `retryBehaviour` exists for exactly the two outcomes 9.1 gives it to. Passing
    // it for an engaged outcome changes nothing, so a step configured to retry
    // cannot resurrect a cadence the prospect has just ended.
    expect(callOutcomeEffects('interested', 'retry_call').stepEffect).toBe('complete_and_advance');
    expect(callOutcomeEffects('interested', 'retry_call').setsManual).toBe(true);
    // And the two it does apply to still honour it.
    expect(callOutcomeEffects('no_answer', 'retry_call').stepEffect).toBe('retry_call');
    expect(callOutcomeEffects('no_answer', 'advance').stepEffect).toBe('advance');
  });
});
