/**
 * Local clock arithmetic through `Intl` and nothing else.
 *
 * Ported from `cloud/lambdas/delegated-worker/src/v1/localClock.ts`. Every calendar
 * concept in the specification names a zone (Appendix D), and a fixed offset is never
 * one: America/New_York is -300 in January and -240 in July, and both of those have
 * to come out right without either being written down.
 *
 * Every function here is pure and takes the zone as an argument. Nothing reads the
 * host's zone, so a test on a European laptop and a test on a UTC CI runner agree.
 */

export interface LocalParts {
  /** The local calendar date as `YYYY-MM-DD`. */
  readonly date: string;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** 0 is Sunday, matching `Date.prototype.getUTCDay`. */
  readonly weekday: number;
  readonly minuteOfDay: number;
}

export class LocalClockError extends Error {
  constructor(readonly code: 'INSTANT_INVALID' | 'ZONE_UNKNOWN' | 'DATE_INVALID', message: string) {
    super(message);
    this.name = 'LocalClockError';
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAY_NUMBERS: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Whether the runtime's `Intl` knows this zone. The database can only check the shape. */
export function isKnownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function formatter(zone: string): Intl.DateTimeFormat {
  const held = formatters.get(zone);
  if (held !== undefined) return held;
  let made: Intl.DateTimeFormat;
  try {
    made = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
  } catch {
    throw new LocalClockError('ZONE_UNKNOWN', `Intl does not know the zone ${zone}`);
  }
  formatters.set(zone, made);
  return made;
}

/** The wall clock in `zone` at `instant`. */
export function localParts(instant: string | number, zone: string): LocalParts {
  const milliseconds = typeof instant === 'number' ? instant : Date.parse(instant);
  if (!Number.isFinite(milliseconds)) {
    throw new LocalClockError('INSTANT_INVALID', 'an instant is an ISO 8601 string or epoch milliseconds');
  }
  const found: Record<string, string> = {};
  for (const part of formatter(zone).formatToParts(new Date(milliseconds))) {
    if (part.type !== 'literal') found[part.type] = part.value;
  }
  const number = (name: string): number => {
    const value = Number(found[name]);
    if (!Number.isInteger(value)) throw new LocalClockError('ZONE_UNKNOWN', `Intl returned no ${name} for ${zone}`);
    return value;
  };
  const year = number('year');
  const month = number('month');
  const day = number('day');
  const hour = number('hour') % 24;
  const minute = number('minute');
  const second = number('second');
  const weekday = WEEKDAY_NUMBERS[found['weekday'] ?? ''];
  if (weekday === undefined) throw new LocalClockError('ZONE_UNKNOWN', `Intl returned no weekday for ${zone}`);
  return {
    date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday,
    minuteOfDay: hour * 60 + minute,
  };
}

/** The zone's offset from UTC at `milliseconds`, in minutes. */
export function zoneOffsetMinutes(milliseconds: number, zone: string): number {
  const parts = localParts(milliseconds, zone);
  const remainder = milliseconds % 1000;
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    remainder < 0 ? 1000 + remainder : remainder,
  );
  return Math.round((asUtc - milliseconds) / 60_000);
}

export interface LocalTimeOfDay {
  readonly hour: number;
  readonly minute: number;
  readonly second?: number;
  readonly millisecond?: number;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The instant at which `zone` reads `date` at `time`, resolved with the zone's own
 * offset at that moment.
 *
 * Daylight saving is where this has to be exactly right, and the two cases resolve
 * deterministically (Appendix G 32):
 *
 *   * **gap** — a wall-clock time the zone skips, such as 02:30 on the second Sunday
 *     in March in America/New_York. The old module's two-step correction settles on
 *     01:30 EST, an instant *before* the time that was asked for. This module keeps
 *     the correction but resolves a gap forward instead, to 03:30 EDT: work is never
 *     scheduled earlier than the wall clock it named, and the step happens once, at
 *     the first moment the clock allows.
 *   * **fold** — a wall-clock time the zone repeats, such as 01:30 on the first Sunday
 *     in November. The first of the two, the one still on daylight time, is chosen.
 *     A fold is never two due instants.
 */
export function localInstant(date: string, time: LocalTimeOfDay, zone: string): string {
  const match = DATE_PATTERN.exec(date);
  if (match === null) throw new LocalClockError('DATE_INVALID', 'a local date is YYYY-MM-DD');
  const guess = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    time.hour,
    time.minute,
    time.second ?? 0,
    time.millisecond ?? 0,
  );
  const first = guess - zoneOffsetMinutes(guess, zone) * 60_000;
  const second = guess - zoneOffsetMinutes(first, zone) * 60_000;
  let result = second !== first ? second : first;

  // A gap is exactly the case where neither candidate reads back as the time that was
  // asked for. Then the later candidate is the one on the far side of the transition.
  const readsBack = localParts(result, zone);
  if (readsBack.hour !== time.hour || readsBack.minute !== time.minute) {
    result = Math.max(first, second);
  }
  return new Date(result).toISOString();
}

/** The local calendar date containing `instant` in `zone`. */
export function localDate(instant: string | number, zone: string): string {
  return localParts(instant, zone).date;
}

/** `HH:MM` on the local clock. */
export function localTimeLabel(parts: LocalParts): string {
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

/** The last millisecond of the local day containing `instant`. */
export function endOfLocalDay(instant: string, zone: string): string {
  return localInstant(localParts(instant, zone).date, { hour: 23, minute: 59, second: 59, millisecond: 999 }, zone);
}

/** `date` moved by whole calendar days, on the calendar rather than by 86 400 000 ms. */
export function addCalendarDays(date: string, days: number): string {
  const match = DATE_PATTERN.exec(date);
  if (match === null) throw new LocalClockError('DATE_INVALID', 'a local date is YYYY-MM-DD');
  const moved = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

/** The weekday of a local calendar date. 0 is Sunday. */
export function weekdayOfDate(date: string): number {
  const match = DATE_PATTERN.exec(date);
  if (match === null) throw new LocalClockError('DATE_INVALID', 'a local date is YYYY-MM-DD');
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
}
