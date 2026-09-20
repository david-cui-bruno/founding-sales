import { archiveCompletedPayloads } from '../jobs/jobStore.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { RetentionLedgerKind } from './kinds.ts';

/**
 * One retention target per kind (specification 10.3, Appendix C, Appendix G 41).
 *
 * A target says four things: which kind of the retention table it is, which tables
 * that kind lives in, what state it is in, and — when it is implemented — how to
 * sweep it. It is a registry rather than a `switch` because three other lanes are in
 * flight and each owns a table this lane has a horizon for but no code for, and a
 * `switch` with no case for them says nothing at all. A registry with a
 * `declared_pending` entry says it out loud, and `PENDING_RETENTION_TABLES` below
 * makes the build fail the moment one of those tables lands.
 *
 * The four states:
 *
 * | State | Meaning |
 * |---|---|
 * | `implemented` | The tables are on main and this lane sweeps them. |
 * | `retained` | 10.3 keeps this kind, so the job proves a no-op rather than skipping. |
 * | `external` | The horizon is enforced outside the database — CloudWatch, RDS. |
 * | `declared_pending` | The table belongs to a lane still in flight. |
 *
 * `retained` is a state rather than an absence for the reason the brief gives it:
 * "audit events 7 years (a no-op job that asserts nothing deletes them earlier);
 * suppression tombstones and history indefinite (a test that no retention job can
 * touch them)". A kind nobody swept because nobody wrote a target looks exactly like
 * a kind somebody decided not to sweep, and only one of those is safe.
 */

export type RetentionTargetState = 'implemented' | 'retained' | 'external' | 'declared_pending';

export interface RetentionSweepInput {
  /** Database time, read by the caller. */
  readonly now: string;
  /** The policy's boundary, or null when the policy states no interval. */
  readonly boundaryAt: string | null;
  readonly limit: number;
}

export interface RetentionSweepResult {
  /** The instant this sweep actually deleted up to. Recorded in the ledger. */
  readonly boundaryAt: string;
  readonly rowsDeleted: number;
  readonly rowsRedacted: number;
  readonly detail: Readonly<Record<string, number>>;
}

export interface RetentionTarget {
  readonly dataKind: RetentionLedgerKind;
  readonly state: RetentionTargetState;
  /** The tables this kind lives in. Never an append-only one. */
  readonly tables: readonly string[];
  /** Non-null only for `implemented`; the registry test asserts both directions. */
  readonly sweep: ((context: RepositoryContext, input: RetentionSweepInput) => Promise<RetentionSweepResult>) | null;
  /** Why this state, in one sentence a reader of the ledger can act on. */
  readonly note: string;
}

/** A bounded batch, so one sweep cannot hold a long transaction over a large table. */
export const RETENTION_BATCH_LIMIT = 500;

/**
 * 13.2's operational window for a completed job payload, in days.
 *
 * `docs/decisions/g5-payload-archival.md` left it to the caller and defaulted to
 * seven, matching the shortest horizon in the 10.3 table. This lane is that caller
 * and keeps the number, so archival and the raw-MIME rule expire together.
 */
export const JOB_PAYLOAD_WINDOW_DAYS = 7;

const empty = (boundaryAt: string): RetentionSweepResult => ({
  boundaryAt,
  rowsDeleted: 0,
  rowsRedacted: 0,
  detail: {},
});

function requireBoundary(input: RetentionSweepInput, dataKind: string): string {
  if (input.boundaryAt === null) {
    // The policy row exists — `runRetentionBatch` checked — but states no interval.
    // Guessing one is exactly what a retention job must never do.
    throw new Error(`the ${dataKind} retention policy states no interval, so there is no boundary to sweep to`);
  }
  return input.boundaryAt;
}

/**
 * Unmatched Gmail metadata, 30 days (10.3).
 *
 * The delete is of `mail_messages` rows that never matched. Their bodies, matches,
 * classifications and effects go with them through the `ON DELETE CASCADE` migration
 * 0009 put on each, which is the right shape: a body without its message is not a
 * thing 12.3 has a name for. A matched message is untouched whatever its age —
 * 10.3 keeps it "with business correspondence".
 */
const unmatchedGmailMetadata: RetentionTarget = {
  dataKind: 'unmatched_gmail_metadata',
  state: 'implemented',
  tables: ['mail_messages', 'mail_message_bodies'],
  note: 'Unmatched Gmail metadata is deleted thirty days after it was recorded; matched correspondence is not.',
  sweep: async (context, input) => {
    const boundaryAt = requireBoundary(input, 'unmatched_gmail_metadata');
    const { rowCount } = await context.db.query(
      `DELETE FROM mail_messages
        WHERE (workspace_id, id) IN (
          SELECT workspace_id, id FROM mail_messages
           WHERE workspace_id = $1 AND NOT matched AND recorded_at < $2::timestamptz
           ORDER BY recorded_at
           LIMIT $3
        )`,
      [context.scope.workspaceId, boundaryAt, input.limit],
    );
    const deleted = rowCount ?? 0;
    return { boundaryAt, rowsDeleted: deleted, rowsRedacted: 0, detail: { mail_messages: deleted } };
  },
};

