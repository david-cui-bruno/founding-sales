import { postalZoneSource } from '../crm/zone.ts';
import { isKnownTimeZone } from '../src/rules/localClock.ts';
import { isUsStateCode, MULTI_ZONE_STATES, type FirmLocation, type FirmZoneSource } from '../src/rules/statePosture.ts';

/**
 * The coordinate time-zone source, and the source order research resolves a firm's
 * zone through (specification 9.2, and the coordinator's note of 20 September).
 *
 * G3a filled G0's `resolveFirmZone` seam with a three-digit postal table that answers
 * for Texas and Florida and refuses the other thirteen multi-zone states, and its
 * decision record ends with a question: a discovery provider returns coordinates for
 * most firms, and a coordinate is a better source than a postal prefix, so should the
 * postal table be superseded rather than grown? The answer is yes, and this is the
 * better source. `docs/decisions/g10-coordinate-zone-source.md` records it.
 *
 * ## What this is, and what it is not
 *
 * It is **not** a reverse geocoder and it is not a time-zone shapefile. A real
 * boundary dataset is a dependency, a licence and a periodic update, and version one
 * needs none of that to be *correct* — it needs to be correct or silent.
 *
 * So it is a per-state boundary table. Within one state a United States time-zone
 * boundary is close enough to a single meridian, or in Idaho's case a single parallel,
 * to write down; across states it is not, which is why the table is keyed by state and
 * why a firm with a coordinate and no state gets nothing from it.
 *
 * ## The margin is the whole design
 *
 * Every rule carries a `margin` in degrees, and a coordinate inside the margin
 * resolves to **nothing**. G3a's asymmetry argument applies unchanged and is worth
 * restating: a missing zone is a hold, which a person clears by recording the zone; a
 * *wrong* zone is a call placed outside the recipient's local business window, which
 * invariant 2 exists to prevent and which the software can never detect afterwards.
 * So the table answers the interior of each side and refuses the seam.
 *
 * A rule side may also be `null`, which refuses that side outright. Indiana's western
 * counties, Oregon's Malheur County and Nevada's West Wendover are enclaves whose
 * boundary is not a meridian at all; the honest encoding is to resolve the large side
 * and say nothing about the small one. Arizona is absent from the table entirely: the
 * part of it that observes daylight saving is the Navajo Nation, and that is a polygon.
 *
 * ## Coverage, against G3a's two states
 *
 * Eleven of the fifteen multi-zone states now resolve in their interiors, including
 * the thirteen G3a had to refuse. Texas and Florida keep answering, and the postal
 * table stays behind this source as the fallback for a hand-entered firm that has an
 * address but no coordinate. It is not grown.
 */

export const COORDINATE_ZONE_RULE_VERSION = 'coordinate-zone.1';

interface CoordinateZoneRule {
  /** Which coordinate the boundary runs along. Idaho's is a parallel; the rest are meridians. */
  readonly axis: 'longitude' | 'latitude';
  readonly boundary: number;
  /** Degrees either side of the boundary in which this rule answers nothing. */
  readonly margin: number;
  /** The zone west of, or south of, the boundary. Null refuses that side. */
  readonly lower: string | null;
  /** The zone east of, or north of, the boundary. Null refuses that side. */
  readonly upper: string | null;
  /** Why the table is drawn this way for this state. Read by a person, not by code. */
  readonly note: string;
}

