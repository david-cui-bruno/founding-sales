import { z } from 'zod';

/**
 * App-side mirror of cloud/lambdas/shared/src/enrichmentRequest.ts — one
 * ndjson line in s3://<inbox>/upstream/enrichment-requests/<...>.ndjson.
 *
 * The "Find contact info" action is the ONLY way an enrichment lookup can
 * happen (no bulk enrichment, ever). The enricher Lambda re-validates every
 * line against the cloud copy of this schema and skips lines that fail, so
 * the app must emit exactly this shape. The round-trip fixture test pins
 * drift.
 */
const isoDatetime = z.string().datetime({ offset: false });

/**
 * Situs address for the vendor lookup. No country_code (Tracerfy is
 * US-only); locality + 2-letter region are required (vendor needs
 * city + state); postal_code is nullable but strongly recommended.
 */
export const enrichmentRequestAddressSchema = z
  .object({
    line1: z.string().min(1),
    locality: z.string().min(1),
    region: z.string().length(2),
    postal_code: z.string().min(1).nullable(),
  })
  .strict();
export type EnrichmentRequestAddress = z.infer<typeof enrichmentRequestAddressSchema>;

export const enrichmentRequestSchema = z
  .object({
    cloud_entity_id: z
      .string()
      .regex(/^ce_[0-9A-HJKMNP-TV-Z]{26}$/, 'ce_<ULID>'),
    requested_at: isoDatetime,
    situs_address: enrichmentRequestAddressSchema,
    owner_full_name: z.string().min(1),
  })
  .strict();
export type EnrichmentRequest = z.infer<typeof enrichmentRequestSchema>;

/** Renderer -> main request for the Find contact info action. */
export const findContactInfoRequestSchema = z
  .object({ personId: z.string().min(1) })
  .strict();
export type FindContactInfoRequest = z.infer<typeof findContactInfoRequestSchema>;

export const findContactRefusalReasonSchema = z.enum([
  'qualification_required', 'fit_gate_failed', 'identity_or_address_missing',
  'direct_contact_exists', 'suppression_blocked', 'rate_limited',
  'credentials_unavailable',
]);

/**
 * Receipt for the Find contact info action. `written` reports whether a
 * request line was uploaded this call; a refusal carries the closed reason.
 */
export const findContactInfoReceiptSchema = z
  .object({
    written: z.boolean(),
    refusalReason: findContactRefusalReasonSchema.nullable(),
  })
  .strict();
export type FindContactInfoReceipt = z.infer<typeof findContactInfoReceiptSchema>;
