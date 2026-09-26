import type { RetentionResult } from '@fss/domain/retention/result.ts';
import type { CommandResult } from './routeSupport.ts';

/**
 * One adapter for the deletion routes (the departure routes that shared it went in
 * wave 2, S6).
 *
 * The domain's `RetentionResult<T, Reason>` carries a *closed* refusal union per
 * command, which is the point of it: the reasons a deletion can be refused and the
 * reasons a departure can be refused are different questions, and a caller should
 * not have to handle the other one's answers. `CommandResult<T>` in `routeSupport.ts` is
 * the wider envelope every route replies through, with `reason: string`.
 *
 * Widening happens here, once, rather than at four call sites — and it happens by
 * rebuilding the object rather than by a cast, so the compiler still checks that a
 * refusal carries a reason and an acceptance carries a value. Under
 * `exactOptionalPropertyTypes` those are two different shapes and neither may carry
 * the other's field as `undefined`, which is what the rebuild expresses.
 */
export function commandResultOf<T, Reason extends string>(outcome: RetentionResult<T, Reason>): CommandResult<T> {
  return outcome.ok ? { ok: true, value: outcome.value } : { ok: false, reason: outcome.reason };
}
