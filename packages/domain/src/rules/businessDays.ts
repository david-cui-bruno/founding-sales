import { LocalClockError, addCalendarDays, localDate, localInstant, weekdayOfDate } from './localClock.ts';
import type { LocalTimeOfDay } from './localClock.ts';

/**
 * Business-day delay resolution with a workspace holiday calendar
 * (specification 11.2 and Appendix D).
 *
 * "Sequence delays state whether they use elapsed time or business days. A
 * business-day delay skips weekends and configured workspace holidays, then resolves
 * in the firm's actual zone. Due instants are stored in UTC together with the source
 * zone and rule version."
 *
 * So every resolution returns three things, not one: the UTC instant, the zone that
 * produced it, and the version of the rule that did. A later change to the holiday
 * calendar can then be told apart from a bug.
 */

export const BUSINESS_DAY_RULE_VERSION = 'business-day.1';
export const ELAPSED_RULE_VERSION = 'elapsed.1';

export interface WorkspaceHolidayCalendar {
  /** Bumped whenever the dates change, so a stored due instant names the calendar it used. */
  readonly version: string;
  /** Local calendar dates, `YYYY-MM-DD`, in the firm's zone. */
  readonly dates: readonly string[];
}

export const EMPTY_HOLIDAY_CALENDAR: WorkspaceHolidayCalendar = { version: 'none.1', dates: [] };

export type SequenceDelay =
  | { readonly unit: 'elapsed'; readonly hours: number }
  | { readonly unit: 'business_days'; readonly days: number };

export interface ResolvedDueInstant {
  /** The stored value: UTC, always. */
  readonly dueAt: string;
  /** The zone that produced it. */
  readonly sourceZone: string;
  /** `<delay rule>+<calendar version>`, so two identical instants from different rules are distinguishable. */
  readonly ruleVersion: string;
  /** The local calendar date the instant falls on, for the card. */
  readonly localDate: string;
}

function isWeekend(date: string): boolean {
  const weekday = weekdayOfDate(date);
  return weekday === 0 || weekday === 6;
}

/** Whether a local date is a business day in this workspace: not a weekend, not a holiday. */
export function isBusinessDay(date: string, calendar: WorkspaceHolidayCalendar): boolean {
  return !isWeekend(date) && !calendar.dates.includes(date);
}

/** The next business day on or after `date`. */
export function nextBusinessDayOnOrAfter(date: string, calendar: WorkspaceHolidayCalendar): string {
  let candidate = date;
  // A calendar that marked a whole year would be a configuration mistake, not an
  // infinite loop: 400 steps is more than a year and the refusal names itself.
  for (let step = 0; step < 400; step += 1) {
    if (isBusinessDay(candidate, calendar)) return candidate;
    candidate = addCalendarDays(candidate, 1);
  }
  throw new LocalClockError('DATE_INVALID', 'the holiday calendar leaves no business day within a year');
}

/**
 * `days` business days after `date`, skipping weekends and configured holidays.
 * Zero business days means "the same day if it is a business day, otherwise the next".
 */
export function addBusinessDays(date: string, days: number, calendar: WorkspaceHolidayCalendar): string {
  if (!Number.isInteger(days) || days < 0) {
    throw new LocalClockError('DATE_INVALID', 'a business-day delay is a non-negative whole number of days');
  }
  let candidate = nextBusinessDayOnOrAfter(date, calendar);
  for (let remaining = days; remaining > 0; remaining -= 1) {
    candidate = nextBusinessDayOnOrAfter(addCalendarDays(candidate, 1), calendar);
  }
  return candidate;
}

export interface ResolveDelayInput {
  /** The instant the delay counts from: the enrollment's start or the previous step. */
  readonly from: string;
  readonly delay: SequenceDelay;
  /** The firm's actual IANA zone (specification 9.2), never a state-wide shortcut. */
  readonly zone: string;
  readonly calendar?: WorkspaceHolidayCalendar;
  /** Where in the local day a business-day delay lands. Defaults to 08:00, the start of the window. */
  readonly localTimeOfDay?: LocalTimeOfDay;
}

/**
 * Resolve a sequence delay into a stored due instant.
 *
 * An elapsed delay is arithmetic on the instant and never touches the calendar: eight
 * hours after a Friday afternoon is a Friday evening, and it is the send window, not
 * this function, that moves it to Monday morning.
 */
export function resolveDelay(input: ResolveDelayInput): ResolvedDueInstant {
  const calendar = input.calendar ?? EMPTY_HOLIDAY_CALENDAR;
  const parsed = Date.parse(input.from);
  if (!Number.isFinite(parsed)) {
    throw new LocalClockError('INSTANT_INVALID', 'a delay counts from an ISO 8601 instant');
  }

  if (input.delay.unit === 'elapsed') {
    const dueAt = new Date(parsed + input.delay.hours * 3_600_000).toISOString();
    return {
      dueAt,
      sourceZone: input.zone,
      ruleVersion: ELAPSED_RULE_VERSION,
      localDate: localDate(dueAt, input.zone),
    };
  }

  const startDate = localDate(input.from, input.zone);
  const targetDate = addBusinessDays(startDate, input.delay.days, calendar);
  const dueAt = localInstant(targetDate, input.localTimeOfDay ?? { hour: 8, minute: 0 }, input.zone);
  return {
    dueAt,
    sourceZone: input.zone,
    ruleVersion: `${BUSINESS_DAY_RULE_VERSION}+${calendar.version}`,
    localDate: targetDate,
  };
}

/** The start-anchored due rule: a step's delay counted from the instant the enrollment began. */
export function startAnchoredDueAt(startedAt: string, delayHours: number): string {
  const parsed = Date.parse(startedAt);
  if (!Number.isFinite(parsed)) {
    throw new LocalClockError('INSTANT_INVALID', 'a start anchor is an ISO 8601 instant');
  }
  return new Date(parsed + delayHours * 3_600_000).toISOString();
}
