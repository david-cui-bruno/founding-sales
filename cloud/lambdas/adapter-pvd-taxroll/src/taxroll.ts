/**
 * Providence 2025 Property Tax Roll (Socrata 6ub4-iebe) -> parcel SourceEvents.
 *
 * Pure functions: row typing, class filtering, absentee/org detection,
 * fingerprinting, and event building. Fetching/paging lives in handler.ts.
 */
import { createHash } from "node:crypto";
import {
  computeIdempotencyKey,
  newCloudEntityId,
  newSourceEventId,
  type CloudSourceEvent,
  type ParcelPayload,
  type PostalAddress,
} from "@callie-sourcing/shared";

export const ADAPTER_NAME = "pvd-taxroll";
export const ADAPTER_VERSION = "1.0.0";
/** This Socrata dataset is the 2025 Property Tax Roll. */
export const TAX_YEAR = 2025;
/** Identity events from a public tax roll: high-confidence typed fields. */
const CONFIDENCE = 0.95;

/** Socrata row (fields per cloud/VERIFIED_SOURCES.md; all values strings). */
export interface TaxRollRow {
  p_id: string;
  tax_map?: string;
  plat?: string;
  lot?: string;
  unit?: string;
  class?: string;
  short_desc?: string;
  levy_code_1?: string;
  short_desc_1?: string;
  // Situs address parts
  civic?: string;
  street?: string;
  suffix?: string;
  formated_address?: string;
  city?: string;
  zip_postal?: string;
  // Owner: individuals come as first/last, orgs in `company`.
  first_name?: string;
  last_name?: string;
  company?: string;
  // Mailing address parts
  civic_1?: string;
  street_1?: string;
  s_suffix?: string;
  city_1?: string;
  state?: string;
  zip_postal_1?: string;
  total_assmt?: string;
  total_exempt?: string;
  total_taxes?: string;
  property_location?: unknown;
}

/**
 * Residential rental stock classes, hard-coded from the observed catalog
 * (scripts/scout-classes.sh against 6ub4-iebe on 2026-09-01):
 *
 *   class    short_desc               count   retained?
 *   03-11+   apt 11+                    136   yes (apartment)
 *   03-610   apt 6-10                   379   yes (apartment)
 *   04-05U   combo 5U                   730   yes (res/comm combo w/ units)
 *   04-11+   Combo 11+                   32   yes (res/comm combo w/ units)
 *   04-610   combo 6-10                  65   yes (res/comm combo w/ units)
 *   1        Single Family            14728   only when absentee (rental SFH)
 *   2        2 -5 Family              14116   yes (core multi-family)
 *   10       Utility                     52   no
 *   12       Miscellaneous              659   no
 *   13       Residential Vacant Land   2903   no
 *   14       CI Vacant Land            1559   no
 *   23       Residential Condo         3963   no (mostly owner-occupied;
 *                                             revisit with levy codes)
 *   24       Commercial Condo           438   no
 *   33       Farm Forest                  2   no
 *   5        Commercial I                 4   no
 *   6        Commercial II             1599   no
 *   7        Industrial                 308   no
 *   70..84   exempt/institutional      ~2.7k  no
 */
export const RESIDENTIAL_RENTAL_CLASSES = new Set([
  "2", // 2-5 Family
  "03-610", // apt 6-10
  "03-11+", // apt 11+
  "04-05U", // combo 5U
  "04-610", // combo 6-10
  "04-11+", // Combo 11+
]);

/** Single-family: retained only when the owner is absentee. */
export const SINGLE_FAMILY_CLASS = "1";

// Recognize organizational owners in the `company` field. Tax rolls use
// varied suffixes; anchored on word boundaries to avoid matching names like
// "Wallace".
const ORG_REGEX =
  /\b(LLC|L\.L\.C\.|LLP|L\.L\.P\.|LP|L\.P\.|TRUST|TRUSTEE|TRS?|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PARTNERS(HIP)?|ASSOC(IATES|IATION)?|PROPERTIES|REALTY|HOLDINGS|GROUP|CHURCH|CITY|HOUSING|AUTHORITY)\b/i;

export function isOrgName(name: string): boolean {
  return ORG_REGEX.test(name);
}

export function ownerKind(row: TaxRollRow): ParcelPayload["owner_kind"] {
  const company = row.company?.trim();
  if (!company) {
    return row.first_name || row.last_name ? "individual" : null;
  }
  if (/\bLLC\b|\bL\.L\.C\.\b/i.test(company)) return "llc";
  if (/\bTRUST\b|\bTRUSTEE\b|\bTRS?\b/i.test(company)) return "trust";
  return "other";
}

export function ownerFullName(row: TaxRollRow): string | null {
  const company = row.company?.trim();
  if (company) return company;
  const name = [row.first_name, row.last_name]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return name || null;
}