/**
 * Raw MIME and temporary mailbox material, at most seven days (10.3, Appendix F).
 *
 * There is no raw MIME in this database and migration 0009 says why — "there is no
 * raw MIME column: 10.3 gives raw MIME at most seven days, and this table is not
 * where a seven-day thing lives". What does exist under this horizon is the
 * temporary mailbox material Appendix F puts in the mailbox owner's visibility
 * class: the Pub/Sub notifications the webhook deduplicated against, and the
 * completed recovery runs. Both are diagnostics about one person's mailbox, neither
 * is business correspondence, and both name a prospect's activity indirectly.
 *
 * A recovery still running is left alone however old it is. Deleting the row a
 * `mail.recover` job is writing to would lose the coverage proof that holds the
 * mailbox's automation, and 4.2 clears that hold "only after complete coverage is
 * proven".
 */
const rawMime: RetentionTarget = {
  dataKind: 'raw_mime',
  state: 'implemented',
  tables: ['gmail_push_notifications', 'mailbox_recoveries'],
  note: 'Temporary mailbox material — push notifications and completed recovery runs — is deleted after seven days; FSS stores no raw MIME at all.',
  sweep: async (context, input) => {
    const boundaryAt = requireBoundary(input, 'raw_mime');
    const notifications = await context.db.query(
      `DELETE FROM gmail_push_notifications
        WHERE (workspace_id, id) IN (
          SELECT workspace_id, id FROM gmail_push_notifications
           WHERE workspace_id = $1 AND received_at < $2::timestamptz
           ORDER BY received_at
           LIMIT $3
        )`,
      [context.scope.workspaceId, boundaryAt, input.limit],
    );
    const recoveries = await context.db.query(
      `DELETE FROM mailbox_recoveries
        WHERE (workspace_id, id) IN (
          SELECT workspace_id, id FROM mailbox_recoveries
           WHERE workspace_id = $1 AND completed_at IS NOT NULL AND completed_at < $2::timestamptz
           ORDER BY completed_at
           LIMIT $3
        )`,
      [context.scope.workspaceId, boundaryAt, input.limit],
    );
    const pushes = notifications.rowCount ?? 0;
    const recovered = recoveries.rowCount ?? 0;
    return {
      boundaryAt,
      rowsDeleted: pushes + recovered,
      rowsRedacted: 0,
      detail: { gmail_push_notifications: pushes, mailbox_recoveries: recovered },
    };
  },
};

/**
 * Research evidence, "with the firm while provider terms permit" (10.3, 7.4).
 *
 * The horizon is per item rather than per workspace: migration 0004 requires an
 * evidence item whose provider terms forbid retention to carry
 * `retention_expires_at`, and G10 computes it from the provider's reviewed
 * `retention_days`. So the boundary this sweep uses is database time, and the
 * predicate is the item's own expiry. An item whose terms permit retention has no
 * expiry and stays with the firm, which is the sentence.
 *
 * A research suggestion pointing at an expiring item has its pointer cleared first:
 * the suggestion is Callie's own proposal and outlives the provider's copy, and the
 * foreign key would otherwise refuse the delete.
 */
const researchEvidence: RetentionTarget = {
  dataKind: 'research_evidence',
  state: 'implemented',
  tables: ['evidence_items', 'research_suggestions'],
  note: 'Evidence whose provider terms have expired is deleted at its own expiry; evidence whose terms permit retention stays with the firm.',
  sweep: async (context, input) => {
    const expiring = await context.db.query<{ id: string }>(
      `SELECT id FROM evidence_items
        WHERE workspace_id = $1 AND retention_expires_at IS NOT NULL AND retention_expires_at < $2::timestamptz
        ORDER BY retention_expires_at
        LIMIT $3`,
      [context.scope.workspaceId, input.now, input.limit],
    );
    const ids = expiring.rows.map(row => row.id);
    if (ids.length === 0) return empty(input.now);

    const cleared = await context.db.query(
      'UPDATE research_suggestions SET evidence_id = NULL WHERE workspace_id = $1 AND evidence_id = ANY($2::uuid[])',
      [context.scope.workspaceId, ids],
    );
    const deleted = await context.db.query(
      'DELETE FROM evidence_items WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
      [context.scope.workspaceId, ids],
    );
    return {
      boundaryAt: input.now,
      rowsDeleted: deleted.rowCount ?? 0,
      rowsRedacted: cleared.rowCount ?? 0,
      detail: { evidence_items: deleted.rowCount ?? 0, research_suggestions: cleared.rowCount ?? 0 },
    };
  },
};

