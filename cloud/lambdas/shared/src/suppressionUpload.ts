/**
 * Suppression upload — the app-side "never contact this handle again" sync,
 * written as ndjson lines to
 * s3://<inbox>/upstream/suppressions/<YYYY-MM-DD>.ndjson.
 *
 * PII-free by construction: each line carries ONLY the salted HMAC of the
 * opted-out contact handle (same HMAC-SHA256 canonicalization as membership
 * uploads and the enricher's suppression check), a closed reason enum, and a
 * timestamp. Names, phones, and emails physically cannot serialize.
 *
 * Consumed by the suppression-sync Lambda, which writes each hash to the
 * suppression table the enricher checks before any contact-bearing event
 * reaches the inbox (CONTRACT.md compliance invariant).
 */
import { z } from "zod";

export const suppressionUploadLineSchema = z
  .object({
    contact_hmac: z.string().regex(/^[0-9a-f]{64}$/, "HMAC-SHA256 lowercase hex"),
    kind: z.enum(["phone", "email"]),
    reason: z.enum(["opt_out", "wrong_person", "founder_block"]),
    observed_at: z.string().datetime({ offset: false }),
  })
  .strict();

export type SuppressionUploadLine = z.infer<typeof suppressionUploadLineSchema>;
