/**
 * Local mirror of the CloudSourceEvent v1 wire contract (cloud/CONTRACT.md).
 *
 * The canonical implementation lives in the cloud workspace
 * (`cloud/lambdas/shared/src/sourceEvent.ts`); the app must never import from
 * `cloud/`, so this file mirrors it faithfully as an independent module. All
 * object schemas are `.strict()`: unknown fields are rejected so nothing can
 * smuggle free text past the typed-fields-only rule. Change this file only in
 * lockstep with the cloud schema and a CONTRACT.md version note.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Channels (CONTRACT.md "Channels" table, aligned with CRM migration 0005)
// ---------------------------------------------------------------------------

export const cloudChannelSchema = z.enum([
  'frbo',
  'community',
  'registry',
  'parcel',
  'deed',
  'permit',
  'violation',
  'rireig',
  'referral',
  'inbound_demo',
  'custom',
]);
export type CloudChannel = z.infer<typeof cloudChannelSchema>;

// ---------------------------------------------------------------------------
// Trigger types (CONTRACT.md v1 set)
// ---------------------------------------------------------------------------

export const cloudTriggerTypeSchema = z.enum([
  'frbo_listing',
  'community_post',
  'violation_opened',
  'permit_filed',
  'deed_transfer',
  'review_pain',
  'lead_cert_window',
  'heating_season',
  'student_turnover',
  'tax_season',
  'registry_delta',
]);
export type CloudTriggerType = z.infer<typeof cloudTriggerTypeSchema>;

const isoDatetime = z.string().datetime({ offset: false });

export const cloudTriggerWindowSchema = z
  .object({
    opens_at: isoDatetime,
    peaks_at: isoDatetime,
    closes_at: isoDatetime,
  })
  .strict();

export const cloudTriggerSchema = z
  .object({
    type: cloudTriggerTypeSchema,
    weight: z.number().min(0),
    half_life_days: z.number().positive().nullable(),
    window: cloudTriggerWindowSchema.nullable(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------

export const cloudPostalAddressSchema = z
  .object({
    line1: z.string().min(1),
    locality: z.string().min(1).nullable(),
    region: z.string().min(1).nullable(),
    postal_code: z.string().min(1).nullable(),
    country_code: z.string().length(2),
  })
  .strict();
export type CloudPostalAddress = z.infer<typeof cloudPostalAddressSchema>;

export const cloudPersonDescriptorSchema = z
  .object({
    full_name: z.string().min(1).nullable(),
    mailing_address: cloudPostalAddressSchema.nullable(),
    phones: z.array(z.string().regex(/^\+[1-9]\d{6,14}$/, 'E.164')),
    emails: z.array(z.string().email()),
    org_names: z.array(z.string().min(1)),
  })
  .strict();
export type CloudPersonDescriptor = z.infer<typeof cloudPersonDescriptorSchema>;

export const cloudPropertyDescriptorSchema = z
  .object({
    situs_address: cloudPostalAddressSchema.nullable(),
    parcel_id: z.string().min(1).nullable(),
    unit_count: z.number().int().positive().nullable(),
    year_built: z.number().int().nullable(),
    use_code: z.string().min(1).nullable(),
  })
  .strict();
export type CloudPropertyDescriptor = z.infer<typeof cloudPropertyDescriptorSchema>;

export const cloudEntitySchema = z
  .object({
    cloud_entity_id: z
      .string()
      .regex(/^ce_[0-9A-HJKMNP-TV-Z]{26}$/, 'ce_<ULID>')
      .nullable(),
    person: cloudPersonDescriptorSchema.nullable(),
    property: cloudPropertyDescriptorSchema.nullable(),
    known_person: z.boolean(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Signal flags — typed only, never prose.
// ---------------------------------------------------------------------------

export const cloudPainMentionSchema = z.enum([
  'no_heat',
  'slow_repair',
  'unresponsive',
  'plumbing',
  'electrical',
  'pests',
  'mold',
  'other',
]);
export type CloudPainMention = z.infer<typeof cloudPainMentionSchema>;

export const cloudSignalFlagsSchema = z
  .object({
    self_managed: z.boolean().nullable(),
    vacancy: z.boolean().nullable(),
    pain_mentions: z.array(cloudPainMentionSchema),
    urgency: z.number().int().min(0).max(3),
    portfolio_hint: z.number().int().nullable(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Scores (null until the scoring engine runs)
// ---------------------------------------------------------------------------

export const cloudScoreReasonSchema = z
  .object({
    signal: z.string().min(1),
    contribution: z.number(),
  })
  .strict();

export const cloudScoresSchema = z
  .object({
    fit: z.number().min(0).max(100),
    timing: z.number().min(0).max(100),
    reasons: z.array(cloudScoreReasonSchema).min(1).max(3),
  })
  .strict();
export type CloudScores = z.infer<typeof cloudScoresSchema>;

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export const cloudProvenanceSchema = z
  .object({
    adapter: z.string().min(1),
    adapter_version: z.string().min(1),
    confidence: z.number().min(0).max(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// Per-channel payload schemas (closed; grow in lockstep with the cloud)
// ---------------------------------------------------------------------------

export const cloudFrboListingPayloadSchema = z
  .object({
    listing_url: z.string().url(),
    rent_usd: z.number().nonnegative().nullable(),
    beds: z.number().nonnegative().nullable(),
    baths: z.number().nonnegative().nullable(),
    property_kind: z.enum([
      'single_family',
      'multi_family',
      'condo',
      'apartment',
      'other',
    ]),
    listed_at: isoDatetime.nullable(),
  })
  .strict();

export const cloudCommunityPostPayloadSchema = z
  .object({
    platform: z.enum(['reddit', 'hackernews', 'other']),
    topic_keywords: z.array(z.string().min(1)),
    post_url: z.string().url(),
  })
  .strict();

export const cloudParcelPayloadSchema = z
  .object({
    assessor_class: z.string().min(1).nullable(),
    assessed_value_usd: z.number().nullable(),
    tax_usd: z.number().nullable(),
    absentee: z.boolean().nullable(),
    owner_kind: z.enum(['individual', 'llc', 'trust', 'other']).nullable(),
    tax_year: z.number().int().nullable(),
  })
  .strict();

export const cloudViolationPayloadSchema = z
  .object({
    violation_kind: z.string().min(1).nullable(),
    status: z.enum(['open', 'closed', 'unknown']),
    opened_at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'ISO date (YYYY-MM-DD)')
      .nullable(),
    case_ref: z.string().min(1).nullable(),
  })
  .strict();

/**
 * Channel -> payload schema registry. Channels without an entry do not have a
 * v1 payload schema yet; validateCloudSourceEvent rejects their events so an
 * unchecked payload can never reach intake.
 */