/**
 * Completed job payloads after the operational window (13.2).
 *
 * G5 wrote the function and deliberately did not schedule it: "the `retention.batch`
 * job kind that calls it on a cadence belongs to the retention lane". This is that
 * cadence. Archival redacts the payload in place and leaves the row, so the dedupe
 * key survives its horizon — which is why this target deletes nothing and reports
 * its work as redaction.
 */
const jobPayloads: RetentionTarget = {
  dataKind: 'job_payloads',
  state: 'implemented',
  tables: ['jobs'],
  note: 'A completed job payload is redacted in place seven days after completion; the row and its idempotency key stay, because the dedupe is what stops duplicate work.',
  sweep: async (context, input) => {
    const seconds = JOB_PAYLOAD_WINDOW_DAYS * 24 * 60 * 60;
    const boundaryAt = new Date(Date.parse(input.now) - seconds * 1000).toISOString();
    const archived = await archiveCompletedPayloads(
      { query: context.db.query.bind(context.db) },
      { olderThanSeconds: seconds, limit: input.limit },
    );
    return { boundaryAt, rowsDeleted: 0, rowsRedacted: archived, detail: { jobs: archived } };
  },
};

const retained = (
  dataKind: RetentionLedgerKind,
  tables: readonly string[],
  note: string,
): RetentionTarget => ({ dataKind, state: 'retained', tables, sweep: null, note });

const external = (dataKind: RetentionLedgerKind, note: string): RetentionTarget => ({
  dataKind,
  state: 'external',
  tables: [],
  sweep: null,
  note,
});

export const RETENTION_TARGETS: readonly RetentionTarget[] = Object.freeze([
  retained(
    'business_records',
    [],
    'Firms, contacts, opportunities, stages, notes and callbacks are kept until a documented admin deletion; no scheduled job removes them.',
  ),
  retained(
    'suppression_history',
    [],
    'Suppression events and their history are kept indefinitely, and UPDATE and DELETE on the table are revoked from both application roles.',
  ),
  retained(
    'audit_events',
    [],
    'Audit events are kept seven years and no application code path may remove one: UPDATE, DELETE and TRUNCATE are revoked from both roles.',
  ),
  researchEvidence,
  unmatchedGmailMetadata,
  rawMime,
  retained(
    'matched_message_body',
    [],
    'A matched message body is kept with the business correspondence it belongs to, so its horizon is the firm record’s and not a clock.',
  ),
  {
    dataKind: 'canceled_drafts',
    state: 'declared_pending',
    tables: ['outbound_messages'],
    sweep: null,
    note: 'Cancelled or deleted unsent drafts get thirty days, and the rows are lane G7-2’s outbound fences, which are not on main yet.',
  },
  external(
    'operational_logs',
    'Operational application logs are CloudWatch log groups with ninety-day retention (infra/modules/observability); the application stores no log rows.',
  ),
  external(
    'database_backups',
    'Point-in-time backups are the RDS instance’s own thirty-five-day retention (infra/modules/database); nothing in the application can reach them.',
  ),
  jobPayloads,
]);

const BY_KIND: ReadonlyMap<string, RetentionTarget> = new Map(
  RETENTION_TARGETS.map(target => [target.dataKind, target]),
);

export function retentionTargetFor(dataKind: string): RetentionTarget | undefined {
  return BY_KIND.get(dataKind);
}

/**
 * The tables a lane still in flight will bring, and what each of them will owe.
 *
 * `test/retention/targets.test.ts` asks the live catalog for each of these and fails
 * when one exists. That is the whole point: three lanes are landing beside this one,
 * each brings a table with a retention or a departure obligation, and the obligation
 * is invisible until the table is there. A list nobody checks is a comment; a list
 * the build checks is a deadline.
 */
export interface PendingRetentionTable {
  readonly table: string;
  readonly lane: string;
  readonly owes: string;
}

export const PENDING_RETENTION_TABLES: readonly PendingRetentionTable[] = Object.freeze([
  {
    table: 'outbound_messages',
    lane: 'G7-2',
    owes: 'the canceled_drafts target: 10.3 gives a cancelled or deleted unsent draft thirty days, and a held or cancelled fence carries the rendered envelope of a message to a prospect.',
  },
  {
    table: 'enrollments',
    lane: 'G8',
    owes: 'the departure command must hold the departed member’s enrollments for reassignment, and the deletion workflow must terminally stop a deleted firm’s rather than leave them due.',
  },
  {
    table: 'step_executions',
    lane: 'G8',
    owes: 'the deletion workflow must cancel a deleted firm’s unexecuted steps, because an execution whose contact has been erased would otherwise still be claimed by a worker.',
  },
  {
    table: 'reply_classifications',
    lane: 'G7b',
    owes: 'the classifier’s stored output names the excerpt it reasoned over, so it follows the message under the unmatched-metadata rule and must be deleted with a deleted firm.',
  },
]);
