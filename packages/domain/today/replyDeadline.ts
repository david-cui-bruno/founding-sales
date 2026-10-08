import { nextBusinessDayOnOrAfter, type WorkspaceHolidayCalendar } from '../src/rules/businessDays.ts';
import { addCalendarDays, localInstant, localParts } from '../src/rules/localClock.ts';

/** The next permitted weekday at the received reply's workspace local clock time. */
export function replyDeadline(receivedAt: string, zone: string, calendar: WorkspaceHolidayCalendar): string {
  const parts = localParts(receivedAt, zone);
  const date = nextBusinessDayOnOrAfter(addCalendarDays(parts.date, 1), calendar);
  return localInstant(date, { hour: parts.hour, minute: parts.minute, second: parts.second,
    millisecond: new Date(receivedAt).getUTCMilliseconds() }, zone);
}
