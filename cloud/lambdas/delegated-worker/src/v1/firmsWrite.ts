import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { accountInstantSchema, accountRouteSchema } from '../../../../../src/shared/contracts/accountContract';
import { isExcludedNumber } from '../../../../../src/main/communications/excludedNumbers';
import { FREE_MAIL_DOMAINS } from '../../../../../src/main/research/businessEmailDiscovery';
import { isTerritoryAddableState, isTerritoryState, TERRITORY_ADDABLE_STATE_TIME_ZONES, TERRITORY_STATE_TIME_ZONES,
  territoryStateSchema, type TerritoryState, type TerritoryTimeZone } from '../../../../../src/shared/contracts/territoryClearanceContract';
import { v1FirmStatusSchema, type AddFirmCommand, type AdmitRouteCommand, type V1FirmStatus } from '../../../../../src/shared/contracts/v1Contract';
import { sha256Utf8 } from '../../../../../src/shared/crypto/sha256';
import { keyPart, type DynamoStore } from '../dynamoStore';
import { canonicalHandle, readFirmSuppression } from './suppression';

/**
 * Firms and routes David enters by hand (FSS target design section 3, `add_firm` and `admit_route`; slice S2), and
 * the `FIRM#<firmId>` record they are written to. A hand-entered firm enters the pool like a researched one: it
 * carries the state David named, the zone derived from that state through the same two maps the research path uses,
 * status `new`, no evidence at all, and it enqueues nothing — research is S4 and it is never started from here.
 *
 * The record is the new shape, written beside the old `ACCOUNT#` records rather than into them: an `ACCOUNT#` route
 * needs a fetched source with an https URL and a sha256 of its excerpt, and a number David typed has none. So a
 * hand-admitted route lives on the `FIRM#` record, and the firm read adapter joins it to whatever the firm already
 * has. That is the same new-first, old-second reading the sequence uses, and it is what S6 keeps when the old records go.
 *
 * Both commands are refused on a suppressed firm, whichever shape suppressed it. Nothing here dials, sends or books,
 * and no route is ever removed: `admit_route` only ever adds.
 */

export const FIRM_PREFIX = 'FIRM#';
export const firmKey = (firmId: string): string => `${FIRM_PREFIX}${keyPart(firmId)}`;
/** Firm ids keep today's shape (`account-…`), so one id space spans both cores. */
export const HAND_ENTERED_FIRM_ID_PREFIX = 'account-';
/** The verification word a number or address David typed himself carries: he confirms it, no page published it. */
export const HAND_ENTERED_VERIFICATION = 'confirmed' as const;

const instant = accountInstantSchema;
const freeMail = new Set(FREE_MAIL_DOMAINS);
const domainSchema = z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/);

/**
 * A route David typed in. Deliberately not `accountRouteSchema`: that schema requires at least one evidence id
 * naming a fetched source with its URL and the sha256 of its excerpt, and a number David read off a business card
 * has none. Claiming a source here would be a fabricated citation, so the hand-entered route carries no evidence at
 * all and says so through its verification word. Every field the firm read adapter selects a phone by is present, so
 * a hand-entered route and a researched one are ranked by exactly the same rule.
 */
export const firmRouteSchema = z.strictObject({
  id: z.string().min(1).max(200),
  channel: z.enum(['phone', 'email']),
  value: z.string().min(1).max(254),
  purpose: z.literal('business'),
  verification: accountRouteSchema.shape.verification,
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  enteredAt: instant,
});
export type FirmRoute = z.infer<typeof firmRouteSchema>;
/** What the firm read adapter needs of a route, whichever shape wrote it. */
export type FirmRouteLike = { id: string; channel: string; purpose: string; value: string; verification: FirmRoute['verification']; version: number };

/**
 * `FIRM#<firmId>`. For a firm David typed in, the whole firm; for a researched firm it carries only what David added
 * by hand afterwards (routes, and the status the suppression set forced). `derivedZoneFrom` records which map named
 * the zone, so the derivation is readable later exactly as it is for a researched firm.
 */
