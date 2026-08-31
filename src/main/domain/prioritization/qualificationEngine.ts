import { z } from 'zod';

import { PrioritizationInputCorruptionError } from '../support/domainErrors';
import type { PrioritizationRuleDocument } from './builtinPrioritizationRules';
import type {
  ConfidenceComponent,
  ContactMethodFact,
  MaintenanceProfileV1,
  PrioritizationReason,
  PropertyFact,
  QualificationInputSnapshot,
  QualificationResult,
  QualifiedInputSnapshot,
} from './prioritizationTypes';
import type { FitBand, Reachability } from '../../db/domainSchema';

const CANONICAL_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function parseCanonicalUtcMillis(value: string, label: string): number {
  if (!CANONICAL_UTC_MS.test(value)) {
    throw new PrioritizationInputCorruptionError(`${label} is not a canonical UTC timestamp.`);
  }
  const millis = Date.parse(value);
  if (!Number.isSafeInteger(millis)) {
    throw new PrioritizationInputCorruptionError(`${label} is not a valid instant.`);
  }
  if (new Date(millis).toISOString() !== value) {
    throw new PrioritizationInputCorruptionError(`${label} is not a canonical instant.`);
  }
  return millis;
}

/**
 * Pure qualification gate. `eligible` on the canonical Prospect is the only
 * state that can enter Fit/Timing evaluation. Deletion short-circuits before
 * opt-out; the caller supplies the already-inspected permission outcome so the
 * engine consumes no repository or Task 10 service directly.
 */
export function evaluateQualification(input: {
  snapshot: QualificationInputSnapshot;
  permission:
    | { kind: 'allowed' }
    | { kind: 'blocked'; tombstoneIds: readonly string[] };
}): QualificationResult {
  const { snapshot } = input;
  if (snapshot.personDeletedAt !== null) {
    return {
      kind: 'operationally_blocked',
      prospectId: snapshot.prospectId,
      reason: 'person_deleted',
      evidenceIds: [snapshot.prospectId],
    };
  }
  if (input.permission.kind === 'blocked') {
    return {
      kind: 'operationally_blocked',
      prospectId: snapshot.prospectId,
      reason: 'person_opted_out',
      evidenceIds: [...input.permission.tombstoneIds].sort(),
    };
  }
  const state = snapshot.qualificationState;
  const gate = snapshot.qualificationGateReason;
  if ((state === 'disqualified') !== (gate !== null)) {
    throw new PrioritizationInputCorruptionError(
      'Stored qualification gate reason contradicts the qualification state.',
    );
  }
  if (state === 'disqualified') {
    return {
      kind: 'gated',
      prospectId: snapshot.prospectId,
      reasons: [gate!],
      evidenceIds: [snapshot.prospectId, snapshot.originalSourceEventId].sort(),
    };
  }
  if (state === 'merge_review') {
    return {
      kind: 'gated',
      prospectId: snapshot.prospectId,
      reasons: ['unresolved_duplicate'],
      evidenceIds: [snapshot.prospectId, snapshot.originalSourceEventId].sort(),
    };
  }
  if (state === 'unreviewed') {
    return {
      kind: 'pending_review',
      prospectId: snapshot.prospectId,
      qualificationState: 'unreviewed',
      evidenceIds: [snapshot.prospectId, snapshot.originalSourceEventId].sort(),
    };
  }
  return {
    kind: 'qualified',
    prospectId: snapshot.prospectId,
    evidenceIds: [snapshot.prospectId, snapshot.originalSourceEventId].sort(),
  };
}

const maintenanceProfileSchema = z.object({
  formatVersion: z.literal(1),
  management: z.enum(['self_managed', 'third_party', 'unknown']),
  relevantProfile: z.union([z.boolean(), z.literal('unknown')]),
  evidenceRefs: z.array(z.string()),
}).strict();

/** Strict V1 maintenance profile parser; unknown keys or malformed JSON fail closed. */
export function parseMaintenanceProfileV1(value: unknown): MaintenanceProfileV1 {
  const parsed = maintenanceProfileSchema.safeParse(value);
  if (!parsed.success) {
    throw new PrioritizationInputCorruptionError('maintenance_profile_json V1 is malformed.');
  }
  return Object.freeze({
    formatVersion: parsed.data.formatVersion,
    management: parsed.data.management,
    relevantProfile: parsed.data.relevantProfile,
    evidenceRefs: Object.freeze([...parsed.data.evidenceRefs]),
  });
}

function normalizeRouteText(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function dedupeSortedById<T extends { id: string }>(
  rows: readonly T[],
  label: string,
): readonly T[] {
  const byId = new Map<string, T>();
  for (const row of rows) {
    const existing = byId.get(row.id);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(row)) {
        throw new PrioritizationInputCorruptionError(
          `${label} contains duplicate IDs with different facts.`,
        );
      }
      continue;
    }
    byId.set(row.id, row);
  }
  return [...byId.values()].sort((left, right) => (
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  ));
}

