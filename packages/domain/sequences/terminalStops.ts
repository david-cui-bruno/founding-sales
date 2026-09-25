import type { Queryable } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { MANUAL_MODE_ORIGINS, type ManualModeOrigin } from '../crm/events.ts';
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
 *
 * ## Two kinds, not one (lane G15)
 *
 * 8.1's close is `opportunity.terminal_stop`. 7.3's other half — manual is entered by
 * a confirmed human email reply, an engaged call outcome or a direct Gmail send, and
 * "current active enrollments end terminally" — is
 * `opportunity.manual_mode`, and until lane G15 nothing acted on that either, so a
 * confirmed reply set the control mode and left the sequence running. Invariant 3 says
 * it must not, so this consumer reads both kinds.
 *
 * The end reason for a manual-mode stop is the event's own origin (lane G22).
 * `setManualControlMode` writes one of `MANUAL_MODE_ORIGINS` into
 * `crm_domain_events.detail.origin`, so an engaged call ends its enrollments
 * `engaged_call` and a direct Gmail send ends them `direct_send`, which is what 7.3's
 * ways in and `ENROLLMENT_END_REASONS`' first members have always meant.
 * `manualModeEndReason` is the map, and an event with no origin — every one written
 * before this lane — still reads as `human_reply`, which is exactly what G15 recorded,
 * so no existing reader changes its answer.
 * `docs/decisions/g22-the-manual-mode-origin.md` records it.
 *
 * ## The second stream: G4's finalization marker
 *
 * `suppression_finalizations` with `outcome = 'finalized'` is Appendix C's "terminal
 * marker", and migration 0006 says in as many words that "an event with an `outcome =
 * 'finalized'` row is one whose terminal stops are owed". `consumeSuppressionStops`
 * is the reader. It has no cursor, and deliberately: the marker's `event_id` is a
 * sha256 hex string and `sequence_event_cursors.last_event_id` is a uuid, so there is
 * no keyset to store without a migration this lane may not write. What it uses
 * instead is stronger — the work *is* the set of live enrollments a still-effective
 * suppression covers, so a marker whose stops have happened offers nothing, and an
 * enrollment created after a suppression is stopped rather than missed.
 */

export const TERMINAL_STOP_SUBSCRIBER = 'sequences.terminal_stop';

/**
 * The outbox kinds that end an enrollment terminally (7.3, 8.1).
 *
 * `opportunity.reopened` is deliberately absent: 8.1 says a reopen "never silently
 * restarts old automation", which is a statement about what must *not* start, and a
 * reopened opportunity has no live enrollment to stop.
 */
export const TERMINAL_STOP_EVENT_KINDS = [
  'opportunity.terminal_stop',
  'opportunity.manual_mode',
] as const;

export interface TerminalStopReport {
  readonly eventsConsumed: number;
  readonly enrollmentsStopped: number;
  readonly executionsCancelled: number;
}

interface EventDbRow {
  readonly id: string;
  readonly occurred_at: Date;
  readonly event_kind: string;
  readonly firm_id: string;
  readonly opportunity_id: string | null;
  /** `detail->>'origin'` for a manual-mode event; null for every other kind. */
  readonly origin: string | null;
  readonly [column: string]: unknown;
}

const MANUAL_MODE_END_REASONS: Readonly<Record<ManualModeOrigin, EnrollmentEndReason>> = Object.freeze({
  human_reply: 'human_reply',
  engaged_call: 'engaged_call',
  direct_send: 'direct_send',
  // A person inside the workspace deciding, which is not one of 7.3's prospect
  // signals: the vocabulary reserves its first four members for those.
  salesperson_command: 'admin_stop',
});

const KNOWN_ORIGINS: ReadonlySet<string> = new Set(MANUAL_MODE_ORIGINS);

/**
 * The end reason one manual-mode event gives the enrollments it stops.
 *
 * An absent or unrecognised origin is `human_reply`, and deliberately: every
 * `opportunity.manual_mode` row written before lane G22 carries no origin, and
 * `human_reply` is the reason lane G15 recorded for all of them. A drain that refused
 * such an event would leave a sequence running after a firm had said no, which is the
 * one outcome invariant 3 forbids.
 */
