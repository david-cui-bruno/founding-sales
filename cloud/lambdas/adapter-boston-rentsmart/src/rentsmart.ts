/**
 * Boston RentSmart (CKAN datastore, package `rentsmart`, resource
 * dc615ff7-2ff3-416a-922b-f0f334f085d0 "RENTSMART 2016 - PRESENT")
 * -> violation SourceEvents.
 *
 * Probed 2026-09-01 via
 *   curl 'https://data.boston.gov/api/3/action/datastore_search?resource_id=dc615ff7-2ff3-416a-922b-f0f334f085d0&limit=3'
 * Sample record (all values text; ~390k rows total):
 *   {
 *     "_id": 1,
 *     "date": "2026-08-29 02:35:00.983+00",
 *     "violation_type": "Sanitation Requests",
 *     "description": "Abandoned Vehicles",
 *     "address": "23 Page St, 02121",
 *     "neighborhood": "Dorchester",
 *     "zip_code": "02121",
 *     "parcel": "1402554000",
 *     "owner": "POWELL UDA M",
 *     "year_built": "1900",
 *     "year_remodeled": "2002",
 *     "property_type": "Residential 2-family",
 *     "latitude": "42.29948000042358",
 *     "longitude": "-71.08320000138492"
 *   }
 *
 * RentSmart is pre-joined: violations, complaints, and service requests per
 * rental address. Observed `violation_type` catalog (datastore_search_sql
 * GROUP BY, 2026-09-01):
 *   Enforcement Violations       281355  -> trigger violation_opened
 *   Housing Complaints            48778  -> identity event (no trigger)
 *   Sanitation Requests           38867  -> identity event (no trigger)
 *   Housing Violations            17768  -> trigger violation_opened
 *   Building Violations            3080  -> trigger violation_opened
 *   Civic Maintenance Requests      466  -> identity event (no trigger)
 */
import { createHash } from "node:crypto";
import {
  computeIdempotencyKey,
  newCloudEntityId,
  newSourceEventId,
  TRIGGER_TYPES,
  type CloudSourceEvent,
  type PostalAddress,
} from "@callie-sourcing/shared";

export const ADAPTER_NAME = "boston-rentsmart";
export const ADAPTER_VERSION = "1.0.0";
export const RESOURCE_ID = "dc615ff7-2ff3-416a-922b-f0f334f085d0";
/** Pre-joined city dataset, occasional address/owner staleness. */
const CONFIDENCE = 0.9;

/** CKAN datastore record (fields verified above; values are text). */
export interface RentSmartRow {
  _id: number;
  date?: string | null;
  violation_type?: string | null;
  description?: string | null;
  address?: string | null;
  neighborhood?: string | null;
  zip_code?: string | null;
  parcel?: string | null;
  owner?: string | null;
  year_built?: string | null;
  year_remodeled?: string | null;
  property_type?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  /** present when rows come from datastore_search_sql */
  _full_text?: unknown;
}

/**
 * Row kinds that are actual violations (decay trigger). Complaints and
 * service requests are identity events: they name the address/owner but a
 * complaint is not a confirmed violation.
 */
export const VIOLATION_TYPES = new Set([
  "Enforcement Violations",
  "Housing Violations",
  "Building Violations",
]);

export function isViolationKind(row: RentSmartRow): boolean {
  return VIOLATION_TYPES.has(row.violation_type?.trim() ?? "");
}

const ORG_REGEX =
  /\b(LLC|L\.L\.C\.|LLP|LP|TRUST|TRUSTEE|TRS?|INC|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PARTNERS(HIP)?|ASSOC(IATES|IATION)?|PROPERTIES|REALTY|HOLDINGS|GROUP|CONDOMINIUM|CONDO|AUTHORITY|CITY OF|HOUSING)\b/i;

export function isOrgName(name: string): boolean {
  return ORG_REGEX.test(name);
}

/** "2026-08-29 02:35:00.983+00" -> "2026-08-29" (null if unparseable). */
export function isoDateOf(value: string | null | undefined): string | null {
  const match = value?.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1]! : null;
}

/** "2026-08-29 02:35:00.983+00" -> ISO datetime (null if unparseable). */
export function isoDatetimeOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(" ", "T").replace(/\+00$/, "Z");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** "23 Page St, 02121" -> line1 "23 Page St" (zip lives in zip_code). */
function addressLine1(row: RentSmartRow): string | null {
  const raw = row.address?.trim();
  if (!raw) return null;
  const line1 = raw.split(",")[0]!.trim();
  return line1 || null;
}

