import type { RetentionResult } from '@fss/domain/retention';
import type { LaneResult } from './dialSupport.ts';

/**
 * One adapter for the deletion routes (the departure routes that shared it went in
 * wave 2, S6).
 *
 * The domain's `RetentionResult<T, Reason>` carries a *closed* refusal union per
 * command, which is the point of it: the reasons a deletion can be refused and the
 * reasons a departure can be refused are different questions, and a caller should
 * not have to handle the other one's answers. `LaneResult<T>` in `dialSupport.ts` is
 * the wider envelope every route replies through, with `reason: string`.
 *
 * Widening happens here, once, rather than at four call sites — and it happens by
 * rebuilding the object rather than by a cast, so the compiler still checks that a
 * refusal carries a reason and an acceptance carries a value. Under
 * `exactOptionalPropertyTypes` those are two different shapes and neither may carry
 * the other's field as `undefined`, which is what the rebuild expresses.
 */
export function laneResultOf<T, Reason extends string>(outcome: RetentionResult<T, Reason>): LaneResult<T> {
  return outcome.ok ? { ok: true, value: outcome.value } : { ok: false, reason: outcome.reason };
}
