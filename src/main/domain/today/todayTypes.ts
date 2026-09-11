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

/**
 * No-due-dates lane set (audit 4.9.5): Overdue and Post-interview/offer are
 * gone. Post-interview and post-offer promises fold into Due cadence, which
 * is now "your cadence says this relationship is next", not a timestamp.
 */
export type TodayLane =
  | 'won_onboarding'
  | 'inbound_interrupt'
  | 'due_primary'
  | 'new_p0'
  | 'p1'
  | 'exploration'
  | 'later';

export type TodayCapacity = {
  dialBudget: number;             // default 40; also the whole-queue cap
  conversationTarget: number;    // default 5; metric only
  explorationSlots: number;      // default 2
  resurfacingWindowSeconds: number; // default 259200
};

export type TodayLaneReason =
  | 'won_onboarding'
  | 'warm_priority'
  | 'inbound_inside_sla'
  | 'inbound_response_waiting'
  | 'cadence_step_next'
  | 'promised_follow_up'
  | 'internal_review_waiting'
  | 'callback_promised_today'
  | 'snoozed_until_today'
  | 'ready_p0'
  | 'ready_p1'
  | 'ready_p2'
  | 'ready_p3'
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
  | 'invalid_resurface'
  | 'invalid_selected_call_receipt';

export type TodayDiagnostic = {
  cycleId: string | null;
  personId: string | null;
  kind: TodayDiagnosticKind;
  relatedIds: readonly string[];
};

export type TodayCommitment = { kind: 'callback'; activityId: string; dueAt: string } | { kind: 'post_stage' };

export type TodayItem = {
  segment?: 'hot' | 'cold' | 'warm';
  commitment?: TodayCommitment | null;
  cycleId: string;
  personId: string;
  prospectId: string;
  lane: TodayLane;
  deferredFrom: Exclude<TodayLane, 'later'> | null;
  laneReason: TodayLaneReason;
  action: {
    dueAt?: string;
    id: string;
    workIntent: NextActionWorkIntent;
    actionType: string;
    channel: string | null;
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
  /** Founder-chosen resurface marker; set only when re-entering today. */
  resurfaceAt: string | null;
  resurfaceReason: 'snooze' | 'callback' | null;
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
   * Unreviewed cycles awaiting founder triage. They never enter lanes; the
   * Leads/triage flow owns reviewing them.
   */
  unreviewedBacklogCount: number;
  lanes: ReadonlyArray<{
    lane: TodayLane;
    items: readonly TodayItem[];
    /** Rows cut by the whole-queue capacity cap, per lane. */
    overflowCount: number;
  }>;
  suppressed: readonly {
    cycleId: string;
    reason: 'snoozed' | 'dismissed' | 'recently_contacted' | 'resurface_scheduled' | 'not_due' | 'warm_pipeline_active';
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
  hasActiveWarm?: boolean;
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
      reason: 'snoozed' | 'dismissed' | 'recently_contacted' | 'resurface_scheduled' | 'not_due' | 'warm_pipeline_active';
    }
  | { kind: 'diagnostic'; diagnostic: TodayDiagnostic };

export type TodayCandidateLoadResult =
  | { kind: 'candidate'; candidate: ParsedTodayCandidate }
  | { kind: 'unreviewed_backlog'; cycleId: string }
  | { kind: 'diagnostic'; diagnostic: TodayDiagnostic };

export const DEFAULT_TODAY_CAPACITY: Readonly<TodayCapacity> = Object.freeze({
  dialBudget: 40,
  conversationTarget: 5,
  explorationSlots: 2,
  resurfacingWindowSeconds: 259_200,
});
