import type {
  FitBand,
  Priority,
  QualificationGateReasonCode,
  Reachability,
  ReactivationRuleType,
  TimingBand,
} from '../../db/domainSchema';
import type { QualificationGateReason } from '../identity/identityTypes';

export type DeepReadonly<T> =
  T extends (...args: never[]) => unknown ? T
    : T extends readonly (infer U)[] ? readonly DeepReadonly<U>[]
      : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T;

export type GateReason = QualificationGateReason;

export type PriorityPlay =
  | 'contact_immediately'
  | 'find_direct_line'
  | 'contact_today'
  | 'quick_fit_check'
  | 'qualify_this_week'
  | 'nurture'
  | 'watch_for_trigger'
  | 'archive_candidate';

export type BuiltinStoredTriggerKey =
  | 'live_vacancy'
  | 'recent_acquisition'
  | 'compliance_deadline'
  | 'recent_permit_maintenance'
  | 'heating_season'
  | 'student_turnover'
  | 'post_storm'
  | 'tax_season'
  | 'inbound_demo'
  | 'direct_referral'
  | 'rireig_connection'
  | 'recent_lead_engagement'
  | 'nurture_resurrection';
export type StoredTriggerKey = BuiltinStoredTriggerKey | `custom:${string}`;
export type SourceBackedTriggerKey = Exclude<StoredTriggerKey, 'nurture_resurrection'>;

export type TriggerFunctionEvidenceV1 =
  | {
      function: 'decaying';
    }
  | {
      function: 'approaching';
      deadlineAt: string;
    }
  | {
      function: 'windowed';
      startsAt: string;
      endsAt: string;
    };

export type TriggerEvidenceV1 = TriggerFunctionEvidenceV1 & (
  | {
      formatVersion: 1;
      triggerType: SourceBackedTriggerKey;
      authoredUnderRuleVersionId: string;
      evidenceRefs: readonly [string, ...string[]];
      proof: {
        kind: 'source_event';
        sourceEventId: string;
        sourceObservedAt: string;
      };
    }
  | {
      formatVersion: 1;
      triggerType: 'nurture_resurrection';
      authoredUnderRuleVersionId: string;
      evidenceRefs: readonly [string, ...string[]];
      function: 'windowed';
      startsAt: string;
      endsAt: string;
      proof: {
        kind: 'reactivation_rule_receipt';
        activationKey: string;
        ruleId: string;
        ruleType: ReactivationRuleType;
        sourceCycleId: string;
        newCycleId: string;
        activatedAt: string;
      };
    }
);

export type TriggerEvent = Readonly<{
  id: string;
  prospectId: string;
  sourceEventId: string | null;
  reactivationReceiptActivationKey: string | null;
  reactivationRuleId: string | null;
  triggerType: StoredTriggerKey;
  effectiveAt: string;
  expiresAt: string | null;
  strengthMultiplier: number;
  verificationState: 'verified' | 'unverified';
  evidence: DeepReadonly<TriggerEvidenceV1>;
  createdAt: string;
}>;

export type QualificationResult =
  | {
      kind: 'qualified';
      prospectId: string;
      evidenceIds: readonly string[];
    }
  | {
      kind: 'gated';
      prospectId: string;
      reasons: readonly [GateReason, ...GateReason[]];
      evidenceIds: readonly string[];
    }
  | {
      kind: 'pending_review';
      prospectId: string;
      qualificationState: 'unreviewed';
      evidenceIds: readonly string[];
    }
  | {
      kind: 'operationally_blocked';
      prospectId: string;
      reason: 'person_deleted' | 'person_opted_out';
      evidenceIds: readonly string[];
    };

export type FitCategory = 'door_count' | 'management' | 'route_density' | 'relevant_profile';

export type ConfidenceComponent =
  | 'source_evidence'
  | 'source_age'
  | 'property_verification'
  | 'contact_method'
  | 'profile_evidence';

export type TriggerReasonCode =
  | 'active'
  | 'suppressed'
  | 'not_yet_effective'
  | 'expired'
  | 'below_threshold'
  | 'window_inactive'
  | 'custom_not_configured';

