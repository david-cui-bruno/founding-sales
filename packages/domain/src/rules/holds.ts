import type { BlockedActionKind, HoldReasonCode } from '@fss/contracts';
import { isRecoverableHoldReason } from '@fss/contracts';

/**
 * Hold composition and schedule shifting (specification 4.3).
 *
 * "Automation is eligible only when the opportunity is automated and no applicable
 * active hold exists. Clearing one hold never clears another. When the final
 * applicable hold clears, unfinished due times shift by the union of all blocking
 * intervals, so overlapping holds are not double-counted. If the union exceeds seven
 * calendar days, the enrollment remains held for salesperson review and explicit
 * resume."
 *
 * The union, not the sum, is the whole point: two holds that ran side by side for a
 * day delayed the work by a day, and adding them would push a firm two days out for a
 * single day of trouble. The property tests in test/domain/holds.test.ts check that
 * the union is never larger than the sum, never smaller than the longest single hold,
 * and independent of the order the holds are given in.
 */

export const LONG_HOLD_REVIEW_DAYS = 7;
export const LONG_HOLD_REVIEW_MILLISECONDS = LONG_HOLD_REVIEW_DAYS * 24 * 60 * 60 * 1000;

export interface HoldRecord {
  readonly id: string;
  readonly reasonCode: HoldReasonCode;
  readonly blockedActionKinds: readonly BlockedActionKind[];
  readonly startedAt: string;
  readonly releasedAt: string | null;
}

export interface Interval {
  readonly start: number;
  readonly end: number;
}

function toInterval(hold: HoldRecord, now: number): Interval {
  const start = Date.parse(hold.startedAt);
  const end = hold.releasedAt === null ? now : Date.parse(hold.releasedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new TypeError(`hold ${hold.id} has an unparseable interval`);
  }
  return { start, end: Math.max(end, start) };
}

/** Merge overlapping and touching intervals into a disjoint, sorted set. */
function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].filter(interval => interval.end > interval.start).sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && interval.start <= last.end) {
      if (interval.end > last.end) merged[merged.length - 1] = { start: last.start, end: interval.end };
      continue;
    }
    merged.push(interval);
  }
  return merged;
}

/** The total length of the union of the intervals, in milliseconds. */
export function unionDuration(intervals: readonly Interval[]): number {
  return mergeIntervals(intervals).reduce((total, interval) => total + (interval.end - interval.start), 0);
}

export interface HoldComposition {
  /** True while any applicable hold is open. */
  readonly blocked: boolean;
  /** The union of every applicable hold's blocked action kinds, sorted, without repeats. */
  readonly blockedActionKinds: readonly BlockedActionKind[];
  /** The reason codes of the holds still open, sorted, without repeats. */
  readonly openReasonCodes: readonly HoldReasonCode[];
  /** The ids of the holds still open. */
  readonly openHoldIds: readonly string[];
  /** The union of every blocking interval, in milliseconds. Never the sum. */
  readonly unionMilliseconds: number;
  /**
   * True when the union exceeded seven calendar days. The enrollment stays held for
   * salesperson review even after the last hold clears.
   */
  readonly requiresReview: boolean;
  /** The reason codes a control may clear, out of the open ones. */
  readonly recoverableReasonCodes: readonly HoldReasonCode[];
}

export interface ComposeHoldsInput {
  readonly holds: readonly HoldRecord[];
  /** Database time. An open hold is blocking up to this instant. */
  readonly now: string;
  /** When given, only holds that block one of these kinds are applicable. */
  readonly actionKinds?: readonly BlockedActionKind[];
}

/**
 * Compose every hold that applies to a piece of work into one answer. Fails closed:
 * an empty `actionKinds` filter is "no action kind is being asked about", which
 * applies every hold rather than none.
 */
export function composeHolds(input: ComposeHoldsInput): HoldComposition {
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) throw new TypeError('composeHolds needs an ISO 8601 database time');

  const wanted = input.actionKinds;
  const applicable =
    wanted === undefined || wanted.length === 0
      ? input.holds
      : input.holds.filter(hold => hold.blockedActionKinds.some(kind => wanted.includes(kind)));

  const open = applicable.filter(hold => hold.releasedAt === null);
  const unionMilliseconds = unionDuration(applicable.map(hold => toInterval(hold, now)));

  const sortedUnique = <T extends string>(values: readonly T[]): T[] => [...new Set(values)].sort();

  const openReasonCodes = sortedUnique(open.map(hold => hold.reasonCode));
  return {
    blocked: open.length > 0,
    blockedActionKinds: sortedUnique(open.flatMap(hold => [...hold.blockedActionKinds])),
    openReasonCodes,
    openHoldIds: open.map(hold => hold.id).sort(),
    unionMilliseconds,
    requiresReview: unionMilliseconds > LONG_HOLD_REVIEW_MILLISECONDS,
    recoverableReasonCodes: openReasonCodes.filter(code => isRecoverableHoldReason(code)),
  };
}

export type ResumeDecision =
  | { readonly kind: 'still_held'; readonly openHoldIds: readonly string[] }
  | { readonly kind: 'review_required'; readonly unionMilliseconds: number; readonly reviewDays: number }
  | { readonly kind: 'resume'; readonly shiftMilliseconds: number };

/**
 * What happens to unexecuted work when the holds are reconsidered.
 *
 * Three answers and no fourth: something is still open, or the union was long enough
 * that a person has to look at the rendered future steps first, or the work shifts by
 * the union and resumes after a fresh eligibility check.
 */
export function decideResume(composition: HoldComposition): ResumeDecision {
  if (composition.blocked) return { kind: 'still_held', openHoldIds: composition.openHoldIds };
  if (composition.requiresReview) {
    return {
      kind: 'review_required',
      unionMilliseconds: composition.unionMilliseconds,
      reviewDays: LONG_HOLD_REVIEW_DAYS,
    };
  }
  return { kind: 'resume', shiftMilliseconds: composition.unionMilliseconds };
}

/** Move an unexecuted due instant forward by the union. An executed step is never shifted. */
export function shiftDueInstant(dueAt: string, shiftMilliseconds: number): string {
  const parsed = Date.parse(dueAt);
  if (!Number.isFinite(parsed)) throw new TypeError('a due instant is an ISO 8601 string');
  if (shiftMilliseconds < 0) throw new RangeError('a schedule shift never moves work earlier');
  return new Date(parsed + shiftMilliseconds).toISOString();
}
