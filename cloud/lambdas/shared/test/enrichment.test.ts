import { describe, expect, it } from "vitest";
import {
  enrichmentEmailSchema,
  enrichmentPayloadSchema,
  enrichmentPhoneSchema,
  enrichmentRequestSchema,
  validateSourceEvent,
  computeIdempotencyKey,
  newSourceEventId,
  deterministicCloudEntityId,
  type CloudSourceEvent,
  type EnrichmentPayload,
  type EnrichmentRequest,
} from "../src/index.js";

function validRequest(): EnrichmentRequest {
  return {
    cloud_entity_id: deterministicCloudEntityId("JANE ROE", "02906").replace(/^ce_/, "ce_"),
    requested_at: "2026-09-01T15:00:00.000Z",
    situs_address: {
      line1: "123 Hope St",
      locality: "Providence",
      region: "RI",
      postal_code: "02906",
    },
    owner_full_name: "JANE ROE",
  };
}

function validPayload(): EnrichmentPayload {
  return {
    vendor: "tracerfy",
    hit: true,
    phones: [
      { e164: "+15125550100", kind: "mobile", dnc_listed: false, tcpa_flag: false, rank: 1 },
      { e164: "+15125550200", kind: "landline", dnc_listed: true, tcpa_flag: false, rank: 2 },
    ],
    emails: [{ address: "jane.doe@example.com", rank: 1 }],
    credits_used: 5,
    matched_owner: true,
  };
}

function validEnrichmentEvent(): CloudSourceEvent {
  const ceId = deterministicCloudEntityId("JANE ROE", "02906");
  return {
    contract_version: 1,
    id: newSourceEventId(),
    idempotency_key: computeIdempotencyKey("parcel", `enrich:${ceId}`, "fp-1"),
    channel: "parcel",
    source_uri: `tracerfy:instant-trace:${ceId}`,
    fetched_at: "2026-09-01T15:05:00.000Z",
    observed_at: "2026-09-01T15:05:00.000Z",
    entity: {
      cloud_entity_id: ceId,
      person: {
        full_name: "Jane Doe",
        mailing_address: {
          line1: "PO Box 111",
          locality: "Austin",
          region: "TX",
          postal_code: "78702",
          country_code: "US",
        },
        phones: ["+15125550100", "+15125550200"],
        emails: ["jane.doe@example.com"],
        org_names: [],
      },
      property: null,
      known_person: false,
    },
    payload: validPayload(),
    signal_flags: {
      self_managed: null,
      vacancy: null,
      pain_mentions: [],
      urgency: 0,
      portfolio_hint: null,
    },
    trigger: null,
    scores: null,
    provenance: { adapter: "enricher", adapter_version: "1.0.0", confidence: 0.9 },
  };
}

describe("enrichmentRequestSchema", () => {
  it("round-trips a valid request", () => {
    const request = validRequest();
    const parsed = enrichmentRequestSchema.parse(JSON.parse(JSON.stringify(request)));
    expect(parsed).toEqual(request);
  });

  it("rejects unknown fields (strict, no prose smuggling)", () => {
    expect(
      enrichmentRequestSchema.safeParse({ ...validRequest(), note: "call after 5" }).success,
    ).toBe(false);
    const nested = validRequest();
    expect(
      enrichmentRequestSchema.safeParse({
        ...nested,
        situs_address: { ...nested.situs_address, unit: "2" },
      }).success,
    ).toBe(false);
  });

  it("rejects a bad cloud_entity_id", () => {
    expect(
      enrichmentRequestSchema.safeParse({ ...validRequest(), cloud_entity_id: "ce_short" })
        .success,
    ).toBe(false);
  });

  it("requires a 2-letter region and non-empty locality", () => {
    const request = validRequest();
    expect(
      enrichmentRequestSchema.safeParse({
        ...request,
        situs_address: { ...request.situs_address, region: "Rhode Island" },
      }).success,
    ).toBe(false);
    expect(
      enrichmentRequestSchema.safeParse({
        ...request,
        situs_address: { ...request.situs_address, locality: "" },
      }).success,
    ).toBe(false);
  });

  it("allows a null postal_code", () => {
    const request = validRequest();
    expect(
      enrichmentRequestSchema.safeParse({
        ...request,
        situs_address: { ...request.situs_address, postal_code: null },
      }).success,
    ).toBe(true);
  });
});

describe("enrichmentPayloadSchema", () => {
  it("round-trips a valid payload", () => {
    const payload = validPayload();
    expect(enrichmentPayloadSchema.parse(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
  });

  it("accepts a miss (no contacts, 0 credits)", () => {
    expect(
      enrichmentPayloadSchema.safeParse({
        vendor: "tracerfy",
        hit: false,
        phones: [],
        emails: [],
        credits_used: 0,
        matched_owner: false,
      }).success,
    ).toBe(true);
  });

  it("rejects non-E.164 phones and non-lowercase emails", () => {
    expect(
      enrichmentPhoneSchema.safeParse({
        e164: "5125550100",
        kind: "mobile",
        dnc_listed: false,
        tcpa_flag: false,
        rank: 1,
      }).success,
    ).toBe(false);
    expect(enrichmentEmailSchema.safeParse({ address: "Jane@Example.com", rank: 1 }).success).toBe(
      false,
    );
    expect(enrichmentEmailSchema.safeParse({ address: "jane@example.com", rank: 1 }).success).toBe(
      true,
    );
  });

  it("rejects unknown vendor, unknown phone kind, and extra fields (strict)", () => {
    expect(
      enrichmentPayloadSchema.safeParse({ ...validPayload(), vendor: "spokeo" }).success,
    ).toBe(false);
    const payload = validPayload();
    expect(
      enrichmentPayloadSchema.safeParse({
        ...payload,
        phones: [{ ...payload.phones[0], kind: "satellite" }],
      }).success,
    ).toBe(false);
    expect(
      enrichmentPayloadSchema.safeParse({ ...validPayload(), raw_response: "{}" }).success,
    ).toBe(false);
  });

  it("rejects negative credits and rank 0", () => {
    expect(
      enrichmentPayloadSchema.safeParse({ ...validPayload(), credits_used: -1 }).success,
    ).toBe(false);
    const payload = validPayload();
    expect(
      enrichmentPayloadSchema.safeParse({
        ...payload,
        emails: [{ address: "jane@example.com", rank: 0 }],
      }).success,
    ).toBe(false);
  });
});

describe("parcel channel payload union (tax roll | enrichment)", () => {
  it("validateSourceEvent accepts an enrichment event on channel parcel", () => {
    expect(validateSourceEvent(validEnrichmentEvent()).success).toBe(true);
  });

  it("still accepts a tax-roll parcel payload on the same channel", () => {
    const event = {
      ...validEnrichmentEvent(),
      payload: {
        assessor_class: "2",
        assessed_value_usd: 471400,
        tax_usd: 6599.6,
        absentee: true,
        owner_kind: "llc",
        tax_year: 2025,
      },
    };
    expect(validateSourceEvent(event).success).toBe(true);
  });

  it("rejects a payload matching neither union member", () => {
    const event = { ...validEnrichmentEvent(), payload: { vendor: "tracerfy" } };
    const result = validateSourceEvent(event);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("parcel");
  });
});
