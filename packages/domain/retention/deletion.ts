import { createHash } from 'node:crypto';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { isAdminScope } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { recordSuppression } from '../suppression/events.ts';
import type { SuppressionJournal } from '../suppression/journal.ts';
import { accept, refuse, type RetentionResult } from './result.ts';

/**
 * The documented deletion workflow (specification 10.3).
 *
 * > A documented deletion workflow removes ordinary personal and correspondence data
 * > while retaining a minimal normalized suppression tombstone where needed to
 * > prevent renewed contact. Backup copies expire naturally under retention. Every
 * > deletion and export is audited.
 *
 * ## Why deletion is remove *and* redact
 *
 * Three tables in this schema have `DELETE` revoked from both application roles —
 * `audit_events`, `suppression_events`, `opportunity_stage_events`,
 * `record_merge_events` and `crm_domain_events` — and each of them carries foreign
 * keys onto `firms`, `contacts` or `opportunities`. A deletion that removed the firm
 * row would have to remove that history first, and it is not allowed to, and it
 * should not be: section 10.3's first row keeps "firms, contacts, opportunities,
 * stages" as Callie business history, and 5.2 makes the audit trail append-only on
 * purpose.
 *
 * So the workflow does exactly what the sentence asks and no more. *Ordinary
 * personal and correspondence data* is removed: the handles, the messages and their
 * bodies, the call history, the callbacks, the evidence, the derived work items. The
 * rows the append-only history points at stay, with their identifying fields
 * cleared, so the history remains readable and nothing in it names a person.
 * See docs/decisions/g14-deletion-is-remove-and-redact.md.
 *
 * ## The tombstone has its own source
 *
 * A tombstone has to be effective against renewed contact, terminal, and never
 * reversible by a salesperson. `effective_suppressions` is the one authoritative
 * view (10.2), so it has to be a row in `suppression_events`.
 *
 * Migration 0014 widens that table's source vocabulary with `deletion_tombstone`,
 * which has all three properties and its own name. The first draft of this lane
 * borrowed `prospect_opt_out` because the vocabulary is closed and cross-lane, and
 * that was wrong: the audit trail would have said a prospect opted out when an admin
 * ran a deletion. See docs/decisions/g14-deletion-tombstone-source.md.
 *
 * Terminal comes from `TERMINAL_SOURCES`, so no ten-minute review hold is opened —
 * there is nothing left to protect, the handles having just been removed.
 * Irreversible by a salesperson comes from `mayCorrectSuppression`, which allows
 * only `salesperson_manual` and therefore refuses this one with
 * `not_salesperson_originated`. Neither is a new rule written for this source; both
 * are existing rules it inherits by being what it is.
 *
 * ## Why a preview, and why a hash
 *
 * "A preview before commit" is the brief's, and a preview is only worth anything if
 * the commit is the thing that was previewed. The hash is over the counts and the
 * handles, recomputed at commit; a world that changed under the admin — a new
 * contact, a new message — makes them disagree and the commit is refused rather than
 * silently deleting more than was approved.
 */

export type DeletionTargetKind = 'firm' | 'contact';

export type DeletionRefusal =
  | 'admin_only'
  | 'firm_unknown'
  | 'contact_unknown'
  | 'request_unknown'
  | 'preview_stale'
  | 'already_committed'
  | 'handle_uncanonical';

export interface DeletionPreview {
  readonly requestId: string;
  readonly targetKind: DeletionTargetKind;
  readonly firmId: string;
  readonly contactId: string | null;
  readonly previewHash: string;
  /** Rows a commit would delete outright, by table. */
  readonly removes: Readonly<Record<string, number>>;
  /** Rows a commit would clear the identifying fields of, by table. */
  readonly redacts: Readonly<Record<string, number>>;
  /**
   * Rows a commit would terminally stop, by table.
   *
   * Its own map rather than a line in `redacts`, because stopping an enrollment is
   * not the same act as clearing a name and an approver should not have to read it
   * as one. Nothing is removed here and nothing is blanked; what changes is whether
   * a worker will ever act on the row again.
   */
  readonly stops: Readonly<Record<string, number>>;
  /** Rows a commit would leave alone, by table, so an approver is told what stays. */
  readonly retains: Readonly<Record<string, number>>;
  /**
   * The normalized handles the commit would suppress. Returned to the admin who is
   * approving it and deliberately never stored: a deletion record that quoted them
   * would keep a copy of what it deleted.
   */
  readonly tombstoneHandles: readonly string[];
}

