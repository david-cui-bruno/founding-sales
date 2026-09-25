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
 *
 * The resolution itself — `localParts`, `zoneOffsetMinutes`, `localInstant` and the
 * DST gap and fold rule — lives in `@fss/contracts` since lane g79, because the Mac
 * resolves a callback's wall clock too and one rule must have one implementation
 * (audit item C18). It is re-exported here unchanged, so every domain caller and
 * `@fss/domain`'s own export surface keep the names they had.
 */

import { LocalClockError, localInstant, localParts, type LocalParts } from '@fss/contracts';

export {
  LocalClockError,
  isKnownTimeZone,
  localInstant,
  localParts,
  zoneOffsetMinutes,
  type LocalParts,
  type LocalTimeOfDay,
} from '@fss/contracts';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

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
