import { JOB_CLASSES, type JobClass } from '@fss/domain/jobs/handlerRegistry.ts';

/**
 * Which lane (or lanes, in order) a runner slot claims from.
 *
 * One slot claiming every kind by `run_at` is how a queue of fifty retention batches
 * becomes the latency of the reply someone just sent: the claim orders by `run_at`, so
 * whatever was queued first is claimed first, whatever it is. Splitting the slots by
 * lane means the depth of one lane can no longer be the other lane's wait.
 *
 * The rule, in five lines:
 *
 * 1. Slot 0 claims `urgent` only — there is always somewhere for urgent work to land.
 * 2. Slot 1 claims `bulk` only, but only once there are at least three slots, so bulk
 *    work cannot be starved by sustained urgent load.
 * 3. Every further slot is flexible: `urgent` first, then `bulk`, in the same poll.
 * 4. With two slots there is no bulk-only slot: slot 0 is urgent, slot 1 is flexible.
 * 5. With one slot — production today — that slot is flexible, which is today's
 *    behaviour plus an ordering: urgent is looked at first.
 *
 * A flexible slot tries the lanes in order within one pass and stops at the first lane
 * that yields a claim, so an idle urgent lane costs one extra statement, not a pass.
 */
export function slotClasses(concurrency: number, index: number): readonly JobClass[] {
  const flexible: readonly JobClass[] = JOB_CLASSES;
  if (concurrency <= 1) return flexible;
  if (index === 0) return ['urgent'];
  if (index === 1) return concurrency >= 3 ? ['bulk'] : flexible;
  return flexible;
}

/**
 * How many polls in a row a flexible slot may claim urgent work before it looks at
 * bulk first.
 *
 * Without this, "urgent first" is starvation wearing a better name: the scheduler
 * materializes mail syncs, reconciles and Today builds on a fixed cadence, so at one
 * or two slots — production until `worker_concurrency` lands, and every deployment
 * that turns it down again — a flexible slot can find urgent work on every poll for
 * ever and `sequence.action` never runs. Three is small enough that a reply still
 * beats a sweep to the slot three times out of four, and large enough that the urgent
 * lane is not interleaved away.
 */
export const URGENT_STREAK_LIMIT = 3;

export interface SlotLanes {
  /** The lanes for the next poll, in order. */
  order(): readonly JobClass[];
  /** What that poll claimed. `null` is a poll that claimed nothing. */
  record(claimedClass: JobClass | null): void;
}

/**
 * A slot's lane order, with the streak counter a flexible slot needs.
 *
 * A fixed slot (urgent-only, bulk-only) has nothing to remember. A flexible slot
 * counts consecutive polls that claimed urgent and, once it reaches the limit, puts
 * bulk first for one poll; the flipped poll still tries urgent afterwards, so when
 * there is no bulk work waiting the flip costs one statement and nothing else — which
 * is why the counter does not need to ask, first, whether bulk is runnable.
 */
export function slotLanes(concurrency: number, index: number): SlotLanes {
  const lanes = slotClasses(concurrency, index);
  if (lanes.length < 2) {
    return { order: () => lanes, record: () => {} };
  }
  const urgentFirst: readonly JobClass[] = ['urgent', 'bulk'];
  const bulkFirst: readonly JobClass[] = ['bulk', 'urgent'];
  let urgentStreak = 0;
  let flipped = false;
  return {
    order: () => {
      flipped = urgentStreak >= URGENT_STREAK_LIMIT;
      return flipped ? bulkFirst : urgentFirst;
    },
    record: claimedClass => {
      urgentStreak = !flipped && claimedClass === 'urgent' ? urgentStreak + 1 : 0;
    },
  };
}
