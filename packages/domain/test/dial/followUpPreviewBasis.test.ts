import { describe, expect, it } from 'vitest';
import { previewBasisHolds, scheduleOf } from '../../dial/followUpPreview.ts';
import type { WorkspaceHolidayCalendar } from '../../src/rules/businessDays.ts';
import type { SequenceStepRow } from '../../sequences/types.ts';

/**
 * Whether the dates a person was read are the dates an enrolment started now would use
 * (send-path v2, review of S3, round 2, P1-A).
 *
 * The card shows each step's expected instant to the minute; the command recomputes the
 * schedule at its own transaction's sampled `now()` — the instant `enrollContact`
 * anchors at — and starts the sequence only if every step lands on the same minute. The
 * case the review named: an e-mail with no delay previewed at 16:59 on a Friday shows
 * Friday 16:59; recorded at 17:01 the window has closed and it would send Monday 08:00.
 */

const ZONE = 'America/New_York';
const CALENDAR: WorkspaceHolidayCalendar = { version: 'none.1', dates: [] };

const email: SequenceStepRow = {
  id: '00000000-0000-4000-8000-000000000001',
  sequenceVersionId: '11111111-1111-4111-8111-111111111111',
  ordinal: 1,
  channel: 'email',
  delay: { unit: 'elapsed', hours: 0 },
  onNoAnswer: null,
  templateVersionId: '22222222-2222-4222-8222-222222222222',
};

/** Friday 25 September 2026 in New York (EDT, UTC-4). */
const at = (hhmmss: string): string => new Date(`2026-09-25T${hhmmss}-04:00`).toISOString();

function basisAt(anchor: string) {
  return {
    anchorAt: anchor,
    timeZone: ZONE,
    calendarVersionId: CALENDAR.version,
    steps: scheduleOf([email], anchor, ZONE, CALENDAR).map(step => ({ ordinal: step.ordinal, sendAt: step.sendAt })),
  };
}

describe('the preview basis at the send window’s edge', () => {
  it('shows Friday 16:59 at 16:59, and Monday 08:00 two minutes later', () => {
    expect(basisAt(at('16:59:00')).steps).toEqual([{ ordinal: 1, sendAt: at('16:59:00') }]);
    expect(scheduleOf([email], at('17:01:00'), ZONE, CALENDAR)[0]?.sendAt).toBe(
      new Date('2026-09-28T08:00:00-04:00').toISOString(),
    );
  });

  it('refuses the Friday agreement recorded after the window closed', () => {
    const shown = basisAt(at('16:59:00'));
    expect(previewBasisHolds(shown, { steps: [email], now: at('17:01:00'), zone: ZONE, calendar: CALENDAR })).toBe(false);
  });

  it('holds within the displayed minute, and refuses the next one', () => {
    const shown = basisAt(at('16:58:05'));
    expect(previewBasisHolds(shown, { steps: [email], now: at('16:58:55'), zone: ZONE, calendar: CALENDAR })).toBe(true);
    expect(previewBasisHolds(shown, { steps: [email], now: at('16:59:01'), zone: ZONE, calendar: CALENDAR })).toBe(false);
  });

  it('refuses a changed zone, a changed calendar version, and a missing step', () => {
    const shown = basisAt(at('10:00:00'));
    const now = at('10:00:30');
    expect(previewBasisHolds(shown, { steps: [email], now, zone: 'America/Chicago', calendar: CALENDAR })).toBe(false);
    expect(
      previewBasisHolds(shown, { steps: [email], now, zone: ZONE, calendar: { version: 'other.1', dates: [] } }),
    ).toBe(false);
    expect(previewBasisHolds(shown, { steps: [email], now, zone: null, calendar: CALENDAR })).toBe(false);
    expect(previewBasisHolds({ ...shown, steps: [] }, { steps: [email], now, zone: ZONE, calendar: CALENDAR })).toBe(false);
  });
});
