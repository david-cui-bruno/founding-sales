import type { FirmLocation, FirmZoneSource } from '../src/rules/statePosture.ts';
import { isKnownTimeZone } from '../src/rules/localClock.ts';

/**
 * The postal source behind G0's firm time-zone seam (specification 9.2).
 *
 * "Multi-zone states do not use a state-wide time-zone shortcut. The firm's zone is
 * resolved from location or postal data under a versioned source rule; inability to
 * establish it blocks calling."
 *
 * `resolveFirmZone` in `@fss/domain` is the seam; this is the source G3a plugs into
 * it. It answers only where a three-digit ZIP prefix determines the zone beyond
 * argument, and `null` everywhere else — which leaves `resolveFirmZone` to fall
 * through to the single-zone state default or to `state_spans_zones`, and leaves the
 * firm uncallable. That is the conservative option the specification asks for, and it
 * is deliberately the common case in version one: a wrong zone is a call at the wrong
 * hour, and a missing zone is a hold.
 *
 * ## What the table covers, and why it is this small
 *
 * Of the fifteen multi-zone states, two have a boundary that follows whole ZIP
 * prefixes cleanly enough to write down:
 *
 *   * **Texas** is Central except El Paso and Hudspeth counties, which are Mountain.
 *     Those are the `798`, `799` and `885` prefixes and nothing else.
 *   * **Florida** is Eastern except the western panhandle, which is Central. The
 *     `324` and `325` prefixes are entirely in it.
 *
 * The other thirteen have boundaries that cut through prefixes — Michigan's Upper
 * Peninsula, Indiana's county-by-county line, the Navajo Nation in Arizona, the
 * Nebraska and Dakota panhandles. A three-digit guess there would be wrong for real
 * firms, so they are absent and their firms stay unresolved until someone records the
 * zone deliberately. Extending this table is a versioned change: bump
 * `POSTAL_ZONE_RULE_VERSION` and the firms resolved under the old one can be found.
 */

export const POSTAL_ZONE_RULE_VERSION = 'postal-zone.1';

interface PostalZoneRule {
  /** The zone the rest of the state observes. */
  readonly majority: string;
  /** Three-digit ZIP prefixes that observe a different zone, and which one. */
  readonly exceptions: Readonly<Record<string, string>>;
}

const POSTAL_ZONE_RULES: Readonly<Record<string, PostalZoneRule>> = Object.freeze({
  TX: Object.freeze({
    majority: 'America/Chicago',
    exceptions: Object.freeze({
      '798': 'America/Denver',
      '799': 'America/Denver',
      '885': 'America/Denver',
    }),
  }),
  FL: Object.freeze({
    majority: 'America/New_York',
    exceptions: Object.freeze({
      '324': 'America/Chicago',
      '325': 'America/Chicago',
    }),
  }),
});

/** The three-digit prefix of a US postal code, or null when it is not one. */
export function postalPrefix(postalCode: string): string | null {
  const digits = postalCode.trim().replace(/[^0-9]/gu, '');
  return digits.length >= 5 ? digits.slice(0, 3) : null;
}

/**
 * The zone a US postal code determines, or null when this table does not know.
 *
 * Exported separately from the source object so a test can ask it directly, and so
 * the research lane can reuse it without owning a `FirmZoneSource`.
 */
export function zoneForPostalCode(state: string, postalCode: string): string | null {
  const rule = POSTAL_ZONE_RULES[state.trim().toUpperCase()];
  if (rule === undefined) return null;
  const prefix = postalPrefix(postalCode);
  if (prefix === null) return null;
  const zone = rule.exceptions[prefix] ?? rule.majority;
  // A zone this process cannot place on a clock is worse than no zone at all.
  return isKnownTimeZone(zone) ? zone : null;
}

/** The source to hand `resolveFirmZone`. Never throws, never guesses (9.2). */
export const postalZoneSource: FirmZoneSource = Object.freeze({
  name: 'postal',
  resolve(location: FirmLocation): string | null {
    const state = location.state;
    const postalCode = location.postalCode;
    if (state === undefined || postalCode === undefined) return null;
    return zoneForPostalCode(state, postalCode);
  },
});

/** The sources a CRM command resolves a firm's zone through, in order. */
export const FIRM_ZONE_SOURCES: readonly FirmZoneSource[] = Object.freeze([postalZoneSource]);
