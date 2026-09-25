import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { RecoveryFloorSource } from '../mail/index.ts';

/**
 * The enrollment half of 12.3's recovery floor.
 *
 * "On expired history cursor ... [recover] from the earlier of watermark minus one
 * hour and the oldest unresolved outbound message or active enrollment."
 *
 * G7-1 shipped the port, G7-2 implemented the outbound half and left this one as a
 * second source of the same shape, to be combined with `combinedRecoveryFloor`. This
 * is it.
 *
 * ## What the enrollment half means, and why it is not the enrollment's start
 *
 * The floor answers one question: what can this mailbox have seen that FSS has not?
 * Nothing can have been *seen* before FSS touched the prospect, so the instant that
 * matters is the earliest completed step of a live enrollment — the first email that
 * went out, the first call logged. A reply to either can only postdate it.
 *
 * That is the same reasoning G7-2 used for taking `dispatch_started_at` rather than
 * `created_at`: the enrollment's `started_at` would extend every recovery back through
 * however long the first step sat waiting for its window, which on a Friday evening
 * placement is three days of pages for nothing.
 *
 * It is deliberately *not* the earliest step still unexecuted, which would be the
 * other tempting reading. A reply to step one arrives while step two is pending, so a
 * floor at step two's due instant would start the recovery after the evidence and
 * prove coverage FSS does not have — the one failure 12.3 exists to prevent.
 *
 * ## Why only live enrollments, and only this mailbox's
 *
 * 12.3 says "active enrollment". An enrollment that has ended has ended because
 * something was read — a reply, a stop, a closed opportunity — so its evidence is
 * already in the database. And the floor is per mailbox, so the enrollments that
 * count are the ones whose assigned salesperson owns it: another salesperson's
 * conversation was never going to arrive here.
 *
 * `docs/decisions/g8-enrollment-recovery-floor.md`.
 */

export function enrollmentFloor(): RecoveryFloorSource {
  return {
    async oldestUnresolvedAt(context: RepositoryContext, mailboxId: string): Promise<string | null> {
      const { rows } = await context.db.query<{ floor: Date | null }>(
        `SELECT min(execution.completed_at) AS floor
           FROM step_executions execution
           JOIN sequence_enrollments enrollment
             ON enrollment.workspace_id = execution.workspace_id
            AND enrollment.id = execution.enrollment_id
           JOIN mailboxes mailbox
             ON mailbox.workspace_id = enrollment.workspace_id
            AND mailbox.owner_user_id = enrollment.assigned_user_id
          WHERE execution.workspace_id = $1
            AND mailbox.id = $2
            AND enrollment.ended_at IS NULL
            AND execution.completed_at IS NOT NULL`,
        [context.scope.workspaceId, mailboxId],
      );
      return rows[0]?.floor?.toISOString() ?? null;
    },
  };
}
