import { describe, expect, it } from 'vitest';
import { LINKEDIN_UNDO_WINDOW_MILLISECONDS } from '@fss/domain/sequences';
import { mustCover, readRepositoryFile } from './support/coverage.ts';

/**
 * Appendix G 9: "The LinkedIn successor races undo at 9:59 and 10:00 database time:
 * no early fence."
 *
 * Two suites hold the two sides. The sequences suite completes a LinkedIn step, undoes
 * it inside the window, and then pushes the instant past the window and asserts
 * `undo_window_expired`; the desktop suite asserts the card still offers the button at
 * 9:59 and has withdrawn it at 10:00, measured against an instant the server gave it.
 * What this check adds is the thing the two halves must agree on to be about the same
 * boundary at all: one exported constant, ten minutes, shared by both.
 *
 * ## The vacuous-pass trap
 *
 * A test that read the wall clock would pass or fail by when it happened to run, and
 * worse, would pass most of the time — which is how a boundary bug survives a year.
 * The lane tests close it by injecting both instants explicitly. The residual trap is
 * a second, private copy of the window in the client: a Mac counting down from its own
 * nine or eleven minutes would satisfy both suites separately and still offer an undo
 * the server refuses. Closed here by pinning the constant and asserting the desktop
 * card derives its remaining time from the server's `undoUntil` rather than from a
 * duration of its own.
 */

describe('Appendix G 9: one ten-minute window, measured by the server', () => {
  mustCover(9, ['undo_window_expired', 'LINKEDIN_UNDO_WINDOW_MILLISECONDS', 'remainingUndoMilliseconds']);

  it('is ten minutes, exactly, and exported once', () => {
    expect(LINKEDIN_UNDO_WINDOW_MILLISECONDS).toBe(10 * 60 * 1000);
    // 9:59 is inside and 10:00 is outside, which is the whole of Appendix G 9 stated
    // as arithmetic: the deadline is exclusive.
    expect(9 * 60 * 1000 + 59_000 < LINKEDIN_UNDO_WINDOW_MILLISECONDS).toBe(true);
    expect(10 * 60 * 1000 < LINKEDIN_UNDO_WINDOW_MILLISECONDS).toBe(false);
  });

  it('measures the card against the deadline the server sent', () => {
    // `remainingUndoMilliseconds` takes the card's `undoUntil` and an instant; if it
    // took a duration and a local start time instead, the Mac would be keeping its
    // own clock and the two suites could disagree while both stayed green.
    const desktop = readRepositoryFile('apps/desktop/test/sequences.test.ts');
    expect(desktop).toContain('undoUntil');
    expect(desktop).toContain('remainingUndoMilliseconds(card,');
  });
});
