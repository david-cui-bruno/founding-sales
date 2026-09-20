import { describe, expect, it } from 'vitest';
import {
  ENROLLMENT_END_REASONS,
  SEQUENCE_STOP_CONDITIONS,
  STEP_EXECUTION_STATES,
} from '@fss/domain/sequences';
import { mustCover } from './support/coverage.ts';

/**
 * Appendix G 18: "A LinkedIn reply after handoff and before the next email stops the
 * opportunity through the recorded-reply path."
 *
 * The sequences suite records the reply on a live enrollment and asserts three
 * things at once: the enrollment is `stopped`, its end reason is `linkedin_reply`,
 * and every remaining step execution is `cancelled`. This check adds the vocabulary
 * behind those three words — a LinkedIn reply is a stop condition in its own right,
 * not an email reply wearing a different label, and "cancelled" is a state a step can
 * actually be in.
 *
 * ## The vacuous-pass trap
 *
 * If no successor was ever scheduled, nothing needed stopping and the assertion that
 * every execution is cancelled is true of the empty set. The lane test closes it by
 * enrolling properly first and asserting the successor existed. The trap this file
 * closes is subtler and more likely: `linkedin_reply` quietly folded into
 * `human_reply` because "a reply is a reply". The two are reported differently to the
 * salesperson and counted differently in the dashboard, and the fold would pass every
 * behavioural test while losing the distinction the specification draws.
 */

describe('Appendix G 18: a recorded LinkedIn reply is its own terminal condition', () => {
  mustCover(18, ['scenario 18', 'linkedin_reply', 'recordLinkedInResult']);

  it('keeps the LinkedIn reply distinct from the email reply', () => {
    expect(SEQUENCE_STOP_CONDITIONS).toContain('linkedin_reply');
    expect(SEQUENCE_STOP_CONDITIONS).toContain('human_reply');
    expect(ENROLLMENT_END_REASONS).toContain('linkedin_reply');
    // Distinct values, not aliases: a fold would make these two the same string.
    const reasons: readonly string[] = ENROLLMENT_END_REASONS;
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it('gives an unexecuted successor somewhere terminal to go', () => {
    // "Stops the opportunity" means the scheduled successor must end in a state that
    // is not pending and is not completed — cancelling it is the only honest answer,
    // because it never ran.
    expect(STEP_EXECUTION_STATES).toContain('cancelled');
    expect(STEP_EXECUTION_STATES).toContain('pending');
    expect(STEP_EXECUTION_STATES.indexOf('cancelled')).not.toBe(STEP_EXECUTION_STATES.indexOf('completed'));
  });
});