export type FitResult = Readonly<{
  fitPoints: number;
  fitBand: FitBand;
  reasons: readonly Extract<PrioritizationReason, { kind: 'fit' }>[];
}>;

type AgreedClaims = Readonly<{
  management: 'self_managed' | 'third_party' | null;
  relevantProfile: boolean | null;
  hasProfileEvidenceRefs: boolean;
}>;

function agreeProfileClaims(properties: readonly PropertyFact[]): AgreedClaims {
  const managementClaims = new Set<'self_managed' | 'third_party'>();
  const relevantClaims = new Set<boolean>();
  let hasProfileEvidenceRefs = false;
  for (const property of properties) {
    const profile = property.maintenanceProfile;
    if (profile === null) continue;
    if (profile.management !== 'unknown') managementClaims.add(profile.management);
    if (profile.relevantProfile !== 'unknown') relevantClaims.add(profile.relevantProfile);
    if (
      (profile.management !== 'unknown' || profile.relevantProfile !== 'unknown')
      && profile.evidenceRefs.some((ref) => ref.trim().length > 0)
    ) {
      hasProfileEvidenceRefs = true;
    }
  }
  if (managementClaims.size > 1 || relevantClaims.size > 1) {
    throw new PrioritizationInputCorruptionError(
      'Conflicting non-unknown maintenance profile claims are corruption, not first-row-wins.',
    );
  }
  return {
    management: managementClaims.size === 1 ? [...managementClaims][0]! : null,
    relevantProfile: relevantClaims.size === 1 ? [...relevantClaims][0]! : null,
    hasProfileEvidenceRefs,
  };
}

/** Exact V1 Fit calculation over stable pre-contact facts. */
export function calculateFit(input: {
  properties: readonly PropertyFact[];
  rule: PrioritizationRuleDocument;
}): FitResult {
  const properties = dedupeSortedById(input.properties, 'Fit property input');
  for (const property of properties) {
    if (property.doorCount !== null
      && (!Number.isSafeInteger(property.doorCount) || property.doorCount < 0)) {
      throw new PrioritizationInputCorruptionError('Door counts must be non-negative integers.');
    }
    if (property.verifiedAt !== null) {
      parseCanonicalUtcMillis(property.verifiedAt, 'Property verified_at');
    }
  }
  const fit = input.rule.fit;
  const reasons: Extract<PrioritizationReason, { kind: 'fit' }>[] = [];

  const knownCounts = properties
    .map((property) => property.doorCount)
    .filter((count): count is number => count !== null);
  const doorSum = knownCounts.reduce((sum, count) => sum + count, 0);
  let doorPoints = 0;
  if (knownCounts.length > 0) {
    const [fullMin, fullMax] = fit.doorCount.fullRange;
    if (doorSum >= fullMin && doorSum <= fullMax) {
      doorPoints = fit.doorCount.fullPoints;
    } else if (fit.doorCount.partialRanges.some(([min, max]) => doorSum >= min && doorSum <= max)) {
      doorPoints = fit.doorCount.partialPoints;
    }
  }
  reasons.push({ kind: 'fit', category: 'door_count', points: doorPoints });

  const claims = agreeProfileClaims(properties);
  const managementPoints = claims.management === 'self_managed'
    ? fit.managementSelfManagedPoints
    : 0;
  reasons.push({ kind: 'fit', category: 'management', points: managementPoints });

  const localityGroups = new Map<string, number>();
  for (const property of properties) {
    if (property.verifiedAt === null) continue;
    const key = [
      property.countryCode.toUpperCase(),
      normalizeRouteText(property.region),
      normalizeRouteText(property.locality),
    ].join('\u0000');
    localityGroups.set(key, (localityGroups.get(key) ?? 0) + 1);
  }
  const routePoints = [...localityGroups.values()].some((count) => count >= 2)
    ? fit.routeDensityPoints
    : 0;
  reasons.push({ kind: 'fit', category: 'route_density', points: routePoints });

  const relevantPoints = claims.relevantProfile === true ? fit.relevantProfilePoints : 0;
  reasons.push({ kind: 'fit', category: 'relevant_profile', points: relevantPoints });

  const fitPoints = doorPoints + managementPoints + routePoints + relevantPoints;
  if (fitPoints < 0 || fitPoints > fit.bands.max) {
    throw new PrioritizationInputCorruptionError('Fit points escaped the constructed 0-30 clamp.');
  }
  const fitBand: FitBand = fitPoints <= fit.bands.lowMax
    ? 'low'
    : fitPoints <= fit.bands.mediumMax ? 'medium' : 'high';
  return Object.freeze({ fitPoints, fitBand, reasons: Object.freeze(reasons) });
}

