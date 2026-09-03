/**
 * Boston Property Assessments FY2026 (CKAN datastore, resource
 * ee73430d-96c0-423e-ad21-c4cfb54c8961) -> parcel SourceEvents.
 *
 * ENTITY-DRIVEN SWEEP (review finding F9): this adapter never bulk-imports
 * the assessment roll (~180k parcels, mostly owner-occupants). It sweeps the
 * resolved entities table and queries the roll per OWNER name, so only
 * parcels owned by people we already track (Boston violation leads etc.)
 * become events. That backfills portfolio data (doors, mailing address,
 * absentee) the RentSmart adapter cannot provide.
 *
 * Probed 2026-09-03 via
 *   curl 'https://data.boston.gov/api/3/action/datastore_search?resource_id=ee73430d-96c0-423e-ad21-c4cfb54c8961&limit=2'
 * Field names (all values text): PID, GIS_ID, ST_NUM, ST_NAME, UNIT_NUM,
 * CITY, ZIP_CODE, LUC, LU, LU_DESC, OWN_OCC, OWNER, MAIL_ADDRESSEE,
 * MAIL_STREET_ADDRESS, MAIL_CITY, MAIL_STATE, MAIL_ZIP_CODE, RES_UNITS,
 * COM_UNITS, RC_UNITS, LAND_VALUE, BLDG_VALUE, TOTAL_VALUE (comma-grouped),
 * GROSS_TAX (" $10,203.96 "), YR_BUILT, YR_REMODEL.
 *
 * FY2026 LU codes (Property Assessment data key): R1=1-fam, R2=2-fam,
 * R3=3-fam, R4=4+ fam, RL=res land, RC=res/comm mixed, A=7+ apartments,
 * CD=condo unit, CM=condo main, CP=condo parking, C/CC/CL=commercial,
 * E/EA=exempt, I=industrial, AH=agricultural.
 */
import { createHash } from "node:crypto";
import {
  computeIdempotencyKey,
  deterministicCloudEntityId,
  newCloudEntityId,
  newSourceEventId,
  normalizeOwnerName,
  normalizeZip5,
  ownerKindFromName,
  type CloudSourceEvent,
  type ParcelPayload,
  type PostalAddress,
} from "@callie-sourcing/shared";

export const ADAPTER_NAME = "boston-assessments";
/**
 * Included in the content fingerprint: bumping it re-emits every row once
 * with corrected payloads (snapshot diff sees 'changed'). Bump on any logic
 * change that alters emitted events.
 */
export const ADAPTER_VERSION = "1.0.0";
export const RESOURCE_ID = "ee73430d-96c0-423e-ad21-c4cfb54c8961";
/** FY2026 assessment roll. */
export const TAX_YEAR = 2026;
/** City assessment roll: high-confidence typed fields. */
const CONFIDENCE = 0.95;
/** Cap parcels per owner: an owner matching more is a data smell (city, bank). */
export const MAX_PARCELS_PER_OWNER = 50;

/** CKAN datastore record — only the fields this adapter reads. */
export interface AssessmentRow {
  PID?: string | null;
  ST_NUM?: string | null;
  ST_NAME?: string | null;
  UNIT_NUM?: string | null;
  CITY?: string | null;
  ZIP_CODE?: string | null;
  LU?: string | null;
  LUC?: string | null;
  OWNER?: string | null;
  MAIL_ADDRESSEE?: string | null;
  MAIL_STREET_ADDRESS?: string | null;
  MAIL_CITY?: string | null;
  MAIL_STATE?: string | null;
  MAIL_ZIP_CODE?: string | null;
  RES_UNITS?: string | null;
  COM_UNITS?: string | null;
  RC_UNITS?: string | null;
  TOTAL_VALUE?: string | null;
  GROSS_TAX?: string | null;
  YR_BUILT?: string | null;
  OWN_OCC?: string | null;
  _full_text?: unknown;
}