export const CLOUD_PAYLOAD_SCHEMAS: Partial<Record<CloudChannel, z.ZodTypeAny>> = {
  frbo: cloudFrboListingPayloadSchema,
  community: cloudCommunityPostPayloadSchema,
  parcel: cloudParcelPayloadSchema,
  violation: cloudViolationPayloadSchema,
};

// ---------------------------------------------------------------------------
// The event
// ---------------------------------------------------------------------------

export const cloudSourceEventSchema = z
  .object({
    contract_version: z.literal(1),
    id: z.string().regex(/^se_[0-9A-HJKMNP-TV-Z]{26}$/, 'se_<ULID>'),
    idempotency_key: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 hex'),
    channel: cloudChannelSchema,
    source_uri: z.string().min(1),
    fetched_at: isoDatetime,
    observed_at: isoDatetime,
    entity: cloudEntitySchema,
    // Channel-specific; validated per channel by validateCloudSourceEvent().
    payload: z.record(z.string(), z.unknown()),
    signal_flags: cloudSignalFlagsSchema,
    // null for pure identity events (registry row, parcel row).
    trigger: cloudTriggerSchema.nullable(),
    scores: cloudScoresSchema.nullable(),
    // Set by the scoring engine when it re-emits an enriched event with the
    // SAME idempotency_key. The app treats (idempotency_key, scores_version)
    // as an idempotent score update, never a new person. Absent on adapter
    // events (additive: pre-scorer events still validate).
    scores_version: z.number().int().min(1).optional(),
    provenance: cloudProvenanceSchema,
  })
  .strict();

export type CloudSourceEvent = z.infer<typeof cloudSourceEventSchema>;

export type ValidateCloudSourceEventResult =
  | { success: true; data: CloudSourceEvent }
  | { success: false; error: string };

/**
 * Full validation: the event envelope AND the payload against the channel's
 * registered payload schema. Fails for channels without a payload schema.
 */
export function validateCloudSourceEvent(
  event: unknown,
): ValidateCloudSourceEventResult {
  const envelope = cloudSourceEventSchema.safeParse(event);
  if (!envelope.success) {
    return { success: false, error: `envelope: ${envelope.error.message}` };
  }
  const payloadSchema = CLOUD_PAYLOAD_SCHEMAS[envelope.data.channel];
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