const RULES: Readonly<Record<string, CoordinateZoneRule>> = Object.freeze({
  AK: Object.freeze({
    axis: 'longitude', boundary: -169.5, margin: 0.5,
    lower: 'America/Adak', upper: 'America/Anchorage',
    note: 'The western Aleutians observe Hawaii-Aleutian time; the boundary is near the 169.5 degree meridian.',
  }),
  FL: Object.freeze({
    axis: 'longitude', boundary: -85.0, margin: 0.25,
    lower: 'America/Chicago', upper: 'America/New_York',
    note: 'The western panhandle is Central; the boundary follows the Apalachicola River, near 85 degrees west.',
  }),
  ID: Object.freeze({
    axis: 'latitude', boundary: 45.5, margin: 0.3,
    lower: 'America/Boise', upper: 'America/Los_Angeles',
    note: 'The northern panhandle is Pacific; the boundary follows the Salmon River, near the 45.5 degree parallel.',
  }),
  IN: Object.freeze({
    axis: 'longitude', boundary: -87.3, margin: 1.0,
    lower: null, upper: 'America/Indiana/Indianapolis',
    note: 'Most of the state is Eastern. The twelve Central counties are two enclaves whose edges are county lines, not a meridian, so the western side refuses.',
  }),
  KS: Object.freeze({
    axis: 'longitude', boundary: -101.5, margin: 0.3,
    lower: 'America/Denver', upper: 'America/Chicago',
    note: 'Four far-western counties are Mountain; the boundary is a county line near 101.5 degrees west.',
  }),
  KY: Object.freeze({
    axis: 'longitude', boundary: -86.0, margin: 0.2,
    lower: 'America/Chicago', upper: 'America/Kentucky/Louisville',
    note: 'The western half is Central. Louisville is Eastern and sits close to the line, which is why the margin is narrow.',
  }),
  MI: Object.freeze({
    axis: 'longitude', boundary: -87.6, margin: 0.3,
    lower: 'America/Menominee', upper: 'America/Detroit',
    note: 'Four western Upper Peninsula counties are Central; the boundary is near 87.6 degrees west.',
  }),
  NE: Object.freeze({
    axis: 'longitude', boundary: -101.2, margin: 0.3,
    lower: 'America/Denver', upper: 'America/Chicago',
    note: 'The panhandle is Mountain; the boundary follows county lines near 101.2 degrees west.',
  }),
  NV: Object.freeze({
    axis: 'longitude', boundary: -114.1, margin: 0.4,
    lower: 'America/Los_Angeles', upper: null,
    note: 'The state is Pacific apart from one town on the Utah border, so the eastern side refuses rather than claim it.',
  }),
  ND: Object.freeze({
    axis: 'longitude', boundary: -101.0, margin: 0.4,
    lower: 'America/Denver', upper: 'America/Chicago',
    note: 'The south-west is Mountain; the boundary follows county lines near 101 degrees west.',
  }),
  OR: Object.freeze({
    axis: 'longitude', boundary: -118.5, margin: 0.3,
    lower: 'America/Los_Angeles', upper: null,
    note: 'The state is Pacific apart from most of Malheur County in the south-east, which is bounded by latitude as well, so the eastern side refuses.',
  }),
  SD: Object.freeze({
    axis: 'longitude', boundary: -100.5, margin: 0.4,
    lower: 'America/Denver', upper: 'America/Chicago',
    note: 'The western half is Mountain; the boundary follows the Missouri River and county lines near 100.5 degrees west.',
  }),
  TN: Object.freeze({
    axis: 'longitude', boundary: -85.5, margin: 0.3,
    lower: 'America/Chicago', upper: 'America/New_York',
    note: 'East Tennessee is Eastern; the boundary runs near 85.5 degrees west.',
  }),
  TX: Object.freeze({
    axis: 'longitude', boundary: -105.0, margin: 0.5,
    lower: 'America/Denver', upper: 'America/Chicago',
    note: 'El Paso and Hudspeth counties are Mountain; the margin is wide because Hudspeth reaches east of 105 degrees.',
  }),
  // AZ is deliberately absent. The part of Arizona that observes daylight saving is
  // the Navajo Nation, whose border is a polygon; no meridian or parallel separates it.
});

/** The states this source can answer for at all. Exported so a test can assert the set. */
export const COORDINATE_ZONE_STATES: readonly string[] = Object.freeze(Object.keys(RULES).sort());

export interface Coordinate {
  readonly latitude: number;
  readonly longitude: number;
}

/** True when the pair is a real coordinate on Earth. A provider's `0, 0` is not one. */
export function isUsableCoordinate(value: Coordinate): boolean {
  return (
    Number.isFinite(value.latitude) &&
    Number.isFinite(value.longitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90 &&
    value.longitude >= -180 &&
    value.longitude <= 180 &&
    !(value.latitude === 0 && value.longitude === 0)
  );
}

/**
 * The zone a coordinate determines inside a state, or null when this table does not
 * know — which includes every single-zone state, because their zone is the state's and
 * `resolveFirmZone` already has it.
 *
 * Exported separately from the source object so a test can ask it directly.
 */
export function zoneForCoordinate(state: string, coordinate: Coordinate): string | null {
  const code = state.trim().toUpperCase();
  if (!isUsStateCode(code)) return null;
  // A single-zone state has one answer and it is not a coordinate's to give: letting
  // this source answer there would label the state rule's certainty as a coordinate's.
  if (MULTI_ZONE_STATES[code] === undefined) return null;
  const rule = RULES[code];
  if (rule === undefined) return null;
  if (!isUsableCoordinate(coordinate)) return null;

  const value = rule.axis === 'longitude' ? coordinate.longitude : coordinate.latitude;
  const zone =
    value <= rule.boundary - rule.margin ? rule.lower : value >= rule.boundary + rule.margin ? rule.upper : null;
  if (zone === null) return null;
  // A zone this process cannot place on a clock is worse than no zone at all.
  if (!isKnownTimeZone(zone)) return null;
  // The answer must be one of the two zones the state is known to observe. A table
  // edit that produced a third would be a typo, and a typo here is a wrong call hour.
  const observed = MULTI_ZONE_STATES[code];
  return observed !== undefined && (observed[0] === zone || observed[1] === zone) ? zone : null;
}

/** The coordinate source to hand `resolveFirmZone`. Never throws, never guesses. */
export const coordinateZoneSource: FirmZoneSource = Object.freeze({
  name: 'coordinates',
  resolve(location: FirmLocation): string | null {
    const state = location.state;
    const latitude = location.latitude;
    const longitude = location.longitude;
    if (state === undefined || latitude === undefined || longitude === undefined) return null;
    return zoneForCoordinate(state, { latitude, longitude });
  },
});

/**
 * The sources a research path resolves a firm's zone through, in order: the firm's own
 * coordinate first, then G3a's postal table.
 *
 * `FIRM_ZONE_SOURCES` in `@fss/domain/crm` keeps the postal source alone, and that is
 * correct rather than an oversight: a firm typed in by hand has an address and no
 * coordinate, so consulting a coordinate source there would only ever return null.
 * Research is the path that has coordinates, so research is the path that carries them.
 */
export const RESEARCH_FIRM_ZONE_SOURCES: readonly FirmZoneSource[] = Object.freeze([
  coordinateZoneSource,
  postalZoneSource,
]);
