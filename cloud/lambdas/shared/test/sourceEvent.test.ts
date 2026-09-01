import { describe, expect, it } from "vitest";
import {
  cloudSourceEventSchema,
  communityPostPayloadSchema,
  computeIdempotencyKey,
  deterministicCloudEntityId,
  frboListingPayloadSchema,
  parcelPayloadSchema,
  newCloudEntityId,
  newSourceEventId,
  TRIGGER_TYPES,
  ulid,
  validateSourceEvent,
  violationPayloadSchema,
  type CloudSourceEvent,
} from "../src/sourceEvent.js";

function validFrboEvent(): CloudSourceEvent {
  return {
    contract_version: 1,
    id: newSourceEventId(),
    idempotency_key: computeIdempotencyKey(
      "frbo",
      "zillow:https://www.zillow.com/homedetails/123",
      "fingerprint-1",
    ),
    channel: "frbo",
    source_uri: "ses:zillow-alert:abc123",
    fetched_at: "2026-09-01T03:00:00.000Z",
    observed_at: "2026-09-01T02:59:00.000Z",
    entity: {
      cloud_entity_id: newCloudEntityId(),
      person: null,
      property: {
        situs_address: {
          line1: "123 Hope St",
          locality: "Providence",
          region: "RI",
          postal_code: "02906",
          country_code: "US",
        },
        parcel_id: null,
        unit_count: null,
        year_built: null,
        use_code: null,
      },
      known_person: false,
    },
    payload: {
      listing_url: "https://www.zillow.com/homedetails/123",
      rent_usd: 2200,
      beds: 3,
      baths: 1.5,
      property_kind: "multi_family",
      listed_at: null,
    },
    signal_flags: {
      self_managed: true,
      vacancy: null,
      pain_mentions: [],
      urgency: 1,
      portfolio_hint: null,
    },
    trigger: {
      type: "frbo_listing",
      weight: 1.0,
      half_life_days: TRIGGER_TYPES.frbo_listing.half_life_days,
      window: null,
    },
    scores: null,
    provenance: {
      adapter: "mail-parse",
      adapter_version: "1.0.0",
      confidence: 0.9,
    },
  };
}

