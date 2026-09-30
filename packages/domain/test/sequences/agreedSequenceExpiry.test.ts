import { describe, expect, it } from 'vitest';
import { agreedSequenceExpiry } from '../../sequences/followUpPermissions.ts';
import { resolveStepDue } from '../../src/rules/cadence.ts';
import type { WorkspaceHolidayCalendar } from '../../src/rules/businessDays.ts';
import type { SequenceStepRow } from '../../sequences/types.ts';

/**
 * How long an agreed sequence is agreed for (migration 0025; the second review of PR 332).
 *
 * "An agreed follow-up sequence can run within its agreed scope" is a length as well as a
 * name, and the length has to be *the plan's own*. The first version of this function
 * chained each step's delay from the previous step's due instant and left the workspace's
 * holidays out, which got the length wrong in both directions: a three-step cadence of two
 * business days each ended six days out rather than two — weeks of permission nobody
 * agreed to — and a holiday inside the plan could end the bound before the plan's own last
 * step, refusing a step the person did agree to.
 *
 * The rule is 11.1's: every step's delay is counted **from the enrollment's start**.
 */

const step = (ordinal: number, days: number): SequenceStepRow => ({
  id: `00000000-0000-4000-8000-00000000000${String(ordinal)}`,
  sequenceVersionId: '11111111-1111-4111-8111-111111111111',
  ordinal,
  channel: 'email',
  delay: { unit: 'business_days', days },
  onNoAnswer: null,
  templateVersionId: '22222222-2222-4222-8222-222222222222',
});

const ZONE = 'America/New_York';
/** Wednesday 23 September 2026, 09:00 New York. */
const FROM = '2026-09-23T13:00:00.000Z';
const A_DAY = 24 * 60 * 60 * 1000;

describe('the bound an agreed sequence carries', () => {
  it('is the plan’s own last step, anchored to the start rather than chained', () => {
    const steps = [step(1, 0), step(2, 2), step(3, 2)];
    const expiry = agreedSequenceExpiry(steps, FROM, ZONE);
    // The last step of this plan is due two business days after the start — not four,
    // and not six, which is what chaining produced.
    const latest = resolveStepDue(
      { id: steps[2]!.id, ordinal: 3, channel: 'email', delay: { unit: 'business_days', days: 2 } },
      FROM,
      ZONE,
    ).dueAt;
    expect(Date.parse(expiry)).toBe(Date.parse(latest) + A_DAY);
    // And the chained answer, which is what it must no longer be.
    const chained = resolveStepDue(
      { id: steps[2]!.id, ordinal: 3, channel: 'email', delay: { unit: 'business_days', days: 2 } },
      latest,
      ZONE,
    ).dueAt;
    expect(Date.parse(expiry)).toBeLessThan(Date.parse(chained));
  });

  it('takes the latest step, whatever order the delays are in', () => {
    const steps = [step(1, 0), step(2, 9), step(3, 1)];
    const expiry = agreedSequenceExpiry(steps, FROM, ZONE);
    const ninth = resolveStepDue(
      { id: steps[1]!.id, ordinal: 2, channel: 'email', delay: { unit: 'business_days', days: 9 } },
      FROM,
      ZONE,
    ).dueAt;
    expect(Date.parse(expiry)).toBe(Date.parse(ninth) + A_DAY);
  });

  it('covers the holiday the engine will honour', () => {
    const steps = [step(1, 0), step(2, 3)];
    const calendar: WorkspaceHolidayCalendar = { version: 'fixture.1', dates: ['2026-09-24'] };
    const withHoliday = agreedSequenceExpiry(steps, FROM, ZONE, calendar);
    const without = agreedSequenceExpiry(steps, FROM, ZONE);
    // A holiday inside the plan moves its last step later, so the bound moves with it —
    // a bound computed without the calendar would end before the step it agreed to.
    expect(Date.parse(withHoliday)).toBeGreaterThan(Date.parse(without));
    const due = resolveStepDue(
      { id: steps[1]!.id, ordinal: 2, channel: 'email', delay: { unit: 'business_days', days: 3 } },
      FROM,
      ZONE,
      calendar,
    ).dueAt;
    expect(Date.parse(withHoliday)).toBe(Date.parse(due) + A_DAY);
  });
});
