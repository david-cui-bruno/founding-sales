/**
 * Local clock arithmetic through `Intl` and nothing else, shared by the server and the
 * Mac (specification Appendix D, Appendix G 32; lane g79).
 *
 * Ported from `cloud/lambdas/delegated-worker/src/v1/localClock.ts` by G0, and moved
 * here from `packages/domain/src/rules/localClock.ts` by lane g79. The move is the fix
 * for audit item C18: the Mac turned a callback's wall-clock time into an instant with
 * its own two-step `Intl` correction, which lands New York's 02:30 on 8 March 2026 on
 * 01:30 EST, while the domain resolves the same gap forward to 03:30 EDT
 * (`docs/decisions/g0-dst-gap-resolution.md`). Two implementations of one rule is how
 * a callback ends up an hour earlier than the person confirmed. `@fss/contracts` is the
 * one package both the domain and the desktop may import, so the rule lives here and
 * `packages/domain/src/rules/localClock.ts` re-exports it.
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

/*
 * An explicit field rather than a constructor parameter property: this file is loaded
 * by the packaged desktop's main process under Node's strip-only TypeScript, which
 * refuses parameter properties (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
 */
export class LocalClockError extends Error {
  readonly code: 'INSTANT_INVALID' | 'ZONE_UNKNOWN' | 'DATE_INVALID';

  constructor(code: 'INSTANT_INVALID' | 'ZONE_UNKNOWN' | 'DATE_INVALID', message: string) {
    super(message);
    this.code = code;
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
const TIME_PATTERN = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

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

/**
 * The time a callback promised for a day and no hour is placed at (Appendix D).
 *
 * The form lets a person say "Tuesday" without a time. The callback is still an
 * instant — Today sorts on it — so the day resolves to this wall-clock time in the
 * source zone, and `requested_local_time` stays empty so the card can say "Tuesday"
 * rather than inventing "Tuesday at 9". One constant, read by the Mac that computes the
 * instant it shows and the server that checks the instant it is sent.
 */
const CALLBACK_DATE_ONLY_LOCAL_TIME = '09:00';

/**
 * A callback's wall clock as a UTC instant, or null when any part of it is not one.
 *
 * `localTime` absent or empty is a day with no hour: `CALLBACK_DATE_ONLY_LOCAL_TIME`.
 * The server compares a client's `dueAt` with this function's answer and refuses a
 * disagreement, so the two sides can only agree by calling the same code.
 */
export function callbackInstant(localDate: string, localTime: string | undefined, zone: string): string | null {
  const dateMatch = DATE_PATTERN.exec(localDate.trim());
  if (dateMatch === null) return null;
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const calendar = new Date(Date.UTC(Number(dateMatch[1]), month - 1, day));
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  const time = localTime === undefined || localTime.trim() === '' ? CALLBACK_DATE_ONLY_LOCAL_TIME : localTime.trim();
  const timeMatch = TIME_PATTERN.exec(time);
  if (timeMatch === null) return null;
  if (!isKnownTimeZone(zone)) return null;
  try {
    return localInstant(localDate.trim(), { hour: Number(timeMatch[1]), minute: Number(timeMatch[2]) }, zone);
  } catch {
    return null;
  }
}