export interface DeletionOutcome {
  readonly requestId: string;
  readonly removed: Readonly<Record<string, number>>;
  readonly redacted: Readonly<Record<string, number>>;
  readonly stopped: Readonly<Record<string, number>>;
  readonly tombstoneEventIds: readonly string[];
}

/** What a redacted firm or contact is called afterwards. Non-blank, because the CHECK requires it. */
export const REDACTED_NAME = '[deleted]';

interface Scope {
  readonly firmId: string;
  readonly contactId: string | null;
}

/** `contact_id = $2 OR ($2 IS NULL)` as one predicate, so every count uses the same rule. */
const contactPredicate = (column: string, parameter: string): string =>
  `(${parameter}::uuid IS NULL OR ${column} = ${parameter}::uuid)`;

/**
 * The same rule for G7b's confirmations, which carry a firm but no contact.
 *
 * A confirmation belongs to a message, and which contact a message is about is the
 * match row's answer rather than the confirmation's. A firm deletion takes them all;
 * a contact deletion takes the ones whose message matched that contact. The alias
 * `c` is the caller's to supply, and both uses below do.
 */
const CONFIRMATION_IN_SCOPE = `($2::uuid IS NULL OR EXISTS (
      SELECT 1 FROM mail_message_matches x
       WHERE x.workspace_id = c.workspace_id AND x.mail_message_id = c.mail_message_id
         AND x.contact_id = $2::uuid))`;

async function countOf(
  context: RepositoryContext,
  sql: string,
  values: readonly unknown[],
): Promise<number> {
  const { rows } = await context.db.query<{ count: string }>(sql, values);
  return Number(rows[0]?.count ?? '0');
}

/**
 * Everything a commit would touch, counted.
 *
 * A firm deletion has `contactId === null` and takes the firm's whole set; a contact
 * deletion narrows every table that has a `contact_id` and leaves the firm-level
 * rows — a receptionist's number is not the deleted person's handle.
 */
