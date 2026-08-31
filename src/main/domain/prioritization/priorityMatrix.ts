import type { FitBand, Priority, TimingBand } from '../../db/domainSchema';
import type {
  PrioritizationReason,
  PriorityPlay,
  StoredTriggerKey,
} from './prioritizationTypes';

export type MatrixDecision = Readonly<{
  priority: Priority;
  play: PriorityPlay;
  reasons: readonly Extract<PrioritizationReason, { kind: 'matrix' }>[];
}>;

type MatrixCell = Readonly<{ priority: Priority; play: PriorityPlay }>;

const MATRIX: Readonly<Record<TimingBand, Readonly<Record<FitBand, MatrixCell>>>> = Object.freeze({
  hot: Object.freeze({
    high: Object.freeze({ priority: 'p0' as const, play: 'contact_immediately' as const }),
    medium: Object.freeze({ priority: 'p1' as const, play: 'contact_today' as const }),
    low: Object.freeze({ priority: 'p2' as const, play: 'quick_fit_check' as const }),
  }),
  warm: Object.freeze({
    high: Object.freeze({ priority: 'p1' as const, play: 'contact_today' as const }),
    medium: Object.freeze({ priority: 'p2' as const, play: 'qualify_this_week' as const }),
    low: Object.freeze({ priority: 'p3' as const, play: 'nurture' as const }),
  }),
  cold: Object.freeze({
    high: Object.freeze({ priority: 'p3' as const, play: 'watch_for_trigger' as const }),
    medium: Object.freeze({ priority: 'p3' as const, play: 'nurture' as const }),
    low: Object.freeze({ priority: 'p3' as const, play: 'archive_candidate' as const }),
  }),
});

const PRIORITY_RANK: Readonly<Record<Priority, number>> = Object.freeze({
  p0: 0, p1: 1, p2: 2, p3: 3,
});

/**
 * The exact pure V1 matrix. High/Hot without Direct is P1 `find_direct_line`,
 * never P0. When `nurture_resurrection` is the only selected positive trigger
 * key, computed priority cannot exceed P1 (`nurture_only_p0_block`); any other
 * selected positive key restores the ordinary matrix. This exception applies
 * only to computed priority.
 */
export function resolvePriorityMatrix(input: {
  fitBand: FitBand;
  timingBand: TimingBand;
  reachability: 'direct' | 'indirect' | 'none';
  selectedPositiveTriggerKeys: readonly StoredTriggerKey[];
}): MatrixDecision {
  const reasons: Extract<PrioritizationReason, { kind: 'matrix' }>[] = [];
  let cell = MATRIX[input.timingBand][input.fitBand];
  reasons.push({ kind: 'matrix', code: 'matrix_cell' });

  if (input.timingBand === 'hot' && input.fitBand === 'high'
    && input.reachability !== 'direct') {
    cell = { priority: 'p1', play: 'find_direct_line' };
    reasons.push({ kind: 'matrix', code: 'high_hot_without_direct' });
  }

  const positiveKeys = input.selectedPositiveTriggerKeys;
  const nurtureOnly = positiveKeys.length === 1 && positiveKeys[0] === 'nurture_resurrection';
  if (nurtureOnly && PRIORITY_RANK[cell.priority] < PRIORITY_RANK.p1) {
    cell = { priority: 'p1', play: cell.play };
    reasons.push({ kind: 'matrix', code: 'nurture_only_p0_block' });
  }

  return Object.freeze({
    priority: cell.priority,
    play: cell.play,
    reasons: Object.freeze(reasons),
  });
}