/** Reachability derived independently of Fit/Timing. */
export function deriveReachability(
  contactMethods: readonly ContactMethodFact[],
): Reachability {
  const methods = dedupeSortedById(contactMethods, 'Reachability contact input');
  const valid = methods.filter((method) => method.validationState === 'valid');
  if (valid.some((method) => method.kind === 'phone' && method.reachability === 'direct')) {
    return 'direct';
  }
  if (valid.some((method) => (
    method.kind === 'email'
    || (method.kind === 'phone' && method.reachability === 'indirect')
  ))) {
    return 'indirect';
  }
  return 'none';
}

export type ConfidenceResult = Readonly<{
  dataConfidence: number;
  reasons: readonly Extract<PrioritizationReason, { kind: 'confidence' }>[];
}>;

const elapsedDays = (fromMillis: number, toMillis: number): number => (
  (toMillis - fromMillis) / 86_400_000
);

/** Exact integer V1 data confidence with independent components, capped. */
export function calculateConfidence(input: {
  snapshot: Pick<QualifiedInputSnapshot, 'originalSource' | 'properties' | 'contactMethods'>;
  evaluatedAt: string;
  rule: PrioritizationRuleDocument;
}): ConfidenceResult {
  const rule = input.rule.confidence;
  const evaluatedAtMillis = parseCanonicalUtcMillis(input.evaluatedAt, 'evaluatedAt');
  const source = input.snapshot.originalSource;
  const observedAtMillis = parseCanonicalUtcMillis(source.observedAt, 'Source observed_at');
  if (observedAtMillis > evaluatedAtMillis) {
    throw new PrioritizationInputCorruptionError('Source observed_at cannot be in the future.');
  }
  const properties = dedupeSortedById(input.snapshot.properties, 'Confidence property input');
  const contacts = dedupeSortedById(input.snapshot.contactMethods, 'Confidence contact input');
  const reasons: Extract<PrioritizationReason, { kind: 'confidence' }>[] = [];
  const push = (component: ConfidenceComponent, points: number): void => {
    reasons.push({ kind: 'confidence', component, points });
  };

  const hasEvidenceRef = source.evidenceRef !== null && source.evidenceRef.trim().length > 0;
  const sourceEvidencePoints = source.channel === 'registry' && hasEvidenceRef
    ? rule.registrySourcePoints
    : hasEvidenceRef ? rule.otherSourceWithEvidencePoints : rule.sourceWithoutEvidencePoints;
  push('source_evidence', sourceEvidencePoints);

  const sourceAgeDays = elapsedDays(observedAtMillis, evaluatedAtMillis);
  const sourceAgePoints = sourceAgeDays <= rule.sourceAgeFreshDays
    ? rule.sourceAgeFreshPoints
    : sourceAgeDays <= rule.sourceAgeStaleDays ? rule.sourceAgeStalePoints : 0;
  push('source_age', sourceAgePoints);

  let youngestVerificationDays: number | null = null;
  for (const property of properties) {
    if (property.verifiedAt === null) continue;
    const verifiedAtMillis = parseCanonicalUtcMillis(property.verifiedAt, 'Property verified_at');
    if (verifiedAtMillis > evaluatedAtMillis) {
      throw new PrioritizationInputCorruptionError('Property verified_at cannot be in the future.');
    }
    const age = elapsedDays(verifiedAtMillis, evaluatedAtMillis);
    if (youngestVerificationDays === null || age < youngestVerificationDays) {
      youngestVerificationDays = age;
    }
  }
  const verificationPoints = youngestVerificationDays === null
    ? 0
    : youngestVerificationDays <= rule.propertyVerificationFreshDays
      ? rule.propertyVerificationFreshPoints
      : rule.propertyVerificationStalePoints;
  push('property_verification', verificationPoints);

  const contactPoints = contacts.some((contact) => contact.validationState === 'valid')
    ? rule.contactMethodPoints
    : 0;
  push('contact_method', contactPoints);

  let profileEvidencePoints = 0;
  const claims = agreeProfileClaims(properties);
  if (claims.hasProfileEvidenceRefs
    && (claims.management === 'self_managed' || claims.relevantProfile === true)) {
    profileEvidencePoints = rule.profileEvidencePoints;
  }
  push('profile_evidence', profileEvidencePoints);

  const total = reasons.reduce((sum, reason) => sum + reason.points, 0);
  const dataConfidence = Math.min(total, rule.cap);
  return Object.freeze({ dataConfidence, reasons: Object.freeze(reasons) });
}

/** verifyFirst is true only for P0/P1 with confidence 0-6. */
export function deriveVerifyFirst(input: {
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  dataConfidence: number;
  rule: PrioritizationRuleDocument;
}): boolean {
  return (input.priority === 'p0' || input.priority === 'p1')
    && input.dataConfidence <= input.rule.confidence.verifyFirstMaxConfidence;
}

export const routeGroupingNormalize = normalizeRouteText;