async function measure(
  context: RepositoryContext,
  scope: Scope,
): Promise<{
  readonly removes: Record<string, number>;
  readonly redacts: Record<string, number>;
  readonly stops: Record<string, number>;
  readonly retains: Record<string, number>;
  readonly handles: string[];
}> {
  const workspace = context.scope.workspaceId;
  const firm = scope.firmId;
  const contact = scope.contactId;
  const byContact = [workspace, contact, firm] as const;

  const removes: Record<string, number> = {
    email_addresses: await countOf(
      context,
      `SELECT count(*) AS count FROM email_addresses
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}`,
      byContact,
    ),
    phone_routes: await countOf(
      context,
      `SELECT count(*) AS count FROM phone_routes
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}`,
      byContact,
    ),
    mail_messages: await countOf(
      context,
      `SELECT count(DISTINCT m.id) AS count FROM mail_messages m
         JOIN mail_message_matches x ON x.workspace_id = m.workspace_id AND x.mail_message_id = m.id
        WHERE m.workspace_id = $1 AND x.firm_id = $3 AND ${contactPredicate('x.contact_id', '$2')}`,
      byContact,
    ),
    evidence_items: await countOf(
      context,
      `SELECT count(*) AS count FROM evidence_items
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}`,
      byContact,
    ),
    call_logs: await countOf(
      context,
      `SELECT count(*) AS count FROM call_logs
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}`,
      byContact,
    ),
    callbacks: await countOf(
      context,
      `SELECT count(*) AS count FROM callbacks
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}`,
      byContact,
    ),
    dial_tickets: await countOf(
      context,
      `SELECT count(*) AS count FROM dial_tickets
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}`,
      byContact,
    ),
    today_items: await countOf(
      context,
      `SELECT count(*) AS count FROM today_items
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}`,
      byContact,
    ),
    today_snoozes: await countOf(
      context,
      `SELECT count(*) AS count FROM today_snoozes
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}`,
      byContact,
    ),
    record_aliases: await countOf(
      context,
      `SELECT count(*) AS count FROM record_aliases
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}`,
      byContact,
    ),
    // G7b. A confirmation would cascade with its message anyway, but it is counted
    // and deleted in its own right because it also references `callbacks`, which
    // this workflow removes: a survivor would refuse that delete.
    mail_reply_confirmations: await countOf(
      context,
      `SELECT count(*) AS count FROM mail_reply_confirmations c
        WHERE c.workspace_id = $1 AND c.firm_id = $3 AND ${CONFIRMATION_IN_SCOPE}`,
      byContact,
    ),
    // G8. A recorded LinkedIn reply is the prospect's own response — the one row in
    // the sequence tables that holds their words rather than the plan's.
    enrollment_linkedin_results: await countOf(
      context,
      `SELECT count(*) AS count FROM enrollment_linkedin_results r
        WHERE r.workspace_id = $1 AND r.firm_id = $3 AND EXISTS (
          SELECT 1 FROM sequence_enrollments e
           WHERE e.workspace_id = r.workspace_id AND e.id = r.enrollment_id
             AND ${contactPredicate('e.contact_id', '$2')})`,
      byContact,
    ),
    research_suggestions: await countOf(
      context,
      `SELECT count(*) AS count FROM research_suggestions
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}`,
      byContact,
    ),
    firm_locations:
      contact === null
        ? await countOf(
            context,
            'SELECT count(*) AS count FROM firm_locations WHERE workspace_id = $1 AND firm_id = $2',
            [workspace, firm],
          )
        : 0,
  };

  const redacts: Record<string, number> = {
    // Outbound fences the trigger still lets us touch: `prepared` and `held`, which
    // are the ones with no attempt token and therefore provably unsent. A fence at or
    // past `dispatching` is a message that may have left, `DELETE` on the table is
    // revoked, and migration 0010's trigger refuses to change its envelope — so a
    // deletion cannot reach it and should not: it is correspondence.
    outbound_messages: await countOf(
      context,
      `SELECT count(*) AS count FROM outbound_messages
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}
          AND attempt_token IS NULL AND subject <> $4`,
      [...byContact, REDACTED_NAME],
    ),
    contacts: await countOf(
      context,
      `SELECT count(*) AS count FROM contacts
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('id', '$2')}`,
      byContact,
    ),
    firms: contact === null ? 1 : 0,
  };

  /**
   * G8's terminal stops. Nothing is removed and nothing is blanked; what changes is
   * whether a worker will ever act on the row again.
   *
   * An enrollment left `active` against a firm whose handles have just been deleted
   * is a plan the scheduler keeps materializing work for, and every step of it would
   * hold on a missing route. 11.2's vocabulary already has the right word —
   * `admin_stop`, the end that is not a prospect signal — so deletion uses it rather
   * than inventing a reason of its own.
   */
  const stops: Record<string, number> = {
    sequence_enrollments: await countOf(
      context,
      `SELECT count(*) AS count FROM sequence_enrollments
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}
          AND state IN ('active', 'review_required')`,
      byContact,
    ),
    step_executions: await countOf(
      context,
      `SELECT count(*) AS count FROM step_executions
        WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}
          AND state IN ('pending', 'held')`,
      byContact,
    ),
  };

  const retains: Record<string, number> = {
    opportunity_stage_events: await countOf(
      context,
      'SELECT count(*) AS count FROM opportunity_stage_events WHERE workspace_id = $1 AND firm_id = $2',
      [workspace, firm],
    ),
    crm_domain_events: await countOf(
      context,
      'SELECT count(*) AS count FROM crm_domain_events WHERE workspace_id = $1 AND firm_id = $2',
      [workspace, firm],
    ),
    opportunities: await countOf(
      context,
      'SELECT count(*) AS count FROM opportunities WHERE workspace_id = $1 AND firm_id = $2',
      [workspace, firm],
    ),
    // The honest line in the report, and the one an approver would otherwise
    // discover afterwards. An address frozen into the envelope of a fence that has
    // dispatched cannot be removed: 0010 revokes `DELETE` on `outbound_messages`,
    // its trigger makes the envelope immutable from the instant an attempt token
    // exists, and `outbound_messages_route_fkey` has no `ON DELETE` clause — so the
    // route row is pinned by the same promise that lets Sent-folder reconciliation
    // find the message afterwards. The address is in the tombstones regardless, so
    // the handle is suppressed even where the row survives.
    email_addresses_pinned_by_a_sent_fence: await countOf(
      context,
      `SELECT count(DISTINCT a.id) AS count FROM email_addresses a
         JOIN outbound_messages o
           ON o.workspace_id = a.workspace_id AND o.recipient_route_id = a.id
        WHERE a.workspace_id = $1 AND a.firm_id = $3 AND ${contactPredicate('a.contact_id', '$2')}
          AND o.attempt_token IS NOT NULL`,
      byContact,
    ),
  };

  const { rows: handleRows } = await context.db.query<{ handle: string }>(
    `SELECT address AS handle FROM email_addresses
      WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}
     UNION
     SELECT e164 AS handle FROM phone_routes
      WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}
     ORDER BY handle`,
    byContact,
  );

  return { removes, redacts, stops, retains, handles: handleRows.map(row => row.handle) };
}