/** Fields the CKAN SQL queries SELECT (kept minimal: no interior-detail noise). */
export const SELECTED_FIELDS = [
  "PID",
  "ST_NUM",
  "ST_NAME",
  "UNIT_NUM",
  "CITY",
  "ZIP_CODE",
  "LU",
  "LUC",
  "OWNER",
  "MAIL_ADDRESSEE",
  "MAIL_STREET_ADDRESS",
  "MAIL_CITY",
  "MAIL_STATE",
  "MAIL_ZIP_CODE",
  "RES_UNITS",
  "COM_UNITS",
  "RC_UNITS",
  "TOTAL_VALUE",
  "GROSS_TAX",
  "YR_BUILT",
  "OWN_OCC",
] as const;

// ---------------------------------------------------------------------------
// Owner matching
// ---------------------------------------------------------------------------

/**
 * Does this roll row's OWNER belong to the swept entity? Exact raw
 * (uppercased, whitespace-collapsed) match OR normalized token-set match via
 * the shared normalizeOwnerName — the same function the resolver used to
 * build normalized_name, so "SMITH JOHN" matches "JOHN SMITH".
 */
export function ownerMatchesEntity(
  rowOwner: string | null | undefined,
  entity: { canonicalName: string; normalizedName: string },
): boolean {
  const raw = (rowOwner ?? "").toUpperCase().replace(/\s+/g, " ").trim();
  if (!raw) return false;
  const canonical = entity.canonicalName.toUpperCase().replace(/\s+/g, " ").trim();
  if (canonical && raw === canonical) return true;
  const normalized = normalizeOwnerName(rowOwner);
  return normalized !== "" && normalized === entity.normalizedName;
}

// ---------------------------------------------------------------------------
// Field parsing
// ---------------------------------------------------------------------------

/** "822,900" / " $10,203.96 " -> number; null when absent/garbage. */
export function toNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const cleaned = value.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

export function toYear(value: string | null | undefined): number | null {
  const year = toNumber(value);
  return year !== null && Number.isInteger(year) && year > 1600 && year < 2100
    ? year
    : null;
}

/** Positive integer unit count from RES_UNITS/RC_UNITS/COM_UNITS; else null. */
export function unitCount(row: AssessmentRow): number | null {
  const total = [row.RES_UNITS, row.RC_UNITS, row.COM_UNITS]
    .map(toNumber)
    .filter((n): n is number => n !== null && Number.isInteger(n) && n > 0)
    .reduce((sum, n) => sum + n, 0);
  return total > 0 ? total : null;
}

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function situsAddress(row: AssessmentRow): PostalAddress | null {
  const parts = [row.ST_NUM, row.ST_NAME].map(trimOrNull).filter(Boolean);
  if (parts.length === 0) return null;
  const unit = trimOrNull(row.UNIT_NUM);
  return {
    line1: parts.join(" ") + (unit ? ` UNIT ${unit}` : ""),
    locality: trimOrNull(row.CITY) ?? "Boston",
    region: "MA",
    postal_code: trimOrNull(row.ZIP_CODE),
    country_code: "US",
  };
}

export function mailingAddress(row: AssessmentRow): PostalAddress | null {
  const line1 = trimOrNull(row.MAIL_STREET_ADDRESS);
  if (!line1) return null;
  return {
    line1,
    locality: trimOrNull(row.MAIL_CITY),
    region: trimOrNull(row.MAIL_STATE),
    postal_code: trimOrNull(row.MAIL_ZIP_CODE),
    country_code: "US",
  };
}

/**
 * Absentee = mailing zip5 differs from situs zip5; null when either is
 * unknown. Zip-level (not street-level like PVD) because Boston's roll has a
 * clean MAIL_ZIP_CODE and situs ZIP_CODE pair; same-zip false negatives are
 * acceptable for this identity backfill.
 */
export function isAbsentee(row: AssessmentRow): boolean | null {
  const situs = normalizeZip5(row.ZIP_CODE);
  const mail = normalizeZip5(row.MAIL_ZIP_CODE);
  if (situs.length !== 5 || mail.length !== 5) return null;
  return situs !== mail;
}

export function ownerKind(row: AssessmentRow): ParcelPayload["owner_kind"] {
  const owner = trimOrNull(row.OWNER);
  if (!owner) return null;
  return ownerKindFromName(owner);
}

