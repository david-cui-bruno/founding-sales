import { localParts, localTimeLabel } from './localClock.ts';

/**
 * Calling-window arithmetic.
 *
 * Ported from `cloud/lambdas/delegated-worker/src/v1/callWindow.ts`, with the old
 * module's two rules kept exactly:
 *
 *   * a configured window may only **narrow** the floor fixed in code, never widen it,
 *     and a configuration that leaves nothing is the floor itself;
 *   * a firm with no established zone cannot be placed on any clock, so it is a hold
 *     with the reason `posture_missing`-adjacent code below, never a guess.
 *
 * The specification's own vocabulary replaces the old hold words: revision 3 section
 * 9.2 evaluates the window as step 7 of `authorizeDial`, after the firm's actual zone
 * has been established, and refuses with `outside_calling_window`.
 */

export interface CallingWindow {
  /** Minutes from local midnight. */
  readonly startMinute: number;
  readonly endMinute: number;
}

/** The floor fixed in code: Monday to Friday, 08:00 to 20:00 on the firm's own clock. */
export const CALLING_WINDOW_FLOOR: CallingWindow = Object.freeze({
  startMinute: 8 * 60,
  endMinute: 20 * 60,
});

/** Monday to Friday. */
export const CALLING_WINDOW_WEEKDAYS: readonly number[] = Object.freeze([1, 2, 3, 4, 5]);

/** The usual business day, for the card's open-or-closed word. A guess from the zone, not posted hours. */
export const BUSINESS_HOURS: CallingWindow = Object.freeze({ startMinute: 9 * 60, endMinute: 17 * 60 });

/** Hours inside the floor: the later start and the earlier end. Anything emptier is the floor. */
export function narrowCallingWindow(configured: CallingWindow | null): CallingWindow {
  if (configured === null) return CALLING_WINDOW_FLOOR;
  const startMinute = Math.max(CALLING_WINDOW_FLOOR.startMinute, Math.trunc(configured.startMinute));
  const endMinute = Math.min(CALLING_WINDOW_FLOOR.endMinute, Math.trunc(configured.endMinute));
  return startMinute < endMinute ? { startMinute, endMinute } : CALLING_WINDOW_FLOOR;
}

export type CallingWindowRefusal = 'zone_unknown' | 'outside_calling_window';

export type CallingWindowDecision =
  | {
      readonly allowed: true;
      readonly localTime: string;
      readonly localDate: string;
      readonly openNow: boolean;
      readonly window: CallingWindow;
    }
  | {
      readonly allowed: false;
      readonly refusal: CallingWindowRefusal;
      readonly localTime: string | null;
      readonly localDate: string | null;
      readonly openNow: boolean | null;
      readonly window: CallingWindow;
    };

/**
 * Whether the firm's local clock currently permits a call.
 *
 * This is one input to `authorizeDial`, not the decision: suppression, calling
 * identity, route, assignment, posture and pauses are all checked around it, and the
 * first refusal wins (specification 9.2).
 */
export function evaluateCallingWindow(
  instant: string,
  zone: string | null,
  configured: CallingWindow | null = null,
): CallingWindowDecision {
  const window = narrowCallingWindow(configured);
  if (zone === null || zone.length === 0) {
    return { allowed: false, refusal: 'zone_unknown', localTime: null, localDate: null, openNow: null, window };
  }
  const parts = localParts(instant, zone);
  const onAWeekday = CALLING_WINDOW_WEEKDAYS.includes(parts.weekday);
  const inside = onAWeekday && parts.minuteOfDay >= window.startMinute && parts.minuteOfDay < window.endMinute;
  const openNow =
    onAWeekday && parts.minuteOfDay >= BUSINESS_HOURS.startMinute && parts.minuteOfDay < BUSINESS_HOURS.endMinute;
  if (!inside) {
    return {
      allowed: false,
      refusal: 'outside_calling_window',
      localTime: localTimeLabel(parts),
      localDate: parts.date,
      openNow,
      window,
    };
  }
  return { allowed: true, localTime: localTimeLabel(parts), localDate: parts.date, openNow, window };
}
