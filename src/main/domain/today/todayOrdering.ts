import { PrioritizationInputCorruptionError } from '../support/domainErrors';
import { parseCanonicalUtcMillis } from '../prioritization/qualificationEngine';
import {
  compareProspectPriority,
  toOrderablePriorityRow,
} from '../prioritization/priorityOrdering';
import type {
  ParsedTodayCandidate,
  TodayCapacity,
  TodayDiagnostic,
  TodayEvaluationContext,
  TodayItem,
  TodayLane,
  TodayLaneReason,
  TodayPreCapacityDisposition,
  TodayQueue,
} from './todayTypes';

const CANONICAL_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const LANE_ORDER: readonly TodayLane[] = [
  'won_onboarding',
  'inbound_interrupt',
  'overdue',
  'post_interview_offer',
  'due_primary',
  'new_p0',
  'p1',
  'exploration',
  'later',
];

const LANE_RANK: Readonly<Record<TodayLane, number>> = Object.freeze(
  Object.fromEntries(LANE_ORDER.map((lane, index) => [lane, index])) as Record<TodayLane, number>,
);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  }
  return value;
}

function assertCanonical(value: string, label: string): number {
  if (!CANONICAL_UTC_MS.test(value)) {
    throw new PrioritizationInputCorruptionError(`${label} is not a canonical UTC timestamp.`);
  }
  return parseCanonicalUtcMillis(value, label);
}

/**
 * DST-safe founder-local half-open day interval [localMidnight,
 * nextLocalMidnight), independent of process.env.TZ.
 */
export function resolveLocalDayInterval(input: {
  generatedAt: string;
  timezone: string;
}): { localDate: string; localDayStartAt: string; localDayEndAt: string } {
  const generatedAtMillis = assertCanonical(input.generatedAt, 'generatedAt');
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: input.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    throw new PrioritizationInputCorruptionError('The workspace timezone is not a valid IANA zone.');
  }
  const localDate = formatter.format(new Date(generatedAtMillis));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    throw new PrioritizationInputCorruptionError('The local date could not be derived.');
  }
  const localMidnightUtc = wallClockToUtcMillis(localDate, input.timezone);
  const nextDate = nextLocalDate(localDate);
  const nextMidnightUtc = wallClockToUtcMillis(nextDate, input.timezone);
  return {
    localDate,
    localDayStartAt: new Date(localMidnightUtc).toISOString(),
    localDayEndAt: new Date(nextMidnightUtc).toISOString(),
  };
}

function nextLocalDate(localDate: string): string {
  const [year, month, day] = localDate.split('-').map(Number);
  const next = new Date(Date.UTC(year!, month! - 1, day! + 1));
  return next.toISOString().slice(0, 10);
}

/** Find the UTC instant of local midnight for a wall-clock date, DST-safe. */
function wallClockToUtcMillis(localDate: string, timezone: string): number {
  const [year, month, day] = localDate.split('-').map(Number);
  // Initial guess: treat the wall-clock time as UTC, then correct by offset.
  let guess = Date.UTC(year!, month! - 1, day!, 0, 0, 0, 0);
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const offsetMillis = timezoneOffsetMillis(guess, timezone);
    const corrected = Date.UTC(year!, month! - 1, day!, 0, 0, 0, 0) - offsetMillis;
    if (corrected === guess) return corrected;
    guess = corrected;
  }
  return guess;
}

function timezoneOffsetMillis(utcMillis: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(utcMillis))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === '24' ? '0' : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - utcMillis;
}

function toItem(
  candidate: ParsedTodayCandidate,
  lane: Exclude<TodayLane, 'later'>,
  laneReason: TodayLaneReason,
): TodayItem {
  return {
    cycleId: candidate.cycleId,
    personId: candidate.personId,
    prospectId: candidate.prospectId,
    lane,
    deferredFrom: null,
    laneReason,
    action: candidate.action,
    cadence: candidate.cadence,
    priority: candidate.priority,
    selectedTriggerReasons: candidate.selectedTriggerReasons,
    verifyFirst: candidate.verifyFirst,
    pinned: false,
    lastActivity: candidate.lastActivity,
    stageEnteredAt: candidate.stageEnteredAt,
    inlineDiagnostics: candidate.inlineDiagnostics,
  };
}