describe("cloudSourceEventSchema", () => {
  it("round-trips a valid frbo event", () => {
    const event = validFrboEvent();
    const parsed = cloudSourceEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(parsed).toEqual(event);
  });

  it("validateSourceEvent accepts a valid frbo event", () => {
    const result = validateSourceEvent(validFrboEvent());
    expect(result.success).toBe(true);
  });

  it("rejects unknown top-level fields (strict)", () => {
    const event = { ...validFrboEvent(), sneaky_note: "prose about a person" };
    expect(cloudSourceEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects unknown nested fields (strict entity)", () => {
    const event = validFrboEvent();
    const dirty = JSON.parse(JSON.stringify(event));
    dirty.entity.bio = "free text";
    expect(cloudSourceEventSchema.safeParse(dirty).success).toBe(false);
  });

  it("rejects wrong contract_version", () => {
    const event = { ...validFrboEvent(), contract_version: 2 };
    expect(cloudSourceEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects wrong payload-for-channel", () => {
    const event = validFrboEvent();
    // community payload on an frbo channel event
    event.payload = {
      platform: "reddit",
      topic_keywords: ["landlord"],
      post_url: "https://www.reddit.com/r/providence/comments/x",
    };
    const result = validateSourceEvent(event);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("frbo");
  });

  it("rejects channels without a registered payload schema", () => {
    const event = validFrboEvent();
    const parcelEvent = {
      ...event,
      channel: "parcel" as const,
      trigger: null,
      payload: {},
    };
    const result = validateSourceEvent(parcelEvent);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("parcel");
  });

  it("accepts a valid community event", () => {
    const event = validFrboEvent();
    const community: CloudSourceEvent = {
      ...event,
      channel: "community",
      payload: {
        platform: "reddit",
        topic_keywords: ["landlord software"],
        post_url: "https://www.reddit.com/r/providence/comments/x/y/",
      },
      entity: { ...event.entity, person: null, property: null },
      trigger: {
        type: "community_post",
        weight: 1.0,
        half_life_days: 7,
        window: null,
      },
    };
    expect(validateSourceEvent(community).success).toBe(true);
  });

  it("rejects extra fields in payloads (strict, no prose smuggling)", () => {
    expect(
      communityPostPayloadSchema.safeParse({
        platform: "reddit",
        topic_keywords: ["k"],
        post_url: "https://reddit.com/x",
        post_body: "the entire post text",
      }).success,
    ).toBe(false);
    expect(
      frboListingPayloadSchema.safeParse({
        listing_url: "https://zillow.com/x",
        rent_usd: null,
        beds: null,
        baths: null,
        property_kind: "other",
        listed_at: null,
        description: "charming 3 bed",
      }).success,
    ).toBe(false);
  });

  it("rejects invalid pain_mentions", () => {
    const event = validFrboEvent();
    const dirty = JSON.parse(JSON.stringify(event));
    dirty.signal_flags.pain_mentions = ["leaky_faucet"];
    expect(cloudSourceEventSchema.safeParse(dirty).success).toBe(false);
  });

  it("accepts scores null and 1 to 3 reasons, rejects 0 and 4", () => {
    const event = validFrboEvent();
    expect(cloudSourceEventSchema.safeParse(event).success).toBe(true);
    const scored = {
      ...event,
      scores: {
        fit: 62,
        timing: 41,
        reasons: [
          { signal: "a", contribution: 15 },
          { signal: "b", contribution: 12 },
          { signal: "c", contribution: 8 },
        ],
      },
    };
    expect(cloudSourceEventSchema.safeParse(scored).success).toBe(true);
    const twoReasons = { ...scored, scores: { ...scored.scores, reasons: scored.scores.reasons.slice(0, 2) } };
    expect(cloudSourceEventSchema.safeParse(twoReasons).success).toBe(true);
    const zeroReasons = { ...scored, scores: { ...scored.scores, reasons: [] } };
    expect(cloudSourceEventSchema.safeParse(zeroReasons).success).toBe(false);
    const fourReasons = {
      ...scored,
      scores: {
        ...scored.scores,
        reasons: [...scored.scores.reasons, { signal: "d", contribution: 1 }],
      },
    };
    expect(cloudSourceEventSchema.safeParse(fourReasons).success).toBe(false);
  });
});

describe("scores_version (additive, scorer-emitted)", () => {
  it("is optional: events without it still validate", () => {
    const event = validFrboEvent();
    expect("scores_version" in event).toBe(false);
    expect(cloudSourceEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts a positive integer", () => {
    const event = { ...validFrboEvent(), scores_version: 1 };
    expect(cloudSourceEventSchema.safeParse(event).success).toBe(true);
    expect(validateSourceEvent(event).success).toBe(true);
  });

  it("rejects zero, negatives, and non-integers", () => {
    for (const bad of [0, -1, 1.5, "1"]) {
      const event = { ...validFrboEvent(), scores_version: bad };
      expect(cloudSourceEventSchema.safeParse(event).success, String(bad)).toBe(false);
    }
  });
});

describe("parcel + violation payload schemas", () => {
  const parcelPayload = {
    assessor_class: "2",
    assessed_value_usd: 471400,
    tax_usd: 6599.6,
    absentee: true,
    owner_kind: "llc",
    tax_year: 2025,
  };

  const violationPayload = {
    violation_kind: "Housing Violations",
    status: "open",
    opened_at: "2026-08-28",
    case_ref: "269",
  };

  it("accepts a valid parcel payload and channel event", () => {
    expect(parcelPayloadSchema.safeParse(parcelPayload).success).toBe(true);
    const event = {
      ...validFrboEvent(),
      channel: "parcel",
      trigger: null,
      payload: parcelPayload,
    };
    expect(validateSourceEvent(event).success).toBe(true);
  });

  it("accepts a valid violation payload and channel event", () => {
    expect(violationPayloadSchema.safeParse(violationPayload).success).toBe(true);
    const event = {
      ...validFrboEvent(),
      channel: "violation",
      trigger: {
        type: "violation_opened",
        weight: 1.0,
        half_life_days: TRIGGER_TYPES.violation_opened.half_life_days,
        window: null,
      },
      payload: violationPayload,
    };
    expect(validateSourceEvent(event).success).toBe(true);
  });

  it("parcel: rejects unknown fields and bad owner_kind (strict)", () => {
    expect(
      parcelPayloadSchema.safeParse({ ...parcelPayload, extra: "nope" }).success,
    ).toBe(false);
    expect(
      parcelPayloadSchema.safeParse({ ...parcelPayload, owner_kind: "corp" }).success,
    ).toBe(false);
  });

  it("parcel: all fields nullable", () => {
    expect(
      parcelPayloadSchema.safeParse({
        assessor_class: null,
        assessed_value_usd: null,
        tax_usd: null,
        absentee: null,
        owner_kind: null,
        tax_year: null,
      }).success,
    ).toBe(true);
  });

  it("violation: rejects datetime in opened_at (calendar date only)", () => {
    expect(
      violationPayloadSchema.safeParse({
        ...violationPayload,
        opened_at: "2026-08-28T00:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("violation: rejects unknown status and unknown fields (strict)", () => {
    expect(
      violationPayloadSchema.safeParse({ ...violationPayload, status: "pending" }).success,
    ).toBe(false);
    expect(
      violationPayloadSchema.safeParse({ ...violationPayload, prose: "text" }).success,
    ).toBe(false);
  });

  it("violation event without trigger (complaint identity row) validates", () => {
    const event = {
      ...validFrboEvent(),
      channel: "violation",
      trigger: null,
      payload: { ...violationPayload, violation_kind: "Housing Complaints" },
    };
    expect(validateSourceEvent(event).success).toBe(true);
  });
});

describe("computeIdempotencyKey", () => {
  it("is stable for identical inputs", () => {
    const a = computeIdempotencyKey("frbo", "key", "fp");
    const b = computeIdempotencyKey("frbo", "key", "fp");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is channel-sensitive", () => {
    expect(computeIdempotencyKey("frbo", "key", "fp")).not.toBe(
      computeIdempotencyKey("community", "key", "fp"),
    );
  });

  it("is sensitive to natural key and fingerprint", () => {
    expect(computeIdempotencyKey("frbo", "key1", "fp")).not.toBe(
      computeIdempotencyKey("frbo", "key2", "fp"),
    );
    expect(computeIdempotencyKey("frbo", "key", "fp1")).not.toBe(
      computeIdempotencyKey("frbo", "key", "fp2"),
    );
  });
});

describe("ulid + ID helpers", () => {
  it("generates 26-char Crockford base32 ULIDs", () => {
    const id = ulid();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("timestamp prefix is ordered", () => {
    const a = ulid(1_000_000_000_000);
    const b = ulid(2_000_000_000_000);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });

  it("generates unique IDs", () => {
    const seen = new Set(Array.from({ length: 1000 }, () => ulid()));
    expect(seen.size).toBe(1000);
  });

  it("prefixes se_ and ce_", () => {
    expect(newSourceEventId()).toMatch(/^se_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newCloudEntityId()).toMatch(/^ce_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("rejects out-of-range timestamps", () => {
    expect(() => ulid(-1)).toThrow(RangeError);
    expect(() => ulid(2 ** 48)).toThrow(RangeError);
  });
});

describe("deterministicCloudEntityId", () => {
  it("is stable: same inputs -> same id, across calls", () => {
    const a = deterministicCloudEntityId("212 LLC", "02906");
    const b = deterministicCloudEntityId("212 LLC", "02906");
    expect(a).toBe(b);
  });

  it("matches the ce_ regex used by the entity schema", () => {
    expect(deterministicCloudEntityId("212 LLC", "02906")).toMatch(
      /^ce_[0-9A-HJKMNP-TV-Z]{26}$/,
    );
    expect(deterministicCloudEntityId("Ricardo Baez", null)).toMatch(
      /^ce_[0-9A-HJKMNP-TV-Z]{26}$/,
    );
  });

  it("is insensitive to owner-name formatting (normalizeOwnerName)", () => {
    const canonical = deterministicCloudEntityId("212 LLC", "02906");
    expect(deterministicCloudEntityId("212, L.L.C.", "02906")).toBe(canonical);
    expect(deterministicCloudEntityId("  212   llc ", "02906")).toBe(canonical);
    expect(deterministicCloudEntityId("SMITH, JOHN", "02906")).toBe(
      deterministicCloudEntityId("John Smith", "02906"),
    );
  });

  it("normalizes the zip to zip5 (zip+4 converges)", () => {
    expect(deterministicCloudEntityId("212 LLC", "02906-1234")).toBe(
      deterministicCloudEntityId("212 LLC", "02906"),
    );
  });

  it("is zip-sensitive: same name in different zips stays distinct", () => {
    expect(deterministicCloudEntityId("212 LLC", "02906")).not.toBe(
      deterministicCloudEntityId("212 LLC", "02907"),
    );
    expect(deterministicCloudEntityId("212 LLC", "02906")).not.toBe(
      deterministicCloudEntityId("212 LLC", null),
    );
  });

  it("is name-sensitive: different owners never converge", () => {
    expect(deterministicCloudEntityId("212 LLC", "02906")).not.toBe(
      deterministicCloudEntityId("213 LLC", "02906"),
    );
  });
});
