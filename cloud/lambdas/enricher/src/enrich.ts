/**
 * Enrichment core logic: person picking, contact normalization, suppression
 * HMACs, fingerprinting and event construction. Pure functions — all IO
 * (vendor, S3, Dynamo, SNS, SSM) lives in handler.ts.
 *
 * Person pick order (plan):
 *   1. persons with property_owner === true (among them, prefer the one whose
 *      normalized name matches the request's owner_full_name)
 *   2. else best normalized-name match to owner_full_name
 *   3. else vendor rank order (first person)
 * matched_owner = picked person is property_owner OR name-matches the owner;
 * provenance confidence is 0.9 when matched, 0.6 otherwise.
 */
import { createHash, createHmac } from "node:crypto";
import {
  computeIdempotencyKey,
  newSourceEventId,
  normalizeOwnerName,
  type CloudSourceEvent,
  type EnrichmentEmail,
  type EnrichmentPayload,
  type EnrichmentPhone,
  type EnrichmentRequest,
  type PostalAddress,
} from "@callie-sourcing/shared";
import type { TracerfyPerson, TracerfyPhone } from "./tracerfy";

export const ADAPTER_NAME = "enricher";
export const ADAPTER_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Contact normalization
// ---------------------------------------------------------------------------

/**
 * Vendor phone numbers are bare US 10-digit strings ("5125550100"). Normalize
 * to E.164 with the +1 prefix; returns null for anything that is not a US
 * number shape (dropped + counted, never emitted).
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Vendor `type` ("Mobile" | "Landline" | "Voip" | ...) -> payload kind. */
export function phoneKind(raw: string | null | undefined): EnrichmentPhone["kind"] {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "mobile":
    case "wireless":
    case "cell":
      return "mobile";
    case "landline":
    case "fixed":
      return "landline";
    case "voip":
      return "voip";
    default:
      return "other";
  }
}

export interface NormalizedContacts {
  phones: EnrichmentPhone[];
  emails: EnrichmentEmail[];
  /** Vendor contacts dropped because they could not be normalized. */
  invalidDropped: number;
}

function vendorCompliance(phone: TracerfyPhone): EnrichmentPhone["compliance"] {
  return {
    federal_status: phone.dnc === true ? "listed" : "unknown",
    tcpa_flag: phone.tcpa === true ? true : null,
    covered_area_code: null,
    source: "enrichment_vendor",
    scrubbed_at: null,
    expires_at: null,
  };
}

/**
 * Normalize the picked person's contact set: phones to E.164 (+1), emails
 * lowercased, both deduped, ranks defaulting to array position when the
 * vendor omits them.
 */
export function normalizeContacts(person: TracerfyPerson): NormalizedContacts {
  const phones: EnrichmentPhone[] = [];
  const phonesByE164 = new Map<string, EnrichmentPhone>();
  let invalidDropped = 0;

  for (const [index, phone] of (person.phones ?? []).entries()) {
    const e164 = toE164(phone.number);
    if (!e164) {
      invalidDropped += 1;
      continue;
    }
    const existing = phonesByE164.get(e164);
    if (existing !== undefined) {
      const duplicateCompliance = vendorCompliance(phone);
      if (duplicateCompliance.federal_status === "listed") {
        existing.compliance.federal_status = "listed";
      }
      if (duplicateCompliance.tcpa_flag === true) {
        existing.compliance.tcpa_flag = true;
      }
      continue;
    }
    const normalizedPhone: EnrichmentPhone = {
      e164,
      kind: phoneKind(phone.type),
      compliance: vendorCompliance(phone),
      rank: phone.rank ?? index + 1,
    };
    phonesByE164.set(e164, normalizedPhone);
    phones.push(normalizedPhone);
  }

  const emails: EnrichmentEmail[] = [];
  const seenEmails = new Set<string>();
  for (const [index, email] of (person.emails ?? []).entries()) {
    const address = email.email.trim().toLowerCase();
    // Cheap shape check; the payload schema is the real gate.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      invalidDropped += 1;
      continue;
    }
    if (seenEmails.has(address)) continue;
    seenEmails.add(address);
    emails.push({ address, rank: email.rank ?? index + 1 });
  }

  return { phones, emails, invalidDropped };
}

// ---------------------------------------------------------------------------
// Person pick
// ---------------------------------------------------------------------------

export interface PickedPerson {
  person: TracerfyPerson;
  matchedOwner: boolean;
}

