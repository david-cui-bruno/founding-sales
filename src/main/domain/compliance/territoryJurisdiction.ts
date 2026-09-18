import { isTerritoryState, TERRITORY_STATE_TIME_ZONES, territoryStateSchema, type TerritoryClearanceRecord } from '../../../shared/contracts/territoryClearanceContract';

/**
 * Pure derivation of a firm's jurisdiction and clearance from its Places
 * listing and the founder's per-state territory clearances (design D4). Used by
 * the route policy read beside the per-route receipt: a route with a hand-cited
 * receipt keeps using it; a business phone route without one is authorized
 * against the state clearance, and the derived jurisdiction is folded into the
 * authorization's `contextRevision` exactly like the receipt is today. Nothing
 * here reads the database or the clock.
 */

export type PlaceSource = Readonly<{ id: string; excerpt: string }>;
/** The row fields the derivation needs; the repository projects them from `territory_clearances`. */
export type { TerritoryClearanceRecord };
export type TerritoryHold = Readonly<{ kind: 'held'; reason: 'state_clearance_missing' | 'jurisdiction_unknown'; state: string | null }>;
export type TerritoryDerivation = Readonly<{
  kind: 'derived';
  state: string;
  sourceId: string;
  clearanceRevision: number;
  jurisdiction: { regionCode: string; timezone: string; reviewAt: string };
  clearance: { decision: 'allowed'; registrationConfirmed: true; stateDncSubscriptionConfirmed: true; consentRuleConfirmed: true; effectiveAt: string; expiresAt: string };
}>;
/** No Places listing exists for the route or the account: there is nothing to derive from, so the caller keeps its own "no evidence" answer. */
export type TerritoryAbsence = Readonly<{ kind: 'none' }>;
export type TerritoryResolution = TerritoryDerivation | TerritoryHold | TerritoryAbsence;

/** Places source ids are `place-<id>`; nothing else is a listing excerpt. */
export const isPlaceSourceId = (id: string): boolean => id.startsWith('place-');

/** The two-letter state before a ZIP at the end of a US `formattedAddress`, or null when the excerpt does not say. */
export function deriveStateFromPlacesExcerpt(excerpt: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(excerpt); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null || !('formattedAddress' in parsed)) return null;
  const address = (parsed as { formattedAddress?: unknown }).formattedAddress;
  if (typeof address !== 'string') return null;
  const match = /,\s*([A-Z]{2})\s+\d{5}(?:-\d{4})?(?:,\s*(?:USA|United States))?\s*$/.exec(address.trim());
  const state = match?.[1];
  if (state === undefined) return null;
  return territoryStateSchema.safeParse(state).success ? state : null;
}

/**
 * Prefer the route's own Places evidence; otherwise any Places source on the
 * account. Two listings naming different states is an unknown jurisdiction,
 * never a guess.
 */
export function resolveTerritoryJurisdiction(input: {
  sources: readonly PlaceSource[];
  routeEvidenceIds: readonly string[];
  clearances: readonly TerritoryClearanceRecord[];
  now: string;
}): TerritoryResolution {
  const places = input.sources.filter(source => isPlaceSourceId(source.id));
  if (places.length === 0) return { kind: 'none' };
  const preferred = places.filter(source => input.routeEvidenceIds.includes(source.id));
  const candidates = (preferred.length > 0 ? preferred : places)
    .map(source => ({ sourceId: source.id, state: deriveStateFromPlacesExcerpt(source.excerpt) }))
    .filter((entry): entry is { sourceId: string; state: string } => entry.state !== null);
  const states = new Set(candidates.map(entry => entry.state));
  const first = candidates[0];
  if (states.size !== 1 || first === undefined) return { kind: 'held', reason: 'jurisdiction_unknown', state: null };
  const { state, sourceId } = first;
  if (!isTerritoryState(state)) return { kind: 'held', reason: 'jurisdiction_unknown', state };
  const timezone = TERRITORY_STATE_TIME_ZONES[state];
  const clearance = input.clearances.find(entry => entry.state === state) ?? null;
  if (!clearance || clearance.revokedAt !== null || clearance.timezone !== timezone
    || clearance.confirmedAt > input.now || clearance.reviewAt <= input.now) return { kind: 'held', reason: 'state_clearance_missing', state };
  return {
    kind: 'derived', state, sourceId, clearanceRevision: clearance.revision,
    jurisdiction: { regionCode: state, timezone, reviewAt: clearance.reviewAt },
    clearance: { decision: 'allowed', registrationConfirmed: true, stateDncSubscriptionConfirmed: true, consentRuleConfirmed: true,
      effectiveAt: clearance.confirmedAt, expiresAt: clearance.reviewAt },
  };
}
