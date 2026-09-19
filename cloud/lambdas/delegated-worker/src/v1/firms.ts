import { z } from 'zod';
import { accountRecordSchema, type AccountRecord } from '../../../../../src/shared/contracts/accountRecordContract';
import type { AccountRoute } from '../../../../../src/shared/contracts/accountContract';
import { isTerritoryAddableState, isTerritoryMultiZoneState, isTerritoryState, TERRITORY_ADDABLE_STATE_TIME_ZONES, TERRITORY_STATE_TIME_ZONES,
  territoryStateSchema, type TerritoryState, type TerritoryTimeZone } from '../../../../../src/shared/contracts/territoryClearanceContract';
import type { DynamoStore } from '../dynamoStore';

/**
 * The firm read adapter of the rebuilt core (FSS target design section 2, slice S1). It builds one `FirmCard` per
 * firm from the records the worker keeps today: `ACCOUNT#` (name, site, routes, the Places listing source and the
 * business email claim), `TERRITORY_ENROLLMENT#` plus `CAMPAIGN_ENROLLMENT#` and its `CAMPAIGN_VERSION#` (where the
 * firm stands in the sequence), `CAMPAIGN_EVIDENCE#` (the calls already made under the old keys), `TERRITORY_RETIRED_ROUTE#`
 * (a number never dialed again) and `MAIL_SUPPRESSION#` (a firm that asked to stop). Everything is read with one prefix
 * query per record kind, never one read per firm, and a row the schema refuses is skipped, never coerced.
 *
 * State and zone are derived here and nowhere else: the state comes from the Places `formattedAddress` in the listing
 * source's excerpt, the zone from the fixed territory map first and the addable-state map second; a state that observes
 * two zones and is not in the fixed map has no zone. Each card records how it was derived. Unknown state or zone is a
 * hold (`state_not_cleared` with the closed code `state_unknown` or `zone_unknown`), never a guess and never a refusal.
 * Nothing here is an authority record: ordering inputs are research recency and evidence richness only.
 *
 * `FirmSource` is the seam S6 swaps for `FIRM#`: the list build and the Today view read cards through it and nothing else.
 */

export type FirmHold = { reason: 'state_not_cleared'; code: 'state_unknown' | 'zone_unknown' };
export type FirmDerivation =
  | { source: 'places_formatted_address'; sourceId: string; state: TerritoryState; zoneFrom: 'territory_state_map' | 'addable_state_map' }
  | { source: 'places_formatted_address'; sourceId: string; state: TerritoryState; zoneFrom: null; reason: 'state_spans_two_zones' | 'state_zone_not_recorded' }
  | { source: 'places_formatted_address'; sourceId: string; state: null; zoneFrom: null; reason: 'address_missing' | 'state_not_found' }
  | { source: 'none'; sourceId: null; state: null; zoneFrom: null; reason: 'no_places_source' };
export type FirmPhone = { routeId: string; number: string; verification: AccountRoute['verification'] };
export type FirmEnrollment = {
  enrollmentId: string; versionId: string; state: string; currentStepId: string | null; currentStepIndex: number | null;
  currentStepChannel: 'call' | 'email' | 'linkedin' | null; stepCount: number; nextDueAt: string | null; startedAt: string; restingUntil: string | null;
};
export type FirmCard = {
  firmId: string; name: string; website: string | null; phone: FirmPhone | null; businessEmail: string | null;
  city: string | null; state: TerritoryState | null; timeZone: TerritoryTimeZone | null; derivation: FirmDerivation; hold: FirmHold | null;
  /** When the firm's evidence was last admitted: the newest history entry. */
  researchedAt: string;
  /** Evidence richness: a business email counts two, a phone the firm itself published or confirmed counts one. A directory listing counts nothing. */
  evidenceScore: number;
  enrollment: FirmEnrollment | null;
  suppressed: 'mail_suppression' | 'sequence_stopped' | null;
  /** Calls already made under the old keys (a `CAMPAIGN_EVIDENCE#` call row that was actually dialed). */
  calls: number;
  lastCall: { outcome: string; at: string } | null;
};
export interface FirmSource { listFirms(): Promise<FirmCard[]> }

const PLACES_SOURCE_PREFIX = 'place-';
const NOT_A_CALL = new Set(['cancelled', 'not_called']);
/** Only the fields this adapter reads; the records' full shapes stay with their writers. */
const enrollmentLightSchema = z.object({ id: z.string(), accountId: z.string(), campaignVersionId: z.string(), currentStepId: z.string().nullable(),
  state: z.string(), startedAt: z.string(), nextDueAt: z.string().nullable().optional(), restingUntil: z.string().nullable().optional(), selectedRouteId: z.string() });