export function pickPerson(
  persons: TracerfyPerson[],
  ownerFullName: string,
): PickedPerson | null {
  if (persons.length === 0) return null;
  const ownerNormalized = normalizeOwnerName(ownerFullName);
  const nameMatches = (person: TracerfyPerson): boolean =>
    ownerNormalized !== "" &&
    normalizeOwnerName(person.full_name ?? "") === ownerNormalized;

  const owners = persons.filter((person) => person.property_owner === true);
  if (owners.length > 0) {
    const person = owners.find(nameMatches) ?? owners[0]!;
    return { person, matchedOwner: true };
  }

  const byName = persons.find(nameMatches);
  if (byName) return { person: byName, matchedOwner: true };

  // Rank fallback: vendor order (persons arrive best-first).
  return { person: persons[0]!, matchedOwner: false };
}

// ---------------------------------------------------------------------------
// Suppression HMAC — mirrors src/main/sourcing/upstreamSync.ts#contactHmac
// exactly (HMAC-SHA256 lowercase hex over the normalized handle) so cloud-
// side and app-side hashes always agree.
// ---------------------------------------------------------------------------

export function contactHmac(
  salt: string,
  kind: "phone" | "email",
  normalizedValue: string,
): string {
  const canonical =
    kind === "email"
      ? normalizedValue.trim().toLowerCase()
      : normalizedValue.trim();
  return createHmac("sha256", salt).update(canonical, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Event construction
// ---------------------------------------------------------------------------

export function naturalKey(request: EnrichmentRequest): string {
  return `enrich:${request.cloud_entity_id}`;
}

/**
 * Fingerprint over the (post-suppression) response contact set plus the
 * hit/matched_owner outcome. ADAPTER_VERSION is part of the fingerprint so
 * logic fixes re-emit corrected events. A re-run against an unchanged vendor
 * response produces the same key -> idempotency skip, no duplicate import.
 */
export function contentFingerprint(payload: EnrichmentPayload): string {
  const canonical = {
    hit: payload.hit,
    matched_owner: payload.matched_owner,
    phones: [...payload.phones].sort((a, b) => a.e164.localeCompare(b.e164)),
    emails: [...payload.emails].sort((a, b) => a.address.localeCompare(b.address)),
  };
  return createHash("sha256")
    .update(`${JSON.stringify(canonical)}|${ADAPTER_VERSION}`, "utf8")
    .digest("hex");
}

function vendorMailingAddress(person: TracerfyPerson | null): PostalAddress | null {
  const street = person?.mailing_address?.street?.trim();
  if (!street) return null;
  return {
    line1: street,
    locality: person?.mailing_address?.city?.trim() || null,
    region: person?.mailing_address?.state?.trim() || null,
    postal_code: person?.mailing_address?.zip?.trim() || null,
    country_code: "US",
  };
}

export interface BuildEventInput {
  request: EnrichmentRequest;
  /** null on vendor miss. */
  picked: PickedPerson | null;
  /** Post-suppression surviving contacts (empty arrays on miss). */
  phones: EnrichmentPhone[];
  emails: EnrichmentEmail[];
  creditsUsed: number;
  fetchedAt: Date;
}

/**
 * Build the enrichment SourceEvent. channel `parcel`: enrichment attaches to
 * the entity's EXISTING identity; it never mints a person. payload.hit is
 * false on a vendor miss AND when suppression dropped every contact (the
 * "all contacts drop" rule — the event still lands so the app learns the
 * request resolved to nothing usable).
 */
export function buildEnrichmentEvent(input: BuildEventInput): CloudSourceEvent {
  const { request, picked, phones, emails, creditsUsed, fetchedAt } = input;
  const vendorHit = picked !== null;
  const hasContacts = phones.length > 0 || emails.length > 0;
  const hit = vendorHit && hasContacts;
  const matchedOwner = picked?.matchedOwner ?? false;

  const payload: EnrichmentPayload = {
    vendor: "tracerfy",
    hit,
    phones,
    emails,
    credits_used: creditsUsed,
    matched_owner: matchedOwner,
  };

  const nowIso = fetchedAt.toISOString();
  return {
    contract_version: 1,
    id: newSourceEventId(fetchedAt.getTime()),
    idempotency_key: computeIdempotencyKey(
      "parcel",
      naturalKey(request),
      contentFingerprint(payload),
    ),
    channel: "parcel",
    source_uri: `tracerfy:instant-trace:${request.cloud_entity_id}`,
    fetched_at: nowIso,
    observed_at: nowIso,
    entity: {
      cloud_entity_id: request.cloud_entity_id,
      person: picked
        ? {
            full_name: picked.person.full_name?.trim() || null,
            mailing_address: vendorMailingAddress(picked.person),
            phones: phones.map((phone) => phone.e164),
            emails: emails.map((email) => email.address),
            org_names: [],
          }
        : null,
      property: null,
      // By construction the app already has this entity: it wrote the
      // enrichment request keyed by this cloud_entity_id.
      known_person: true,
    },
    payload,
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
      confidence: matchedOwner ? 0.9 : 0.6,
    },
  };
}
