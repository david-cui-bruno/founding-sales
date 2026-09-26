import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { RecoveryFloorSource } from '../mail/recover.ts';

/**
 * 12.3's recovery floor, now that there is something to compute it from.
 *
 * "On expired history cursor ... [recover] from the earlier of watermark minus one
 * hour and the oldest unresolved outbound message or active enrollment."
 *
 * G7-1 shipped `RecoveryFloorSource` as a port with `NO_RECOVERY_FLOOR` behind it,
 * because the second half of that sentence needs `outbound_messages` and the table
 * did not exist. This is the implementation.
 *
 * ## What "unresolved" means
 *
 * A fence is unresolved when FSS does not know what happened to it: `dispatching`,
 * `reconciling`, and `unknown_terminal` with no admin answer. Those are exactly the
 * states whose evidence is in the mailbox rather than in the database — a Sent-folder
 * entry, a bounce, a reply — so a recovery that started *after* one of them began
 * could read past the evidence that would settle it and prove coverage it does not
 * have.
 *
 * `sent` is resolved: the provider ids are recorded and a reply to it will match on
 * thread or Message-ID whenever it arrives. `held` and `prepared` never reached
 * Gmail, so there is nothing in the mailbox to find.
 *
 * ## Why the floor is the *dispatch* instant and not the preparation instant
 *
 * The question a recovery answers is "what has this mailbox seen that FSS has not".
 * Nothing can have been seen before the send was attempted, so `dispatch_started_at`
 * is the earliest instant that can matter — and using `created_at` instead would
 * extend every recovery backwards by however long the fence waited in the queue,
 * which on a Friday-evening placement is three days of pages for no benefit.
 *
 * ## Active enrollments
 *
 * The other half of the sentence is G8's: `enrollments` does not exist on this
 * branch. the enrollment floor is a second source with the same shape, so G8 supplies it
 * in one line and `combinedRecoveryFloor` takes the earlier of the two. Until then
 * the outbound half stands alone, which is strictly better than the `null` G7-1 had.
 */

export function outboundRecoveryFloor(): RecoveryFloorSource {
  return {
    async oldestUnresolvedAt(context: RepositoryContext, mailboxId: string): Promise<string | null> {
      const { rows } = await context.db.query<{ floor: Date | null }>(
        `SELECT min(dispatch_started_at) AS floor
           FROM outbound_messages
          WHERE workspace_id = $1
            AND mailbox_id = $2
            AND dispatch_started_at IS NOT NULL
            AND (
              state IN ('dispatching', 'reconciling')
              OR (state = 'unknown_terminal' AND admin_resolution IS NULL)
            )`,
        [context.scope.workspaceId, mailboxId],
      );
      return rows[0]?.floor?.toISOString() ?? null;
    },
  };
}

/**
 * The earlier of two floors, for the day G8's enrollment floor arrives.
 *
 * Earlier, not later: 12.3 says "the earlier of", and a recovery that starts too
 * early costs pages while one that starts too late claims coverage it does not have.
 */
export function combinedRecoveryFloor(
  ...sources: readonly RecoveryFloorSource[]
): RecoveryFloorSource {
  return {
    async oldestUnresolvedAt(context: RepositoryContext, mailboxId: string): Promise<string | null> {
      let earliest: string | null = null;
      for (const source of sources) {
        const candidate = await source.oldestUnresolvedAt(context, mailboxId);
        if (candidate === null) continue;
        if (earliest === null || Date.parse(candidate) < Date.parse(earliest)) earliest = candidate;
      }
      return earliest;
    },
  };
}