export function situsAddress(row: RentSmartRow): PostalAddress | null {
  const line1 = addressLine1(row);
  if (!line1) return null;
  return {
    line1,
    locality: "Boston",
    region: "MA",
    postal_code: row.zip_code?.trim() || null,
    country_code: "US",
  };
}

/**
 * Natural key: RentSmart rows have a stable dataset _id, but the datastore
 * reloads can renumber. Composite of the stable business fields keeps the
 * key stable across reloads; _id breaks ties for same-day same-kind rows at
 * one address.
 */
export function naturalKey(row: RentSmartRow): string {
  return `boston-rentsmart:${row._id}:${isoDateOf(row.date) ?? "unknown"}:${normalize(
    row.violation_type,
  )}:${normalize(row.address)}`;
}

function normalize(value: string | null | undefined): string {
  return (value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Stable content projection: kind + description + address + owner + status-ish fields. */
export function contentFingerprint(row: RentSmartRow): string {
  const projection = {
    date: isoDateOf(row.date) ?? "",
    violation_type: normalize(row.violation_type),
    description: normalize(row.description),
    address: normalize(row.address),
    zip: normalize(row.zip_code),
    parcel: normalize(row.parcel),
    owner: normalize(row.owner),
    property_type: normalize(row.property_type),
  };
  return createHash("sha256")
    .update(JSON.stringify(projection), "utf8")
    .digest("hex");
}

function toYear(value: string | null | undefined): number | null {
  if (!value) return null;
  const year = Number(value);
  return Number.isInteger(year) && year > 1600 && year < 2100 ? year : null;
}

export interface RunMeta {
  fetchedAt: Date;
  /** ISO calendar date of this snapshot run (YYYY-MM-DD). */
  snapshotDate: string;
}

/**
 * violation-kind rows -> trigger violation_opened (weight 1.0, half-life 45d)
 * complaint/request rows -> identity events (trigger null), the row kind
 * rides in payload.violation_kind.
 *
 * RentSmart carries no case status column: status is 'open' for
 * violation-kind rows (the dataset lists active enforcement) and 'unknown'
 * for complaint/request rows.
 */
export function buildViolationEvent(row: RentSmartRow, meta: RunMeta): CloudSourceEvent {
  const violation = isViolationKind(row);
  const owner = row.owner?.trim() || null;
  const openedAt = isoDateOf(row.date);
  const observedAt =
    isoDatetimeOf(row.date) ?? `${meta.snapshotDate}T00:00:00.000Z`;

  return {
    contract_version: 1,
    id: newSourceEventId(meta.fetchedAt.getTime()),
    idempotency_key: computeIdempotencyKey(
      "violation",
      naturalKey(row),
      contentFingerprint(row),
    ),
    channel: "violation",
    source_uri: `ckan:data.boston.gov:${RESOURCE_ID}:${row._id}`,
    fetched_at: meta.fetchedAt.toISOString(),
    observed_at: observedAt,
    entity: {
      cloud_entity_id: newCloudEntityId(meta.fetchedAt.getTime()),
      person: owner
        ? {
            full_name: owner,
            mailing_address: null, // RentSmart has no owner mailing address
            phones: [],
            emails: [],
            org_names: isOrgName(owner) ? [owner] : [],
          }
        : null,
      property: {
        situs_address: situsAddress(row),
        parcel_id: row.parcel?.trim() || null,
        unit_count: null,
        year_built: toYear(row.year_built),
        use_code: row.property_type?.trim() || null,
      },
      known_person: false,
    },
    payload: {
      violation_kind: row.violation_type?.trim() || null,
      status: violation ? "open" : "unknown",
      opened_at: openedAt,
      case_ref: String(row._id),
    },
    signal_flags: {
      self_managed: null,
      vacancy: null,
      pain_mentions: [],
      urgency: violation ? 1 : 0,
      portfolio_hint: null,
    },
    trigger: violation
      ? {
          type: "violation_opened",
          weight: 1.0,
          half_life_days: TRIGGER_TYPES.violation_opened.half_life_days,
          window: null,
        }
      : null,
    scores: null,
    provenance: {
      adapter: ADAPTER_NAME,
      adapter_version: ADAPTER_VERSION,
      confidence: CONFIDENCE,
    },
  };
}
