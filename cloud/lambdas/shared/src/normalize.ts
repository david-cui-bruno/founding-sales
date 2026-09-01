/**
 * Deterministic owner-name and mailing-address normalization, shared by the
 * entity resolver (writes `normalized_name` to the entities table) and the
 * scorer (queries the `normalized_name` GSI). Both sides MUST use these exact
 * functions so lookups agree — that is the whole reason this file lives in
 * the shared package.
 *
 * Design (deterministic v1, no ML):
 * - Names: uppercase, strip punctuation (periods/apostrophes joined so
 *   "L.L.C." -> "LLC" and "O'BRIEN" -> "OBRIEN"), collapse whitespace, strip
 *   suffix noise (LLC, INC, TRUST, TR, ET AL, LIVING, REVOCABLE, ...), then
 *   dedupe + SORT tokens. Sorting makes "SMITH, JOHN" and "JOHN SMITH"
 *   produce the same normalized name (token-set comparison by construction).
 * - Fallback: when noise-stripping leaves fewer than 2 tokens but the
 *   pre-strip form had more (e.g. "212 LLC" -> "212"), the pre-strip tokens
 *   are kept — a bare number or surname is too ambiguous, but "212 LLC" is a
 *   perfectly distinctive owner name within a zip.
 * - Addresses: uppercase, small USPS abbreviation table (STREET -> ST, ...);
 *   unit designators (APT 2, UNIT B, #3, ...) are stripped from the COMPARE
 *   key only — stored records keep the full address.
 */

// ---------------------------------------------------------------------------
// Owner names
// ---------------------------------------------------------------------------

/**
 * Suffix/annotation tokens that carry no identity signal on a tax roll.
 * Stripped AFTER punctuation removal, so "L.L.C." arrives here as "LLC".
 */
const NAME_NOISE_TOKENS: ReadonlySet<string> = new Set([
  "LLC",
  "LLP",
  "LP",
  "INC",
  "INCORPORATED",
  "CORP",
  "CORPORATION",
  "LTD",
  "LIMITED",
  "TRUST",
  "TRUSTS",
  "TRUSTEE",
  "TRUSTEES",
  "TR",
  "TRS",
  "ETAL",
  "LIVING",
  "REVOCABLE",
  "IRREVOCABLE",
]);