export const firmRecordSchema = z.strictObject({
  version: z.literal(1),
  firmId: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(300),
  /** The firm's own domain, lower-case, or null. Never a URL. */
  domain: domainSchema.nullable(),
  city: z.string().trim().min(1).max(200).nullable(),
  state: territoryStateSchema.nullable(),
  timeZone: z.string().max(64).nullable(),
  derivedZoneFrom: z.enum(['territory_state_map', 'addable_state_map']).nullable(),
  status: v1FirmStatusSchema,
  enteredBy: z.enum(['research', 'hand']),
  /** One line about the firm's evidence; empty for a hand-entered firm, which has none. */
  evidenceSummary: z.string().max(400),
  /**
   * Which research pass last wrote this firm's `EVIDENCE#` record, and when (S4). Absent on every record written
   * before S4 and on a hand-entered firm, which has no evidence at all; `research.firm` sets both together.
   */
  researchRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  researchedAt: instant.nullable().optional(),
  routes: z.array(firmRouteSchema).max(100),
  enteredAt: instant,
  updatedAt: instant,
});
export type FirmRecord = z.infer<typeof firmRecordSchema>;

/** The zone the state David named implies: the fixed territory map first, the single-zone addable states second. Pure. */
export function zoneOfState(state: TerritoryState): { timeZone: TerritoryTimeZone; from: 'territory_state_map' | 'addable_state_map' } | null {
  if (isTerritoryState(state)) return { timeZone: TERRITORY_STATE_TIME_ZONES[state], from: 'territory_state_map' };
  if (isTerritoryAddableState(state)) return { timeZone: TERRITORY_ADDABLE_STATE_TIME_ZONES[state], from: 'addable_state_map' };
  return null;
}

/**
 * The id a hand-entered firm gets: derived from the name, the city and the state, so entering the same firm twice
 * reaches the same record and the second attempt is refused as an existing firm instead of making a duplicate.
 */
export function handEnteredFirmId(input: { name: string; city: string; state: string }): string {
  const hash = sha256Utf8(JSON.stringify({ kind: 'hand_entered_firm', version: 1,
    name: input.name.trim().toLowerCase().replace(/\s+/g, ' '), city: input.city.trim().toLowerCase().replace(/\s+/g, ' '), state: input.state }));
  return `${HAND_ENTERED_FIRM_ID_PREFIX}${hash.slice(0, 32)}`;
}

/** The route id a hand-admitted handle gets, derived from the firm and the canonical handle so a replay adds nothing. */
export function handEnteredRouteId(firmId: string, handle: string): string {
  return `route-hand-${sha256Utf8(JSON.stringify({ kind: 'hand_entered_route', version: 1, firmId, handle })).slice(0, 32)}`;
}

export type RouteRefusal = 'no_route' | 'both_routes' | 'phone_invalid' | 'phone_excluded' | 'email_invalid' | 'email_free_mail' | 'route_exists';
/**
 * One hand-entered handle as a route, or the reason it is refused. An email on a free-mail domain is refused because
 * the domain does not belong to the firm; a number the production launcher would never dial (service and short codes,
 * the plant-test exchanges, the reserved fictional 555-01XX block, anything not well-formed E.164) is refused here so
 * it can never reach a card in the first place. Pure except for the canonical normalizers.
 */