function effectivePriorityOf(candidate: ParsedTodayCandidate): 'p0' | 'p1' | 'p2' | 'p3' | null {
  return candidate.priority?.effectivePriority ?? null;
}

/**
 * Pure first-match lane classification in the exact plan order. The persisted
 * work_intent is load-bearing; due time never converts discretionary work into
 * a promise.
 */
export function classifyTodayCandidate(
  candidate: ParsedTodayCandidate,
  context: TodayEvaluationContext,
): TodayPreCapacityDisposition {
  const asOfMillis = assertCanonical(context.generatedAt, 'generatedAt');
  const dayStartMillis = assertCanonical(context.localDayStartAt, 'localDayStartAt');
  const dayEndMillis = assertCanonical(context.localDayEndAt, 'localDayEndAt');
  const dueAtMillis = assertCanonical(candidate.action.dueAt, 'Action due_at');
  const intent = candidate.action.workIntent;
  const sla = candidate.action.inboundSla;

  // 1. Won onboarding outranks everything.
  if (candidate.workflowStatus === 'onboarding') {
    return { kind: 'lane', lane: 'won_onboarding', item: toItem(candidate, 'won_onboarding', 'won_onboarding') };
  }

  // 2. Fresh inbound inside its SLA.
  if (intent === 'inbound_response' && sla.kind !== 'none') {
    const slaDueMillis = assertCanonical(sla.dueAt, 'Inbound SLA due_at');
    if (asOfMillis < slaDueMillis) {
      return { kind: 'lane', lane: 'inbound_interrupt', item: toItem(candidate, 'inbound_interrupt', 'inbound_inside_sla') };
    }
    // 3a. Breached inbound SLA enters Overdue at exactly the deadline.
    return { kind: 'lane', lane: 'overdue', item: toItem(candidate, 'overdue', 'inbound_sla_breached') };
  }

  const discretionary = intent === 'discretionary_prospecting';

  // 3b. Non-discretionary overdue: strict dueAt < asOf; equality is due now.
  if (!discretionary && dueAtMillis < asOfMillis) {
    return { kind: 'lane', lane: 'overdue', item: toItem(candidate, 'overdue', 'non_discretionary_overdue') };
  }

  const dueToday = dueAtMillis >= dayStartMillis && dueAtMillis < dayEndMillis;

  // 4. Promised follow-up at Interviewed/Offered due in founder-local Today.
  if (intent === 'promised_follow_up'
    && (candidate.stage === 'interviewed' || candidate.stage === 'offered')
    && dueToday) {
    return {
      kind: 'lane',
      lane: 'post_interview_offer',
      item: toItem(candidate, 'post_interview_offer', 'post_stage_due_today'),
    };
  }

  // 5. Any other non-discretionary work due in founder-local Today.
  if (!discretionary && dueToday) {
    return {
      kind: 'lane',
      lane: 'due_primary',
      item: toItem(candidate, 'due_primary', 'other_non_discretionary_due_today'),
    };
  }

  if (!discretionary) {
    // Future promise/internal work waits in Later with its own reason.
    const item = toItem(candidate, 'due_primary', 'future_promise');
    return { kind: 'later', item: { ...item, lane: 'later', deferredFrom: 'due_primary' } };
  }

  // Suppression applies only to discretionary lanes 6-8.
  const suppression = discretionarySuppression(candidate, context, asOfMillis);
  if (suppression !== null) return suppression;

  // Missing/stale/corrupt projections cannot silently rescore discretionary work.
  if (candidate.priorityState !== 'current' || candidate.priority === null) {
    const kind = candidate.priorityState === 'missing'
      ? 'missing_priority_projection' as const
      : candidate.priorityState === 'stale'
        ? 'stale_priority_projection' as const
        : 'corrupt_priority_projection' as const;
    return {
      kind: 'diagnostic',
      diagnostic: {
        cycleId: candidate.cycleId,
        personId: candidate.personId,
        kind,
        relatedIds: [candidate.prospectId],
      },
    };
  }

  const priority = effectivePriorityOf(candidate);
  if (priority === 'p0') {
    return { kind: 'lane', lane: 'new_p0', item: toItem(candidate, 'new_p0', 'ready_p0') };
  }
  if (priority === 'p1') {
    return { kind: 'lane', lane: 'p1', item: toItem(candidate, 'p1', 'ready_p1') };
  }
  const reason = priority === 'p2' ? 'ready_p2' as const : 'ready_p3' as const;
  return { kind: 'lane', lane: 'exploration', item: toItem(candidate, 'exploration', reason) };
}

