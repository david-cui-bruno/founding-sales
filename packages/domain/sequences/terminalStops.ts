import type { RepositoryContext } from '../db/workspaceScope.ts';
import { stopEnrollments } from './enrollments.ts';
import type { EnrollmentEndReason } from './types.ts';

/**
 * Subscribing to the CRM's terminal-stop outbox (specification 8.1, 7.3,
 * `docs/decisions/g3a-domain-event-outbox.md`).
 *
 * Section 8.1: "Closing an opportunity stops its active enrollments." Lane G3a wrote
 * the signal — an `opportunity.terminal_stop` row in `crm_domain_events`, committed
 * in the transaction that changed the stage — and said plainly that until this lane
 * subscribes, closing an opportunity stops nothing. This is the subscription.
 *
 * ## Why this reads the table rather than calling `readCrmDomainEvents`
 *
 * The outbox's reader takes a single timestamp as its high-water mark and compares
 * with `>`. Two events written in one transaction share `now()` to the microsecond,
 * so a timestamp-only cursor either skips the second of a pair or re-reads the pair
 * forever. The outbox's own ordering is `(occurred_at, id)`, and a cursor that
 * matches it exactly is a row-value comparison on the same pair — which is what this
 * file does. Nothing about the table changes; this is the keyset form of the same
 * read, and `docs/decisions/g8-outbox-cursor.md` records why.
 *
 * Re-reading would be harmless anyway: `stopEnrollments` only touches enrollments
 * whose `ended_at IS NULL`, so a second consumption of the same event stops nothing a
 * second time. The cursor is an optimisation over an idempotent operation, which is
 * the right way round.
 *
 * ## What a stop means here
 *
 * The end reason comes from the opportunity's own status rather than from the event's
 * payload, because the status is the fact and the payload is a description of it. An
 * opportunity the signal says closed but the pipeline says is open is recorded as
 * `admin_stop`: something asked for a terminal stop that the pipeline does not
 * corroborate, and inventing `stage_lost` for it would put a reason in the history
 * that never happened.
 */

export const TERMINAL_STOP_SUBSCRIBER = 'sequences.terminal_stop';

export interface TerminalStopReport {
  readonly eventsConsumed: number;
  readonly enrollmentsStopped: number;
  readonly executionsCancelled: number;
}

interface EventDbRow {
  readonly id: string;
  readonly occurred_at: Date;
  readonly firm_id: string;
  readonly opportunity_id: string | null;
  readonly [column: string]: unknown;
}

/**
 * Consume every terminal stop this workspace has not acted on yet.
 *
 * The cursor advances in the same transaction as the stops, so a crash between the
 * two is a replay rather than a loss, and a replay is a no-op.
 */
export async function consumeTerminalStops(
  context: RepositoryContext,
  options: { readonly limit?: number } = {},
): Promise<TerminalStopReport> {
  const { rows: cursors } = await context.db.query<{
    last_event_at: Date | null;
    last_event_id: string | null;
  }>(
    `SELECT last_event_at, last_event_id FROM sequence_event_cursors
      WHERE workspace_id = $1 AND subscriber = $2 FOR UPDATE`,
    [context.scope.workspaceId, TERMINAL_STOP_SUBSCRIBER],
  );
  const cursor = cursors[0] ?? { last_event_at: null, last_event_id: null };

  const { rows: events } = await context.db.query<EventDbRow>(
    `SELECT id, occurred_at, firm_id, opportunity_id
       FROM crm_domain_events
      WHERE workspace_id = $1
        AND event_kind = 'opportunity.terminal_stop'
        AND ($2::timestamptz IS NULL OR (occurred_at, id) > ($2::timestamptz, $3::uuid))
      ORDER BY occurred_at, id
      LIMIT $4`,
    [
      context.scope.workspaceId,
      cursor.last_event_at,
      cursor.last_event_id,
      Math.trunc(options.limit ?? 200),
    ],
  );
  if (events.length === 0) {
    return { eventsConsumed: 0, enrollmentsStopped: 0, executionsCancelled: 0 };
  }

  let enrollmentsStopped = 0;
  let executionsCancelled = 0;
  for (const event of events) {
    const reason = await endReasonFor(context, event.opportunity_id);
    const stopped = await stopEnrollments(context, {
      ...(event.opportunity_id === null
        ? { firmId: event.firm_id }
        : { opportunityId: event.opportunity_id }),
      reason,
      cancelReason: 'terminal_stop',
    });
    enrollmentsStopped += stopped.enrollmentsStopped;
    executionsCancelled += stopped.executionsCancelled;
  }

  const last = events[events.length - 1];
  if (last !== undefined) {
    await context.db.query(
      `INSERT INTO sequence_event_cursors (workspace_id, subscriber, last_event_at, last_event_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, subscriber)
         DO UPDATE SET last_event_at = EXCLUDED.last_event_at,
                       last_event_id = EXCLUDED.last_event_id,
                       updated_at = now()`,
      [context.scope.workspaceId, TERMINAL_STOP_SUBSCRIBER, last.occurred_at, last.id],
    );
  }

  return { eventsConsumed: events.length, enrollmentsStopped, executionsCancelled };
}

async function endReasonFor(
  context: RepositoryContext,
  opportunityId: string | null,
): Promise<EnrollmentEndReason> {
  if (opportunityId === null) return 'admin_stop';
  const { rows } = await context.db.query<{ status: string }>(
    'SELECT status FROM opportunities WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, opportunityId],
  );
  const status = rows[0]?.status;
  if (status === 'won') return 'stage_won';
  if (status === 'lost') return 'stage_lost';
  return 'admin_stop';
}
