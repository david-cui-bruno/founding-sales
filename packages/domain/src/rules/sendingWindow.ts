import { addCalendarDays, localInstant, localParts } from './localClock.ts';
import { EMPTY_HOLIDAY_CALENDAR, type WorkspaceHolidayCalendar } from './businessDays.ts';

/**
 * The email sending window (specification 11.2, Appendix D, Appendix G 32).
 *
 * "Email may send only Monday–Friday from 08:00 through 17:00 in the firm's actual
 * IANA zone. The scheduler prefers 08:00–12:00 and uses 12:00–17:00 for overflow. A
 * Monday-due email sends Monday morning rather than waiting for Tuesday. Work due
 * outside a window moves to the next valid window."
 *
 * The Monday clause is the one that is easy to get wrong. A naive "move forward to the
 * next window" applied to an instant that is already inside Monday morning would push
 * it to Tuesday; the rule is that a due instant inside a window sends where it is.
 */

export const EMAIL_WINDOW = Object.freeze({
  /** Minutes from local midnight. */
  openMinute: 8 * 60,
  preferredEndMinute: 12 * 60,
  closeMinute: 17 * 60,
});

/** Monday to Friday. */
export const EMAIL_WINDOW_WEEKDAYS: readonly number[] = Object.freeze([1, 2, 3, 4, 5]);

export type EmailWindowBand = 'morning' | 'overflow';

export interface EmailSendPlacement {
  /** The instant the send may first be released. UTC, always. */
  readonly sendAt: string;
  /** Which half of the window it landed in. Morning is preferred; overflow is the rest. */
  readonly band: EmailWindowBand;
  /** True when the due instant was already inside a window and did not have to move. */
  readonly inPlace: boolean;
  /** The firm-local date the send lands on. */
  readonly localDate: string;
  readonly sourceZone: string;
}

export interface PlaceEmailSendOptions {
  /** Holidays are not sending days either; a holiday-due email moves to the next business day. */
  readonly calendar?: WorkspaceHolidayCalendar;
}

function isSendingDay(date: string, weekday: number, calendar: WorkspaceHolidayCalendar): boolean {
  return EMAIL_WINDOW_WEEKDAYS.includes(weekday) && !calendar.dates.includes(date);
}

/**
 * Where a due email actually goes out.
 *
 * Inside a window it stays where it is. Before a window on a sending day it opens at
 * 08:00 that morning — which is what makes a Monday-due email send Monday morning.
 * After the window, or on a day that is not a sending day, it opens at 08:00 on the
 * next sending day.
 */
export function placeEmailSend(
  dueAt: string,
  zone: string,
  options: PlaceEmailSendOptions = {},
): EmailSendPlacement {
  const calendar = options.calendar ?? EMPTY_HOLIDAY_CALENDAR;
  const parts = localParts(dueAt, zone);

  const bandOf = (minuteOfDay: number): EmailWindowBand =>
    minuteOfDay < EMAIL_WINDOW.preferredEndMinute ? 'morning' : 'overflow';

  if (
    isSendingDay(parts.date, parts.weekday, calendar) &&
    parts.minuteOfDay >= EMAIL_WINDOW.openMinute &&
    parts.minuteOfDay < EMAIL_WINDOW.closeMinute
  ) {
    return {
      sendAt: new Date(Date.parse(dueAt)).toISOString(),
      band: bandOf(parts.minuteOfDay),
      inPlace: true,
      localDate: parts.date,
      sourceZone: zone,
    };
  }

  // Before the window on a sending day: this morning. Otherwise the next sending day.
  const openToday =
    isSendingDay(parts.date, parts.weekday, calendar) && parts.minuteOfDay < EMAIL_WINDOW.openMinute;
  let date = openToday ? parts.date : addCalendarDays(parts.date, 1);
  for (let step = 0; step < 400; step += 1) {
    const weekday = localParts(localInstant(date, { hour: 12, minute: 0 }, zone), zone).weekday;
    if (isSendingDay(date, weekday, calendar)) break;
    date = addCalendarDays(date, 1);
  }

  return {
    sendAt: localInstant(date, { hour: 8, minute: 0 }, zone),
    band: 'morning',
    inPlace: false,
    localDate: date,
    sourceZone: zone,
  };
}

/**
 * Pacing inside a window (specification 11.2: "Sends are paced throughout the window;
 * they are never released as a start-of-window burst").
 *
 * Spreads `count` sends evenly across the band that `firstSendAt` falls in, starting
 * at the first send rather than at the window's open, so a placement that landed at
 * 09:30 paces from 09:30. Returns instants in order; an empty count returns nothing.
 */
export function paceWithinWindow(placement: EmailSendPlacement, zone: string, count: number): string[] {
  if (!Number.isInteger(count) || count <= 0) return [];
  const parts = localParts(placement.sendAt, zone);
  const bandEndMinute =
    placement.band === 'morning' ? EMAIL_WINDOW.preferredEndMinute : EMAIL_WINDOW.closeMinute;
  const start = Date.parse(placement.sendAt);
  const end = Date.parse(localInstant(parts.date, { hour: 0, minute: bandEndMinute }, zone));
  const span = Math.max(end - start, 0);
  // `count` sends occupy `count` slots, so the last one starts before the band closes.
  const step = count === 0 ? 0 : Math.floor(span / count);
  return Array.from({ length: count }, (_unused, index) => new Date(start + step * index).toISOString());
}
