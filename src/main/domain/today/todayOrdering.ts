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
 * No-due-dates lane order (audit 4.9.5): Onboard now, Fresh inbound, Due
 * cadence, New P0, P1, Exploration, Later. Overdue and Post-interview/offer
 * are gone; post-stage promises fold into Due cadence.
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
    resurfaceAt: candidate.resurfaceAt,
    resurfaceReason: candidate.resurfaceReason,
    inlineDiagnostics: candidate.inlineDiagnostics,
  };
}

function effectivePriorityOf(candidate: ParsedTodayCandidate): 'p0' | 'p1' | 'p2' | 'p3' | null {
  return candidate.priority?.effectivePriority ?? null;
}

/**
 * Pure first-match lane classification in the fixed no-due-dates order.
 * Time never converts work into a promise: lanes derive from workflow
 * status, work intent, and founder-chosen resurface markers only.
 */
export function classifyTodayCandidate(
  candidate: ParsedTodayCandidate,
  context: TodayEvaluationContext,
): TodayPreCapacityDisposition {
  const asOfMillis = assertCanonical(context.generatedAt, 'generatedAt');
  const intent = candidate.action.workIntent;
  const sla = candidate.action.inboundSla;

  // 0. A future founder-chosen resurface hides the cycle entirely.
  let resurfaceReason: TodayLaneReason | null = null;
  if (candidate.resurfaceAt !== null) {
    const resurfaceMillis = assertCanonical(candidate.resurfaceAt, 'resurface_at');
    if (resurfaceMillis > asOfMillis) {
      return {
        kind: 'suppressed',
        cycleId: candidate.cycleId,
        reason: 'resurface_scheduled',
      };
    }
    resurfaceReason = candidate.resurfaceReason === 'callback'
      ? 'callback_promised_today'
      : 'snoozed_until_today';
  }

  // 1. Won onboarding outranks everything.
  if (candidate.workflowStatus === 'onboarding') {
    return { kind: 'lane', lane: 'won_onboarding', item: toItem(candidate, 'won_onboarding', 'won_onboarding') };
  }

  // 2. Fresh inbound: an inbound response is time-sensitive while inside its
  // SLA and stays at the top of Fresh inbound after it (age ordering).
  if (intent === 'inbound_response') {
    if (sla.kind !== 'none') {
      assertCanonical(sla.dueAt, 'Inbound SLA due_at');
    }
    return {
      kind: 'lane',
      lane: 'inbound_interrupt',
      item: toItem(candidate, 'inbound_interrupt', resurfaceReason ?? 'inbound_inside_sla'),
    };
  }

  const discretionary = intent === 'discretionary_prospecting';

  // 3. Non-discretionary work (cadence next steps, promises, internal
  // review) is Due cadence: the cadence or founder said this is next.
  if (!discretionary) {
    const reason: TodayLaneReason = resurfaceReason
      ?? (intent === 'promised_follow_up'
        ? (candidate.cadence !== null ? 'cadence_step_next' : 'promised_follow_up')
        : 'internal_review_waiting');
    return { kind: 'lane', lane: 'due_primary', item: toItem(candidate, 'due_primary', reason) };
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
 * The within-lane comparator (audit 4.9.5): priority band, then cloud
 * timing (higher first, nulls last), then last-touch age (older first,
 * never-touched first as "oldest"), then stable ids. Computed at render;
 * nothing here reads a stored due time.
 */
function bandTimingAgeCompare(left: TodayItem, right: TodayItem): number {
  if (pinnedOf(left) !== pinnedOf(right)) return pinnedOf(left) ? -1 : 1;
  const leftBand = left.priority === null
    ? 4 : PRIORITY_RANK[left.priority.effectivePriority];
  const rightBand = right.priority === null
    ? 4 : PRIORITY_RANK[right.priority.effectivePriority];
  if (leftBand !== rightBand) return leftBand - rightBand;
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
 * by lane rank > priority band > cloud timing > last-touch age, and applies
 * the whole-queue capacity cap (dialBudget, default 40) with per-lane
 * computed overflow counts. No database, clock, IDs, or ambient time.
 */
export function planTodayQueue(input: {
  candidates: readonly ParsedTodayCandidate[];
  generatedAt: string;
  timezone: string;
  capacity: TodayCapacity;
  completedDiscretionaryDialCount: number;
  unreviewedBacklogCount?: number;
  extraDiagnostics?: readonly TodayDiagnostic[];
  extraSuppressed?: readonly {
    cycleId: string;
    reason: 'snoozed' | 'dismissed' | 'recently_contacted' | 'resurface_scheduled';
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
    reason: 'snoozed' | 'dismissed' | 'recently_contacted' | 'resurface_scheduled';
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

  // Whole-queue capacity: at most `dialBudget` rows across the actionable
  // lanes, cut lane-by-lane in rank order with computed overflow counts.
  const overflowByLane = new Map<TodayLane, number>(
    LANE_ORDER.map((lane): [TodayLane, number] => [lane, 0]),
  );
  let remaining = capacity.dialBudget;
  for (const lane of LANE_ORDER) {
    if (lane === 'later') continue;
    const bucket = laneBuckets.get(lane)!;
    if (bucket.length <= remaining) {
      remaining -= bucket.length;
      continue;
    }
    const retained = bucket.slice(0, remaining);
    const cut = bucket.slice(remaining);
    overflowByLane.set(lane, cut.length);
    for (const item of cut) {
      later.push({
        ...item,
        lane: 'later',
        deferredFrom: lane as Exclude<TodayLane, 'later'>,
        laneReason: 'capacity_overflow',
      });
    }
    laneBuckets.set(lane, retained);
    remaining = 0;
  }

  const isCall = (item: TodayItem): boolean => item.action.actionType === 'call';
  const queuedDiscretionaryDialCount = (['new_p0', 'p1', 'exploration'] as const)
    .flatMap((lane) => laneBuckets.get(lane)!)
    .filter(isCall).length;
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
