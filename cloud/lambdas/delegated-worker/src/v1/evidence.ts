import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { accountInstantSchema, BUSINESS_EMAIL_SELECTIONS } from '../../../../../src/shared/contracts/accountContract';
import type { AccountRecord } from '../../../../../src/shared/contracts/accountRecordContract';
import { isTerritoryAddableState, isTerritoryMultiZoneState, isTerritoryState, TERRITORY_ADDABLE_STATE_TIME_ZONES, TERRITORY_STATE_TIME_ZONES,
  territoryStateSchema, type TerritoryState, type TerritoryTimeZone } from '../../../../../src/shared/contracts/territoryClearanceContract';
import { companyFactKeys } from '../../../../../src/main/research/companyFactExtraction';
import { keyPart, type DynamoStore } from '../dynamoStore';
import { recordAttempt } from './attempts';
import { firmKey, firmRecordSchema, readFirmRecord } from './firmsWrite';

/**
 * `EVIDENCE#<firmId>` and the state and zone derivation (FSS target design section 2; slice S4).
 *
 * The firm record and its evidence are two items on purpose. `FIRM#` is what every list build, card and
 * scheduler decision reads, dozens of firms at a time, so it stays under 2 KB: the name, the routes, the
 * derived state and zone, one line about the evidence, and the research revision and instant. Everything the
 * research job actually fetched — the sources with their URLs, fetch instants, sha256 digests and excerpts,
 * the extraction and the business email finding — lives here, read only when David opens one firm.
 *
 * The write refuses rather than truncates. DynamoDB's item limit is a hard boundary, and silently dropping
 * sources or cutting an excerpt would leave a citation that no longer matches the bytes its digest names. So
 * an oversized write is refused whole, recorded as a failed `research` attempt with the code
 * `evidence_too_large`, and the previous revision stands untouched.
 *
 * State and zone are derived here and nowhere else (design section 2: "State and zone are derived at research
 * from the Places address and the state zone map"). S1's firm adapter calls this; so does the backfill job,
 * which has a Places page rather than a stored record. An unknown state or zone is a hold, never a refusal
 * and never a guess.
 */

export const EVIDENCE_PREFIX = 'EVIDENCE#';
export const evidenceKey = (firmId: string): string => `${EVIDENCE_PREFIX}${keyPart(firmId)}`;
/** Design section 2: capped at 40 sources. */
export const EVIDENCE_MAX_SOURCES = 40;
export const EVIDENCE_EXCERPT_MAX = 12_000;
/** The one line `FIRM#` carries about the evidence; `firmRecordSchema.evidenceSummary` is the same ceiling. */
export const EVIDENCE_SUMMARY_MAX = 400;

const instant = accountInstantSchema;
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);

/** One fetched page as its receipt recorded it: where it came from, when, the digest of the bytes read, and the text kept. */
export const evidenceSourceSchema = z.strictObject({
  url: z.string().min(1).max(2048),
  fetchedAt: instant,
  sha256: hex64,
  excerpt: z.string().max(EVIDENCE_EXCERPT_MAX),
});
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;

/** What the model read out of those pages, each fact quoting exactly one source. Null when no extraction ran. */
export const evidenceExtractionSchema = z.strictObject({
  facts: z.array(z.strictObject({ key: z.enum(companyFactKeys), sourceId: z.string().min(1).max(200), quote: z.string().min(1).max(2000) })).max(60),
  at: instant,
});
export type EvidenceExtraction = z.infer<typeof evidenceExtractionSchema>;

/** The business email discovery's whole answer, including what it refused and why. The free-mail refusal is the shared contract. */
export const evidenceBusinessEmailSchema = z.strictObject({
  email: z.string().min(3).max(254).nullable(),
  sourceId: z.string().min(1).max(200).nullable(),
  selection: z.enum(BUSINESS_EMAIL_SELECTIONS).nullable(),
  considered: z.array(z.string().min(3).max(254)).max(40),
  refused: z.strictObject({ free_mail: z.number().int().nonnegative(), off_domain: z.number().int().nonnegative(),
    withheld_contact: z.number().int().nonnegative(), unparsable: z.number().int().nonnegative() }),
});
export type EvidenceBusinessEmail = z.infer<typeof evidenceBusinessEmailSchema>;

