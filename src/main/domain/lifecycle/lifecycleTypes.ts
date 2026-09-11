import type { LifecycleStage, ReactivationRuleType, WorkflowStatus } from '../../db/domainSchema';
import type {
  ReactivationCommandEnvelope,
  ReactivationResultEnvelope,
  ReactivationReviewPayload,
  ReactivationReviewResolution,
} from './reactivationContracts';

export type UtcTimestamp = string;

export type LostNurtureReason =
  | 'no_response'
  | 'not_interested'
  | 'bad_timing'
  | 'not_decision_maker'
  | 'not_qualified'
  | 'price'
  | 'trust'
  | 'chose_alternative'
  | 'product_gap'
  | 'cadence_exhausted'
  | 'disqualified'
  | 'opt_out'
  | 'other';

export type SalesCycle = Readonly<{
  id: string;
  personId: string;
  prospectId: string;
  entrySourceEventId: string;
  stage: LifecycleStage;
  workflowStatus: WorkflowStatus;
  currentNextActionId: string | null;
  stageEnteredAt: UtcTimestamp;
  designPartnerFitness: number | null;
  closeReason: LostNurtureReason | null;
  closeNotes: string | null;
  onboardingStopReason: string | null;
  closedAt: UtcTimestamp | null;
  resurfaceAt: UtcTimestamp | null;
  resurfaceReason: 'snooze' | 'callback' | null;
  version: number;
  createdAt: UtcTimestamp;
  updatedAt: UtcTimestamp;
}>;

export type NextActionWorkIntent =
  | 'internal_review'
  | 'inbound_response'
  | 'promised_follow_up'
  | 'discretionary_prospecting';

export type InboundSla =
  | Readonly<{ kind: 'none'; dueAt: null; sourceEventId: null; provenance: null }>
  | Readonly<{
      kind: 'inbound_demo_permitted_minutes';
      dueAt: UtcTimestamp;
      sourceEventId: string;
      provenance: Readonly<{
        version: 1;
        sourceEventId: string;
        sourceObservedAt: UtcTimestamp;
        calculation: 'permitted_minutes';
        minutes: 15;
        policyId: string;
        computedDueAt: UtcTimestamp;
      }>;
    }>
  | Readonly<{
      kind: 'direct_referral_elapsed';
      dueAt: UtcTimestamp;
      sourceEventId: string;
      provenance: Readonly<{
        version: 1;
        sourceEventId: string;
        sourceObservedAt: UtcTimestamp;
        calculation: 'elapsed_hours';
        hours: 48;
        policyId: null;
        computedDueAt: UtcTimestamp;
      }>;
    }>;

export type CadenceActionBinding =
  | Readonly<{
      cadenceEnrollmentId: null;
      cadenceDefinitionId: null;
      cadenceStepId: null;
      cadenceComponentId: null;
    }>
  | Readonly<{
      cadenceEnrollmentId: string;
      cadenceDefinitionId: string;
      cadenceStepId: string;
      cadenceComponentId: string;
    }>;

export type NextActionIntentAndSla =
  | Readonly<{ workIntent: 'inbound_response'; inboundSla: InboundSla }>
  | Readonly<{
      workIntent: Exclude<NextActionWorkIntent, 'inbound_response'>;
      inboundSla: Extract<InboundSla, { kind: 'none' }>;
    }>;

export type ExpectedActionIntentAndSla =
  | Readonly<{ expectedWorkIntent: 'inbound_response'; expectedInboundSla: InboundSla }>
  | Readonly<{
      expectedWorkIntent: Exclude<NextActionWorkIntent, 'inbound_response'>;
      expectedInboundSla: Extract<InboundSla, { kind: 'none' }>;
    }>;

export type ActionSettlementOutcome =
  | 'answered' | 'no_answer' | 'voicemail_left' | 'accepted' | 'replied'
  | 'opted_out' | 'channel_unavailable' | 'marked_impossible' | 'resolved'
  | 'reviewed_ready' | 'lost_nurture' | 'upgraded' | 'interviewed_confirmed'
  | 'offered_confirmed' | 'won_confirmed' | 'onboarding_waived' | 'phase_completed' | 'workflow_superseded';

export type ImpossibleReasonCode =
  | 'missing_phone'
  | 'missing_email'
  | 'invalid_contact_method'
  | 'channel_disabled'
  | 'other';

export type ImpossibleSettlementReason = Readonly<{
  code: ImpossibleReasonCode;
  notes: string | null;
}>;

export type ActionSettlement = Readonly<{
  version: 1;
  outcome: ActionSettlementOutcome;
  reason: string | ImpossibleSettlementReason | null;
  evidenceActivityId: string | null;
  plannerTransition: Readonly<{
    definitionId: string | null;
    stepId: string | null;
    componentId: string | null;
    attempt: number | null;
    outcome: ActionSettlementOutcome;
  }>;
  cadence: CadenceActionBinding;
  workIntent: NextActionWorkIntent;
  inboundSla: InboundSla;
}>;

export type ActionDueSource = 'legacy_unscheduled' | 'recorded_callback' | 'founder_resurface' | 'playbook_v1' | 'internal_review';

