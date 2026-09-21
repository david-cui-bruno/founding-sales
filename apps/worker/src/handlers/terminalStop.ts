import { repositoryContext, type SessionQueryable } from '@fss/domain/db';
import { jobIdempotencyKey, type JobHandler, type JobSpecification } from '@fss/domain/jobs';
import {
  consumeSuppressionStops,
  consumeTerminalStops,
  readTerminalStopWork,
} from '@fss/domain/sequences';
import type { DueWorkSource } from '../scheduler/schedulerPass.ts';

/**
 * The `sequence.terminal_stop` job and the source that materializes it (7.3, 8.1,
 * 10.2, 13.1, invariant 3).
 *
 * Three lanes built a terminal stop and none of them could finish it, because the
 * process that performs one did not exist yet when they were written:
 *
 *   * **G3a** committed `opportunity.terminal_stop` and `opportunity.manual_mode` into
 *     `crm_domain_events` with the stage change, and said in
 *     `docs/decisions/g3a-domain-event-outbox.md` that "until G8 subscribes, closing
 *     an opportunity stops no enrollment".
 *   * **G8** wrote the subscriber, `consumeTerminalStops`, and nothing called it.
 *   * **G4** wrote the `suppression_finalizations` marker and said "the sequences lane
 *     subscribes to this marker"; nothing did.
 *
 * This is the caller. It drains both streams in one transaction for one workspace,
 * because both end with the same statement pair — `stopEnrollments` — and a job that
 * did half would leave the other half owed with no signal that anything had happened.
 *
 * ## Why `business_uniqueness`, and why that is honest
 *
 * `stopEnrollments` matches `ended_at IS NULL`, the outbox cursor advances in the same
 * transaction as the stops it made, and the marker reader's work *is* the set of live
 * enrollments a suppression still covers. So a second run of this job stops nothing a
 * second time, and a stolen lease rolls the whole thing back with the failed
 * completion. Nothing here reaches outside PostgreSQL, so there is no fence to keep.
 *
 * ## One job per workspace, not one per firm
 *
 * The brief asked for one firm per job. The cursor is what makes that impossible
 * without a migration this lane may not write: `sequence_event_cursors.subscriber` is
 * a text column whose CHECK is `^[a-z][a-z0-9_.]{2,63}$`, which a uuid's hyphens do
 * not satisfy, so a per-firm cursor has nowhere to live. Draining per workspace under
 * one cursor is what the table the previous lane built supports. See
 * `docs/decisions/g15-the-worker-drains-what-the-lanes-left.md`.
 */
export function terminalStopJobHandler(
  options: { readonly maxAttempts?: number; readonly leaseSeconds?: number; readonly limit?: number } = {},
): JobHandler {
  return {
    kind: 'sequence.terminal_stop',
    protection: 'business_uniqueness',
    // The ladder's default (docs/decisions/g5-retry-ladder.md). A stop that keeps
    // failing is an enrollment still sending to a firm that said no, so four attempts
    // over four minutes and then a dead job somebody is told about is the right shape.
    maxAttempts: options.maxAttempts ?? 4,
    leaseSeconds: options.leaseSeconds ?? 60,
    handle: async input => {
      const context = repositoryContext(input.scope, input.session);
      const limit = options.limit ?? 200;
      // The runner has already opened the transaction a `business_uniqueness` handler
      // runs in, so both drains and the cursor advance commit with the completion.
      await consumeTerminalStops(context, { limit });
      await consumeSuppressionStops(context, { limit });
    },
  };
}

/**
 * The due-work source (13.1).
 *
 * Unlike `retentionSource`, this one materializes nothing for a workspace with nothing
 * owed. A job a minute per workspace would be a queue of no-ops and an `oldest
 * runnable job` figure that meant nothing; the price is that the source has to know
 * what is outstanding, which `readTerminalStopWork` answers in one statement over the
 * two streams.
 *
 * The key is the pair of stream heads. It advances only when a drain succeeded, so:
 * a repeated pass over unchanged state inserts nothing; a new close or a new
 * finalization moves a head and inserts one job; and a job that exhausted its attempts
 * keeps its key, so the work waits for the audited admin requeue 13.2 requires rather
 * than filling the dead-job list with one row a minute.
 *
 * One read per workspace rather than one across all of them, because the index that
 * exists on the outbox leads with `workspace_id` and 13.1 asks for indexed queries.
 * `retentionSource` walks the workspace list the same way.
 */
export function terminalStopSource(): DueWorkSource {
  return {
    name: 'terminal-stop',
    find: async (session: SessionQueryable): Promise<readonly JobSpecification[]> => {
      const { rows } = await session.query<{ id: string }>('SELECT id FROM workspaces ORDER BY id');
      const specifications: JobSpecification[] = [];
      for (const workspace of rows) {
        const work = await readTerminalStopWork(session, workspace.id);
        if (work === null) continue;
        specifications.push({
          workspaceId: workspace.id,
          kind: 'sequence.terminal_stop',
          idempotencyKey: jobIdempotencyKey.terminalStop(work.outboxHead, work.markerHead),
          payload: { outboxHead: work.outboxHead, markerHead: work.markerHead },
          maxAttempts: 4,
        });
      }
      return specifications;
    },
  };
}
