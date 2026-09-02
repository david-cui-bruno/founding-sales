/**
 * Enrichment request — the app-side "Find contact info" action, written as
 * ndjson lines to s3://<inbox>/upstream/enrichment-requests/<date>.ndjson.
 *
 * This is the ONLY way an enrichment lookup can happen (no bulk enrichment,
 * ever — plan non-negotiable #1). The enricher Lambda validates every line
 * against this schema and skips lines that fail, so a malformed request can
 * never trigger a vendor call.
 *
 * The address is the property's situs address (what Tracerfy traces), and
 * owner_full_name is the entity's owner name as known to the app — used
 * cloud-side to prefer the vendor person that actually matches the owner.
 */
import { z } from "zod";

const isoDatetime = z.string().datetime({ offset: false });

/**
 * Situs address for the vendor lookup. Unlike postalAddressSchema this has no
 * country_code (Tracerfy is US-only) and requires locality + 2-letter region
 * because the vendor API requires city + state. postal_code is optional but
 * strongly recommended by the vendor (disambiguates similar addresses).
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
      .regex(/^ce_[0-9A-HJKMNP-TV-Z]{26}$/, "ce_<ULID>"),
    requested_at: isoDatetime,
    situs_address: enrichmentRequestAddressSchema,
    owner_full_name: z.string().min(1),
  })
  .strict();
export type EnrichmentRequest = z.infer<typeof enrichmentRequestSchema>;
