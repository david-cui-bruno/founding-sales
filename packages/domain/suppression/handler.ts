import type { JobHandler } from '../jobs/handlerRegistry.ts';
import { repositoryContext } from '../db/workspaceScope.ts';
import { finalizeManualSuppression } from './finalize.ts';

/**
 * The `suppression.finalize` job handler (Appendix C, specification 10.2).
 *
 * | Work | Idempotency key | Effect protection |
 * | Suppression finalizer | `suppression-finalize:{event}` | Event lock and terminal marker |
 *
 * `business_uniqueness` is the protection Appendix C names, and the registry refuses
 * a handler that declares another. It is honest here: the effect is one row in
 * `suppression_finalizations` whose primary key is the event, so running twice
 * writes once, and a worker whose lease was stolen has its transaction rolled back
 * with the failed completion.
 *
 * The handler lives in `@fss/domain` rather than in `apps/worker` because everything
 * it touches is domain code and because the at-least-once harness in
 * `packages/domain/jobs/atLeastOnce.ts` has to be able to register it without
 * importing the worker. `apps/worker` composes it into the registry.
 */
export function suppressionFinalizeHandler(
  options: { readonly maxAttempts?: number; readonly leaseSeconds?: number } = {},
): JobHandler {
  return {
    kind: 'suppression.finalize',
    protection: 'business_uniqueness',
    maxAttempts: options.maxAttempts ?? 4,
    leaseSeconds: options.leaseSeconds ?? 60,
    handle: async input => {
      const eventId = input.job.payload['eventId'];
      if (typeof eventId !== 'string' || eventId.length === 0) {
        throw new Error('a suppression finalizer payload names the event it finalizes');
      }
      const context = repositoryContext(input.scope, input.session);
      const outcome = await finalizeManualSuppression(context, { eventId });
      if (outcome === 'unknown') {
        // The event is gone, which cannot happen — the table is insert-only — so this
        // is a payload naming an event from another workspace, and the scope stopped
        // it. Fail rather than complete: a silent success would hide the attempt.
        throw new Error('the suppression finalizer found no such event in its workspace');
      }
    },
  };
}
