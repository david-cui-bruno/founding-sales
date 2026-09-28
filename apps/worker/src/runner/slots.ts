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
