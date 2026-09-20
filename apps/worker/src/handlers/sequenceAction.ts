import { repositoryContext, workspaceScope, type SessionQueryable } from '@fss/domain/db';
import { jobIdempotencyKey, type JobHandler, type JobSpecification } from '@fss/domain/jobs';
import {
  composeEligibility,
  runDueStepExecution,
  unavailableSendHandoff,
  type SendHandoff,
  type StepEligibility,
} from '@fss/domain/sequences';
import type { DueWorkSource } from '../scheduler/schedulerPass.ts';

/**
 * The `sequence.action` job and the source that materializes it (specification 11.2,
 * 13.1, Appendix B, Appendix C).
 *
 * Appendix C: "Sequence action | `step-execution:{id}` | Execution state and outbound
 * fence". Both halves of that protection are real. The key is the execution's id, and
 * `UNIQUE (workspace_id, enrollment_id, step_id)` in migration 0012 means there is one
 * execution per step of an enrollment to build a key from; the fence is G7-2's, and it
 * is what makes the protection `outbound_fence` rather than `business_uniqueness`.
 *
 * The declared protection matters to the runner, not only to the registry. An
 * `outbound_fence` handler runs *outside* the completion transaction, because
 * `prepared → dispatching` and the Gmail call after it cannot be rolled back
 * (Appendix B). So a stolen lease here does not roll the send back — the fence is what
 * stops a second one, and `apps/worker/test/sequenceAction.test.ts` proves it by
 * stealing a lease for real rather than by calling the handler twice.
 *
 * ## The send is not wired in this release
 *
 * `unavailableSendHandoff` refuses with `scoped_pause`, so a due email step *holds*
 * with a reason a salesperson can read rather than throwing in a worker log. That is
 * 4.2's rule — a system that cannot send holds — and it is the same shape the mail
 * lane used for its own unwired adapters: real code, no credentials, honest state.
 * G7-2's adapter replaces the argument and nothing else changes.
 */

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
      await runDueStepExecution(
        repositoryContext(
          workspaceScope(input.scope.workspaceId, { kind: 'system', component: 'worker' }),
          input.session,
        ),
        { stepExecutionId, now, eligibility, sendHandoff },
      );
    },
  };
}

/**
 * The due-work source (13.1).
 *
 * One indexed query over `step_executions_runnable`, which is the partial index on
 * `(workspace_id, due_at, not_before) WHERE state = 'pending'`. Both comparisons are
 * PostgreSQL's: no worker's clock decides whether a step is due, and the
 * `not_before` half is what keeps 11.3's ten-minute LinkedIn grace period honest
 * through a scheduler running in another region.
 *
 * A `held` execution is deliberately not materialized. A hold is cleared by a person
 * or by the lane that opened it, and the resume is what puts the row back to
 * `pending`; a job that claimed a held step every minute would be a queue full of work
 * that cannot proceed and an `oldest runnable job` alarm that means nothing.
 */
export function sequenceActionSource(): DueWorkSource {
  return {
    name: 'sequence-action',
    find: async (session: SessionQueryable, now: string): Promise<readonly JobSpecification[]> => {
      const { rows } = await session.query<{ id: string; workspace_id: string }>(
        `SELECT e.id, e.workspace_id
           FROM step_executions e
           JOIN sequence_enrollments n
             ON n.workspace_id = e.workspace_id AND n.id = e.enrollment_id
          WHERE e.state = 'pending'
            AND e.due_at <= $1::timestamptz
            AND e.not_before <= $1::timestamptz
            AND n.ended_at IS NULL
            AND n.state = 'active'
          ORDER BY e.due_at, e.id
          LIMIT 500`,
        [now],
      );
      return rows.map(row => ({
        workspaceId: row.workspace_id,
        kind: 'sequence.action' as const,
        idempotencyKey: jobIdempotencyKey.sequenceAction(row.id),
        payload: { stepExecutionId: row.id },
        maxAttempts: 4,
      }));
    },
  };
}
