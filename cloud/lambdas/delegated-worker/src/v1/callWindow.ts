import { localParts, localTimeLabel } from './localClock';

/**
 * Whether a firm may be dialed now (FSS target design section 3: dialAllowed computed by the server at request time).
 * The code floor is Monday to Friday, 08:00 to 20:00 on the firm's own clock; call hours from Settings (S5, `SETTINGS#calls`)
 * can only narrow it, never widen it, and S1 has none, so the floor alone applies. A firm without a zone cannot be placed
 * on any clock: that is the hold `state_not_cleared` with the code `zone_unknown`, never a guess. Pure.
 */

export type CallWindow = { startMinute: number; endMinute: number };
export const CALL_WINDOW_FLOOR: CallWindow = Object.freeze({ startMinute: 8 * 60, endMinute: 20 * 60 });
/** Monday to Friday. */
export const CALL_WINDOW_DAYS: readonly number[] = Object.freeze([1, 2, 3, 4, 5]);
/** The usual business day, for the card's open-or-closed word; a guess from the zone, not the firm's posted hours. */
export const OPEN_HOURS: CallWindow = Object.freeze({ startMinute: 9 * 60, endMinute: 17 * 60 });

export type DialEvaluation = {
  dialAllowed: boolean;
  holdReason: 'outside_hours' | 'state_not_cleared' | null;
  holdCode: 'outside_hours' | 'zone_unknown' | 'state_unknown' | null;
  localTime: string | null;
  openNow: boolean | null;
};

/** Hours inside the floor: the later start and the earlier end. Hours that leave nothing, or none, are the floor itself. */
export function narrowCallWindow(hours: CallWindow | null): CallWindow {
  if (!hours) return CALL_WINDOW_FLOOR;
  const startMinute = Math.max(CALL_WINDOW_FLOOR.startMinute, Math.trunc(hours.startMinute));
  const endMinute = Math.min(CALL_WINDOW_FLOOR.endMinute, Math.trunc(hours.endMinute));
  return startMinute < endMinute ? { startMinute, endMinute } : CALL_WINDOW_FLOOR;
}

export function evaluateDial(instant: string, zone: string | null, hours: CallWindow | null = null): DialEvaluation {
  if (!zone) return { dialAllowed: false, holdReason: 'state_not_cleared', holdCode: 'zone_unknown', localTime: null, openNow: null };
  const parts = localParts(instant, zone);
  const weekday = CALL_WINDOW_DAYS.includes(parts.weekday);
  const window = narrowCallWindow(hours);
  const inside = weekday && parts.minuteOfDay >= window.startMinute && parts.minuteOfDay < window.endMinute;
  const openNow = weekday && parts.minuteOfDay >= OPEN_HOURS.startMinute && parts.minuteOfDay < OPEN_HOURS.endMinute;
  return { dialAllowed: inside, holdReason: inside ? null : 'outside_hours', holdCode: inside ? null : 'outside_hours', localTime: localTimeLabel(parts), openNow };
}
