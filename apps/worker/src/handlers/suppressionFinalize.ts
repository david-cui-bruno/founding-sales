import { suppressionFinalizeHandler } from '@fss/domain/suppression/handler.ts';
import type { JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';

/**
 * The worker's registration of `suppression.finalize` (Appendix C, specification
 * 10.2).
 *
 * The handler body is in `@fss/domain/suppression`, beside the correction it races,
 * for two reasons: the two have to claim the same row in the same way, and the
 * at-least-once harness in `packages/domain/jobs/atLeastOnce.ts` has to be able to
 * register it without importing `apps/worker`. This file is the composition —
 * what the process registers and with which attempt and lease budget.
 *
 * Four attempts and sixty seconds are the defaults from
 * `docs/decisions/g5-retry-ladder.md`. Nothing about this handler is slow: it reads
 * one event, claims one row and releases the holds that event opened.
 *
 * There is no `DueWorkSource` for it. The job is enqueued by the command that
 * recorded the suppression, in the same transaction, with `run_at` at the
 * ten-minute deadline — so the finalizer exists for every event that has a window,
 * or neither does. A scheduler pass that materialized it separately could only
 * materialize it late.
 */
export function suppressionFinalizeJobHandler(): JobHandler {
  return suppressionFinalizeHandler();
}