export function manualModeEndReason(origin: string | null | undefined): EnrollmentEndReason {
  if (origin === null || origin === undefined) return 'human_reply';
  if (!KNOWN_ORIGINS.has(origin)) return 'human_reply';
  return MANUAL_MODE_END_REASONS[origin as ManualModeOrigin];
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
    `SELECT id, occurred_at, event_kind, firm_id, opportunity_id, detail->>'origin' AS origin
       FROM crm_domain_events
      WHERE workspace_id = $1
        AND event_kind = ANY($5::text[])
        AND ($2::timestamptz IS NULL OR (occurred_at, id) > ($2::timestamptz, $3::uuid))
      ORDER BY occurred_at, id
      LIMIT $4`,
    [
      context.scope.workspaceId,
      cursor.last_event_at,
      cursor.last_event_id,
      Math.trunc(options.limit ?? 200),
      [...TERMINAL_STOP_EVENT_KINDS],
    ],
  );
  if (events.length === 0) {
    return { eventsConsumed: 0, enrollmentsStopped: 0, executionsCancelled: 0 };
  }

  let enrollmentsStopped = 0;
  let executionsCancelled = 0;
  for (const event of events) {
    // 7.3's manual paragraph is firm-wide — "terminally stop every active enrollment
    // for the firm across contacts", which Appendix A's "Confirm human reply" row
    // repeats as "all firm enrollments" — while 8.1's close is about one opportunity.
    // G15 scoped both to the opportunity, which every `opportunity.%` event names, so
    // an enrollment still live against a firm's earlier closed opportunity survived a
    // reply that said no. Lane G22 widened the manual arm to the firm, which is the
    // sentence, and is a widening only ever in the safe direction.
    const manual = event.event_kind === 'opportunity.manual_mode';
    const reason = manual
      ? manualModeEndReason(event.origin)
      : await endReasonFor(context, event.opportunity_id);
    const stopped = await stopEnrollments(context, {
      ...(manual || event.opportunity_id === null
        ? { firmId: event.firm_id }
        : { opportunityId: event.opportunity_id }),
      reason,
      cancelReason: 'terminal_stop',
    });
    await auditStops(context, stopped.enrollmentIds, reason, event.event_kind);
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

/**
 * The terminal stop a manual-mode transition owes, applied by the caller that caused
 * it (7.3, Appendix A "Confirm human reply", lane G22).
 *
 * 7.3 does not describe this as background work. "A confirmed human reply performs
 * **one transaction**: record and classify the message; set manual; terminally stop
 * every active enrollment for the firm across contacts; cancel unclaimed executions;
 * ... and write the audit event." Appendix A's row is the same list under "commits
 * together". Lane G15's drain was the first thing that stopped these enrollments at
 * all, and it is still the net; but a stop that waits for the next one-minute pass
 * leaves the sequence live in the meantime, and a pass that fails for a reason of its
 * own — another workspace event in the same batch, the suppression-marker half of the
 * same job — rolls the stop back with it.
 *
 * So the command calls this inside its own transaction, and the drain does the same
 * work for the origins nobody committed at the source. Running both is safe and is the
 * point: `stopEnrollments` matches `ended_at IS NULL`, so the second pass finds
 * nothing live, stops nothing and audits nothing. The idempotence is keyed on the
 * event — the drain's cursor is a keyset on `(occurred_at, id)` and never re-reads a
 * consumed row — and backed by the enrollment's own end, which no replay can undo.
 */
export async function applyManualModeStop(
  context: RepositoryContext,
  input: {
    readonly firmId: string;
    readonly origin: ManualModeOrigin;
    /** What the audit detail calls the cause. The drain uses the event kind. */
    readonly cause?: string | undefined;
  },
): Promise<{ readonly enrollmentsStopped: number; readonly executionsCancelled: number }> {
  const reason = manualModeEndReason(input.origin);
  const stopped = await stopEnrollments(context, {
    firmId: input.firmId,
    reason,
    cancelReason: 'terminal_stop',
  });
  await auditStops(context, stopped.enrollmentIds, reason, input.cause ?? 'opportunity.manual_mode');
  return {
    enrollmentsStopped: stopped.enrollmentsStopped,
    executionsCancelled: stopped.executionsCancelled,
  };
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

/**
 * One audit event per enrollment this consumer ended (5.2, Appendix A).
 *
 * `stopEnrollments` writes none, and it should not: it is called by the API's own
 * command and by the enrollment's own completion, each of
 * which audits its own action under its own name. What is audited here is the
 * *consumption* — the moment the worker acted on a signal somebody else committed —
 * and `detail` is identifiers and codes, never a note or a name.
 */
async function auditStops(
  context: RepositoryContext,
  enrollmentIds: readonly string[],
  reason: EnrollmentEndReason,
  cause: string,
): Promise<void> {
  for (const enrollmentId of enrollmentIds) {
    await recordCrmAuditEvent(context, {
      action: 'enrollment.terminally_stopped',
      subjectKind: 'sequence_enrollment',
      subjectId: enrollmentId,
      detail: { reason, cause },
    });
  }
}

export interface SuppressionStopReport {
  readonly markersConsumed: number;
  readonly enrollmentsStopped: number;
  readonly executionsCancelled: number;
}

/** 10.2's prospect-originated sources, which are terminal the moment they commit. */
const PROSPECT_SOURCES: ReadonlySet<string> = new Set(['prospect_opt_out', 'prospect_do_not_call']);

/**
 * The end reason a finalized suppression gives the enrollments it covers.
 *
 * A firm-wide do-not-contact is `firm_suppressed`, which is the fact itself. A handle
 * a prospect asked to stop is `opt_out`. A handle a salesperson suppressed and did not
 * correct inside the ten minutes is neither — the vocabulary reserves its first four
 * members for prospect signals — so it is `admin_stop`, the member that means somebody
 * inside decided.
 */
function suppressionEndReason(scope: string, source: string): EnrollmentEndReason {
  if (scope === 'firm') return 'firm_suppressed';
  return PROSPECT_SOURCES.has(source) ? 'opt_out' : 'admin_stop';
}

/**
 * The live enrollments a still-effective finalized suppression covers.
 *
 * The handle arm is `suppressionSource()`'s query in `eligibility.ts`, on purpose: the
 * set of enrollments a handle suppression stops must be the set the eligibility read
 * refuses, or a step would be held for a reason no stop ever acted on.
 * `effective_suppressions` rather than `suppression_events` because 10.2 makes that
 * view authoritative, and an event an admin superseded before this sweep ran is no
 * longer a reason to stop anything.
 */
const OUTSTANDING_SUPPRESSION_STOPS = `
  SELECT f.workspace_id, f.event_id, f.decided_at, e.scope, e.source, n.id AS enrollment_id
    FROM suppression_finalizations f
    JOIN effective_suppressions e
      ON e.workspace_id = f.workspace_id AND e.event_id = f.event_id
    JOIN sequence_enrollments n
      ON n.workspace_id = f.workspace_id
     AND n.ended_at IS NULL
     AND (
       (e.scope = 'firm' AND e.canonical_key = n.firm_id::text)
       OR (e.scope = 'handle' AND EXISTS (
             SELECT 1 FROM email_addresses a
              WHERE a.workspace_id = n.workspace_id AND a.contact_id = n.contact_id
                AND a.address = e.canonical_key
             UNION ALL
             SELECT 1 FROM phone_routes p
              WHERE p.workspace_id = n.workspace_id AND p.contact_id = n.contact_id
                AND p.e164 = e.canonical_key
           ))
     )
   WHERE f.outcome = 'finalized'`;

/**
 * Stop what the finalization markers still owe, for one workspace.
 *
 * Idempotent by construction rather than by a cursor: every row it reads names a live
 * enrollment, and stopping one removes it from the read. Running twice does the work
 * once, and a crash between two stops leaves the rest owed rather than lost.
 */
export async function consumeSuppressionStops(
  context: RepositoryContext,
  options: { readonly limit?: number } = {},
): Promise<SuppressionStopReport> {
  const { rows } = await context.db.query<{
    event_id: string;
    scope: string;
    source: string;
    enrollment_id: string;
  }>(
    `SELECT event_id, scope, source, enrollment_id
       FROM (${OUTSTANDING_SUPPRESSION_STOPS}) AS owed
      WHERE owed.workspace_id = $1
      ORDER BY owed.decided_at, owed.event_id, owed.enrollment_id
      LIMIT $2`,
    [context.scope.workspaceId, Math.trunc(options.limit ?? 200)],
  );
  if (rows.length === 0) {
    return { markersConsumed: 0, enrollmentsStopped: 0, executionsCancelled: 0 };
  }

  const markers = new Set<string>();
  let enrollmentsStopped = 0;
  let executionsCancelled = 0;
  for (const row of rows) {
    markers.add(row.event_id);
    const reason = suppressionEndReason(row.scope, row.source);
    // One enrollment at a time, because the covering key differs per row: a firm
    // suppression covers the firm and a handle suppression covers whichever contacts
    // hold that handle, and only the enrollment id says both at once.
    const stopped = await stopEnrollments(context, {
      enrollmentId: row.enrollment_id,
      reason,
      cancelReason: 'suppression_finalized',
    });
    await auditStops(context, stopped.enrollmentIds, reason, 'suppression.finalized');
    enrollmentsStopped += stopped.enrollmentsStopped;
    executionsCancelled += stopped.executionsCancelled;
  }
  return { markersConsumed: markers.size, enrollmentsStopped, executionsCancelled };
}

/** The head of each terminal-stop stream a workspace has not consumed. */
export interface TerminalStopWork {
  /** The oldest unconsumed outbox event, or null when the cursor has caught up. */
  readonly outboxHead: string | null;
  /** The oldest finalized suppression whose stops are still owed, or null. */
  readonly markerHead: string | null;
}

/**
 * What one workspace owes, for the one-minute pass (13.1), or null when it owes
 * nothing.
 *
 * Per workspace rather than across all of them, because 13.1 says the pass "finds due
 * work through indexed queries" and the index that exists is
 * `crm_domain_events_by_kind (workspace_id, event_kind, occurred_at)` — leading column
 * `workspace_id`. A single statement over every workspace at once cannot use it and
 * would sequentially scan the outbox every minute for ever. `suppression_finalizations`
 * is the same shape: its primary key is `(workspace_id, event_id)`.
 *
 * A workspace that owes nothing returns null and materializes no job, which is what
 * keeps this source from filling the queue with no-ops. The two heads become the job's
 * idempotency key, so the pass inserts one job per distinct state of the two streams,
 * and the next pass over an unchanged state inserts nothing.
 */
export async function readTerminalStopWork(
  db: Queryable,
  workspaceId: string,
): Promise<TerminalStopWork | null> {
  const { rows } = await db.query<{ outbox_head: string | null; marker_head: string | null }>(
    `WITH outbox AS (
       SELECT e.id::text AS head
         FROM crm_domain_events e
         LEFT JOIN sequence_event_cursors c
           ON c.workspace_id = e.workspace_id AND c.subscriber = $2
        WHERE e.workspace_id = $1
          AND e.event_kind = ANY($3::text[])
          AND (c.last_event_at IS NULL
               OR (e.occurred_at, e.id) > (c.last_event_at, c.last_event_id))
        ORDER BY e.occurred_at, e.id
        LIMIT 1
     ),
     markers AS (
       SELECT owed.event_id AS head
         FROM (${OUTSTANDING_SUPPRESSION_STOPS}) AS owed
        WHERE owed.workspace_id = $1
        ORDER BY owed.decided_at, owed.event_id
        LIMIT 1
     )
     SELECT (SELECT head FROM outbox) AS outbox_head,
            (SELECT head FROM markers) AS marker_head`,
    [workspaceId, TERMINAL_STOP_SUBSCRIBER, [...TERMINAL_STOP_EVENT_KINDS]],
  );
  const row = rows[0];
  if (row === undefined) return null;
  if (row.outbox_head === null && row.marker_head === null) return null;
  return { outboxHead: row.outbox_head, markerHead: row.marker_head };
}
