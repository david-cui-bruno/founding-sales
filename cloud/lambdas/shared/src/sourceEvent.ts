/**
 * CloudSourceEvent schema — canonical implementation of cloud/CONTRACT.md v1.
 *
 * Every adapter (mail-parse, permits, parcels, ...) validates events against
 * these schemas before writing ndjson to the inbox bucket. All object schemas
 * are `.strict()`: unknown fields are rejected so adapters cannot smuggle
 * free text (design rule: flags, not prose).
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Channels (CONTRACT.md "Channels" table, aligned with CRM migration 0005)
// ---------------------------------------------------------------------------

export const channelSchema = z.enum([
  "frbo",
  "community",
  "registry",
  "parcel",
  "deed",
  "permit",
  "violation",
  "rireig",
  "referral",
  "inbound_demo",
  "custom",
]);
export type Channel = z.infer<typeof channelSchema>;

// ---------------------------------------------------------------------------
// Trigger types (CONTRACT.md v1 set) with the half-life table as a const.
// `half_life_days: null` = the trigger is window-based, seasonal, or
// informational (no exponential decay).
// ---------------------------------------------------------------------------

export const TRIGGER_TYPES = {
  frbo_listing: { kind: "decay", half_life_days: 3 },
  community_post: { kind: "decay", half_life_days: 7 },
  violation_opened: { kind: "decay", half_life_days: 45 },
  permit_filed: { kind: "decay", half_life_days: 60 },
  deed_transfer: { kind: "decay", half_life_days: 180 },
  review_pain: { kind: "decay", half_life_days: 45 },
  lead_cert_window: { kind: "window", half_life_days: null },
  heating_season: { kind: "seasonal", half_life_days: null },
  student_turnover: { kind: "seasonal", half_life_days: null },
  tax_season: { kind: "seasonal", half_life_days: null },
  registry_delta: { kind: "informational", half_life_days: null },
} as const;

export type TriggerType = keyof typeof TRIGGER_TYPES;

export const triggerTypeSchema = z.enum(
  Object.keys(TRIGGER_TYPES) as [TriggerType, ...TriggerType[]],
);

const isoDatetime = z.string().datetime({ offset: false });

export const triggerWindowSchema = z
  .object({
    opens_at: isoDatetime,
    peaks_at: isoDatetime,
    closes_at: isoDatetime,
  })
  .strict();

export const triggerSchema = z
  .object({
    type: triggerTypeSchema,
    weight: z.number().min(0),
    half_life_days: z.number().positive().nullable(),
    window: triggerWindowSchema.nullable(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------

export const postalAddressSchema = z
  .object({
    line1: z.string().min(1),
    locality: z.string().min(1).nullable(),
    region: z.string().min(1).nullable(),
    postal_code: z.string().min(1).nullable(),
    country_code: z.string().length(2),
  })
  .strict();
export type PostalAddress = z.infer<typeof postalAddressSchema>;

export const personDescriptorSchema = z
  .object({
    full_name: z.string().min(1).nullable(),
    mailing_address: postalAddressSchema.nullable(),
    phones: z.array(z.string().regex(/^\+[1-9]\d{6,14}$/, "E.164")),
    emails: z.array(z.string().email()),
    org_names: z.array(z.string().min(1)),
  })
  .strict();

export const propertyDescriptorSchema = z
  .object({
    situs_address: postalAddressSchema.nullable(),
    parcel_id: z.string().min(1).nullable(),
    unit_count: z.number().int().positive().nullable(),
    year_built: z.number().int().nullable(),
    use_code: z.string().min(1).nullable(),
  })
  .strict();

export const entitySchema = z
  .object({
    cloud_entity_id: z
      .string()
      .regex(/^ce_[0-9A-HJKMNP-TV-Z]{26}$/, "ce_<ULID>")
      .nullable(),
    person: personDescriptorSchema.nullable(),
    property: propertyDescriptorSchema.nullable(),
    known_person: z.boolean(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Signal flags — typed only, never prose.
// ---------------------------------------------------------------------------

export const painMentionSchema = z.enum([
  "no_heat",
  "slow_repair",
  "unresponsive",
  "plumbing",
  "electrical",
  "pests",
  "mold",
  "other",
]);
export type PainMention = z.infer<typeof painMentionSchema>;

export const signalFlagsSchema = z
  .object({
    self_managed: z.boolean().nullable(),
    vacancy: z.boolean().nullable(),
    pain_mentions: z.array(painMentionSchema),
    urgency: z.number().int().min(0).max(3),
    portfolio_hint: z.number().int().nullable(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Scores (null until the scoring engine runs)
// ---------------------------------------------------------------------------

export const scoreReasonSchema = z
  .object({
    signal: z.string().min(1),
    contribution: z.number(),
  })
  .strict();

export const scoresSchema = z
  .object({
    fit: z.number().min(0).max(100),
    timing: z.number().min(0).max(100),
    // CONTRACT.md: "exactly the top 3, ordered".
    reasons: z.array(scoreReasonSchema).min(1).max(3),
  })
  .strict();

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export const provenanceSchema = z
  .object({
    adapter: z.string().min(1),
    adapter_version: z.string().min(1),
    confidence: z.number().min(0).max(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// Per-channel payload schemas (closed; grow as adapters land)
// ---------------------------------------------------------------------------

export const frboListingPayloadSchema = z
  .object({
    listing_url: z.string().url(),
    rent_usd: z.number().nonnegative().nullable(),
    beds: z.number().nonnegative().nullable(),
    baths: z.number().nonnegative().nullable(),
    property_kind: z.enum([
      "single_family",
      "multi_family",
      "condo",
      "apartment",
      "other",
    ]),
    listed_at: isoDatetime.nullable(),
  })
  .strict();
export type FrboListingPayload = z.infer<typeof frboListingPayloadSchema>;

export const communityPostPayloadSchema = z
  .object({
    platform: z.enum(["reddit", "hackernews", "other"]),
    topic_keywords: z.array(z.string().min(1)),
    post_url: z.string().url(),
  })
  .strict();
export type CommunityPostPayload = z.infer<typeof communityPostPayloadSchema>;

/**
 * Channel -> payload schema registry. Channels without an entry do not have a
 * v1 payload schema yet; validateSourceEvent rejects events for them so an
 * adapter cannot ship an unchecked payload.
 */
