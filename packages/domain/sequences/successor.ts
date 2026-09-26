import {
  isBusinessDay,
  nextBusinessDayOnOrAfter,
  resolveDelay,
  type ResolvedDueInstant,
  type WorkspaceHolidayCalendar,
} from '../src/rules/businessDays.ts';
import { resolveStepDue, type SequenceStep } from '../src/rules/cadence.ts';
import { addCalendarDays } from '../src/rules/localClock.ts';

/**
 * When a completed step's successor is due (specification 11.2, 12.5, Appendix B;
 * lane g82, audit C11).
 *
 * The cadence the salesperson reviews is start-anchored: the editor labels every delay
 * "N business days after enrollment" and `resolveStepDue` counts it from the
 * enrollment's start. That is the configured anchor and it stays the plan.
 *
 * Before this lane the successor was *only* the plan, which fails the moment a step
 * runs late. An email planned for Monday that waited on a cap, a route or a pause and
 * went on Thursday was followed by a call planned for Wednesday — due at once, the
 * same hour as the email. And 12.5 says outright that a send confirmed after
 * reconciliation "continues the sequence with the next delay calculated from the
 * original dispatch time" (Appendix B: "Continue successor from original dispatch
 * timestamp"), which a start-anchored successor never did: the dispatch instant became
 * `completed_at` and nothing read it.
 *
 * So the successor is due at the later of two instants:
 *
 * * **the plan** — the next step's own delay from the enrollment's start;
 * * **the spacing floor** — the gap the plan leaves between the two steps, counted
 *   from the instant the previous step actually happened. For an email that is the
 *   fence's original dispatch time, never the moment a reconciliation or an admin
 *   settled it; for a person's step it is when they completed it.
 *
 * On time, the floor lands on the plan and changes nothing. Late, the floor keeps the
 * spacing the salesperson reviewed. A business-day gap is counted in business days —
 * the ones the rendered plan leaves between the two steps' dates — and resolved from
 * the completion's own date in the firm's zone and calendar, so a step that slipped
 * over a weekend does not have the weekend counted twice. An elapsed gap is the
 * difference between the two planned instants.
 *
 * Pure: every instant is passed in, and nothing here reads a clock or a table.
 */

/** Appended to a floor's rule version, so a stored due instant says which anchor produced it. */
export const COMPLETION_ANCHOR_RULE_SUFFIX = '+after-completion';

export interface SuccessorDueInput {
  /** The step that just completed, or undefined for a first step. */
  readonly previous: SequenceStep | undefined;
  readonly next: SequenceStep;
  readonly startedAt: string;
  readonly zone: string;
  readonly calendar: WorkspaceHolidayCalendar;
  /** When the previous step actually happened: an email's original dispatch instant. */
  readonly completedAt: string;
}

export interface SuccessorDue extends ResolvedDueInstant {
  /** `plan` when the start-anchored cadence decided, `completion` when the spacing floor did. */
  readonly anchor: 'plan' | 'completion';
}

export function successorDue(input: SuccessorDueInput): SuccessorDue {
  const plan = resolveStepDue(input.next, input.startedAt, input.zone, input.calendar);
  if (input.previous === undefined) return { ...plan, anchor: 'plan' };
  const floor = spacingFloor(input.previous, input);
  if (Date.parse(floor.dueAt) <= Date.parse(plan.dueAt)) return { ...plan, anchor: 'plan' };
  return { ...floor, ruleVersion: `${floor.ruleVersion}${COMPLETION_ANCHOR_RULE_SUFFIX}`, anchor: 'completion' };
}

/** The planned gap between `previous` and `next`, counted again from `completedAt`. */
function spacingFloor(previous: SequenceStep, input: SuccessorDueInput): ResolvedDueInstant {
  const previousPlan = resolveStepDue(previous, input.startedAt, input.zone, input.calendar);
  const nextPlan = resolveStepDue(input.next, input.startedAt, input.zone, input.calendar);
  if (input.next.delay.unit === 'business_days') {
    // The previous step's plan may fall on a weekend (an elapsed first step on a
    // Saturday); its business day is the one the window would have used.
    const from = nextBusinessDayOnOrAfter(previousPlan.localDate, input.calendar);
    const days = businessDaysAfter(from, nextPlan.localDate, input.calendar);
    return resolveDelay({
      from: input.completedAt,
      delay: { unit: 'business_days', days },
      zone: input.zone,
      calendar: input.calendar,
    });
  }
  const gapMilliseconds = Math.max(0, Date.parse(nextPlan.dueAt) - Date.parse(previousPlan.dueAt));
  return resolveDelay({
    from: input.completedAt,
    delay: { unit: 'elapsed', hours: gapMilliseconds / 3_600_000 },
    zone: input.zone,
    calendar: input.calendar,
  });
}

/** How many business days fall in `(from, to]`. Zero when `to` is not after `from`. */
export function businessDaysAfter(from: string, to: string, calendar: WorkspaceHolidayCalendar): number {
  let count = 0;
  let day = from;
  // Bounded like `nextBusinessDayOnOrAfter`: a plan more than two years long is a
  // configuration mistake, not a loop to wait on.
  for (let step = 0; step < 800 && day < to; step += 1) {
    day = addCalendarDays(day, 1);
    if (isBusinessDay(day, calendar)) count += 1;
  }
  return count;
}
