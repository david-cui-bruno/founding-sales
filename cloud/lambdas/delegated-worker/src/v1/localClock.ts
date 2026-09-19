/**
 * Local clock arithmetic through Intl and nothing else (FSS target design: dates are America/New_York, computed with
 * Intl, never a fixed offset). Pure functions over an instant and an IANA zone: the local calendar date, the minute of
 * the local day, the weekday, and the instant a local wall-clock time falls on, with the zone's own offset at that
 * moment, so both daylight-saving offsets come out right without either being written down.
 */

export const EASTERN = 'America/New_York';
export type LocalParts = { date: string; year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number; minuteOfDay: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function formatter(zone: string): Intl.DateTimeFormat {
  let held = formatters.get(zone);
  if (!held) {
    held = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    formatters.set(zone, held);
  }
  return held;
}

/** The wall clock in `zone` at `instant`. Throws on an instant that does not parse or a zone Intl does not know. */
export function localParts(instant: string | number, zone: string): LocalParts {
  const ms = typeof instant === 'number' ? instant : Date.parse(instant);
  if (!Number.isFinite(ms)) throw new Error('local_clock_instant');
  const parts: Record<string, string> = {};
  for (const part of formatter(zone).formatToParts(new Date(ms))) if (part.type !== 'literal') parts[part.type] = part.value;
  const number = (name: string) => { const value = Number(parts[name]); if (!Number.isInteger(value)) throw new Error('local_clock_parts'); return value; };
  const year = number('year'), month = number('month'), day = number('day'), hour = number('hour') % 24, minute = number('minute'), second = number('second');
  const weekday = WEEKDAYS[parts.weekday ?? ''];
  if (weekday === undefined) throw new Error('local_clock_parts');
  return { date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, year, month, day, hour, minute, second, weekday, minuteOfDay: hour * 60 + minute };
}

/** The zone's offset from UTC at `ms`, in minutes (America/New_York is -240 in summer, -300 in winter). */
export function zoneOffsetMinutes(ms: number, zone: string): number {
  const p = localParts(ms, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, ms % 1000 < 0 ? 1000 + (ms % 1000) : ms % 1000);
  return Math.round((asUtc - ms) / 60000);
}

/** The instant at which `zone` reads `date` (YYYY-MM-DD) at `hour:minute:second.ms`, using the zone's offset at that moment. */
export function localInstant(date: string, time: { hour: number; minute: number; second?: number; millisecond?: number }, zone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error('local_clock_date');
  const guess = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), time.hour, time.minute, time.second ?? 0, time.millisecond ?? 0);
  let result = guess - zoneOffsetMinutes(guess, zone) * 60000;
  const again = guess - zoneOffsetMinutes(result, zone) * 60000;
  if (again !== result) result = again;
  return new Date(result).toISOString();
}

/** The last millisecond of the local day containing `instant`, as an instant. */
export function endOfLocalDay(instant: string, zone: string): string {
  return localInstant(localParts(instant, zone).date, { hour: 23, minute: 59, second: 59, millisecond: 999 }, zone);
}

/** `HH:MM` on the local clock. */
export function localTimeLabel(parts: LocalParts): string {
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}
