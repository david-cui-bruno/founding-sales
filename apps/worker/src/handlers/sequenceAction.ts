import { withTransaction, type SessionQueryable } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { type JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';
import { jobIdempotencyKey } from '@fss/domain/jobs/jobKinds.ts';
import { type JobSpecification } from '@fss/domain/jobs/jobStore.ts';
import { composeEligibility, type StepEligibility } from '@fss/domain/sequences/eligibility.ts';
import { dispatchPreparedStep, runDueStepExecution } from '@fss/domain/sequences/executions.ts';
import { unavailableSendHandoff, type SendHandoff } from '@fss/domain/sequences/sendHandoff.ts';
import { listStepWakes } from '@fss/domain/sequences/wake.ts';
import type { DueWorkSource } from '../scheduler/schedulerPass.ts';

/**
 * The `sequence.action` job and the source that materializes it (specification 11.2,
 * 13.1, Appendix B, Appendix C).
 *
 * Appendix C: "Sequence action | `step-execution:{id}` | Execution state and outbound
 * fence". Both halves of that protection are real. The key is the execution's id and
 * the wake it is for — `step-execution:{id}:{wake}`, the row's version (lane g82,
 * `packages/domain/sequences/wake.ts`) — and `UNIQUE (workspace_id, enrollment_id,
 * step_id)` in migration 0012 means there is one execution per step of an enrollment
 * to build it from; the fence is G7-2's, and it is what makes the protection
 * `outbound_fence` rather than `business_uniqueness`. A step is looked at again when
 * its row moves, never twice for one version, and never by two live jobs at once.
 *
 * The declared protection matters to the runner, not only to the registry. An
 * `outbound_fence` handler runs *outside* the completion transaction, because
 * `prepared → dispatching` and the Gmail call after it cannot be rolled back
 * (Appendix B). So a stolen lease here does not roll the send back — the fence is what
 * stops a second one, and `apps/worker/test/sequenceAction.test.ts` proves it by
 * stealing a lease for real rather than by calling the handler twice.
 *
 * ## The hand-off, and what a deployment without Gmail does
 *
 * The bootstrap passes `outboundSendHandoff()`, which is G7-2's fence behind G8's
 * interface. `prepare` and the outcome read are real; `dispatch` needs a Gmail
 * configuration this release gives nobody, so a due email step *holds* with the
 * reason the fence gave rather than throwing in a worker log. That is 4.2's rule — a
 * system that cannot send holds — and it is the same shape the mail lane used for its
 * own unwired adapters: real code, no credentials, honest state.
 *
 * `unavailableSendHandoff` is still the default when no hand-off is supplied at all,
 * which is what a test that wants nothing sent asks for.
 */

/**
 * What the step's transaction left behind for the dispatch that follows it.
 *
 * Carried in an array rather than a nullable local because TypeScript's narrowing
 * does not follow a value assigned inside a callback back out of it.
 */
interface PreparedFence {
  readonly stepExecutionId: string;
  readonly outboundMessageId: string;
}

export interface SequenceActionHandlerOptions {
  readonly maxAttempts?: number;
  readonly leaseSeconds?: number;
  /** G7-2's adapter. Absent holds every due email step with `scoped_pause`. */
  readonly sendHandoff?: SendHandoff | undefined;
  /** The composed eligibility read. Absent is the default eleven-question composition. */
  readonly eligibility?: StepEligibility | undefined;
}

export function sequenceActionJobHandler(options: SequenceActionHandlerOptions = {}): JobHandler {
  const sendHandoff = options.sendHandoff ?? unavailableSendHandoff();
  const eligibility = options.eligibility ?? composeEligibility();
  return {
    kind: 'sequence.action',
    protection: 'outbound_fence',
    // Four attempts and sixty seconds, the defaults from
    // docs/decisions/g5-retry-ladder.md. Everything slow in this handler is behind
    // the fence, which is not this job's to retry.
    maxAttempts: options.maxAttempts ?? 4,
    leaseSeconds: options.leaseSeconds ?? 60,
    handle: async input => {
      const stepExecutionId = input.job.payload['stepExecutionId'];
      if (typeof stepExecutionId !== 'string') {
        throw new Error('a sequence.action payload names the step execution it runs');
      }
      const { rows } = await input.session.query<{ now: Date }>('SELECT now() AS now');
      const now = (rows[0]?.now ?? new Date()).toISOString();
      const context = repositoryContext(
        workspaceScope(input.scope.workspaceId, { kind: 'system', component: 'worker' }),
        input.session,
      );

      // 11.2: eligibility is re-read "inside the claiming transaction", and the fence
      // is prepared in it. The runner does not open one for an `outbound_fence`
      // handler, so the handler opens its own and commits it before dispatching.
      const prepared: PreparedFence[] = [];
      await withTransaction(input.session, async () => {
        const outcome = await runDueStepExecution(context, {
          stepExecutionId,
          now,
          eligibility,
          sendHandoff,
        });
        if (outcome.kind === 'handed_to_send') {
          prepared.push({
            stepExecutionId: outcome.stepExecutionId,
            outboundMessageId: outcome.outboundMessageId,
          });
        }
      });

      // Appendix B: `prepared → dispatching` and the provider call after it cannot be
      // rolled back, so they happen after the commit and never inside it.
      const handed = prepared[0];
      if (handed !== undefined) {
        await dispatchPreparedStep(context, { ...handed, sendHandoff, now });
      }
    },
  };
}

/**
 * The due-work source (13.1).
 *
 * `listStepWakes` decides what is owed a look (lane g82, audit C02, C03, C05, C10):
 *
 * * due `pending` work;
 * * `held` work whose `not_before` has passed and that no open hold blocks — every
 *   scope `active_holds` carries, the same scopes `composeEligibility` asks — so a
 *   released pause, reply hold or mailbox hold wakes its steps on the next pass, and a
 *   step still blocked is not prepared every pass;
 * * `dispatched` work that has sat for ten minutes, whose worker died between the step's
 *   transaction and the claim, so its prepared fence goes to the dispatch path again.
 *
 * Each becomes one job keyed by the row's version. Before lane g82 the key was the
 * execution's id alone and only four clock-clearing reasons were materialized out of
 * `held` — and even those never ran again, because the first job's key was `done`.
 */
export function sequenceActionSource(): DueWorkSource {
  return {
    name: 'sequence-action',
    find: async (session: SessionQueryable, now: string): Promise<readonly JobSpecification[]> => {
      const wakes = await listStepWakes(session, { now });
      return wakes.map(wake => ({
        workspaceId: wake.workspaceId,
        kind: 'sequence.action' as const,
        idempotencyKey: jobIdempotencyKey.sequenceAction(wake.stepExecutionId, wake.wake),
        payload: { stepExecutionId: wake.stepExecutionId },
        maxAttempts: 4,
      }));
    },
  };
}
