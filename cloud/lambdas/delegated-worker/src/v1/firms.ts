import { z } from 'zod';
import { accountRecordSchema } from '../../../../../src/shared/contracts/accountRecordContract';
import type { AccountRoute } from '../../../../../src/shared/contracts/accountContract';
import { isTerritoryAddableState, isTerritoryState, TERRITORY_ADDABLE_STATE_TIME_ZONES, TERRITORY_STATE_TIME_ZONES,
  type TerritoryState, type TerritoryTimeZone } from '../../../../../src/shared/contracts/territoryClearanceContract';
import type { DynamoStore } from '../dynamoStore';
// S4 moved the derivation into `evidence.ts` as the single implementation; this adapter and the backfill job
// both call it, so a firm's state and zone can never be derived two different ways.
import { deriveStateAndZone, type FirmDerivation, type FirmHold } from './evidence';
export { deriveStateAndZone, parseUsAddress, type FirmDerivation, type FirmHold } from './evidence';
import { listFirmRecords, type FirmRecord, type FirmRouteLike } from './firmsWrite';
import { listSuppressedFirmIds } from './suppression';

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
 *
 * Slice S2 adds the new-shape reads beside the old ones, so one card can come from either core: the `FIRM#` records
 * (a firm David entered by hand, and the routes he admitted by hand on a researched firm) and the `SUPPRESS#FIRM#`
 * set. New first, old second — a firm suppressed under either shape is suppressed, and a hand-admitted route ranks
 * by exactly the same rule as a researched one.
 */

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
  /** The newest stored version of every route the firm carries, researched or hand-admitted; what a wrong number selects a replacement from (S2). */
  routes: FirmRouteLike[];
  /** Routes never dialed again: this firm's `TERRITORY_RETIRED_ROUTE#` rows, sorted. */
  retiredRouteIds: string[];
  /** Whether the firm itself came from research or from David's own hand (S2, `add_firm`). */
  enteredBy: 'research' | 'hand';
  /** How many fetched sources back the firm's record; zero for a hand-entered firm, which has no evidence yet. */
  sourceCount: number;
  suppressed: 'mail_suppression' | 'sequence_stopped' | 'suppression_set' | null;
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

/** The newest stored version of each route id, whichever shape wrote it. */
function newestRoutes(routes: readonly FirmRouteLike[]): FirmRouteLike[] {
  const newest = new Map<string, FirmRouteLike>();
  for (const route of routes) { const held = newest.get(route.id); if (!held || held.version < route.version) newest.set(route.id, route); }
  return [...newest.values()];
}
/**
 * The phone the card offers: the enrolled route when the sequence selected one and it is not retired; otherwise the
 * best remaining business phone, a number from the firm's own page before a directory listing, never an unverified one.
 */
function selectPhone(routes: readonly FirmRouteLike[], retired: ReadonlySet<string>, selectedRouteId: string | null): FirmPhone | null {
  const candidates = newestRoutes(routes).filter(route => route.channel === 'phone' && route.purpose === 'business' && route.verification !== 'unverified' && !retired.has(route.id));
  const selected = selectedRouteId ? candidates.find(route => route.id === selectedRouteId) : undefined;
  const rank = (route: FirmRouteLike) => route.verification === 'published' ? 0 : route.verification === 'confirmed' ? 1 : 2;
  const chosen = selected ?? [...candidates].sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  return chosen ? { routeId: chosen.id, number: chosen.value, verification: chosen.verification } : null;
}

async function listParsed<T>(store: DynamoStore, prefix: string, schema: z.ZodType<T>): Promise<T[]> {
  return (await store.list<unknown>(prefix)).flatMap(row => { const parsed = schema.safeParse(row.stored.data); return parsed.success ? [parsed.data] : []; });
}

/**
 * Today's records as the firm source: nine prefix queries per listing, one card per `ACCOUNT#` row that parses, plus
 * one card per firm that exists only as a `FIRM#` record because David typed it in. Never one read per firm.
 */
