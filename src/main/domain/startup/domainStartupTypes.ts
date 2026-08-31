import type { DomainInvariantViolation } from '../lifecycle/invariantAudit';

export type DeepReadonly<T> =
  T extends (...args: never[]) => unknown ? T
    : T extends readonly (infer U)[] ? readonly DeepReadonly<U>[]
      : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T;

export type DomainStartupFatalCode =
  | 'storage_not_encrypted'
  | 'schema_not_ready'
  | 'pragma_not_ready'
  | 'foreign_key_violation'
  | 'fts_unavailable'
  | 'manifest_mismatch'
  | 'catalog_conflict'
  | 'active_rule_invalid'
  | 'audit_execution_failed'
  | 'bootstrap_failed';

export type DomainStartupReport = DeepReadonly<{
  status: 'ready' | 'blocked';
  evaluatedAt: string;
  activePrioritizationRuleVersionId: string;
  violations: readonly DomainInvariantViolation[];
  blockingViolationCount: number;
  repairableIssueCount: number;
  projectionRefreshCandidateCount: number;
  projectionRebuildsQueued: number;
  pendingProjectionRebuilds: number;
  interruptedJobsRecovered: number;
}>;

export class DomainStartupFatalError extends Error {
  readonly code: DomainStartupFatalCode;

  constructor(code: DomainStartupFatalCode, message: string) {
    super(message);
    this.name = 'DomainStartupFatalError';
    this.code = code;
  }
}

export class DomainRuntimeBlockedError extends Error {
  constructor(message = 'The domain runtime is blocked by invariant violations; only diagnostics are available.') {
    super(message);
    this.name = 'DomainRuntimeBlockedError';
  }
}

export class DomainRuntimeUnavailableError extends Error {
  constructor(message = 'The domain runtime is not initialized or has shut down.') {
    super(message);
    this.name = 'DomainRuntimeUnavailableError';
  }
}

export type PriorityProjectionRefreshReason =
  | 'missing_projection'
  | 'wrong_active_rule'
  | 'prior_founder_local_day'
  | 'projection_expired'
  | 'relevant_input_changed';

export type PriorityProjectionRebuildCommandV1 = {
  formatVersion: 1;
  jobId: string;
  evaluationId: string;
  prospectId: string;
  ruleVersionId: string;
  founderTimezone: string;
  founderLocalDate: string;
  evaluatedAt: string;
  expectedProjectionVersion: number | null;
  qualifiedInputFingerprint: string;
  refreshFingerprint: string;
  reasons: readonly PriorityProjectionRefreshReason[];
};

export const PRIORITY_PROJECTION_REBUILD_JOB_TYPE = 'priority_projection_rebuild_v1' as const;