export const PAYLOAD_SCHEMAS: Partial<Record<Channel, z.ZodTypeAny>> = {
  frbo: frboListingPayloadSchema,
  community: communityPostPayloadSchema,
};

// ---------------------------------------------------------------------------
// The event
// ---------------------------------------------------------------------------

export const cloudSourceEventSchema = z
  .object({
    contract_version: z.literal(1),
    id: z.string().regex(/^se_[0-9A-HJKMNP-TV-Z]{26}$/, "se_<ULID>"),
    idempotency_key: z.string().regex(/^[0-9a-f]{64}$/, "sha256 hex"),
    channel: channelSchema,
    source_uri: z.string().min(1),
    fetched_at: isoDatetime,
    observed_at: isoDatetime,
    entity: entitySchema,
    // Channel-specific; validated per channel by validateSourceEvent().
    payload: z.record(z.unknown()),
    signal_flags: signalFlagsSchema,
    // null for pure identity events (registry row, parcel row).
    trigger: triggerSchema.nullable(),
    scores: scoresSchema.nullable(),
    provenance: provenanceSchema,
  })
  .strict();

export type CloudSourceEvent = z.infer<typeof cloudSourceEventSchema>;

export type ValidateSourceEventResult =
  | { success: true; data: CloudSourceEvent }
  | { success: false; error: string };

/**
 * Full validation: the event envelope AND the payload against the channel's
 * registered payload schema. Fails for channels without a payload schema.
 */
export function validateSourceEvent(event: unknown): ValidateSourceEventResult {
  const envelope = cloudSourceEventSchema.safeParse(event);
  if (!envelope.success) {
    return { success: false, error: `envelope: ${envelope.error.message}` };
  }
  const payloadSchema = PAYLOAD_SCHEMAS[envelope.data.channel];
  if (!payloadSchema) {
    return {
      success: false,
      error: `no payload schema registered for channel "${envelope.data.channel}"`,
    };
  }
  const payload = payloadSchema.safeParse(envelope.data.payload);
  if (!payload.success) {
    return {
      success: false,
      error: `payload (${envelope.data.channel}): ${payload.error.message}`,
    };
  }
  return { success: true, data: envelope.data };
}

// ---------------------------------------------------------------------------
// Idempotency + IDs
// ---------------------------------------------------------------------------

/**
 * CONTRACT.md rule 3:
 * idempotency_key = sha256(channel | source_natural_key | content_fingerprint)
 * The "|" separator is literal, making the key channel-sensitive and
 * unambiguous across the three parts.
 */
export function computeIdempotencyKey(
  channel: Channel,
  sourceNaturalKey: string,
  contentFingerprint: string,
): string {
  return createHash("sha256")
    .update(`${channel}|${sourceNaturalKey}|${contentFingerprint}`, "utf8")
    .digest("hex");
}

// Crockford base32, per the ULID spec (no I, L, O, U).
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Inline ULID (no dependency): 48-bit ms timestamp (10 chars) + 80 bits of
 * crypto randomness (16 chars). Monotonicity within the same millisecond is
 * not guaranteed; event ordering relies on timestamps, not IDs.
 */
export function ulid(timestamp: number = Date.now()): string {
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > 2 ** 48 - 1) {
    throw new RangeError(`ulid timestamp out of range: ${timestamp}`);
  }
  let ts = timestamp;
  let timePart = "";
  for (let i = 0; i < 10; i++) {
    timePart = ULID_ALPHABET[ts % 32] + timePart;
    ts = Math.floor(ts / 32);
  }
  const bytes = randomBytes(16);
  let randPart = "";
  for (let i = 0; i < 16; i++) {
    // 256 % 32 === 0, so byte & 31 is uniform.
    randPart += ULID_ALPHABET[bytes[i]! & 31];
  }
  return timePart + randPart;
}

export function newSourceEventId(timestamp?: number): string {
  return `se_${ulid(timestamp)}`;
}

export function newCloudEntityId(timestamp?: number): string {
  return `ce_${ulid(timestamp)}`;
}