export function handEnteredRoute(input: { firmId: string; enteredAt: string; phone?: string | undefined; email?: string | undefined }):
{ route: FirmRoute; handle: string } | { refused: RouteRefusal } {
  const hasPhone = typeof input.phone === 'string' && input.phone.trim().length > 0;
  const hasEmail = typeof input.email === 'string' && input.email.trim().length > 0;
  if (hasPhone && hasEmail) return { refused: 'both_routes' };
  if (!hasPhone && !hasEmail) return { refused: 'no_route' };
  if (hasPhone) {
    const canonical = canonicalHandle(input.phone!);
    if (!canonical || canonical.channel !== 'phone') return { refused: 'phone_invalid' };
    if (isExcludedNumber(canonical.handle) !== false) return { refused: 'phone_excluded' };
    return { route: firmRouteSchema.parse({ id: handEnteredRouteId(input.firmId, canonical.handle),
      channel: 'phone', value: canonical.handle, purpose: 'business', verification: HAND_ENTERED_VERIFICATION, version: 1, enteredAt: input.enteredAt }), handle: canonical.handle };
  }
  const canonical = canonicalHandle(input.email!);
  if (!canonical || canonical.channel !== 'email') return { refused: 'email_invalid' };
  const domain = canonical.handle.slice(canonical.handle.indexOf('@') + 1);
  if (freeMail.has(domain)) return { refused: 'email_free_mail' };
  return { route: firmRouteSchema.parse({ id: handEnteredRouteId(input.firmId, canonical.handle),
    channel: 'email', value: canonical.handle, purpose: 'business', verification: HAND_ENTERED_VERIFICATION, version: 1, enteredAt: input.enteredAt }), handle: canonical.handle };
}

export async function readFirmRecord(store: DynamoStore, firmId: string): Promise<{ record: FirmRecord; rev: number } | null> {
  const row = await store.get<unknown>(firmKey(firmId));
  if (!row) return null;
  const parsed = firmRecordSchema.safeParse(row.data);
  return parsed.success ? { record: parsed.data, rev: row.rev } : null;
}

/** Every `FIRM#` record, by firm id. One prefix query; a row the schema refuses is skipped, never coerced. */
export async function listFirmRecords(store: DynamoStore): Promise<Map<string, FirmRecord>> {
  const records = new Map<string, FirmRecord>();
  for (const row of await store.list<unknown>(FIRM_PREFIX)) {
    const parsed = firmRecordSchema.safeParse(row.stored.data);
    if (parsed.success) records.set(parsed.data.firmId, parsed.data);
  }
  return records;
}

export type AddFirmRefusal = 'firm_exists' | 'zone_unknown' | 'site_invalid' | RouteRefusal;
export type AddFirmPlan = { outcome: 'planned'; items: TransactWriteItem[]; record: FirmRecord } | { outcome: 'refused'; reason: AddFirmRefusal };

/**
 * The writes of one `add_firm`, for the caller's own transaction. Absent-fenced on the derived id, so the same firm
 * entered twice is refused rather than duplicated. A state whose zone neither map records is refused here, because a
 * firm that cannot be placed on a clock could never be dialed and would sit in the pool as a permanent hold.
 */
export async function planAddFirm(store: DynamoStore, command: AddFirmCommand): Promise<AddFirmPlan> {
  const state = territoryStateSchema.parse(command.state);
  const zone = zoneOfState(state);
  if (!zone) return { outcome: 'refused', reason: 'zone_unknown' };
  const firmId = handEnteredFirmId({ name: command.name, city: command.city, state });
  if (await readFirmRecord(store, firmId)) return { outcome: 'refused', reason: 'firm_exists' };
  let domain: string | null = null;
  if (command.site !== undefined && command.site.trim().length > 0) {
    const parsed = domainSchema.safeParse(siteDomain(command.site));
    if (!parsed.success) return { outcome: 'refused', reason: 'site_invalid' };
    domain = parsed.data;
  }
  const now = store.now();
  const routes: FirmRoute[] = [];
  for (const handle of [{ phone: command.phone }, { email: command.email }]) {
    const given = 'phone' in handle ? handle.phone : handle.email;
    if (given === undefined || given.trim().length === 0) continue;
    const made = handEnteredRoute({ firmId, enteredAt: now, ...handle });
    if ('refused' in made) return { outcome: 'refused', reason: made.refused };
    routes.push(made.route);
  }
  if (routes.length === 0) return { outcome: 'refused', reason: 'no_route' };
  const record = firmRecordSchema.parse({ version: 1, firmId, name: command.name, domain, city: command.city, state,
    timeZone: zone.timeZone, derivedZoneFrom: zone.from, status: 'new', enteredBy: 'hand', evidenceSummary: '',
    routes, enteredAt: now, updatedAt: now });
  return { outcome: 'planned', items: [store.put(firmKey(firmId), record, null)], record };
}