export function createAccountFirmSource(store: DynamoStore): FirmSource {
  return { async listFirms(): Promise<FirmCard[]> {
    const [accounts, territory, enrollments, versions, evidence, retiredRows, suppressions, firmRecords, suppressedIds] = await Promise.all([
      listParsed(store, 'ACCOUNT#', accountRecordSchema), listParsed(store, 'TERRITORY_ENROLLMENT#', territoryEnrollmentLightSchema),
      listParsed(store, 'CAMPAIGN_ENROLLMENT#', enrollmentLightSchema), listParsed(store, 'CAMPAIGN_VERSION#', versionLightSchema),
      listParsed(store, 'CAMPAIGN_EVIDENCE#', evidenceLightSchema), listParsed(store, 'TERRITORY_RETIRED_ROUTE#', retiredLightSchema),
      listParsed(store, 'MAIL_SUPPRESSION#', suppressionLightSchema), listFirmRecords(store), listSuppressedFirmIds(store)]);
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
    const cards: FirmCard[] = accounts.map(record => {
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
      // Routes David admitted by hand on this firm live on its `FIRM#` record, never inside the researched record.
      const routes = newestRoutes([...record.routes, ...(firmRecords.get(firmId)?.routes ?? [])]);
      const phone = selectPhone(routes, retiredByFirm.get(firmId) ?? new Set(), enrollmentRow?.selectedRouteId ?? null);
      const email = record.claims.find(claim => claim.key === 'business_email');
      const businessEmail = email?.key === 'business_email' ? email.value : null;
      const calls = [...(callsByFirm.get(firmId) ?? [])].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
      const researchedAt = record.history.reduce((latest, entry) => entry.at > latest ? entry.at : latest, record.history[0]!.at);
      const evidenceScore = (businessEmail ? 2 : 0) + (phone && (phone.verification === 'published' || phone.verification === 'confirmed') ? 1 : 0);
      return { firmId, name: record.account.name, website: record.account.domain, phone, businessEmail, city: derived.city, state: derived.state, timeZone: derived.timeZone,
        derivation: derived.derivation, hold: derived.hold, researchedAt, evidenceScore, enrollment,
        routes, retiredRouteIds: [...(retiredByFirm.get(firmId) ?? new Set<string>())].sort(), enteredBy: 'research', sourceCount: record.sources.length,
        suppressed: suppressedIds.has(firmId) ? 'suppression_set' : suppressed.has(firmId) ? 'mail_suppression' : enrollment?.state === 'stopped' ? 'sequence_stopped' : null,
        calls: calls.length, lastCall: calls.at(-1) ?? null };
    });
    // A firm David typed in has no `ACCOUNT#` row of its own; its card comes from its `FIRM#` record, with the same
    // enrollment, retired-route, call and suppression joins applied, so it is a card like any other.
    const researched = new Set(cards.map(card => card.firmId));
    for (const record of firmRecords.values()) {
      if (researched.has(record.firmId) || record.enteredBy !== 'hand') continue;
      cards.push(handEnteredCard(record, { territoryByFirm, enrollmentById, versionById, retiredByFirm, callsByFirm, suppressed, suppressedIds }));
    }
    return cards;
  } };
}

type FirmJoins = {
  territoryByFirm: ReadonlyMap<string, { accountId: string; enrollmentId: string; versionId: string; routeId: string }>;
  enrollmentById: ReadonlyMap<string, z.infer<typeof enrollmentLightSchema>>;
  versionById: ReadonlyMap<string, z.infer<typeof versionLightSchema>>;
  retiredByFirm: ReadonlyMap<string, Set<string>>;
  callsByFirm: ReadonlyMap<string, { outcome: string; at: string }[]>;
  suppressed: ReadonlySet<string>;
  suppressedIds: ReadonlySet<string>;
};

/** One card for a firm that exists only as a `FIRM#` record: the state David named, the zone the record derived. */
function handEnteredCard(record: FirmRecord, joins: FirmJoins): FirmCard {
  const state = record.state;
  const timeZone = territoryTimeZoneOf(record);
  const derivation: FirmDerivation = state && timeZone && record.derivedZoneFrom
    ? { source: 'hand_entered', sourceId: null, state, zoneFrom: record.derivedZoneFrom }
    : { source: 'hand_entered', sourceId: null, state, zoneFrom: null, reason: state ? 'state_zone_not_recorded' : 'state_not_found' };
  const hold: FirmHold | null = !state ? { reason: 'state_not_cleared', code: 'state_unknown' }
    : !timeZone ? { reason: 'state_not_cleared', code: 'zone_unknown' } : null;
  const territoryRow = joins.territoryByFirm.get(record.firmId);
  const enrollmentRow = territoryRow ? joins.enrollmentById.get(territoryRow.enrollmentId) : undefined;
  const retiredRouteIds = [...(joins.retiredByFirm.get(record.firmId) ?? new Set<string>())].sort();
  const routes = newestRoutes(record.routes);
  const phone = selectPhone(routes, new Set(retiredRouteIds), enrollmentRow?.selectedRouteId ?? null);
  const businessEmail = routes.find(route => route.channel === 'email')?.value ?? null;
  const calls = [...(joins.callsByFirm.get(record.firmId) ?? [])].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  return { firmId: record.firmId, name: record.name, website: record.domain, phone, businessEmail, city: record.city, state, timeZone,
    derivation, hold, researchedAt: record.enteredAt,
    evidenceScore: (businessEmail ? 2 : 0) + (phone && (phone.verification === 'published' || phone.verification === 'confirmed') ? 1 : 0),
    enrollment: null, routes, retiredRouteIds, enteredBy: 'hand', sourceCount: 0,
    suppressed: joins.suppressedIds.has(record.firmId) ? 'suppression_set' : joins.suppressed.has(record.firmId) ? 'mail_suppression' : null,
    calls: calls.length, lastCall: calls.at(-1) ?? null };
}

/** The zone on a `FIRM#` record, only when it is one the territory contract actually records. */
function territoryTimeZoneOf(record: FirmRecord): TerritoryTimeZone | null {
  if (!record.state) return null;
  if (isTerritoryState(record.state)) return TERRITORY_STATE_TIME_ZONES[record.state];
  if (isTerritoryAddableState(record.state)) return TERRITORY_ADDABLE_STATE_TIME_ZONES[record.state];
  return null;
}