/** Uppercase, join periods/apostrophes, everything else non-alnum -> space. */
function cleanName(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[.'’]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\bET\s+AL\b/g, " ") // "ET AL" bigram; bare "AL" stays (a name)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Canonical normalized owner name: cleaned, noise-stripped, deduped, sorted
 * tokens joined by single spaces. Returns "" for empty/whitespace input.
 *
 * "SMITH, JOHN" === "JOHN SMITH" === "John Smith" -> "JOHN SMITH".
 * "COTE REALTY LLC" -> "COTE REALTY"; "212 LLC" -> "212 LLC" (fallback).
 */
export function normalizeOwnerName(raw: string | null | undefined): string {
  if (!raw) return "";
  const allTokens = cleanName(raw).split(" ").filter(Boolean);
  if (allTokens.length === 0) return "";

  let tokens = allTokens.filter((t) => !NAME_NOISE_TOKENS.has(t));
  // Fallback: never let noise-stripping collapse a multi-token name into an
  // ambiguous single token (or nothing) — keep the pre-strip tokens instead.
  if (tokens.length < 2 && allTokens.length > tokens.length) {
    tokens = allTokens;
  }

  return [...new Set(tokens)].sort().join(" ");
}

/**
 * Single-token normalized names ("SMITH") are too ambiguous to merge across
 * records; the resolver keeps each such record as its own entity.
 */
export function isAmbiguousName(normalizedName: string): boolean {
  return normalizedName === "" || !normalizedName.includes(" ");
}

// ---------------------------------------------------------------------------
// Owner kind (llc | trust | individual | other) via regex over the raw name
// ---------------------------------------------------------------------------

const ORG_HINT_TOKENS: ReadonlySet<string> = new Set([
  "INC",
  "INCORPORATED",
  "CORP",
  "CORPORATION",
  "LTD",
  "LIMITED",
  "LP",
  "LLP",
  "COMPANY",
  "PROPERTIES",
  "REALTY",
  "HOLDINGS",
  "GROUP",
  "PARTNERS",
  "PARTNERSHIP",
  "ASSOCIATES",
  "ASSOCIATION",
  "CHURCH",
  "CITY",
  "HOUSING",
  "AUTHORITY",
  "ESTATE",
]);

export type OwnerKind = "individual" | "llc" | "trust" | "other";

/** Classify an owner name string. Individuals are the default. */
export function ownerKindFromName(raw: string | null | undefined): OwnerKind {
  if (!raw) return "other";
  const tokens = new Set(cleanName(raw).split(" ").filter(Boolean));
  if (tokens.has("LLC")) return "llc";
  if (
    tokens.has("TRUST") ||
    tokens.has("TRUSTS") ||
    tokens.has("TRUSTEE") ||
    tokens.has("TRUSTEES") ||
    tokens.has("TR") ||
    tokens.has("TRS")
  ) {
    return "trust";
  }
  for (const token of tokens) {
    if (ORG_HINT_TOKENS.has(token)) return "other";
  }
  return tokens.size > 0 ? "individual" : "other";
}

// ---------------------------------------------------------------------------
// Mailing addresses
// ---------------------------------------------------------------------------

/** Small USPS-style abbreviation table (no libpostal at this scale). */
const USPS_ABBREVIATIONS: Readonly<Record<string, string>> = {
  STREET: "ST",
  AVENUE: "AVE",
  AVE: "AVE",
  ROAD: "RD",
  DRIVE: "DR",
  LANE: "LN",
  COURT: "CT",
  PLACE: "PL",
  BOULEVARD: "BLVD",
  CIRCLE: "CIR",
  TERRACE: "TER",
  PARKWAY: "PKWY",
  HIGHWAY: "HWY",
  SQUARE: "SQ",
  PLAZA: "PLZ",
  EXTENSION: "EXT",
  NORTH: "N",
  SOUTH: "S",
  EAST: "E",
  WEST: "W",
  APARTMENT: "APT",
  SUITE: "STE",
  FLOOR: "FL",
  ROOM: "RM",
  BUILDING: "BLDG",
  DEPARTMENT: "DEPT",
  POST: "PO",
};

/** Unit designators stripped (with their value token) from compare keys. */
const UNIT_DESIGNATORS: ReadonlySet<string> = new Set([
  "APT",
  "STE",
  "UNIT",
  "FL",
  "RM",
  "BLDG",
  "DEPT",
  "#",
]);

/**
 * Normalize one address line: uppercase, punctuation -> space ("#" kept as
 * its own token so "#3" is recognized as a unit), USPS abbreviations applied
 * per token, whitespace collapsed.
 */
export function normalizeAddressLine(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .toUpperCase()
    .replace(/[.'’]/g, "")
    .replace(/#/g, " # ")
    .replace(/[^A-Z0-9#]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((token) => USPS_ABBREVIATIONS[token] ?? token)
    .join(" ");
}

/**
 * Compare-key form of an address line: normalized AND unit designators
 * removed (each designator plus its following value token). "12 MAIN ST APT
 * 4B" and "12 MAIN STREET" compare equal; stored records keep the unit.
 */
export function addressLineCompareKey(raw: string | null | undefined): string {
  const tokens = normalizeAddressLine(raw).split(" ").filter(Boolean);
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (UNIT_DESIGNATORS.has(token)) {
      i += 1; // skip the unit value too ("APT 4B" -> both dropped)
      continue;
    }
    kept.push(token);
  }
  return kept.join(" ");
}

/** First 5 digits of a US zip ("02906-1234" -> "02906"); "" when absent. */
export function normalizeZip5(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length >= 5) return digits.slice(0, 5);
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned;
}

export interface NormalizableAddress {
  line1: string;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
}

/**
 * Full mailing-address compare key: unit-stripped line1 | locality | region |
 * zip5. Two records merge at confidence 0.95 when these keys are equal.
 * Returns null when the address itself is null.
 */
export function mailingAddressCompareKey(
  address: NormalizableAddress | null | undefined,
): string | null {
  if (!address) return null;
  const line = addressLineCompareKey(address.line1);
  if (!line) return null;
  const locality = normalizeAddressLine(address.locality);
  const region = normalizeAddressLine(address.region);
  const zip = normalizeZip5(address.postal_code);
  return `${line}|${locality}|${region}|${zip}`;
}
