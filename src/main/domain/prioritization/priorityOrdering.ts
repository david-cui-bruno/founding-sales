import { PrioritizationInputCorruptionError } from '../support/domainErrors';
import { parseCanonicalUtcMillis } from './qualificationEngine';
import type {
  EffectivePrioritySnapshot,
  OrderablePriorityRow,
} from './prioritizationTypes';

const PRIORITY_RANK: Readonly<Record<'p0' | 'p1' | 'p2' | 'p3', number>> = Object.freeze({
  p0: 0, p1: 1, p2: 2, p3: 3,
});

const REACHABILITY_RANK: Readonly<Record<'direct' | 'indirect' | 'none', number>> = Object.freeze({
  direct: 0, indirect: 1, none: 2,
});

/** Sentinel used only when the corresponding null flag already orders the row. */
const NULL_SENTINEL = 0;

export function toOrderablePriorityRow(
  snapshot: EffectivePrioritySnapshot,
): OrderablePriorityRow {
  if ((snapshot.lastContactActivityId === null) !== (snapshot.lastContactAt === null)) {
    throw new PrioritizationInputCorruptionError(
      'Snapshot last-contact Activity ID and timestamp must be all-or-none.',
    );
  }
  return Object.freeze({
    prospectId: snapshot.prospectId,
    effectivePriority: snapshot.effectivePriority,
    earliestTriggerExpiresAt: snapshot.earliestTriggerExpiresAt,
    timingMilliPoints: snapshot.timingMilliPoints,
    fitPoints: snapshot.fitPoints,
    reachability: snapshot.reachability,
    dataConfidence: snapshot.dataConfidence,
    lastContactAt: snapshot.lastContactAt,
    cloudSourcePercentile: snapshot.cloudSourcePercentile ?? null,
    cloudTiming: snapshot.cloudTiming ?? null,
  });
}

export function buildProspectPriorityTuple(
  row: OrderablePriorityRow,
): readonly [
  number, number, number, number, number, number, number, number, number,
  number, number, number, number, string,
] {
  const expirationMillis = row.earliestTriggerExpiresAt === null
    ? NULL_SENTINEL
    : parseCanonicalUtcMillis(row.earliestTriggerExpiresAt, 'earliestTriggerExpiresAt');
  const lastContactMillis = row.lastContactAt === null
    ? NULL_SENTINEL
    : parseCanonicalUtcMillis(row.lastContactAt, 'lastContactAt');
  return Object.freeze([
    PRIORITY_RANK[row.effectivePriority],
    row.earliestTriggerExpiresAt === null ? 1 : 0,
    expirationMillis,
    -row.timingMilliPoints,
    -row.fitPoints,
    REACHABILITY_RANK[row.reachability],
    -row.dataConfidence,
    row.lastContactAt === null ? 0 : 1,
    lastContactMillis,
    // Cloud tiebreakers only, strictly after every local key. The
    // within-source percentile (F10) leads because raw cloud axes from
    // different acquisition sources are not comparable; raw timing follows
    // as a residual within-source tiebreaker. Unscored (null) rows order
    // after scored rows.
    row.cloudSourcePercentile === null ? 1 : 0,
    row.cloudSourcePercentile === null ? NULL_SENTINEL : -row.cloudSourcePercentile,
    row.cloudTiming === null ? 1 : 0,
    row.cloudTiming === null ? NULL_SENTINEL : -row.cloudTiming,
    row.prospectId,
  ]) as readonly [
    number, number, number, number, number, number, number, number, number,
    number, number, number, number, string,
  ];
}

export function compareProspectPriority(
  left: OrderablePriorityRow,
  right: OrderablePriorityRow,
): number {
  const leftTuple = buildProspectPriorityTuple(left);
  const rightTuple = buildProspectPriorityTuple(right);
  for (let index = 0; index < leftTuple.length; index += 1) {
    const leftValue = leftTuple[index]!;
    const rightValue = rightTuple[index]!;
    if (leftValue === rightValue) continue;
    if (typeof leftValue === 'number' && typeof rightValue === 'number') {
      return leftValue - rightValue;
    }
    return leftValue < rightValue ? -1 : 1;
  }
  return 0;
}

export const PRIORITY_ORDERABLE_SQL_ALIAS = 'priority_orderable' as const;
export const PROSPECT_PRIORITY_ORDER_BY_SQL = `
  CASE priority_orderable.effective_priority
    WHEN 'p0' THEN 0 WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 WHEN 'p3' THEN 3
    ELSE 4
  END ASC,
  CASE WHEN priority_orderable.earliest_trigger_expires_at IS NULL
    THEN 1 ELSE 0 END ASC,
  priority_orderable.earliest_trigger_expires_at ASC,
  priority_orderable.timing_millipoints DESC,
  priority_orderable.fit_points DESC,
  CASE priority_orderable.reachability
    WHEN 'direct' THEN 0 WHEN 'indirect' THEN 1 WHEN 'none' THEN 2
    ELSE 3
  END ASC,
  priority_orderable.data_confidence DESC,
  CASE WHEN priority_orderable.last_contact_at IS NULL THEN 0 ELSE 1 END ASC,
  priority_orderable.last_contact_at ASC,
  CASE WHEN priority_orderable.cloud_source_percentile IS NULL THEN 1 ELSE 0 END ASC,
  priority_orderable.cloud_source_percentile DESC,
  CASE WHEN priority_orderable.cloud_timing IS NULL THEN 1 ELSE 0 END ASC,
  priority_orderable.cloud_timing DESC,
  priority_orderable.prospect_id COLLATE BINARY ASC
` as const;