export type MatrixReasonCode =
  | 'matrix_cell'
  | 'high_hot_without_direct'
  | 'nurture_only_p0_block';

export type GateExplanationCode =
  | 'qualification_gated'
  | 'pending_review'
  | 'person_deleted'
  | 'person_opted_out';

export type PrioritizationReason =
  | Readonly<{
      kind: 'gate';
      code: GateExplanationCode;
      gateReasons: readonly GateReason[];
      evidenceIds: readonly string[];
    }>
  | Readonly<{ kind: 'fit'; category: FitCategory; points: number }>
  | Readonly<{ kind: 'reachability'; value: Reachability }>
  | Readonly<{ kind: 'confidence'; component: ConfidenceComponent; points: number }>
  | Readonly<{
      kind: 'trigger';
      triggerKey: StoredTriggerKey;
      eventId: string;
      code: TriggerReasonCode;
      selected: boolean;
      contributed: boolean;
      contributionMilliPoints: number;
      winningEventId: string | null;
      recomputedExpiresAt: string | null;
    }>
  | Readonly<{ kind: 'matrix'; code: MatrixReasonCode }>;

export type QualifiedPrioritizationEvaluation = {
  decisionKind: 'evaluated';
  id: string;
  prospectId: string;
  ruleVersionId: string;
  evaluatedAt: string;
  fitPoints: number;
  fitBand: FitBand;
  timingMilliPoints: number;
  timingBand: TimingBand;
  reachability: Reachability;
  dataConfidence: number;
  priority: Priority;
  play: PriorityPlay;
  earliestTriggerExpiresAt: string | null;
  verifyFirst: boolean;
  lastContactActivityId: string | null;
  lastContactAt: string | null;
  explanation: readonly PrioritizationReason[];
};

export type NotPrioritizableEvaluation = {
  decisionKind: 'not_prioritizable';
  id: string;
  prospectId: string;
  ruleVersionId: string;
  evaluatedAt: string;
  qualification: Exclude<QualificationResult, { kind: 'qualified' }>;
  explanation: readonly PrioritizationReason[];
};

export type PrioritizationEvaluation =
  | DeepReadonly<QualifiedPrioritizationEvaluation>
  | DeepReadonly<NotPrioritizableEvaluation>;

export type ProspectPriorityProjection = Readonly<{
  prospectId: string;
  ruleVersionId: string;
  evaluationId: string;
  fitPoints: number;
  fitBand: FitBand;
  timingMilliPoints: number;
  timingBand: TimingBand;
  reachability: Reachability;
  dataConfidence: number;
  priority: Priority;
  earliestTriggerExpiresAt: string | null;
  verifyFirst: boolean;
  lastContactActivityId: string | null;
  lastContactAt: string | null;
  version: number;
  evaluatedAt: string;
  updatedAt: string;
}>;

export type RecalculationResult =
  | {
      kind: 'evaluated';
      evaluation: DeepReadonly<QualifiedPrioritizationEvaluation>;
      projection: ProspectPriorityProjection;
    }
  | {
      kind: 'not_prioritizable';
      evaluation: DeepReadonly<NotPrioritizableEvaluation>;
      projection: null;
      qualification: Exclude<QualificationResult, { kind: 'qualified' }>;
    };

export type LastContactEvidence = Readonly<{
  activityId: string;
  occurredAt: string;
}>;

export type PriorityOverrideKind = 'priority' | 'pin_to_top' | 'snooze' | 'dismiss';

export type PriorityOverride = Readonly<{
  id: string;
  prospectId: string;
  kind: PriorityOverrideKind;
  priority: Priority | null;
  reason: string;
  createdAt: string;
  expiresAt: string;
  status: 'active' | 'expired';
  expiredAt: string | null;
}>;

export type EffectivePriorityControl = Readonly<{
  id: string;
  kind: PriorityOverrideKind;
  priority: Priority | null;
  reason: string;
  createdAt: string;
  expiresAt: string;
  status: 'active';
}>;

export type OrderablePriorityRow = Readonly<{
  prospectId: string;
  effectivePriority: Priority;
  earliestTriggerExpiresAt: string | null;
  timingMilliPoints: number;
  fitPoints: number;
  reachability: Reachability;
  dataConfidence: number;
  lastContactAt: string | null;
}>;