const versionLightSchema = z.object({ id: z.string(), steps: z.array(z.object({ id: z.string(), channel: z.enum(['call', 'email', 'linkedin']), delayHours: z.number() })) });
const territoryEnrollmentLightSchema = z.object({ accountId: z.string(), enrollmentId: z.string(), versionId: z.string(), routeId: z.string() });
const evidenceLightSchema = z.object({ accountId: z.string(), channel: z.string(), source: z.string(), outcome: z.string(), observedAt: z.string() });
const retiredLightSchema = z.object({ accountId: z.string(), routeId: z.string() });
const suppressionLightSchema = z.object({ accountId: z.string() });
const placesExcerptSchema = z.object({ formattedAddress: z.string().optional() });

/**
 * The state and city of a United States postal address as Google Places formats it (`street, city, ST 02903, USA`,
 * with or without the ZIP and the country). Pure. Anything that does not end that way, or names a code that is not
 * a US state, is `{ city: null, state: null }`: never a guess.
 */
export function parseUsAddress(formatted: string): { city: string | null; state: TerritoryState | null } {
  const match = /,\s*([^,]+?),\s*([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*(?:,\s*(?:USA|United States|US))?\s*$/.exec(formatted.trim())
    ?? /^([^,]+?),\s*([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*(?:,\s*(?:USA|United States|US))?\s*$/.exec(formatted.trim());
  if (!match) return { city: null, state: null };
  const state = territoryStateSchema.safeParse(match[2]);
  if (!state.success) return { city: null, state: null };
  const city = match[1]!.trim();
  return { city: city.length ? city : null, state: state.data };
}

/** State, city, zone and the record of how they were derived, from the firm's Places listing source. Pure. */
export function deriveStateAndZone(record: AccountRecord): { city: string | null; state: TerritoryState | null; timeZone: TerritoryTimeZone | null; derivation: FirmDerivation; hold: FirmHold | null } {
  const listing = record.sources.find(source => source.id.startsWith(PLACES_SOURCE_PREFIX));
  if (!listing) return { city: null, state: null, timeZone: null, derivation: { source: 'none', sourceId: null, state: null, zoneFrom: null, reason: 'no_places_source' }, hold: { reason: 'state_not_cleared', code: 'state_unknown' } };
  let formatted: string | undefined;
  try { formatted = placesExcerptSchema.parse(JSON.parse(listing.excerpt)).formattedAddress; } catch { formatted = undefined; }
  const sourceId = listing.id;
  if (!formatted) return { city: null, state: null, timeZone: null, derivation: { source: 'places_formatted_address', sourceId, state: null, zoneFrom: null, reason: 'address_missing' }, hold: { reason: 'state_not_cleared', code: 'state_unknown' } };
  const { city, state } = parseUsAddress(formatted);
  if (!state) return { city: null, state: null, timeZone: null, derivation: { source: 'places_formatted_address', sourceId, state: null, zoneFrom: null, reason: 'state_not_found' }, hold: { reason: 'state_not_cleared', code: 'state_unknown' } };
  // The fixed territory map first (Texas is there with America/Chicago by David's decision), then the single-zone states he may add.
  if (isTerritoryState(state)) return { city, state, timeZone: TERRITORY_STATE_TIME_ZONES[state], derivation: { source: 'places_formatted_address', sourceId, state, zoneFrom: 'territory_state_map' }, hold: null };
  if (isTerritoryAddableState(state)) return { city, state, timeZone: TERRITORY_ADDABLE_STATE_TIME_ZONES[state], derivation: { source: 'places_formatted_address', sourceId, state, zoneFrom: 'addable_state_map' }, hold: null };
  const reason = isTerritoryMultiZoneState(state) ? 'state_spans_two_zones' : 'state_zone_not_recorded';
  return { city, state, timeZone: null, derivation: { source: 'places_formatted_address', sourceId, state, zoneFrom: null, reason }, hold: { reason: 'state_not_cleared', code: 'zone_unknown' } };
}

/** The newest stored version of each route id. */
function newestRoutes(routes: readonly AccountRoute[]): AccountRoute[] {
  const newest = new Map<string, AccountRoute>();
  for (const route of routes) { const held = newest.get(route.id); if (!held || held.version < route.version) newest.set(route.id, route); }
  return [...newest.values()];
}
/**
 * The phone the card offers: the enrolled route when the sequence selected one and it is not retired; otherwise the
 * best remaining business phone, a number from the firm's own page before a directory listing, never an unverified one.
 */
function selectPhone(routes: readonly AccountRoute[], retired: ReadonlySet<string>, selectedRouteId: string | null): FirmPhone | null {
  const candidates = newestRoutes(routes).filter(route => route.channel === 'phone' && route.purpose === 'business' && route.verification !== 'unverified' && !retired.has(route.id));
  const selected = selectedRouteId ? candidates.find(route => route.id === selectedRouteId) : undefined;
  const rank = (route: AccountRoute) => route.verification === 'published' ? 0 : route.verification === 'confirmed' ? 1 : 2;
  const chosen = selected ?? [...candidates].sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  return chosen ? { routeId: chosen.id, number: chosen.value, verification: chosen.verification } : null;
}

async function listParsed<T>(store: DynamoStore, prefix: string, schema: z.ZodType<T>): Promise<T[]> {
  return (await store.list<unknown>(prefix)).flatMap(row => { const parsed = schema.safeParse(row.stored.data); return parsed.success ? [parsed.data] : []; });
}

/** Today's records as the firm source. Seven prefix queries per listing, one card per `ACCOUNT#` row that parses. */
export function createAccountFirmSource(store: DynamoStore): FirmSource {
  return { async listFirms(): Promise<FirmCard[]> {
    const [accounts, territory, enrollments, versions, evidence, retiredRows, suppressions] = await Promise.all([
      listParsed(store, 'ACCOUNT#', accountRecordSchema), listParsed(store, 'TERRITORY_ENROLLMENT#', territoryEnrollmentLightSchema),
      listParsed(store, 'CAMPAIGN_ENROLLMENT#', enrollmentLightSchema), listParsed(store, 'CAMPAIGN_VERSION#', versionLightSchema),
      listParsed(store, 'CAMPAIGN_EVIDENCE#', evidenceLightSchema), listParsed(store, 'TERRITORY_RETIRED_ROUTE#', retiredLightSchema),
      listParsed(store, 'MAIL_SUPPRESSION#', suppressionLightSchema)]);
    const territoryByFirm = new Map(territory.map(row => [row.accountId, row]));
    const enrollmentById = new Map(enrollments.map(row => [row.id, row]));
    const versionById = new Map(versions.map(row => [row.id, row]));
    const suppressed = new Set(suppressions.map(row => row.accountId));
    const retiredByFirm = new Map<string, Set<string>>();
    for (const row of retiredRows) { const set = retiredByFirm.get(row.accountId) ?? new Set<string>(); set.add(row.routeId); retiredByFirm.set(row.accountId, set); }
    const callsByFirm = new Map<string, { outcome: string; at: string }[]>();
    for (const row of evidence) {
      if (row.channel !== 'call' || row.source !== 'human' || NOT_A_CALL.has(row.outcome)) continue;
      const calls = callsByFirm.get(row.accountId) ?? []; calls.push({ outcome: row.outcome, at: row.observedAt }); callsByFirm.set(row.accountId, calls);
    }
    return accounts.map(record => {
      const firmId = record.account.id;
      const derived = deriveStateAndZone(record);
      const territoryRow = territoryByFirm.get(firmId);
      const enrollmentRow = territoryRow ? enrollmentById.get(territoryRow.enrollmentId) : undefined;
      let enrollment: FirmEnrollment | null = null;
      if (enrollmentRow) {
        const version = versionById.get(enrollmentRow.campaignVersionId);
        const index = version ? version.steps.findIndex(step => step.id === enrollmentRow.currentStepId) : -1;
        const step = index >= 0 ? version!.steps[index] : undefined;
        const nextDueAt = enrollmentRow.nextDueAt !== undefined ? enrollmentRow.nextDueAt
          : step ? new Date(Date.parse(enrollmentRow.startedAt) + step.delayHours * 3600000).toISOString() : null;
        enrollment = { enrollmentId: enrollmentRow.id, versionId: enrollmentRow.campaignVersionId, state: enrollmentRow.state, currentStepId: enrollmentRow.currentStepId,
          currentStepIndex: index >= 0 ? index : null, currentStepChannel: step?.channel ?? null, stepCount: version?.steps.length ?? 0,
          nextDueAt, startedAt: enrollmentRow.startedAt, restingUntil: enrollmentRow.restingUntil ?? null };
      }
      const phone = selectPhone(record.routes, retiredByFirm.get(firmId) ?? new Set(), enrollmentRow?.selectedRouteId ?? null);
      const email = record.claims.find(claim => claim.key === 'business_email');
      const businessEmail = email?.key === 'business_email' ? email.value : null;
      const calls = [...(callsByFirm.get(firmId) ?? [])].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
      const researchedAt = record.history.reduce((latest, entry) => entry.at > latest ? entry.at : latest, record.history[0]!.at);
      const evidenceScore = (businessEmail ? 2 : 0) + (phone && (phone.verification === 'published' || phone.verification === 'confirmed') ? 1 : 0);
      return { firmId, name: record.account.name, website: record.account.domain, phone, businessEmail, city: derived.city, state: derived.state, timeZone: derived.timeZone,
        derivation: derived.derivation, hold: derived.hold, researchedAt, evidenceScore, enrollment,
        suppressed: suppressed.has(firmId) ? 'mail_suppression' : enrollment?.state === 'stopped' ? 'sequence_stopped' : null,
        calls: calls.length, lastCall: calls.at(-1) ?? null };
    });
  } };
}
