import type { LifecycleStage } from '../../db/domainSchema';
import type { ActivityKind } from '../events/eventTypes';
import type { CadenceFamily } from '../cadence/cadenceTypes';
import type {
  InboundSla,
  NextActionWorkIntent,
} from '../lifecycle/lifecycleTypes';
import type {
  EffectivePrioritySnapshot,
  PrioritizationReason,
} from '../prioritization/prioritizationTypes';

export type TodayLane =
  | 'won_onboarding'
  | 'inbound_interrupt'
  | 'overdue'
  | 'post_interview_offer'
  | 'due_primary'
  | 'new_p0'
  | 'p1'
  | 'exploration'
  | 'later';

export type TodayCapacity = {
  dialBudget: number;             // default 40
  conversationTarget: number;    // default 5; metric only
  explorationSlots: number;      // default 2
  resurfacingWindowSeconds: number; // default 259200
};

export type TodayLaneReason =
  | 'won_onboarding'
  | 'inbound_inside_sla'
  | 'non_discretionary_overdue'
  | 'inbound_sla_breached'
  | 'post_stage_due_today'
  | 'other_non_discretionary_due_today'
  | 'ready_p0'
  | 'ready_p1'
  | 'ready_p2'
  | 'ready_p3'
  | 'future_promise'
  | 'capacity_overflow'
  | 'exploration_quota_overflow';

export type TodayDiagnosticKind =
  | 'missing_current_action'
  | 'invalid_current_action'
  | 'current_action_owner_mismatch'
  | 'cadence_owner_graph_mismatch'
  | 'invalid_work_intent'
  | 'invalid_inbound_sla'
  | 'missing_priority_projection'
  | 'stale_priority_projection'
  | 'corrupt_priority_projection'
  | 'outbound_permission_blocked'
  | 'duplicate_candidate'
  | 'invalid_last_activity'
  | 'invalid_last_contact'
  | 'invalid_timestamp'
  | 'invalid_timezone'
  | 'invalid_channel_policy'
  | 'invalid_control'
  | 'invalid_selected_call_receipt';

export type TodayDiagnostic = {
  cycleId: string | null;
  personId: string | null;
  kind: TodayDiagnosticKind;
  relatedIds: readonly string[];
};

export type TodayItem = {
  cycleId: string;
  personId: string;
  prospectId: string;
  lane: TodayLane;
  deferredFrom: Exclude<TodayLane, 'later'> | null;
  laneReason: TodayLaneReason;
  action: {
    id: string;
    workIntent: NextActionWorkIntent;
    actionType: string;
    channel: string | null;
    dueAt: string;
    timezone: string;
    allowedWindow: string | null;
    inboundSla: InboundSla;
  };
  cadence: {
    enrollmentId: string;
    definitionId: string;
    family: CadenceFamily;
    stepId: string;
    stepSequence: number;
    componentId: string;
  } | null;
  priority: EffectivePrioritySnapshot | null;
  selectedTriggerReasons: readonly PrioritizationReason[];
  verifyFirst: boolean | null;
  pinned: boolean;
  lastActivity: {
    id: string;
    kind: ActivityKind;
    occurredAt: string;
    observedOutcome: string | null;
  } | null;
  stageEnteredAt: string;
  inlineDiagnostics: readonly TodayDiagnosticKind[];
};

export type TodayQueue = {
  generatedAt: string;
  timezone: string;
  localDate: string;
  capacity: TodayCapacity;
  completedDiscretionaryDialCount: number;
  queuedDiscretionaryDialCount: number;
  dialCount: number;
  remainingDiscretionaryDialCount: number;
  /**
   * Unreviewed cycles whose review action is already overdue. They are
   * summarized as one count instead of flooding the Overdue lane; the Leads
   * screen owns reviewing them.
   */
  unreviewedBacklogCount: number;
  lanes: ReadonlyArray<{ lane: TodayLane; items: readonly TodayItem[] }>;
  suppressed: readonly {
    cycleId: string;
    reason: 'snoozed' | 'dismissed' | 'recently_contacted';
  }[];
  diagnostics: readonly TodayDiagnostic[];
};

export type ParsedTodayCandidate =
  Omit<TodayItem, 'lane' | 'deferredFrom' | 'laneReason' | 'pinned'> & {
    stage: LifecycleStage;
    workflowStatus: 'active' | 'onboarding';
    priorityState: 'current' | 'missing' | 'stale' | 'corrupt';
  };

export type TodayEvaluationContext = {
  generatedAt: string;
  timezone: string;
  localDayStartAt: string;
  localDayEndAt: string;
  capacity: TodayCapacity;
};

export type TodayPreCapacityDisposition =
  | {
      kind: 'lane';
      lane: Exclude<TodayLane, 'later'>;
      item: TodayItem;
    }
  | { kind: 'later'; item: TodayItem }
  | {
      kind: 'suppressed';
      cycleId: string;
      reason: 'snoozed' | 'dismissed' | 'recently_contacted';
    }
  | { kind: 'diagnostic'; diagnostic: TodayDiagnostic };

export type TodayCandidateLoadResult =
  | { kind: 'candidate'; candidate: ParsedTodayCandidate }
  | { kind: 'diagnostic'; diagnostic: TodayDiagnostic };

export const DEFAULT_TODAY_CAPACITY: Readonly<TodayCapacity> = Object.freeze({
  dialBudget: 40,
  conversationTarget: 5,
  explorationSlots: 2,
  resurfacingWindowSeconds: 259_200,
});
