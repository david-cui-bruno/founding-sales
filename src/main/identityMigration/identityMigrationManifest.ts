import { createHash } from 'node:crypto';
import { z } from 'zod';

export type IdentityAuditCandidate = {
  candidateId: string;
  normalizedDisplayName: string;
  currentPersonId: string;
  priorPeople: Array<{
    priorPersonId: string;
    displayName: string;
    postalCodes: string[];
    propertyAddresses: string[];
    cloudEntityIds: string[];
    sourceEventIds: string[];
  }>;
  conflictReasons: Array<'DIFFERENT_POSTAL_CODES' | 'DIFFERENT_PROPERTY_ADDRESSES' | 'DIFFERENT_CLOUD_ENTITY_IDS'>;
  contactOwnership: 'unknown';
};
export type IdentityMigrationManifest = {
  format: 'callie-identity-migration-audit';
  version: 1;
  beforeDatabaseSha256: string;
  currentDatabaseSha256: string;
  generatedAt: string;
  candidates: IdentityAuditCandidate[];
};
export type ReviewedIdentityMigrationManifest = Omit<IdentityMigrationManifest, 'format'> & {
  format: 'callie-identity-migration-review';
  auditManifestSha256: string;
  reviewedAt: string;
  approvedCandidateIds: string[];
  rejectedCandidateIds: string[];
};

const text = z.string().min(1);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = text.refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const uniqueStrings = z.array(text).refine(values => new Set(values).size === values.length);
const priorPerson = z.object({
  priorPersonId: text, displayName: text, postalCodes: uniqueStrings,
  propertyAddresses: uniqueStrings, cloudEntityIds: uniqueStrings, sourceEventIds: uniqueStrings,
}).strict();
const candidate = z.object({
  candidateId: text, normalizedDisplayName: text, currentPersonId: text,
  priorPeople: z.array(priorPerson).min(2).refine(values => new Set(values.map(v => v.priorPersonId)).size === values.length),
  conflictReasons: z.array(z.enum(['DIFFERENT_POSTAL_CODES', 'DIFFERENT_PROPERTY_ADDRESSES', 'DIFFERENT_CLOUD_ENTITY_IDS']))
    .min(1).refine(values => new Set(values).size === values.length),
  contactOwnership: z.literal('unknown'),
}).strict();
const base = {
  version: z.literal(1), beforeDatabaseSha256: digest, currentDatabaseSha256: digest,
  generatedAt: timestamp,
  candidates: z.array(candidate).refine(values => new Set(values.map(v => v.candidateId)).size === values.length),
};
const auditSchema = z.object({ ...base, format: z.literal('callie-identity-migration-audit') }).strict();
const reviewSchema = z.object({ ...base, format: z.literal('callie-identity-migration-review'),
  auditManifestSha256: digest, reviewedAt: timestamp,
  approvedCandidateIds: uniqueStrings, rejectedCandidateIds: uniqueStrings,
}).strict().refine(value => {
  const ids = [...value.approvedCandidateIds, ...value.rejectedCandidateIds];
  const candidates = new Set(value.candidates.map(c => c.candidateId));
  return ids.length === candidates.size && new Set(ids).size === ids.length && ids.every(id => candidates.has(id));
});
const decisionSchema = z.array(z.object({ candidateId: text, decision: z.enum(['approved', 'rejected']) }).strict());
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function orderedCandidates(candidates: IdentityAuditCandidate[]): IdentityAuditCandidate[] {
  return candidates.map(c => ({ ...c,
    conflictReasons: [...c.conflictReasons].sort(),
    priorPeople: c.priorPeople.map(p => ({ ...p,
      postalCodes: [...p.postalCodes].sort(), propertyAddresses: [...p.propertyAddresses].sort(),
      cloudEntityIds: [...p.cloudEntityIds].sort(), sourceEventIds: [...p.sourceEventIds].sort(),
    })).sort((a, b) => compare(a.priorPersonId, b.priorPersonId)),
  })).sort((a, b) => compare(a.candidateId, b.candidateId));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([key, item]) => [key, canonical(item)]),
  );
  return value;
}

export function serializeIdentityMigrationManifest(value: IdentityMigrationManifest | ReviewedIdentityMigrationManifest): string {
  const parsed = value.format === 'callie-identity-migration-audit' ? auditSchema.parse(value) : reviewSchema.parse(value);
  const ordered = { ...parsed, candidates: orderedCandidates(parsed.candidates as IdentityAuditCandidate[]) };
  if ('approvedCandidateIds' in ordered) {
    ordered.approvedCandidateIds.sort(); ordered.rejectedCandidateIds.sort();
  }
  return JSON.stringify(canonical(ordered)) + '\n';
}

/** Hash the original immutable bytes, not a parsed/re-serialized approximation. */
export function finalizeIdentityMigrationReview(input: {
  auditManifestBytes: Buffer; decisions: unknown; reviewedAt: string;
}): ReviewedIdentityMigrationManifest {
  const audit = auditSchema.parse(JSON.parse(input.auditManifestBytes.toString('utf8')));
  const decisions = decisionSchema.parse(input.decisions);
  const review = {
    ...audit, format: 'callie-identity-migration-review' as const,
    candidates: orderedCandidates(audit.candidates as IdentityAuditCandidate[]),
    auditManifestSha256: createHash('sha256').update(input.auditManifestBytes).digest('hex'),
    reviewedAt: input.reviewedAt,
    approvedCandidateIds: decisions.filter(row => row.decision === 'approved').map(row => row.candidateId).sort(),
    rejectedCandidateIds: decisions.filter(row => row.decision === 'rejected').map(row => row.candidateId).sort(),
  };
  return reviewSchema.parse(review) as ReviewedIdentityMigrationManifest;
}
