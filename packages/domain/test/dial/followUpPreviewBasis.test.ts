import { describe, expect, it } from 'vitest';
import { previewBasisHolds, scheduleOf } from '../../dial/followUpPreview.ts';
import type { WorkspaceHolidayCalendar } from '../../src/rules/businessDays.ts';
import type { SequenceStepRow } from '../../sequences/types.ts';

/**
 * Whether the dates a person was read are the dates an enrolment started now would use
 * (send-path v2, review of S3, round 2, P1-A).
 *
 * The card shows each step's date and time in the firm's zone; the command recomputes
 * the schedule at its own transaction's sampled `now()` — the instant `enrollContact`
 * anchors at — and starts the sequence only if every step lands on the same local day
 * and within fifteen minutes of what was shown (coordinator's rule, 30 September 2026).
 * The case the review named — an e-mail with no delay previewed at 16:59 on a Friday
 * and recorded at 17:01, which would send Monday 08:00 — is a day change and refused.
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

const call: SequenceStepRow = { ...email, id: '00000000-0000-4000-8000-000000000002', channel: 'call_task', templateVersionId: null };
const hourLater: SequenceStepRow = { ...email, delay: { unit: 'elapsed', hours: 1 } };

const holds = (steps: readonly SequenceStepRow[], shownAt: string, now: string, zone = ZONE) =>
  previewBasisHolds(
    {
      anchorAt: shownAt,
      timeZone: ZONE,
      calendarVersionId: CALENDAR.version,
      steps: scheduleOf(steps, shownAt, ZONE, CALENDAR).map(step => ({ ordinal: step.ordinal, sendAt: step.sendAt })),
    },
    { steps, now, zone, calendar: CALENDAR },
  );

describe('the preview basis: same local day, and within fifteen minutes', () => {
  it('shows Friday 16:59 at 16:59, and Monday 08:00 two minutes later', () => {
    expect(basisAt(at('16:59:00')).steps).toEqual([{ ordinal: 1, sendAt: at('16:59:00') }]);
    expect(scheduleOf([email], at('17:01:00'), ZONE, CALENDAR)[0]?.sendAt).toBe(
      new Date('2026-09-28T08:00:00-04:00').toISOString(),
    );
  });

  it('holds a step recorded two minutes after its 16:59 preview on the same day', () => {
    // A call task has no send window: 16:59 shown, 17:01 recomputed — the same Friday,
    // two minutes apart, so the person agreed to it.
    expect(holds([call], at('16:59:00'), at('17:01:00'))).toBe(true);
    // And an hour-delay e-mail previewed at 10:00 and recorded at 10:07 lands at 11:07,
    // seven minutes from the 11:00 shown: the same agreement, no extra step.
    expect(holds([hourLater], at('10:00:00'), at('10:07:00'))).toBe(true);
  });

  it('refuses the Friday e-mail recorded after the window closed: it would send Monday', () => {
    expect(holds([email], at('16:59:00'), at('17:01:00'))).toBe(false);
  });

  it('refuses a step that crosses midnight in the firm’s zone, however few minutes it moved', () => {
    // A call task shown 23:55 Friday; recorded at 00:05 it is due Saturday.
    expect(holds([call], at('23:55:00'), new Date('2026-09-26T00:05:00-04:00').toISOString())).toBe(false);
  });

  it('refuses a drift of sixteen minutes, and holds one of fifteen', () => {
    expect(holds([hourLater], at('10:00:00'), at('10:16:00'))).toBe(false);
    expect(holds([hourLater], at('10:00:00'), at('10:15:00'))).toBe(true);
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