function hashOf(scope: Scope, measured: Awaited<ReturnType<typeof measure>>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        firmId: scope.firmId,
        contactId: scope.contactId,
        removes: measured.removes,
        redacts: measured.redacts,
        stops: measured.stops,
        handles: measured.handles,
      }),
    )
    .digest('hex');
}

async function resolveScope(
  context: RepositoryContext,
  input: { readonly targetKind: DeletionTargetKind; readonly firmId: string; readonly contactId?: string | undefined },
): Promise<RetentionResult<Scope, DeletionRefusal>> {
  const { rows } = await context.db.query<{ id: string }>(
    'SELECT id FROM firms WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
    [context.scope.workspaceId, input.firmId],
  );
  if (rows.length === 0) return refuse('firm_unknown');

  if (input.targetKind === 'firm') return accept({ firmId: input.firmId, contactId: null });

  if (input.contactId === undefined) return refuse('contact_unknown');
  const contact = await context.db.query<{ id: string }>(
    'SELECT id FROM contacts WHERE workspace_id = $1 AND id = $2 AND firm_id = $3 FOR UPDATE',
    [context.scope.workspaceId, input.contactId, input.firmId],
  );
  if (contact.rows.length === 0) return refuse('contact_unknown');
  return accept({ firmId: input.firmId, contactId: input.contactId });
}

export interface PreviewDeletionInput {
  readonly targetKind: DeletionTargetKind;
  readonly firmId: string;
  readonly contactId?: string | undefined;
}

export async function previewDeletion(
  context: RepositoryContext,
  input: PreviewDeletionInput,
): Promise<RetentionResult<DeletionPreview, DeletionRefusal>> {
  if (!isAdminScope(context.scope)) return refuse('admin_only');
  const scoped = await resolveScope(context, input);
  if (!scoped.ok) return refuse(scoped.reason);
  const scope = scoped.value;

  const measured = await measure(context, scope);
  const previewHash = hashOf(scope, measured);

  const actor = context.scope.actor;
  const requestedBy = actor.kind === 'user' ? actor.userId : null;
  if (requestedBy === null) return refuse('admin_only');

  const { rows } = await context.db.query<{ id: string }>(
    `INSERT INTO deletion_requests
       (workspace_id, target_kind, firm_id, contact_id, requested_by_user_id, preview, preview_hash)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     RETURNING id`,
    [
      context.scope.workspaceId,
      input.targetKind,
      scope.firmId,
      scope.contactId,
      requestedBy,
      // Counts only. The handles are returned to the caller and never written down.
      JSON.stringify({
        removes: measured.removes,
        redacts: measured.redacts,
        stops: measured.stops,
        retains: measured.retains,
      }),
      previewHash,
    ],
  );

  await recordCrmAuditEvent(context, {
    action: 'deletion.previewed',
    subjectKind: input.targetKind,
    subjectId: scope.contactId ?? scope.firmId,
    detail: {
      requestId: rows[0]?.id ?? '',
      removes: measured.removes,
      redacts: measured.redacts,
      stops: measured.stops,
    },
  });

  return accept({
    requestId: rows[0]?.id ?? '',
    targetKind: input.targetKind,
    firmId: scope.firmId,
    contactId: scope.contactId,
    previewHash,
    removes: measured.removes,
    redacts: measured.redacts,
    stops: measured.stops,
    retains: measured.retains,
    tombstoneHandles: measured.handles,
  });
}

export interface CommitDeletionInput {
  readonly requestId: string;
  readonly previewHash: string;
  readonly commandId: string;
  readonly journal: SuppressionJournal;
}

