import { createHash } from 'node:crypto';

import { canonicalRuleJson } from '../prioritization/builtinPrioritizationRules';
import type { PrioritizationRepository, PrioritizationRuleVersion } from '../prioritization/prioritizationRepository';
import { resolveLocalDayInterval } from '../today/todayOrdering';
import type {
  PriorityProjectionRebuildCommandV1,
  PriorityProjectionRefreshReason,
} from './domainStartupTypes';
import { PRIORITY_PROJECTION_REBUILD_JOB_TYPE } from './domainStartupTypes';

export type PriorityProjectionRefreshCandidate = Readonly<{
  prospectId: string;
  reasons: readonly PriorityProjectionRefreshReason[];
  expectedProjectionVersion: number | null;
  qualifiedInputFingerprint: string;
  refreshFingerprint: string;
}>;

export type PriorityProjectionScanResult = Readonly<{
  candidates: readonly PriorityProjectionRefreshCandidate[];
  corruptProspectIds: readonly string[];
}>;

export function fingerprintCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalRuleJson(value)).digest('hex');
}

export function deriveRefreshIdempotencyKey(input: {
  prospectId: string;
  ruleVersionId: string;
  founderLocalDate: string;
  refreshFingerprint: string;
}): string {
  return [
    PRIORITY_PROJECTION_REBUILD_JOB_TYPE,
    input.prospectId,
    input.ruleVersionId,
    input.founderLocalDate,
    input.refreshFingerprint,
  ].join(':');
}

export function buildRebuildCommand(input: {
  jobId: string;
  evaluationId: string;
  candidate: PriorityProjectionRefreshCandidate;
  ruleVersionId: string;
  founderTimezone: string;
  founderLocalDate: string;
  evaluatedAt: string;
}): PriorityProjectionRebuildCommandV1 {
  return {
    formatVersion: 1,
    jobId: input.jobId,
    evaluationId: input.evaluationId,
    prospectId: input.candidate.prospectId,
    ruleVersionId: input.ruleVersionId,
    founderTimezone: input.founderTimezone,
    founderLocalDate: input.founderLocalDate,
    evaluatedAt: input.evaluatedAt,
    expectedProjectionVersion: input.candidate.expectedProjectionVersion,
    qualifiedInputFingerprint: input.candidate.qualifiedInputFingerprint,
    refreshFingerprint: input.candidate.refreshFingerprint,
    reasons: input.candidate.reasons,
  };
}

/**
 * Scans otherwise-prioritizable canonical Prospects for repairable refresh
 * reasons in stable Prospect-ID order. Structurally malformed or relationally
 * divergent projections are blocking corruption, never overwritten.
 */
export function scanPriorityProjections(input: {
  repository: PrioritizationRepository;
  listEligibleProspectIds: () => readonly string[];
  activeRule: PrioritizationRuleVersion;
  asOf: string;
  workspaceTimezone: string;
}): PriorityProjectionScanResult {
  const interval = resolveLocalDayInterval({
    generatedAt: input.asOf,
    timezone: input.workspaceTimezone,
  });
  const candidates: PriorityProjectionRefreshCandidate[] = [];
  const corruptProspectIds: string[] = [];
  const prospectIds = [...input.listEligibleProspectIds()].sort();

  for (const prospectId of prospectIds) {
    let qualifiedInputFingerprint: string;
    try {
      const snapshot = input.repository.loadQualifiedEvaluationInputs(prospectId);
      const lastContact = input.repository.loadQualifyingLastContact(prospectId, input.asOf);
      qualifiedInputFingerprint = fingerprintCanonical({
        formatVersion: 1,
        originalSource: snapshot.originalSource,
        properties: snapshot.properties,
        contactMethods: snapshot.contactMethods,
        lastContact,
        triggerEvents: snapshot.triggerEvents,
      });
    } catch {
      corruptProspectIds.push(prospectId);
      continue;
    }

    const reasons: PriorityProjectionRefreshReason[] = [];
    let expectedProjectionVersion: number | null = null;
    let projectionIdentity: {
      evaluationId: string;
      version: number;
      ruleVersionId: string;
      evaluatedAt: string;
    } | null = null;

    try {
      const projection = input.repository.getProjection(prospectId);
      if (projection === null) {
        reasons.push('missing_projection');
      } else {
        expectedProjectionVersion = projection.version;
        projectionIdentity = {
          evaluationId: projection.evaluationId,
          version: projection.version,
          ruleVersionId: projection.ruleVersionId,
          evaluatedAt: projection.evaluatedAt,
        };
        const evaluation = input.repository.getEvaluationById(projection.evaluationId);
        if (evaluation === null
          || evaluation.decisionKind !== 'evaluated'
          || evaluation.prospectId !== prospectId) {
          corruptProspectIds.push(prospectId);
          continue;
        }
        if (projection.ruleVersionId !== input.activeRule.id) {
          reasons.push('wrong_active_rule');
        }
        const inDay = projection.evaluatedAt >= interval.localDayStartAt
          && projection.evaluatedAt < interval.localDayEndAt;
        if (!inDay) reasons.push('prior_founder_local_day');
        if (projection.earliestTriggerExpiresAt !== null
          && projection.earliestTriggerExpiresAt <= input.asOf) {
          reasons.push('projection_expired');
        }
        const stored = input.repository.getStoredEvaluationCommand(projection.evaluationId);
        if (stored === null) {
          corruptProspectIds.push(prospectId);
          continue;
        }
        // Compare the canonical current input to the immutable stored snapshot.
        const evaluatedFingerprint = fingerprintOfStoredSnapshot(
          input.repository, projection.evaluationId,
        );
        if (evaluatedFingerprint !== null && evaluatedFingerprint !== qualifiedInputFingerprint) {
          reasons.push('relevant_input_changed');
        }
      }
    } catch {
      corruptProspectIds.push(prospectId);
      continue;
    }

    if (reasons.length === 0) continue;
    const sortedReasons = Object.freeze([...new Set(reasons)].sort());
    const refreshFingerprint = fingerprintCanonical({
      formatVersion: 1,
      qualifiedInputFingerprint,
      projectionIdentity,
      reasons: sortedReasons,
    });
    candidates.push(Object.freeze({
      prospectId,
      reasons: sortedReasons,
      expectedProjectionVersion,
      qualifiedInputFingerprint,
      refreshFingerprint,
    }));
  }

  return Object.freeze({
    candidates: Object.freeze(candidates),
    corruptProspectIds: Object.freeze(corruptProspectIds),
  });
}

function fingerprintOfStoredSnapshot(
  repository: PrioritizationRepository,
  evaluationId: string,
): string | null {
  const stored = repository.getStoredEvaluationCommand(evaluationId);
  if (stored === null) return null;
  const snapshotRow = repository.getEvaluationInputSnapshot(evaluationId);
  if (snapshotRow === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshotRow) as unknown;
  } catch {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record === null || typeof record !== 'object' || record.kind !== 'evaluated_snapshot') {
    return null;
  }
  return fingerprintCanonical({
    formatVersion: 1,
    originalSource: record.originalSource,
    properties: record.properties,
    contactMethods: record.contactMethods,
    lastContact: record.lastContact,
    triggerEvents: record.triggerEvents,
  });
}