export const evidenceRecordSchema = z.strictObject({
  version: z.literal(1),
  firmId: z.string().min(1).max(200),
  sources: z.array(evidenceSourceSchema).max(EVIDENCE_MAX_SOURCES),
  extraction: evidenceExtractionSchema.nullable(),
  businessEmailFinding: evidenceBusinessEmailSchema.nullable(),
  /** Which research pass wrote this. The same number stands on `FIRM#`, so the two items are readable as one. */
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  updatedAt: instant,
});
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;

export async function readEvidence(store: DynamoStore, firmId: string): Promise<{ record: EvidenceRecord; rev: number } | null> {
  const row = await store.get<unknown>(evidenceKey(firmId));
  if (!row) return null;
  const parsed = evidenceRecordSchema.safeParse(row.data);
  return parsed.success ? { record: parsed.data, rev: row.rev } : null;
}

export type EvidenceWriteInput = {
  firmId: string;
  sources: readonly EvidenceSource[];
  extraction: EvidenceExtraction | null;
  businessEmailFinding: EvidenceBusinessEmail | null;
  revision: number;
  jobId?: string | undefined;
};
export type EvidenceWrite = { written: true; revision: number } | { written: false; reason: 'evidence_too_large' };

/**
 * Writes one research pass's evidence, compare-and-set on the revision the record already carried. Over the
 * store's item limit the write is refused whole and recorded; it is never made to fit. The number of sources is
 * capped by the schema before any of this, so a page provider that returned more is refused at the boundary too.
 */
export async function writeEvidence(store: DynamoStore, input: EvidenceWriteInput): Promise<EvidenceWrite> {
  const held = await store.get<unknown>(evidenceKey(input.firmId));
  let record: EvidenceRecord;
  let item: TransactWriteItem;
  try {
    record = evidenceRecordSchema.parse({ version: 1, firmId: input.firmId, sources: [...input.sources], extraction: input.extraction,
      businessEmailFinding: input.businessEmailFinding, revision: input.revision, updatedAt: store.now() });
    item = store.put(evidenceKey(input.firmId), record, held?.rev ?? null);
  } catch {
    await recordEvidenceRefusal(store, input);
    return { written: false, reason: 'evidence_too_large' };
  }
  try { await store.transact([item]); }
  catch {
    // A concurrent pass wrote first, or the transaction refused the item: neither is a reason to write less evidence.
    const now = await readEvidence(store, input.firmId);
    if (now && now.record.revision >= input.revision) return { written: true, revision: now.record.revision };
    throw new Error('evidence_write_failed');
  }
  return { written: true, revision: record.revision };
}

/** The refused write as Diagnostics shows it: the firm, the job and how many bytes the sources came to. */
async function recordEvidenceRefusal(store: DynamoStore, input: EvidenceWriteInput): Promise<void> {
  const bytes = Buffer.byteLength(JSON.stringify(input.sources));
  await recordAttempt(store, { kind: 'research', outcome: 'failed', reason: 'evidence_too_large',
    detail: { code: 'evidence_too_large', firmId: input.firmId.slice(0, 80), bytes, count: input.sources.length,
      ...(input.jobId === undefined ? {} : { jobId: input.jobId.slice(0, 80) }) },
    durationMs: null, ref: input.firmId.slice(0, 80) });
}

/** One line about a firm's evidence, for `FIRM#`. Bounded by construction, never a sentence built from fetched text. */
export function evidenceSummaryLine(input: { sources: number; businessEmail: string | null; facts: number; researchedAt: string }): string {
  const parts = [`${input.sources} sources`];
  if (input.facts > 0) parts.push(`${input.facts} facts`);
  parts.push(input.businessEmail ? 'business email found' : 'no business email');
  return `${parts.join(', ')}; researched ${input.researchedAt}`.slice(0, EVIDENCE_SUMMARY_MAX);
}

/**
 * The `FIRM#` writes of one finished research pass: the one-line summary, the revision and the instant, and
 * nothing else. The sources themselves never touch this record. Returns no item when the firm has no `FIRM#`
 * record and none is supplied, so a caller that creates the record itself stays the only writer of it.
 */
export async function planFirmEvidenceSummary(store: DynamoStore, input: { firmId: string; summary: string; revision: number; researchedAt: string }): Promise<TransactWriteItem[]> {
  const held = await readFirmRecord(store, input.firmId);
  if (!held) return [];
  const record = firmRecordSchema.parse({ ...held.record, evidenceSummary: input.summary.slice(0, EVIDENCE_SUMMARY_MAX),
    researchRevision: input.revision, researchedAt: input.researchedAt, updatedAt: store.now() });
  return [store.put(firmKey(input.firmId), record, held.rev)];
}

