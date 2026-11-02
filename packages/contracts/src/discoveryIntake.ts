import { z } from 'zod';
import { instant, uuid } from './foundationRows.ts';
import { candidateStatusSchema, sourcingUrlSchema } from './sourcing.ts';

// Retained source references are data, never authority to fetch or contact.
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export const discoveryProviderSchema = z.enum(['overture_places', 'first_party', 'apollo_free', 'public_directory']);
export const discoverySourceSchema = z.strictObject({
  provider: discoveryProviderSchema,
  recordId: z.string().min(1).max(500),
  release: z.string().min(1).max(200),
  retrievedAt: instant.nullable(),
  sourceUrl: sourcingUrlSchema,
});
export type DiscoverySource = z.infer<typeof discoverySourceSchema>;
export const discoverySourceKey = (source: DiscoverySource): string =>
  JSON.stringify([source.provider, source.release, source.recordId]);

export const discoveryIntakeRowV1Schema = z.strictObject({
  source: discoverySourceSchema,
  observations: z.array(discoverySourceSchema).min(1).max(16),
  firmName: z.string().trim().min(1).max(300),
  // Preserve supplied HTTP/bare references, including unknowns. Do not make them fetch URLs.
  website: z.string().min(1).max(2000).nullable(),
  locality: z.string().min(1).max(150).nullable(),
  region: z.string().regex(/^[A-Z]{2}$/u).nullable(),
  sourceConfidence: z.number().min(0).max(1).nullable(),
  residentialFit: z.enum(['unknown', 'supported', 'rejected']),
  websiteAssociation: z.enum(['unknown', 'supported', 'ambiguous']),
  officePhoneEvidence: z.enum(['unknown', 'observed_source', 'observed_first_party', 'office_supported', 'ambiguous', 'absent']),
  probableGroupKey: z.string().min(1).max(500).nullable(),
}).superRefine((row, ctx) => {
  const keys = row.observations.map(discoverySourceKey);
  if (new Set(keys).size !== keys.length || !keys.includes(discoverySourceKey(row.source))) {
    ctx.addIssue({ code: 'custom', message: 'Unique observations must include the primary source.' });
  }
  const primary = row.observations.find(source => discoverySourceKey(source) === discoverySourceKey(row.source));
  if (primary && JSON.stringify(primary) !== JSON.stringify(row.source)) {
    ctx.addIssue({ code: 'custom', message: 'Primary source metadata must match its observation.' });
  }
});
export type DiscoveryIntakeRowV1 = z.infer<typeof discoveryIntakeRowV1Schema>;
export const discoveryCandidatePayloadSchema = z.strictObject({
  kind: z.literal('discovery-v1'), row: discoveryIntakeRowV1Schema,
}).refine(value => bytes(value) <= 20000, 'Candidate payload exceeds 20000 bytes.');

// Overture provenance only. Reject arbitrary body/contact/CRM fields rather than copying raw records.
const provenanceKeys = new Set(['property', 'dataset', 'license', 'record_id', 'update_time', 'confidence', 'between', 'provider', 'resource', 'version']);
function primitive(value: unknown): boolean {
  return value === null || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length <= 2000);
}
const sourcesJsonSchema = z.string().max(8192).refine(text => {
  try {
    const value: unknown = JSON.parse(text);
    return new TextEncoder().encode(text).length <= 8192 && Array.isArray(value) && value.length <= 16 &&
      value.every((entry: unknown) => {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
        return Object.entries(entry).every(([key, item]: [string, unknown]) => provenanceKeys.has(key) &&
          (primitive(item) || (key === 'between' && Array.isArray(item) && item.length <= 16 && item.every(primitive))));
      });
  } catch { return false; }
}, 'Use bounded source-only provenance, not business bodies or contact records.');
export const discoveryOriginSchema = z.strictObject({
  source: discoverySourceSchema,
  sourceMetadata: z.strictObject({ sourcesJson: sourcesJsonSchema }),
  licenses: z.array(z.string().min(1).max(200)).min(1).max(16),
  notices: z.array(z.strictObject({
    label: z.string().min(1).max(300), url: sourcingUrlSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })).min(1).max(16),
}).refine(value => bytes(value.sourceMetadata) <= 8192, 'Source metadata exceeds 8192 bytes.');
export type DiscoveryOrigin = z.infer<typeof discoveryOriginSchema>;

export const discoveryIntakeCandidateSchema = z.strictObject({
  id: uuid, status: candidateStatusSchema, revision: z.number().int().positive(), createdAt: instant,
  payload: discoveryCandidatePayloadSchema, origins: z.array(discoveryOriginSchema).min(1).max(16),
});
