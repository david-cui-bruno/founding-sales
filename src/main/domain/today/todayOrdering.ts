import { PrioritizationInputCorruptionError } from '../support/domainErrors';
import { parseCanonicalUtcMillis } from '../prioritization/qualificationEngine';
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

/**
 * Stable lane identities for the dated playbook. Commitments and warm work
 * lead the due lane. Automatic prospecting waits while warm work remains.
 */
const LANE_ORDER: readonly TodayLane[] = [
  'won_onboarding',
  'inbound_interrupt',
  'due_primary',
  'new_p0',
  'p1',
  'exploration',
  'later',
];

const LANE_RANK: Readonly<Record<TodayLane, number>> = Object.freeze(
  Object.fromEntries(LANE_ORDER.map((lane, index) => [lane, index])) as Record<TodayLane, number>,
);

const PRIORITY_RANK: Readonly<Record<'p0' | 'p1' | 'p2' | 'p3', number>> = Object.freeze({
  p0: 0, p1: 1, p2: 2, p3: 3,
});

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

export type DailyAccountCallPlan = Readonly<{
  accountIds: readonly string[];
  workloadConflict: boolean;
}>;

export function planDailyAccountCalls(input: {
  due: readonly string[];
  ranked: readonly string[];
  newCallSlots: number;
  completedAccountIds: readonly string[];
  totalCallCapacity: number | null;
}): DailyAccountCallPlan {
  if (!Number.isSafeInteger(input.newCallSlots) || input.newCallSlots < 0) {
    throw new PrioritizationInputCorruptionError('newCallSlots must be a safe nonnegative integer.');
  }
  if (input.totalCallCapacity !== null
    && (!Number.isSafeInteger(input.totalCallCapacity) || input.totalCallCapacity < 0)) {
    throw new PrioritizationInputCorruptionError('totalCallCapacity must be null or a safe nonnegative integer.');
  }
  const uniqueDue = [...new Set(input.due)];
  const completed = new Set(input.completedAccountIds);
  const dueSet = new Set(uniqueDue);
  const newIds = [...new Set(input.ranked)]
    .filter(id => !dueSet.has(id) && !completed.has(id));
  const accountIds = [...uniqueDue, ...newIds.slice(0, input.newCallSlots)];
  return Object.freeze({
    accountIds,
    workloadConflict: input.totalCallCapacity !== null && accountIds.length > input.totalCallCapacity,
  });
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

function effectiveDueAt(candidate: ParsedTodayCandidate): string {
  const actionDue = candidate.action.dueAt ?? candidate.stageEnteredAt;
  const callback = candidate.commitment?.kind === 'callback' ? candidate.commitment : null;
  if (callback !== null) {
    // A future callback cannot postpone an independent post-stage obligation.
    return ['interviewed', 'offered', 'won'].includes(candidate.stage)
      && candidate.action.actionType !== 'call' && actionDue < callback.dueAt
      ? actionDue : callback.dueAt;
  }
  return candidate.resurfaceAt ?? actionDue;
}

function toItem(
  candidate: ParsedTodayCandidate,
  lane: Exclude<TodayLane, 'later'>,
  laneReason: TodayLaneReason,
): TodayItem {
  return {
    segment: candidate.segment ?? 'cold',
    commitment: candidate.commitment ?? (['interviewed', 'offered', 'won'].includes(candidate.stage) ? { kind: 'post_stage' } : null),
    cycleId: candidate.cycleId,
    personId: candidate.personId,
    prospectId: candidate.prospectId,
    lane,
    deferredFrom: null,
    laneReason,
    action: { ...candidate.action, dueAt: effectiveDueAt(candidate) },
    cadence: candidate.cadence,
    priority: candidate.priority,
    selectedTriggerReasons: candidate.selectedTriggerReasons,
    verifyFirst: candidate.verifyFirst,
    pinned: false,
    lastActivity: candidate.lastActivity,
    stageEnteredAt: candidate.stageEnteredAt,
    resurfaceAt: candidate.resurfaceAt,
    resurfaceReason: candidate.resurfaceReason,
    inlineDiagnostics: candidate.inlineDiagnostics,
  };
}

function effectivePriorityOf(candidate: ParsedTodayCandidate): 'p0' | 'p1' | 'p2' | 'p3' | null {
  return candidate.priority?.effectivePriority ?? null;
}

/**
 * Pure dated classification. Time and legacy work-intent labels never turn
 * automatic prospecting into an evidenced promise.
 */
export function classifyTodayCandidate(
  candidate: ParsedTodayCandidate,
  context: TodayEvaluationContext,
): TodayPreCapacityDisposition {
  const asOfMillis = assertCanonical(context.generatedAt, 'generatedAt');
  const intent = candidate.action.workIntent;
  const sla = candidate.action.inboundSla;

  const commitment = candidate.commitment ?? (['interviewed', 'offered', 'won'].includes(candidate.stage)
    ? { kind: 'post_stage' as const } : null);
  const callback = commitment?.kind === 'callback' ? commitment : null;
  // A genuine callback overrides a generic snooze. Only owned activity proof
  // admitted by the repository qualifies, never the old promise label.
  const dueAt = effectiveDueAt(candidate);
  if (assertCanonical(dueAt, 'action dueAt') > asOfMillis) {
    return { kind: 'suppressed', cycleId: candidate.cycleId,
      reason: candidate.resurfaceAt !== null && callback === null ? 'resurface_scheduled' : 'not_due' };
  }
  const resurfaceReason: TodayLaneReason | null = callback !== null ? 'callback_promised_today'
    : candidate.resurfaceAt !== null ? 'snoozed_until_today' : null;
  if (candidate.workflowStatus === 'onboarding') {
    return { kind: 'lane', lane: 'won_onboarding', item: toItem(candidate, 'won_onboarding', 'won_onboarding') };
  }
  if (commitment !== null) {
    return { kind: 'lane', lane: 'due_primary', item: toItem(candidate, 'due_primary',
      callback !== null && callback.dueAt === dueAt ? 'callback_promised_today' : 'promised_follow_up') };
  }
  if (intent === 'inbound_response') {
    if (sla.kind !== 'none') assertCanonical(sla.dueAt, 'Inbound SLA due_at');
    return { kind: 'lane', lane: 'inbound_interrupt', item: toItem(candidate, 'inbound_interrupt', 'inbound_inside_sla') };
  }
  if (candidate.segment === 'warm') {
    return { kind: 'lane', lane: 'due_primary', item: toItem(candidate, 'due_primary', 'warm_priority') };
  }
  if (context.hasActiveWarm) {
    return { kind: 'suppressed', cycleId: candidate.cycleId, reason: 'warm_pipeline_active' };
  }
  if (intent !== 'discretionary_prospecting') {
    return { kind: 'lane', lane: 'due_primary', item: toItem(candidate, 'due_primary', resurfaceReason
      ?? (intent === 'internal_review' ? 'internal_review_waiting' : 'cadence_step_next')) };
  }

  // Suppression applies only to discretionary lanes.
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
    return { kind: 'lane', lane: 'new_p0', item: toItem(candidate, 'new_p0', resurfaceReason ?? 'ready_p0') };
  }
  if (priority === 'p1') {
    return { kind: 'lane', lane: 'p1', item: toItem(candidate, 'p1', resurfaceReason ?? 'ready_p1') };
  }
  const reason = resurfaceReason ?? (priority === 'p2' ? 'ready_p2' as const : 'ready_p3' as const);
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

/**
 * Commitments, warm work and due time precede priority/cloud/age tiebreakers.
 * The residual source percentile ordering prevents a single acquisition
 * source from monopolizing equally urgent work.
 */
function bandTimingAgeCompare(left: TodayItem, right: TodayItem): number {
  const commitmentRank = (item: TodayItem) => item.commitment != null ? 0 : item.segment === 'warm' ? 1 : 2;
  const rank = commitmentRank(left) - commitmentRank(right);
  if (rank !== 0) return rank;
  if (left.action.dueAt && right.action.dueAt && left.action.dueAt !== right.action.dueAt) {
    return compareCanonical(left.action.dueAt, right.action.dueAt);
  }
  if (pinnedOf(left) !== pinnedOf(right)) return pinnedOf(left) ? -1 : 1;
  const leftBand = left.priority === null
    ? 4 : PRIORITY_RANK[left.priority.effectivePriority];
  const rightBand = right.priority === null
    ? 4 : PRIORITY_RANK[right.priority.effectivePriority];
  if (leftBand !== rightBand) return leftBand - rightBand;
  const leftPercentile = left.priority?.cloudSourcePercentile ?? null;
  const rightPercentile = right.priority?.cloudSourcePercentile ?? null;
  if ((leftPercentile === null) !== (rightPercentile === null)) {
    return leftPercentile === null ? 1 : -1;
  }
  if (leftPercentile !== null && rightPercentile !== null
    && leftPercentile !== rightPercentile) {
    return rightPercentile - leftPercentile;
  }
  const leftTiming = left.priority?.cloudTiming ?? null;
  const rightTiming = right.priority?.cloudTiming ?? null;
  if ((leftTiming === null) !== (rightTiming === null)) {
    return leftTiming === null ? 1 : -1;
  }
  if (leftTiming !== null && rightTiming !== null && leftTiming !== rightTiming) {
    return rightTiming - leftTiming;
  }
  const leftTouch = lastTouchOf(left);
  const rightTouch = lastTouchOf(right);
  if (leftTouch !== rightTouch) return compareCanonical(leftTouch, rightTouch);
  const byAction = compareCanonical(left.action.id, right.action.id);
  if (byAction !== 0) return byAction;
  return compareCanonical(left.cycleId, right.cycleId);
}

/** Never-touched sorts as oldest; otherwise the last activity instant. */
function lastTouchOf(item: TodayItem): string {
  return item.lastActivity?.occurredAt ?? '';
}

function inboundCompare(left: TodayItem, right: TodayItem): number {
  if (pinnedOf(left) !== pinnedOf(right)) return pinnedOf(left) ? -1 : 1;
  // Inside Fresh inbound, the tightest SLA first; missing SLA (post-window
  // rows kept by intent) falls back to band/timing/age.
  const leftSla = left.action.inboundSla.dueAt;
  const rightSla = right.action.inboundSla.dueAt;
  if ((leftSla === null) !== (rightSla === null)) return leftSla === null ? 1 : -1;
  if (leftSla !== null && rightSla !== null) {
    const bySla = compareCanonical(leftSla, rightSla);
    if (bySla !== 0) return bySla;
  }
  return bandTimingAgeCompare(left, right);
}

/** Public within-lane comparator: pin applies only inside the assigned lane. */
export function compareTodayItems(left: TodayItem, right: TodayItem): number {
  if (left.lane !== right.lane) {
    return LANE_RANK[left.lane] - LANE_RANK[right.lane];
  }
  switch (left.lane) {
    case 'inbound_interrupt':
      return inboundCompare(left, right);
    case 'later': {
      const leftFrom = left.deferredFrom === null ? Number.MAX_SAFE_INTEGER : LANE_RANK[left.deferredFrom];
      const rightFrom = right.deferredFrom === null ? Number.MAX_SAFE_INTEGER : LANE_RANK[right.deferredFrom];
      if (leftFrom !== rightFrom) return leftFrom - rightFrom;
      return bandTimingAgeCompare(left, right);
    }
    default:
      return bandTimingAgeCompare(left, right);
  }
}

/**
 * Pure Today planner: classifies, applies pins after lane assignment, orders
 * by lane rank > commitment/warm > due time > priority, and applies
 * the discretionary dial cap (dialBudget, default 40) with per-lane
 * computed overflow counts. No database, clock, IDs, or ambient time.
 */
export function planTodayQueue(input: {
  candidates: readonly ParsedTodayCandidate[];
  hasActiveWarm?: boolean;
  generatedAt: string;
  timezone: string;
  capacity: TodayCapacity;
  completedDiscretionaryDialCount: number;
  unreviewedBacklogCount?: number;
  extraDiagnostics?: readonly TodayDiagnostic[];
  extraSuppressed?: readonly {
    cycleId: string;
    reason: 'snoozed' | 'dismissed' | 'recently_contacted' | 'resurface_scheduled' | 'not_due' | 'warm_pipeline_active';
  }[];
}): TodayQueue {
  const capacity = validateCapacity(input.capacity);
  if (!Number.isSafeInteger(input.completedDiscretionaryDialCount)
    || input.completedDiscretionaryDialCount < 0) {
    throw new PrioritizationInputCorruptionError(
      'Completed discretionary dial count must be a safe nonnegative integer.',
    );
  }
  const unreviewedBacklogCount = input.unreviewedBacklogCount ?? 0;
  if (!Number.isSafeInteger(unreviewedBacklogCount) || unreviewedBacklogCount < 0) {
    throw new PrioritizationInputCorruptionError(
      'Unreviewed backlog count must be a safe nonnegative integer.',
    );
  }
  const interval = resolveLocalDayInterval({
    generatedAt: input.generatedAt,
    timezone: input.timezone,
  });
  const context: TodayEvaluationContext = {
    hasActiveWarm: input.hasActiveWarm ?? input.candidates.some(candidate => candidate.segment === 'warm'),
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
  const suppressed: {
    cycleId: string;
    reason: 'snoozed' | 'dismissed' | 'recently_contacted' | 'resurface_scheduled' | 'not_due' | 'warm_pipeline_active';
  }[] = [
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

  // Exploration slots: keep the configured number, defer the rest.
  const later = laneBuckets.get('later')!;
  const exploration = laneBuckets.get('exploration')!;
  const selectedExploration = exploration.slice(0, capacity.explorationSlots);
  const quotaOverflow = exploration.slice(capacity.explorationSlots);
  for (const item of quotaOverflow) {
    later.push({ ...item, lane: 'later', deferredFrom: 'exploration', laneReason: 'exploration_quota_overflow' });
  }
  laneBuckets.set('exploration', selectedExploration);

  // Capacity constrains discretionary dials, never warm work or commitments.
  const overflowByLane = new Map<TodayLane, number>(LANE_ORDER.map(lane => [lane, 0]));
  let remaining = Math.max(0, capacity.dialBudget - input.completedDiscretionaryDialCount);
  for (const lane of LANE_ORDER) {
    if (lane === 'later') continue;
    const retained: TodayItem[] = [];
    for (const item of laneBuckets.get(lane)!) {
      const protectedWork = item.commitment != null || item.segment === 'warm'
        || lane === 'won_onboarding' || lane === 'inbound_interrupt';
      if (protectedWork || item.action.actionType !== 'call' || remaining > 0) {
        retained.push(item);
        if (!protectedWork && item.action.actionType === 'call') remaining -= 1;
      } else {
        overflowByLane.set(lane, overflowByLane.get(lane)! + 1);
        later.push({ ...item, lane: 'later', deferredFrom: lane, laneReason: 'capacity_overflow' });
      }
    }
    laneBuckets.set(lane, retained);
  }

  const queuedDiscretionaryDialCount = LANE_ORDER.filter(lane => lane !== 'later')
    .flatMap((lane) => laneBuckets.get(lane)!)
    .filter(item => item.action.actionType === 'call' && item.commitment == null
      && item.segment !== 'warm' && item.lane !== 'won_onboarding' && item.lane !== 'inbound_interrupt').length;
  const remainingBudget = Math.max(
    0, capacity.dialBudget - input.completedDiscretionaryDialCount,
  );

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
    unreviewedBacklogCount,
    lanes: LANE_ORDER.map((lane) => ({
      lane,
      items: laneBuckets.get(lane)!,
      overflowCount: overflowByLane.get(lane) ?? 0,
    })),
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