function discretionarySuppression(
  candidate: ParsedTodayCandidate,
  context: TodayEvaluationContext,
  asOfMillis: number,
): TodayPreCapacityDisposition | null {
  const priority = candidate.priority;
  if (priority !== null) {
    const snooze = priority.controls.snooze;
    if (snooze !== null) {
      return { kind: 'suppressed', cycleId: candidate.cycleId, reason: 'snoozed' };
    }
    const dismiss = priority.controls.dismiss;
    if (dismiss !== null) {
      return { kind: 'suppressed', cycleId: candidate.cycleId, reason: 'dismissed' };
    }
    if (priority.lastContactAt !== null) {
      if (priority.lastContactActivityId === null) {
        return {
          kind: 'diagnostic',
          diagnostic: {
            cycleId: candidate.cycleId,
            personId: candidate.personId,
            kind: 'invalid_last_contact',
            relatedIds: [candidate.prospectId],
          },
        };
      }
      const lastContactMillis = assertCanonical(priority.lastContactAt, 'Snapshot last contact');
      if (lastContactMillis > asOfMillis) {
        return {
          kind: 'diagnostic',
          diagnostic: {
            cycleId: candidate.cycleId,
            personId: candidate.personId,
            kind: 'invalid_last_contact',
            relatedIds: [priority.lastContactActivityId],
          },
        };
      }
      const resurfaceMillis = lastContactMillis
        + context.capacity.resurfacingWindowSeconds * 1_000;
      if (asOfMillis < resurfaceMillis) {
        return { kind: 'suppressed', cycleId: candidate.cycleId, reason: 'recently_contacted' };
      }
    }
  }
  return null;
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pinnedOf(item: TodayItem): boolean {
  return item.pinned;
}

function dueOrderedCompare(left: TodayItem, right: TodayItem): number {
  if (pinnedOf(left) !== pinnedOf(right)) return pinnedOf(left) ? -1 : 1;
  const byDue = compareCanonical(left.action.dueAt, right.action.dueAt);
  if (byDue !== 0) return byDue;
  const byStage = compareCanonical(left.stageEnteredAt, right.stageEnteredAt);
  if (byStage !== 0) return byStage;
  const leftSequence = left.cadence?.stepSequence ?? null;
  const rightSequence = right.cadence?.stepSequence ?? null;
  if ((leftSequence === null) !== (rightSequence === null)) {
    return leftSequence === null ? 1 : -1;
  }
  if (leftSequence !== null && rightSequence !== null && leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }
  const byAction = compareCanonical(left.action.id, right.action.id);
  if (byAction !== 0) return byAction;
  return compareCanonical(left.cycleId, right.cycleId);
}

function inboundCompare(left: TodayItem, right: TodayItem): number {
  if (pinnedOf(left) !== pinnedOf(right)) return pinnedOf(left) ? -1 : 1;
  const leftSla = left.action.inboundSla.dueAt ?? left.action.dueAt;
  const rightSla = right.action.inboundSla.dueAt ?? right.action.dueAt;
  const bySla = compareCanonical(leftSla, rightSla);
  if (bySla !== 0) return bySla;
  const byDue = compareCanonical(left.action.dueAt, right.action.dueAt);
  if (byDue !== 0) return byDue;
  const byStage = compareCanonical(left.stageEnteredAt, right.stageEnteredAt);
  if (byStage !== 0) return byStage;
  const byAction = compareCanonical(left.action.id, right.action.id);
  if (byAction !== 0) return byAction;
  return compareCanonical(left.cycleId, right.cycleId);
}

function priorityCompare(left: TodayItem, right: TodayItem): number {
  if (pinnedOf(left) !== pinnedOf(right)) return pinnedOf(left) ? -1 : 1;
  if (left.priority === null || right.priority === null) {
    throw new PrioritizationInputCorruptionError(
      'Priority lanes require a current effective snapshot.',
    );
  }
  return compareProspectPriority(
    toOrderablePriorityRow(left.priority),
    toOrderablePriorityRow(right.priority),
  );
}

function explorationCompare(left: TodayItem, right: TodayItem): number {
  const leftPriority = left.priority?.effectivePriority;
  const rightPriority = right.priority?.effectivePriority;
  // P2 always precedes P3 even against a pinned P3.
  if (leftPriority !== rightPriority) {
    return leftPriority === 'p2' ? -1 : 1;
  }
  return priorityCompare(left, right);
}

/** Public within-lane comparator: pin applies only inside the assigned lane. */
export function compareTodayItems(left: TodayItem, right: TodayItem): number {
  if (left.lane !== right.lane) {
    return LANE_RANK[left.lane] - LANE_RANK[right.lane];
  }
  switch (left.lane) {
    case 'inbound_interrupt':
      return inboundCompare(left, right);
    case 'new_p0':
    case 'p1':
      return priorityCompare(left, right);
    case 'exploration':
      return explorationCompare(left, right);
    case 'later': {
      const leftFrom = left.deferredFrom === null ? Number.MAX_SAFE_INTEGER : LANE_RANK[left.deferredFrom];
      const rightFrom = right.deferredFrom === null ? Number.MAX_SAFE_INTEGER : LANE_RANK[right.deferredFrom];
      if (leftFrom !== rightFrom) return leftFrom - rightFrom;
      return compareCanonical(left.cycleId, right.cycleId);
    }
    default:
      return dueOrderedCompare(left, right);
  }
}

/**
 * Pure Today planner: classifies, applies pins after lane assignment, orders,
 * and applies exact durable capacity. No database, clock, IDs, or ambient time.
 */
export function planTodayQueue(input: {
  candidates: readonly ParsedTodayCandidate[];
  generatedAt: string;
  timezone: string;
  capacity: TodayCapacity;
  completedDiscretionaryDialCount: number;
  extraDiagnostics?: readonly TodayDiagnostic[];
  extraSuppressed?: readonly { cycleId: string; reason: 'snoozed' | 'dismissed' | 'recently_contacted' }[];
}): TodayQueue {
  const capacity = validateCapacity(input.capacity);
  if (!Number.isSafeInteger(input.completedDiscretionaryDialCount)
    || input.completedDiscretionaryDialCount < 0) {
    throw new PrioritizationInputCorruptionError(
      'Completed discretionary dial count must be a safe nonnegative integer.',
    );
  }
  const interval = resolveLocalDayInterval({
    generatedAt: input.generatedAt,
    timezone: input.timezone,
  });
  const context: TodayEvaluationContext = {
    generatedAt: input.generatedAt,
    timezone: input.timezone,
    localDayStartAt: interval.localDayStartAt,
    localDayEndAt: interval.localDayEndAt,
    capacity,
  };
  const generatedAtMillis = assertCanonical(input.generatedAt, 'generatedAt');

  const laneBuckets = new Map<TodayLane, TodayItem[]>(
    LANE_ORDER.map((lane): [TodayLane, TodayItem[]] => [lane, []]),
  );
  const suppressed: { cycleId: string; reason: 'snoozed' | 'dismissed' | 'recently_contacted' }[] = [
    ...(input.extraSuppressed ?? []),
  ];
  const diagnostics: TodayDiagnostic[] = [...(input.extraDiagnostics ?? [])];
  const seenCycleIds = new Set<string>();

  for (const candidate of input.candidates) {
    if (seenCycleIds.has(candidate.cycleId)) {
      diagnostics.push({
        cycleId: candidate.cycleId,
        personId: candidate.personId,
        kind: 'duplicate_candidate',
        relatedIds: [candidate.action.id],
      });
      continue;
    }
    seenCycleIds.add(candidate.cycleId);
    const disposition = classifyTodayCandidate(candidate, context);
    if (disposition.kind === 'diagnostic') {
      diagnostics.push(disposition.diagnostic);
      continue;
    }
    if (disposition.kind === 'suppressed') {
      suppressed.push({ cycleId: disposition.cycleId, reason: disposition.reason });
      continue;
    }
    const pinControl = disposition.item.priority?.controls.pin ?? null;
    const pinned = pinControl !== null
      && pinControl.createdAt <= input.generatedAt
      && input.generatedAt < pinControl.expiresAt
      && assertCanonical(pinControl.expiresAt, 'Pin expiration') > generatedAtMillis;
    const item = { ...disposition.item, pinned };
    if (disposition.kind === 'later') {
      laneBuckets.get('later')!.push(item);
    } else {
      laneBuckets.get(disposition.lane)!.push(item);
    }
  }

  for (const lane of LANE_ORDER) {
    laneBuckets.get(lane)!.sort(compareTodayItems);
  }

  // Exact durable capacity.
  const remainingBudget = Math.max(
    0, capacity.dialBudget - input.completedDiscretionaryDialCount,
  );
  let remaining = remainingBudget;
  const later = laneBuckets.get('later')!;

  const isCall = (item: TodayItem): boolean => item.action.actionType === 'call';

  // Select up to explorationSlots from ordered P2 then P3 candidates.
  const exploration = laneBuckets.get('exploration')!;
  const selectedExploration = exploration.slice(0, capacity.explorationSlots);
  const quotaOverflow = exploration.slice(capacity.explorationSlots);
  const retainedExploration: TodayItem[] = [];
  for (const item of selectedExploration) {
    if (!isCall(item)) {
      retainedExploration.push(item);
      continue;
    }
    if (remaining > 0) {
      retainedExploration.push(item);
      remaining -= 1;
    } else {
      later.push({ ...item, lane: 'later', deferredFrom: 'exploration', laneReason: 'capacity_overflow' });
    }
  }
  for (const item of quotaOverflow) {
    later.push({ ...item, lane: 'later', deferredFrom: 'exploration', laneReason: 'exploration_quota_overflow' });
  }
  laneBuckets.set('exploration', retainedExploration);

  // Retain P0 then P1 discretionary calls up to remaining; non-calls are free.
  let queuedDiscretionaryDialCount = retainedExploration.filter(isCall).length;
  for (const lane of ['new_p0', 'p1'] as const) {
    const bucket = laneBuckets.get(lane)!;
    const retained: TodayItem[] = [];
    for (const item of bucket) {
      if (!isCall(item)) {
        retained.push(item);
        continue;
      }
      if (remaining > 0) {
        retained.push(item);
        remaining -= 1;
        queuedDiscretionaryDialCount += 1;
      } else {
        later.push({ ...item, lane: 'later', deferredFrom: lane, laneReason: 'capacity_overflow' });
      }
    }
    laneBuckets.set(lane, retained);
  }

  later.sort(compareTodayItems);
  suppressed.sort((left, right) => compareCanonical(left.cycleId, right.cycleId));
  diagnostics.sort((left, right) => compareCanonical(left.cycleId ?? '', right.cycleId ?? ''));

  const queue: TodayQueue = {
    generatedAt: input.generatedAt,
    timezone: input.timezone,
    localDate: interval.localDate,
    capacity,
    completedDiscretionaryDialCount: input.completedDiscretionaryDialCount,
    queuedDiscretionaryDialCount,
    dialCount: input.completedDiscretionaryDialCount + queuedDiscretionaryDialCount,
    remainingDiscretionaryDialCount: Math.max(0, remainingBudget - queuedDiscretionaryDialCount),
    lanes: LANE_ORDER.map((lane) => ({ lane, items: laneBuckets.get(lane)! })),
    suppressed,
    diagnostics,
  };
  return deepFreeze(queue);
}

function validateCapacity(capacity: TodayCapacity): TodayCapacity {
  for (const [label, value] of Object.entries(capacity)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new PrioritizationInputCorruptionError(
        `Capacity field ${label} must be a safe nonnegative integer.`,
      );
    }
  }
  return { ...capacity };
}
