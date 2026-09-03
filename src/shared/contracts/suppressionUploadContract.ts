import { z } from 'zod';

/**
 * App-side mirror of cloud/lambdas/shared/src/suppressionUpload.ts — one
 * ndjson line in s3://<inbox>/upstream/suppressions/<YYYY-MM-DD>.ndjson.
 *
 * PII-free by construction: each line carries ONLY the salted HMAC of the
 * opted-out contact handle (contactHmac canonicalization in
 * upstreamSync.ts), a closed reason enum, and a timestamp. Names, phones,
 * and emails physically cannot serialize. Any drift from the cloud schema
 * is a contract break; the round-trip fixture test pins it.
 */
export const suppressionUploadLineSchema = z
  .object({
    contact_hmac: z.string().regex(/^[0-9a-f]{64}$/, 'HMAC-SHA256 lowercase hex'),
    kind: z.enum(['phone', 'email']),
    reason: z.enum(['opt_out', 'wrong_person', 'founder_block']),
    observed_at: z.string().datetime({ offset: false }),
  })
  .strict();

export type SuppressionUploadLine = z.infer<typeof suppressionUploadLineSchema>;
