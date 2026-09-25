import { describe, expect, it } from 'vitest';
import {
  ENROLLMENT_END_REASONS as WIRE_END_REASONS,
  SEQUENCE_STOP_CONDITIONS as WIRE_STOP_CONDITIONS,
} from '@fss/contracts';
import { MANUAL_MODE_ORIGINS } from '@fss/domain/crm';
import { ENROLLMENT_END_REASONS, SEQUENCE_STOP_CONDITIONS, manualModeEndReason } from '@fss/domain/sequences';
import { mustCover } from './support/coverage.ts';

/**
 * Appendix G 18: "A LinkedIn reply after handoff and before the next email stops the
 * opportunity through the recorded-reply path."
 *
 * LinkedIn was removed on 25 September 2026, and with it the recorded LinkedIn reply.
 * Migration 0012 was not changed: every version's `stop_conditions` still carries
 * `linkedin_reply`, because the column's default puts it there and
 * `sequence_versions_stop_conditions_complete` requires it, and `end_reason` still
 * admits it. So what remains of the scenario is on the read side: a stored
 * `linkedin_reply` is dropped rather than handed to a Mac whose contract no longer has
 * the word, and a manual-mode event that names it as its origin still stops the
 * enrollment — as `human_reply`, the reading of every origin nothing knows.
 *
 * ## The vacuous-pass trap
 *
 * A reader that drops a value nobody stored passes by construction. The lane test reads
 * the raw row first and asserts `linkedin_reply` is really there. This check holds the
 * vocabulary: neither side of the wire has the member, and an origin nobody knows
 * still ends an enrollment rather than leaving it running.
 */

describe('Appendix G 18: removed with LinkedIn; a stored linkedin_reply is no value, and still stops', () => {
  mustCover(18, ['linkedin_reply', 'stop_conditions', 'end_reason', 'endReason', 'human_reply']);

  it('has no linkedin_reply on either side of the wire', () => {
    for (const list of [SEQUENCE_STOP_CONDITIONS, WIRE_STOP_CONDITIONS, ENROLLMENT_END_REASONS, WIRE_END_REASONS]) {
      expect(list as readonly string[]).not.toContain('linkedin_reply');
    }
    expect(MANUAL_MODE_ORIGINS as readonly string[]).not.toContain('linkedin_reply');
    expect([...WIRE_STOP_CONDITIONS]).toEqual([...SEQUENCE_STOP_CONDITIONS]);
    expect([...WIRE_END_REASONS]).toEqual([...ENROLLMENT_END_REASONS]);
  });

  it('still ends an enrollment for the removed origin', () => {
    expect(manualModeEndReason('linkedin_reply')).toBe('human_reply');
  });
});