export type NextAction = Readonly<{
  dueAt: UtcTimestamp;
  dueSource: ActionDueSource;
  id: string;
  salesCycleId: string;
  actionType: string;
  channel: string | null;
  status: 'pending' | 'completed' | 'cancelled' | 'impossible';
  timezone: string;
  allowedWindow: string | null;
  workIntent: NextActionWorkIntent;
  inboundSla: InboundSla;
  cadence: CadenceActionBinding;
  completionActivityId: string | null;
  settlement: ActionSettlement | null;
  version: number;
  createdAt: UtcTimestamp;
  completedAt: UtcTimestamp | null;
  updatedAt: UtcTimestamp;
}>;

export type CadenceEnrollment = Readonly<{
  id: string;
  salesCycleId: string;
  cadenceDefinitionId: string;
  status: 'active' | 'completed' | 'stopped';
  anchorAt: UtcTimestamp;
  currentStepId: string | null;
  scheduledStepCount: number;
  mode: 'standard' | 'inbound_over_cap_response';
  allowedStepIds: readonly string[] | null;
  stopReason: string | null;
  version: number;
  createdAt: UtcTimestamp;
  updatedAt: UtcTimestamp;
}>;

type ReactivationRuleBase = Readonly<{
  id: string;
  salesCycleId: string;
  version: number;
  consumedAt: UtcTimestamp | null;
  createdAt: UtcTimestamp;
}>;

export type ReactivationRule = ReactivationRuleBase & (
  | Readonly<{
      ruleType: Extract<ReactivationRuleType, 'seasonal:heating-oct1' | 'manual'>;
      dueAt: UtcTimestamp;
      matcher: null;
    }>
  | Readonly<{
      ruleType: 'new-frbo-listing';
      dueAt: null;
      matcher: Readonly<{ version: 1; eventType: 'new-frbo-listing'; personWide: true }>;
    }>
  | Readonly<{
      ruleType: 'lead-cert-expiry-window';
      dueAt: null;
      matcher: Readonly<{ version: 1; eventType: 'lead-cert-expiry-window'; personWide: true }>;
    }>
);

export type CycleReactivationReceipt = Readonly<{
  activationKey: string;
  activationKind: 'rule' | 'inbound_response';
  personId: string;
  sourceCycleId: string;
  reactivationRuleId: string | null;
  sourceEventId: string | null;
  newCycleId: string;
  command: ReactivationCommandEnvelope;
  result: ReactivationResultEnvelope;
  createdAt: UtcTimestamp;
}>;

export type LifecycleReviewItem = Readonly<{
  id: string;
  activationKey: string;
  status: 'open' | 'resolved';
  personId: string;
  prospectId: string;
  sourceCycleId: string;
  reactivationRuleId: string | null;
  sourceEventId: string | null;
  reason: string;
  payload: ReactivationReviewPayload;
  resolution: ReactivationReviewResolution | null;
  resolvedAt: UtcTimestamp | null;
  version: number;
  createdAt: UtcTimestamp;
  updatedAt: UtcTimestamp;
}>;

export type ReadinessStrength = 'unknown' | 'weak' | 'moderate' | 'strong';

export type CloseReadiness = Readonly<{
  salesCycleId: string;
  painConfirmed: boolean;
  decisionAuthorityConfirmed: boolean;
  concreteTrialIdentified: boolean;
  readiness: Readonly<{
    version: 1;
    demonstratedPain: Readonly<{ value: ReadinessStrength; evidenceActivityIds: readonly string[] }>;
    activeTimeline: Readonly<{ value: ReadinessStrength; evidenceActivityIds: readonly string[] }>;
    decisionAuthority: Readonly<{ value: ReadinessStrength; evidenceActivityIds: readonly string[] }>;
    willingnessToTryOrPay: Readonly<{ value: ReadinessStrength; evidenceActivityIds: readonly string[] }>;
    concreteNextStep: Readonly<{ value: ReadinessStrength; evidenceActivityIds: readonly string[] }>;
  }>;
  version: number;
  assessedAt: string;
  updatedAt: string;
}>;

export type WonTerms = Readonly<{
  salesCycleId: string;
  doorsCommitted: number;
  billingModel: 'per_door_monthly' | 'flat_monthly' | 'manual_projected_monthly';
  unitRateCents: number;
  projectedMrrCents: number;
  projectionFormulaVersion: 'founder_terms_v1';
  manualProjectionReason: string | null;
  foundingCustomer: boolean;
  effectiveAt: string;
  createdAt: string;
}>;

export type InsertCycleInput = Readonly<{
  id: string;
  personId: string;
  prospectId: string;
  entrySourceEventId: string;
  stage: LifecycleStage;
  workflowStatus: 'active' | 'onboarding';
  currentNextActionId: string | null;
  stageEnteredAt: UtcTimestamp;
  createdAt: UtcTimestamp;
}>;

export type InsertNextActionInput = NextActionIntentAndSla & Readonly<{
  dueAt?: UtcTimestamp;
  dueSource?: ActionDueSource;
  id: string;
  salesCycleId: string;
  actionType: string;
  channel: string | null;
  status: 'pending';
  timezone: string;
  allowedWindow: string | null;
  cadence: CadenceActionBinding;
  createdAt: UtcTimestamp;
}>;

export function deepFreezeLifecycle<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreezeLifecycle(child);
  }
  return value;
}