export async function commitDeletion(
  context: RepositoryContext,
  input: CommitDeletionInput,
): Promise<RetentionResult<DeletionOutcome, DeletionRefusal>> {
  if (!isAdminScope(context.scope)) return refuse('admin_only');
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refuse('admin_only');

  const request = await context.db.query<{
    id: string;
    target_kind: DeletionTargetKind;
    firm_id: string;
    contact_id: string | null;
    preview_hash: string;
    state: 'previewed' | 'committed';
  }>(
    `SELECT id, target_kind, firm_id, contact_id, preview_hash, state
       FROM deletion_requests WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [context.scope.workspaceId, input.requestId],
  );
  const row = request.rows[0];
  if (row === undefined) return refuse('request_unknown');
  if (row.state === 'committed') return refuse('already_committed');

  const scope: Scope = { firmId: row.firm_id, contactId: row.contact_id };
  const measured = await measure(context, scope);
  const currentHash = hashOf(scope, measured);
  // Both comparisons. The presented hash catches a client approving somebody else's
  // preview; the stored one catches the world changing since it was shown.
  if (input.previewHash !== currentHash || row.preview_hash !== currentHash) return refuse('preview_stale');

  // The tombstones first, while the handles still exist to be read. Every one is
  // journalled before its row by `recordSuppression` (10.2), so a lost journal write
  // fails the command before anything has been deleted.
  // `tombstone_event_ids` on the request row is what makes these findable later.
  const tombstoneEventIds: string[] = [];
  for (const handle of measured.handles) {
    const recorded = await recordSuppression(context, {
      scope: 'handle',
      value: handle,
      source: 'deletion_tombstone',
      commandId: `${input.commandId}:${handle}`,
      journal: input.journal,
    });
    if (!recorded.ok) return refuse('handle_uncanonical');
    tombstoneEventIds.push(recorded.value.eventId);
  }
  if (row.target_kind === 'firm') {
    const recorded = await recordSuppression(context, {
      scope: 'firm',
      firmId: scope.firmId,
      source: 'deletion_tombstone',
      commandId: input.commandId,
      journal: input.journal,
    });
    if (!recorded.ok) return refuse('firm_unknown');
    tombstoneEventIds.push(recorded.value.eventId);
  }

  const workspace = context.scope.workspaceId;
  const byContact = [workspace, scope.contactId, scope.firmId] as const;
  const removed: Record<string, number> = {};

  const remove = async (table: string, sql: string, values: readonly unknown[]): Promise<void> => {
    const { rowCount } = await context.db.query(sql, values);
    removed[table] = rowCount ?? 0;
  };

  // G7b's confirmations before the messages that would cascade them, because a
  // confirmation also references a callback this workflow is about to remove.
  await remove(
    'mail_reply_confirmations',
    `DELETE FROM mail_reply_confirmations c
      WHERE c.workspace_id = $1 AND c.firm_id = $3 AND ${CONFIRMATION_IN_SCOPE}`,
    byContact,
  );
  // Correspondence next: the messages take their bodies, matches, classifications,
  // classifier calls and effects with them through the cascades of 0009 and 0011.
  await remove(
    'mail_messages',
    `DELETE FROM mail_messages
      WHERE workspace_id = $1 AND id IN (
        SELECT x.mail_message_id FROM mail_message_matches x
         WHERE x.workspace_id = $1 AND x.firm_id = $3 AND ${contactPredicate('x.contact_id', '$2')}
      )`,
    byContact,
  );
  // Then the things that point at a route, then the routes.
  await remove(
    'dial_tickets',
    `DELETE FROM dial_tickets WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}`,
    byContact,
  );
  await remove(
    'call_logs',
    `DELETE FROM call_logs WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}`,
    byContact,
  );
  await remove(
    'callbacks',
    `DELETE FROM callbacks WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}`,
    byContact,
  );
  await remove(
    'today_snoozes',
    `DELETE FROM today_snoozes WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}`,
    byContact,
  );
  await remove(
    'today_items',
    `DELETE FROM today_items WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}`,
    byContact,
  );
  // Detach the unsent fences from the routes that are about to go. 0010's trigger
  // permits it while there is no attempt token — that is exactly the window in which
  // an envelope is still editable — and without it the delete below would fail on
  // `outbound_messages_route_fkey` for any firm that had a draft prepared.
  await context.db.query(
    `UPDATE outbound_messages
        SET recipient_route_id = NULL, recipient_route_version = NULL, updated_at = now()
      WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}
        AND attempt_token IS NULL AND recipient_route_id IS NOT NULL`,
    byContact,
  );
  await remove(
    'phone_routes',
    `DELETE FROM phone_routes WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}`,
    byContact,
  );
  await remove(
    'email_addresses',
    `DELETE FROM email_addresses a
      WHERE a.workspace_id = $1 AND a.firm_id = $3 AND ${contactPredicate('a.contact_id', '$2')}
        AND NOT EXISTS (
          SELECT 1 FROM outbound_messages o
           WHERE o.workspace_id = a.workspace_id AND o.recipient_route_id = a.id)`,
    byContact,
  );
  await remove(
    'research_suggestions',
    `DELETE FROM research_suggestions
      WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}`,
    byContact,
  );
  await remove(
    'evidence_items',
    `DELETE FROM evidence_items WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}`,
    byContact,
  );
  await remove(
    'enrollment_linkedin_results',
    `DELETE FROM enrollment_linkedin_results r
      WHERE r.workspace_id = $1 AND r.firm_id = $3 AND EXISTS (
        SELECT 1 FROM sequence_enrollments e
         WHERE e.workspace_id = r.workspace_id AND e.id = r.enrollment_id
           AND ${contactPredicate('e.contact_id', '$2')})`,
    byContact,
  );
  await remove(
    'record_aliases',
    `DELETE FROM record_aliases WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}`,
    byContact,
  );
  if (scope.contactId === null) {
    await remove('firm_locations', 'DELETE FROM firm_locations WHERE workspace_id = $1 AND firm_id = $2', [
      workspace,
      scope.firmId,
    ]);
  }

  // The stops, after the removals and before the redactions. `step_executions`
  // first: an execution is the child, and a `pending` one under a `stopped`
  // enrollment is a row the scheduler still claims. Both updates clear the column
  // their new state forbids — `hold_reason_code` for a cancelled execution,
  // `review_union_milliseconds` for a stopped enrollment — because 0012 writes each
  // of those as an equivalence rather than as a nullable field.
  const stopped: Record<string, number> = {};
  const executions = await context.db.query(
    `UPDATE step_executions
        SET state = 'cancelled', cancelled_at = now(), cancel_reason = 'deleted under 10.3',
            hold_reason_code = NULL, updated_at = now()
      WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}
        AND state IN ('pending', 'held')`,
    byContact,
  );
  stopped['step_executions'] = executions.rowCount ?? 0;
  const enrollments = await context.db.query(
    `UPDATE sequence_enrollments
        SET state = 'stopped', ended_at = now(), end_reason = 'admin_stop',
            review_union_milliseconds = NULL, updated_at = now()
      WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}
        AND state IN ('active', 'review_required')`,
    byContact,
  );
  stopped['sequence_enrollments'] = enrollments.rowCount ?? 0;

  const redacted: Record<string, number> = {};
  const fences = await context.db.query(
    `UPDATE outbound_messages
        SET subject = $4, body = $4, updated_at = now()
      WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}
        AND attempt_token IS NULL AND subject <> $4`,
    [...byContact, REDACTED_NAME],
  );
  redacted['outbound_messages'] = fences.rowCount ?? 0;

  const contacts = await context.db.query(
    `UPDATE contacts
        SET full_name = $4, title = NULL, linkedin_url = NULL, status = 'inactive', is_primary = false,
            updated_at = now()
      WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('id', '$2')} AND status <> 'merged'`,
    [...byContact, REDACTED_NAME],
  );
  redacted['contacts'] = contacts.rowCount ?? 0;

  if (scope.contactId === null) {
    const firms = await context.db.query(
      `UPDATE firms
          SET name = $3, website = NULL, address_line = NULL, locality = NULL, postal_code = NULL,
              updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [workspace, scope.firmId, REDACTED_NAME],
    );
    redacted['firms'] = firms.rowCount ?? 0;
  }

  await context.db.query(
    `UPDATE deletion_requests
        SET state = 'committed', committed_at = now(), committed_by_user_id = $3, command_id = $4,
            outcome = $5::jsonb, tombstone_event_ids = $6::text[]
      WHERE workspace_id = $1 AND id = $2`,
    [
      workspace,
      row.id,
      actor.userId,
      input.commandId,
      JSON.stringify({ removed, redacted, stopped }),
      tombstoneEventIds,
    ],
  );

  await recordCrmAuditEvent(context, {
    action: 'deletion.committed',
    subjectKind: row.target_kind,
    subjectId: scope.contactId ?? scope.firmId,
    detail: { requestId: row.id, removed, redacted, stopped, tombstones: tombstoneEventIds.length },
  });

  return accept({ requestId: row.id, removed, redacted, stopped, tombstoneEventIds });
}
