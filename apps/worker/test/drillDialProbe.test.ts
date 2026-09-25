import { describe, expect, it } from 'vitest';
import { dialProbeFailure } from '../src/tools/fss/drill.ts';

/**
 * Step 1's dial assertion on its own (lanes g59 and g60).
 *
 * `drillRehearsal.test.ts` runs the whole drill on a real restored copy, where the
 * restore hold is a workspace hold over every action kind and so always applies to the
 * probe. That makes the half of the rule that matters untestable there: a dial refused
 * for a reason of its own — no posture for the state, outside the calling window — with
 * no restore hold behind it. So the rule is asserted here, on the report shape
 * `fss admin dial-authorize` prints.
 *
 * ## The vacuous-pass trap, named
 *
 * `allowed: false` is what every probe in a rehearsal answers, because the evidence
 * firms' state has no posture and `authorizeDial` stops at step 6 before it reaches the
 * restore hold at step 8. A step that asked only for the refusal would pass whether or
 * not a restore was in progress.
 */
describe('step 1: a dial is refused during a restore', () => {
  const refused = (reason: string, holds: readonly string[]) => ({
    allowed: false,
    reason,
    at: '2026-09-25T13:00:00.000Z',
    subject: { workspaceId: 'w', firmId: 'f', routeId: 'r', callingIdentityId: 'i' },
    holds,
  });

  it('passes a refusal the restore hold stands behind, whichever step of 9.2 answered first', () => {
    expect(dialProbeFailure(refused('restore_in_progress', ['restore_in_progress']))).toBeNull();
    expect(dialProbeFailure(refused('posture_missing', ['restore_in_progress', 'scoped_pause']))).toBeNull();
  });

  it('fails an authorized dial', () => {
    expect(dialProbeFailure({ allowed: true, holds: ['restore_in_progress'] })).toContain(
      'a dial was authorized while a restore was in progress',
    );
  });

  it('fails a refusal with no restore hold behind it, because it says nothing about the restore', () => {
    for (const report of [refused('posture_missing', []), refused('outside_calling_window', ['scoped_pause']), { allowed: false }]) {
      expect(dialProbeFailure(report), JSON.stringify(report)).toContain('no restore hold applies to it');
    }
  });
});
