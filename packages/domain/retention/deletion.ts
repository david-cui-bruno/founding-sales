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
 * ## Why the tombstone is a `prospect_opt_out`
 *
 * A tombstone has to be effective against renewed contact, terminal, and never
 * reversible by a salesperson. `effective_suppressions` is the one authoritative
 * view (10.2), so the tombstone has to be a row in `suppression_events`, and the
 * source vocabulary there is a closed list this lane does not own.
 *
 * `prospect_opt_out` is an **interim**. It has exactly those three properties — it is
 * terminal on commit, and Appendix G 30 already proves a salesperson cannot correct
 * one — but the audit trail must not say a prospect opted out when an admin ran a
 * deletion. The coordinator overruled the borrowing on 20 September; this lane's
 * migration 0014 adds a `deletion_tombstone` source at the final merge, once every
 * lane touching the vocabulary has landed, and `PENDING_RETENTION_TABLES` is what
 * makes the build ask for it. See docs/decisions/g14-deletion-tombstone-source.md.
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

  return { removes, redacts, retains, handles: handleRows.map(row => row.handle) };
}

function hashOf(scope: Scope, measured: Awaited<ReturnType<typeof measure>>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        firmId: scope.firmId,
        contactId: scope.contactId,
        removes: measured.removes,
        redacts: measured.redacts,
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
      JSON.stringify({ removes: measured.removes, redacts: measured.redacts, retains: measured.retains }),
      previewHash,
    ],
  );

  await recordCrmAuditEvent(context, {
    action: 'deletion.previewed',
    subjectKind: input.targetKind,
    subjectId: scope.contactId ?? scope.firmId,
    detail: { requestId: rows[0]?.id ?? '', removes: measured.removes, redacts: measured.redacts },
  });

  return accept({
    requestId: rows[0]?.id ?? '',
    targetKind: input.targetKind,
    firmId: scope.firmId,
    contactId: scope.contactId,
    previewHash,
    removes: measured.removes,
    redacts: measured.redacts,
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
  // `tombstone_event_ids` on the request row is what makes these findable later,
  // which is what turns the `deletion_tombstone` backfill into one UPDATE.
  const tombstoneEventIds: string[] = [];
  for (const handle of measured.handles) {
    const recorded = await recordSuppression(context, {
      scope: 'handle',
      value: handle,
      source: 'prospect_opt_out',
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
      source: 'prospect_opt_out',
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

  // Correspondence first: the messages take their bodies, matches, classifications
  // and effects with them through migration 0009's cascades.
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
  await remove(
    'phone_routes',
    `DELETE FROM phone_routes WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}`,
    byContact,
  );
  await remove(
    'email_addresses',
    `DELETE FROM email_addresses WHERE workspace_id = $1 AND firm_id = $3 AND ${contactPredicate('contact_id', '$2')}`,
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
      JSON.stringify({ removed, redacted }),
      tombstoneEventIds,
    ],
  );

  await recordCrmAuditEvent(context, {
    action: 'deletion.committed',
    subjectKind: row.target_kind,
    subjectId: scope.contactId ?? scope.firmId,
    detail: { requestId: row.id, removed, redacted, tombstones: tombstoneEventIds.length },
  });

  return accept({ requestId: row.id, removed, redacted, tombstoneEventIds });
}
