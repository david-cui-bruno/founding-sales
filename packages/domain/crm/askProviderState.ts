import { z } from 'zod';

/** Opaque per-call protocol state, never evidence or tool authority. Kept only in
 * the running request's bounded transcript; not persisted in history or audits. */
export const askProviderMetadataSchema = z.record(z.string(), z.record(z.string(), z.json()))
  .refine(value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 65536);
export type AskProviderMetadata = z.infer<typeof askProviderMetadataSchema>;