// ---------------------------------------------------------------------------------------------------------
// State and zone derivation: the single implementation (moved here from S1's firm adapter, which now calls it).
// ---------------------------------------------------------------------------------------------------------

export type FirmHold = { reason: 'state_not_cleared'; code: 'state_unknown' | 'zone_unknown' };
export type FirmDerivation =
  | { source: 'places_formatted_address'; sourceId: string; state: TerritoryState; zoneFrom: 'territory_state_map' | 'addable_state_map' }
  /** A firm David typed in himself (S2, `add_firm`): he named the state, the zone comes from the same two maps. */
  | { source: 'hand_entered'; sourceId: null; state: TerritoryState; zoneFrom: 'territory_state_map' | 'addable_state_map' }
  | { source: 'hand_entered'; sourceId: null; state: TerritoryState | null; zoneFrom: null; reason: 'state_zone_not_recorded' | 'state_not_found' }
  | { source: 'places_formatted_address'; sourceId: string; state: TerritoryState; zoneFrom: null; reason: 'state_spans_two_zones' | 'state_zone_not_recorded' }
  | { source: 'places_formatted_address'; sourceId: string; state: null; zoneFrom: null; reason: 'address_missing' | 'state_not_found' }
  | { source: 'none'; sourceId: null; state: null; zoneFrom: null; reason: 'no_places_source' };

export type DerivedPlace = { city: string | null; state: TerritoryState | null; timeZone: TerritoryTimeZone | null; derivation: FirmDerivation; hold: FirmHold | null };

const PLACES_SOURCE_PREFIX = 'place-';
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

/**
 * State, city, zone and the record of how they were derived, from one Places `formattedAddress`. The backfill job
 * holds a Places page rather than a stored record, so it calls exactly this; `deriveStateAndZone` reads the
 * address out of a stored record and then calls it too. Unknown is a hold, never a refusal. Pure.
 */
export function deriveStateAndZoneFromAddress(formatted: string | null, sourceId: string | null): DerivedPlace {
  if (sourceId === null) return { city: null, state: null, timeZone: null, derivation: { source: 'none', sourceId: null, state: null, zoneFrom: null, reason: 'no_places_source' }, hold: { reason: 'state_not_cleared', code: 'state_unknown' } };
  if (!formatted) return { city: null, state: null, timeZone: null, derivation: { source: 'places_formatted_address', sourceId, state: null, zoneFrom: null, reason: 'address_missing' }, hold: { reason: 'state_not_cleared', code: 'state_unknown' } };
  const { city, state } = parseUsAddress(formatted);
  if (!state) return { city: null, state: null, timeZone: null, derivation: { source: 'places_formatted_address', sourceId, state: null, zoneFrom: null, reason: 'state_not_found' }, hold: { reason: 'state_not_cleared', code: 'state_unknown' } };
  // The fixed territory map first (Texas is there with America/Chicago by David's decision), then the single-zone states he may add.
  if (isTerritoryState(state)) return { city, state, timeZone: TERRITORY_STATE_TIME_ZONES[state], derivation: { source: 'places_formatted_address', sourceId, state, zoneFrom: 'territory_state_map' }, hold: null };
  if (isTerritoryAddableState(state)) return { city, state, timeZone: TERRITORY_ADDABLE_STATE_TIME_ZONES[state], derivation: { source: 'places_formatted_address', sourceId, state, zoneFrom: 'addable_state_map' }, hold: null };
  const reason = isTerritoryMultiZoneState(state) ? 'state_spans_two_zones' : 'state_zone_not_recorded';
  return { city, state, timeZone: null, derivation: { source: 'places_formatted_address', sourceId, state, zoneFrom: null, reason }, hold: { reason: 'state_not_cleared', code: 'zone_unknown' } };
}

/** State, city, zone and the record of how they were derived, from the firm's stored Places listing source. Pure. */
export function deriveStateAndZone(record: AccountRecord): DerivedPlace {
  const listing = record.sources.find(source => source.id.startsWith(PLACES_SOURCE_PREFIX));
  if (!listing) return deriveStateAndZoneFromAddress(null, null);
  let formatted: string | undefined;
  try { formatted = placesExcerptSchema.parse(JSON.parse(listing.excerpt)).formattedAddress; } catch { formatted = undefined; }
  return deriveStateAndZoneFromAddress(formatted ?? null, listing.id);
}