/** Uppercase, drop punctuation, collapse whitespace — for address compares. */
export function normalizeAddressPart(value: string | undefined | null): string {
  return (value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function situsLine1(row: TaxRollRow): string | null {
  const formatted = row.formated_address?.trim();
  if (formatted) return formatted;
  const parts = [row.civic, row.street, row.suffix].map((p) => p?.trim()).filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

function mailingLine1(row: TaxRollRow): string | null {
  const parts = [row.civic_1, row.street_1, row.s_suffix]
    .map((p) => p?.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Absentee = normalized mailing street+city differs from situs street+city.
 * Zip is deliberately excluded: the roll shows same-street rows with
 * different zips (data quirk), and street+city is the ownership-relevant
 * comparison. null when either side is missing.
 */
export function isAbsentee(row: TaxRollRow): boolean | null {
  const situs = situsLine1(row);
  const mailing = mailingLine1(row);
  if (!situs || !mailing) return null;
  const situsKey = `${normalizeAddressPart(situs)}|${normalizeAddressPart(row.city)}`;
  const mailingKey = `${normalizeAddressPart(mailing)}|${normalizeAddressPart(row.city_1)}`;
  return situsKey !== mailingKey;
}

/**
 * Landlord-relevance filter:
 * - multi-family / apartment / combo classes always retained
 * - single-family retained ONLY when absentee (owner-occupied SFH is not
 *   rental stock)
 */
export function shouldRetainRow(row: TaxRollRow): boolean {
  const cls = row.class?.trim() ?? "";
  if (RESIDENTIAL_RENTAL_CLASSES.has(cls)) return true;
  if (cls === SINGLE_FAMILY_CLASS) return isAbsentee(row) === true;
  return false;
}

/**
 * Stable normalized projection of the fields we care about. Owner or
 * assessment changes flip the fingerprint (=> 'changed' snapshot, re-emit);
 * cosmetic field-order or geo jitter does not.
 */
export function normalizedRowForFingerprint(row: TaxRollRow): Record<string, string> {
  return {
    p_id: row.p_id ?? "",
    class: row.class?.trim() ?? "",
    levy_code_1: row.levy_code_1?.trim() ?? "",
    owner: normalizeAddressPart(ownerFullName(row)),
    mailing: `${normalizeAddressPart(mailingLine1(row))}|${normalizeAddressPart(row.city_1)}|${normalizeAddressPart(row.state)}|${normalizeAddressPart(row.zip_postal_1)}`,
    situs: `${normalizeAddressPart(situsLine1(row))}|${normalizeAddressPart(row.city)}|${normalizeAddressPart(row.zip_postal)}`,
    total_assmt: row.total_assmt?.trim() ?? "",
    total_taxes: row.total_taxes?.trim() ?? "",
  };
}

export function contentFingerprint(row: TaxRollRow): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizedRowForFingerprint(row)), "utf8")
    .digest("hex");
}

export function naturalKey(row: TaxRollRow): string {
  return `pvd-taxroll:${row.p_id}`;
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function mailingAddress(row: TaxRollRow): PostalAddress | null {
  const line1 = mailingLine1(row);
  if (!line1) return null;
  return {
    line1,
    locality: row.city_1?.trim() || null,
    region: row.state?.trim() || null,
    postal_code: row.zip_postal_1?.trim() || null,
    country_code: "US",
  };
}

function situsAddress(row: TaxRollRow): PostalAddress | null {
  const line1 = situsLine1(row);
  if (!line1) return null;
  return {
    line1,
    locality: row.city?.trim() || "Providence",
    region: "RI",
    postal_code: row.zip_postal?.trim() || null,
    country_code: "US",
  };
}

export interface RunMeta {
  fetchedAt: Date;
  /** ISO calendar date of this snapshot run (YYYY-MM-DD). */
  snapshotDate: string;
}

/**
 * Pure identity event (trigger null): the tax roll says who owns what, not
 * that something happened. observed_at = snapshot date (the roll carries no
 * per-row record date; CONTRACT.md fallback).
 */
export function buildParcelEvent(row: TaxRollRow, meta: RunMeta): CloudSourceEvent {
  const fingerprint = contentFingerprint(row);
  const fullName = ownerFullName(row);
  const company = row.company?.trim() || null;
  const orgNames = company && isOrgName(company) ? [company] : [];

  return {
    contract_version: 1,
    id: newSourceEventId(meta.fetchedAt.getTime()),
    idempotency_key: computeIdempotencyKey("parcel", naturalKey(row), fingerprint),
    channel: "parcel",
    source_uri: `socrata:6ub4-iebe:${row.p_id}`,
    fetched_at: meta.fetchedAt.toISOString(),
    observed_at: `${meta.snapshotDate}T00:00:00.000Z`,
    entity: {
      cloud_entity_id: newCloudEntityId(meta.fetchedAt.getTime()),
      person: {
        full_name: fullName,
        mailing_address: mailingAddress(row),
        phones: [],
        emails: [],
        org_names: orgNames,
      },
      property: {
        situs_address: situsAddress(row),
        parcel_id: row.tax_map?.trim() || null,
        unit_count: null,
        year_built: null,
        use_code: row.class?.trim() || null,
      },
      known_person: false,
    },
    payload: {
      assessor_class: row.class?.trim() || null,
      assessed_value_usd: toNumber(row.total_assmt),
      tax_usd: toNumber(row.total_taxes),
      absentee: isAbsentee(row),
      owner_kind: ownerKind(row),
      tax_year: TAX_YEAR,
    },
    signal_flags: {
      self_managed: null,
      vacancy: null,
      pain_mentions: [],
      urgency: 0,
      portfolio_hint: null,
    },
    trigger: null,
    scores: null,
    provenance: {
      adapter: ADAPTER_NAME,
      adapter_version: ADAPTER_VERSION,
      confidence: CONFIDENCE,
    },
  };
}
