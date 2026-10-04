import { meetingDeadlineSchema, type MeetingDeadline } from '@fss/contracts';
import { addCalendarDays, isKnownTimeZone, localInstant, localParts, weekdayOfDate } from '../src/rules/localClock.ts';
import type { MeetingResult } from './outcomeTypes.ts';
const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** Conservative calendar parser: ambiguous qualifiers and times require a human correction. */
export function resolveMeetingDeadline(input: { text: string; anchorAt: string; zone: string | null; sourceKind: 'transcript' | 'debrief' }): MeetingResult<MeetingDeadline> {
  const fail = (): MeetingResult<MeetingDeadline> => ({ ok: false, reason: 'deadline_unclear' });
  if (input.zone === null || !isKnownTimeZone(input.zone) || !Number.isFinite(Date.parse(input.anchorAt))) return fail();
  const text = input.text.toLowerCase().trim().replace(/^(?:by|on)\s+/u, '').replace(/\.$/u, '');
  const time = /^(.*?) at (\d{1,2})(?::(\d{2}))?\s*(am|pm)$/u.exec(text);
  const dateText = time?.[1] ?? text;
  const anchor = localParts(input.anchorAt, input.zone);
  let date: string;
  if (dateText === 'today' || dateText === 'tomorrow') date = addCalendarDays(anchor.date, dateText === 'today' ? 0 : 1);
  else if (/^\d{4}-\d{2}-\d{2}$/u.test(dateText)) date = dateText;
  else if (weekdays.includes(dateText)) date = addCalendarDays(anchor.date, ((weekdays.indexOf(dateText) - weekdayOfDate(anchor.date) + 7) % 7) || 7);
  else {
    const named = /^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/u.exec(dateText);
    if (named === null || !months.includes(named[1]!)) return fail();
    const year = named[3] ?? String(anchor.year);
    date = `${year}-${String(months.indexOf(named[1]!) + 1).padStart(2, '0')}-${named[2]!.padStart(2, '0')}`;
    // No guessing a rollover when a year was omitted.
    if (named[3] === undefined && date < anchor.date) return fail();
  }
  const dateOnly = meetingDeadlineSchema.safeParse({ precision: 'date', localDate: date, zone: input.zone });
  if (!dateOnly.success) return fail();
  if (time === null) return { ok: true, value: dateOnly.data };
  const spokenHour = Number(time[2]), minute = Number(time[3] ?? 0);
  if (spokenHour < 1 || spokenHour > 12 || minute > 59) return fail();
  const hour = spokenHour % 12 + (time[4] === 'pm' ? 12 : 0);
  const at = localInstant(date, { hour, minute }, input.zone);
  const resolved = localParts(at, input.zone);
  // Reject nonexistent and repeated clocks instead of applying callback-specific DST guesses.
  if (resolved.date !== date || resolved.hour !== hour || resolved.minute !== minute) return fail();
  for (const offset of [-3600000, 3600000, -1800000, 1800000]) {
    const other = localParts(Date.parse(at) + offset, input.zone);
    if (other.date === date && other.hour === hour && other.minute === minute) return fail();
  }
  return { ok: true, value: { precision: 'instant', at, zone: input.zone } };
}
/** A date-only task becomes overdue at the start of the following local day. */
export function meetingDeadlineDueAt(deadline: MeetingDeadline): string {
  return deadline.precision === 'instant' ? deadline.at : localInstant(addCalendarDays(deadline.localDate, 1), { hour: 0, minute: 0 }, deadline.zone);
}