/** The bare host of whatever David typed in the site field: a domain, a URL, or a domain with a path. Pure. */
export function siteDomain(site: string): string {
  const raw = site.trim().toLowerCase();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`;
  try { return new URL(withScheme).hostname.replace(/^www\./, ''); } catch { return raw; }
}

export type AdmitRoutePlan = { outcome: 'planned'; items: TransactWriteItem[]; record: FirmRecord }
  | { outcome: 'refused'; reason: AddFirmRefusal | 'firm_unknown' | 'suppressed' };

/**
 * The writes of one `admit_route`. The firm must already exist in one of the two shapes; the route lands on its
 * `FIRM#` record, which is created for a researched firm the first time David adds something to it by hand. A route
 * whose canonical handle the firm already carries is refused as existing rather than written twice, and a suppressed
 * firm is refused outright: the suppression set is permanent and admitting a way to reach the firm would undo it.
 */
export async function planAdmitRoute(store: DynamoStore, command: AdmitRouteCommand,
  existing: { name: string; domain: string | null; city: string | null; state: TerritoryState | null; routes: readonly FirmRouteLike[]; status: V1FirmStatus } | null): Promise<AdmitRoutePlan> {
  if (await readFirmSuppression(store, command.firmId)) return { outcome: 'refused', reason: 'suppressed' };
  const held = await readFirmRecord(store, command.firmId);
  if (!held && !existing) return { outcome: 'refused', reason: 'firm_unknown' };
  const now = store.now();
  const made = handEnteredRoute({ firmId: command.firmId, enteredAt: now, phone: command.phone, email: command.email });
  if ('refused' in made) return { outcome: 'refused', reason: made.refused };
  const carried: readonly FirmRouteLike[] = [...(held?.record.routes ?? []), ...(existing?.routes ?? [])];
  if (carried.some(route => route.channel === made.route.channel && canonicalHandle(route.value)?.handle === made.handle)) {
    return { outcome: 'refused', reason: 'route_exists' };
  }
  if (held) {
    const record = firmRecordSchema.parse({ ...held.record, routes: [...held.record.routes, made.route], updatedAt: now });
    return { outcome: 'planned', items: [store.put(firmKey(command.firmId), record, held.rev)], record };
  }
  const state = existing!.state;
  const zone = state ? zoneOfState(state) : null;
  const record = firmRecordSchema.parse({ version: 1, firmId: command.firmId, name: existing!.name, domain: existing!.domain,
    city: existing!.city, state, timeZone: zone?.timeZone ?? null, derivedZoneFrom: zone?.from ?? null, status: existing!.status,
    enteredBy: 'research', evidenceSummary: '', routes: [made.route], enteredAt: now, updatedAt: now });
  return { outcome: 'planned', items: [store.put(firmKey(command.firmId), record, null)], record };
}

/**
 * The write that records a firm's new status on its `FIRM#` record, when it has one. Used by the suppression path so
 * the record David reads says `suppressed` beside the suppression set itself; the set stays the truth either way.
 */
export async function planFirmStatus(store: DynamoStore, firmId: string, status: V1FirmStatus): Promise<TransactWriteItem[]> {
  const held = await readFirmRecord(store, firmId);
  if (!held || held.record.status === status) return [];
  return [store.put(firmKey(firmId), firmRecordSchema.parse({ ...held.record, status, updatedAt: store.now() }), held.rev)];
}
