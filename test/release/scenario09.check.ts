import { describe, expect, it } from 'vitest';
import { STEP_CHANNELS as WIRE_STEP_CHANNELS } from '@fss/contracts';
import { STEP_CHANNELS, isStepChannel } from '@fss/domain/sequences';
import { ENROLLMENT_PATHS } from '../../apps/api/src/routes/enrollments.ts';
import { mustCover } from './support/coverage.ts';

/**
 * Appendix G 9: "The LinkedIn successor races undo at 9:59 and 10:00 database time:
 * no early fence."
 *
 * LinkedIn was removed on 25 September 2026: there is no handoff, so there is no undo
 * window and no successor to race it. What has to stay true is the thing the race was
 * about — no LinkedIn step reaches a fence — and it now has a different shape.
 * Migration 0012 still admits `linkedin_task`, so a step stored before the removal may
 * still come due, and the worker must hold it rather than run it.
 *
 * ## The vacuous-pass trap
 *
 * A removal that deleted the routes and the editor's option would pass every test that
 * looked for them, while the worker could still take a stored LinkedIn step for a
 * manual task. The lane test closes it by running the real worker function over a
 * stored `linkedin_task` row, twice, and requiring `held` with `long_hold_review` and
 * no send prepared. This check adds the vocabulary: no channel on either side of the
 * wire is LinkedIn's, and no enrollment path is mounted for it.
 */

describe('Appendix G 9: removed with LinkedIn; a stored LinkedIn step is held and never run', () => {
  mustCover(9, ['linkedin_task', 'long_hold_review', 'runDueStepExecution', 'isStepChannel', '/enrollments/linkedin/complete']);

  it('has no LinkedIn channel on either side of the wire', () => {
    expect([...STEP_CHANNELS]).toEqual(['email', 'call_task']);
    expect([...WIRE_STEP_CHANNELS]).toEqual([...STEP_CHANNELS]);
    expect(isStepChannel('linkedin_task')).toBe(false);
  });

  it('mounts no LinkedIn enrollment path', () => {
    expect(ENROLLMENT_PATHS.filter(path => path.includes('linkedin'))).toEqual([]);
  });
});