/** Org detection for org_names, reusing the shared owner-kind classifier. */
export function isOrgName(name: string): boolean {
  return ownerKindFromName(name) !== "individual";
}

// ---------------------------------------------------------------------------
// Fingerprint / keys
// ---------------------------------------------------------------------------

function norm(value: string | null | undefined): string {
  return (value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Stable normalized projection: owner, addresses, LU, value, units, year.
 * Owner or assessment changes flip the fingerprint; cosmetic field-order
 * changes do not.
 */
export function normalizedRowForFingerprint(row: AssessmentRow): Record<string, string> {
  return {
    pid: row.PID ?? "",
    lu: norm(row.LU),
    owner: norm(row.OWNER),
    mailing: `${norm(row.MAIL_STREET_ADDRESS)}|${norm(row.MAIL_CITY)}|${norm(row.MAIL_STATE)}|${normalizeZip5(row.MAIL_ZIP_CODE)}`,
    situs: `${norm(row.ST_NUM)} ${norm(row.ST_NAME)}|${norm(row.UNIT_NUM)}|${norm(row.CITY)}|${normalizeZip5(row.ZIP_CODE)}`,
    total_value: String(toNumber(row.TOTAL_VALUE) ?? ""),
    gross_tax: String(toNumber(row.GROSS_TAX) ?? ""),
    units: String(unitCount(row) ?? ""),
    yr_built: String(toYear(row.YR_BUILT) ?? ""),
  };
}

export function contentFingerprint(row: AssessmentRow): string {
  // ADAPTER_VERSION is part of the fingerprint so adapter LOGIC fixes
  // re-emit corrected events; the source row alone would say 'unchanged'
  // forever.
  return createHash("sha256")
    .update(
      `${JSON.stringify(normalizedRowForFingerprint(row))}|${ADAPTER_VERSION}`,
      "utf8",
    )
    .digest("hex");
}

export function naturalKey(row: AssessmentRow): string {
  return `ckan:boston-assessments:${row.PID}`;
}

export interface RunMeta {
  fetchedAt: Date;
  /** ISO calendar date of this snapshot run (YYYY-MM-DD). */
  snapshotDate: string;
}

/**
 * Pure identity event (trigger null): the assessment roll says who owns
 * what, not that something happened. observed_at = snapshot date (the roll
 * carries no per-row record date; CONTRACT.md fallback).
 */
export function buildParcelEvent(row: AssessmentRow, meta: RunMeta): CloudSourceEvent {
  const fingerprint = contentFingerprint(row);
  const owner = trimOrNull(row.OWNER);
  const orgNames = owner && isOrgName(owner) ? [owner] : [];

  return {
    contract_version: 1,
    id: newSourceEventId(meta.fetchedAt.getTime()),
    idempotency_key: computeIdempotencyKey("parcel", naturalKey(row), fingerprint),
    channel: "parcel",
    source_uri: `ckan:data.boston.gov:${RESOURCE_ID}:${row.PID}`,
    fetched_at: meta.fetchedAt.toISOString(),
    observed_at: `${meta.snapshotDate}T00:00:00.000Z`,
    entity: {
      // Deterministic: same owner name + MAILING zip5 -> same ce_ id across
      // parcels, channels, and runs, so identities converge with existing
      // entities. Random fallback only when the roll has no owner at all.
      cloud_entity_id: owner
        ? deterministicCloudEntityId(owner, trimOrNull(row.MAIL_ZIP_CODE))
        : newCloudEntityId(meta.fetchedAt.getTime()),
      person: {
        full_name: owner,
        mailing_address: mailingAddress(row),
        phones: [],
        emails: [],
        org_names: orgNames,
      },
      property: {
        situs_address: situsAddress(row),
        parcel_id: trimOrNull(row.PID),
        unit_count: unitCount(row),
        year_built: toYear(row.YR_BUILT),
        use_code: trimOrNull(row.LU),
      },
      known_person: false,
    },
    payload: {
      assessor_class: trimOrNull(row.LU),
      assessed_value_usd: toNumber(row.TOTAL_VALUE),
      tax_usd: toNumber(row.GROSS_TAX),
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