export type EffectivePrioritySnapshot = DeepReadonly<{
  prospectId: string;
  ruleVersionId: string;
  evaluationId: string;
  projectionVersion: number;
  evaluatedAt: string;
  asOf: string;
  computedPriority: Priority;
  effectivePriority: Priority;
  computedPlay: PriorityPlay;
  fitPoints: number;
  fitBand: FitBand;
  timingMilliPoints: number;
  timingBand: TimingBand;
  reachability: Reachability;
  dataConfidence: number;
  earliestTriggerExpiresAt: string | null;
  verifyFirst: boolean;
  lastContactActivityId: string | null;
  lastContactAt: string | null;
  controls: {
    priority: EffectivePriorityControl | null;
    pin: EffectivePriorityControl | null;
    snooze: EffectivePriorityControl | null;
    dismiss: EffectivePriorityControl | null;
  };
  explanation: readonly PrioritizationReason[];
}>;

export type PrioritizationPreview = Readonly<{
  prospectId: string;
  ruleVersionId: string;
  evaluatedAt: string;
  outcome:
    | Readonly<{
        kind: 'evaluated';
        fitPoints: number;
        fitBand: FitBand;
        timingMilliPoints: number;
        timingBand: TimingBand;
        reachability: Reachability;
        dataConfidence: number;
        priority: Priority;
        play: PriorityPlay;
        earliestTriggerExpiresAt: string | null;
        verifyFirst: boolean;
        lastContactActivityId: string | null;
        lastContactAt: string | null;
        explanation: readonly PrioritizationReason[];
      }>
    | Readonly<{
        kind: 'not_prioritizable';
        qualification: DeepReadonly<Exclude<QualificationResult, { kind: 'qualified' }>>;
        explanation: readonly PrioritizationReason[];
      }>;
}>;

export type PrioritizationPreferenceAction =
  | 'acted_out_of_order'
  | 'snoozed'
  | 'dismissed'
  | 'reordered'
  | 'priority_overridden'
  | 'pinned';

export type PrioritizationPreferenceEvent = Readonly<{
  id: string;
  controlId: string | null;
  controlledProspectId: string | null;
  action: PrioritizationPreferenceAction;
  winnerProspectId: string;
  winnerEvaluationId: string;
  loserProspectId: string;
  loserEvaluationId: string;
  observedAt: string;
  context: DeepReadonly<{ formatVersion: 1; reason: string }>;
  createdAt: string;
}>;

export type MaintenanceProfileV1 = Readonly<{
  formatVersion: 1;
  management: 'self_managed' | 'third_party' | 'unknown';
  relevantProfile: boolean | 'unknown';
  evidenceRefs: readonly string[];
}>;

/** Strict, pre-parsed pure-engine inputs built from stored rows. */
export type PropertyFact = Readonly<{
  id: string;
  doorCount: number | null;
  countryCode: string;
  region: string;
  locality: string;
  verifiedAt: string | null;
  maintenanceProfile: MaintenanceProfileV1 | null;
}>;

export type ContactMethodFact = Readonly<{
  id: string;
  kind: 'phone' | 'email';
  validationState: 'unverified' | 'valid' | 'invalid';
  reachability: Reachability;
}>;

export type OriginalSourceFact = Readonly<{
  id: string;
  channel: string;
  observedAt: string;
  evidenceRef: string | null;
}>;

export type QualificationInputSnapshot = Readonly<{
  prospectId: string;
  personId: string;
  qualificationState: 'unreviewed' | 'eligible' | 'disqualified' | 'merge_review';
  qualificationGateReason: QualificationGateReasonCode | null;
  personDeletedAt: string | null;
  originalSourceEventId: string;
}>;

export type QualifiedInputSnapshot = Readonly<{
  prospectId: string;
  personId: string;
  originalSource: OriginalSourceFact;
  properties: readonly PropertyFact[];
  contactMethods: readonly ContactMethodFact[];
  lastContact: LastContactEvidence | null;
  triggerEvents: readonly TriggerEvent[];
}>;
