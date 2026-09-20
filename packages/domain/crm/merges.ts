import type { RepositoryContext } from '../db/workspaceScope.ts';
import { decideFirmMutation } from './authorization.ts';
import { recordCrmAuditEvent } from './audit.ts';
import { emitCrmDomainEvent } from './events.ts';
import { loadFirmForUpdate, readFirm } from './firms.ts';
import { readContact } from './contacts.ts';
import {
  accept,
  actorUserId,
  refuse,
  refuseWithConflicts,
  type ContactRow,
  type CrmResult,
  type FirmRow,
  type MergeConflict,
} from './types.ts';

/**
 * Firm and contact merges (specification 7.2, Appendix A "Merge records",
 * Appendix G 37).
 *
 * "Firm and contact merges are explicit audited commands. They preserve suppressions,
 * aliases, evidence, stage events, messages, notes, callbacks, enrollments, and
 * external IDs; conflicts are shown for resolution. Research may suggest duplicates
 * but never performs a destructive merge automatically."
 *
 * Four things make that true here.
 *
 * **Nothing is deleted.** The source firm stays, with `status = 'merged'` and a
 * pointer at the target. Its children are re-pointed rather than dropped, and its
 * canonical values become aliases of the target, so every identifier that used to
 * reach the source still reaches something.
 *
 * **Suppressions are re-asserted, not moved.** `suppression_events` is insert-only by
 * privilege (10.2), so a firm-scoped suppression on the source cannot be updated to
 * name the target. A *new* event is inserted for the target, citing the source's,
 * which is both the only legal operation and the honest one: the prospect's request
 * is preserved and the history of it is intact.
 *
 * **Conflicts refuse rather than choose.** If both records carry a different website,
 * the merge stops and names the field. Picking one silently is how a merge loses a
 * canonical value nobody meant to lose.
 *
 * **The source is locked first.** Appendix G 37 asks for correctness "under
 * concurrent research enrichment". `loadFirmForUpdate` on the source takes a row lock
 * that a concurrent `INSERT` into any of its child tables already contends for
 * through the foreign key's `FOR KEY SHARE`, so the merge either waits for the
 * enrichment and carries it over, or the enrichment waits and lands on the source
 * after it is marked merged — where the next command refuses it as `firm_merged`.
 *
 * An admin-only command? No: the assigned salesperson merges their own duplicates,
 * and `decideFirmMutation` on *both* records is what stops a salesperson folding
 * someone else's firm into theirs.
 */

export interface MergeOutcome {
  readonly sourceId: string;
  readonly targetId: string;
  readonly preserved: Readonly<Record<string, number>>;
}

/** Canonical fields a firm merge refuses to choose between. */
const FIRM_CONFLICT_FIELDS: readonly (keyof FirmRow & string)[] = [
  'website',
  'address_line',
  'locality',
  'region_code',
  'postal_code',
];

const CONTACT_CONFLICT_FIELDS: readonly (keyof ContactRow & string)[] = ['title', 'linkedin_url'];

function conflictsBetween(
  source: Readonly<Record<string, unknown>>,
  target: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): readonly MergeConflict[] {
  const conflicts: MergeConflict[] = [];
  for (const field of fields) {
    const from = source[field];
    const to = target[field];
    // A value only the source has is not a conflict: it fills a blank on the target.
    // Two different values are, because keeping one means losing the other.
    if (typeof from === 'string' && typeof to === 'string' && from !== to) {
      conflicts.push({ field, source: from, target: to });
    }
  }
  return conflicts;
}

export interface MergeFirmsInput {
  readonly sourceFirmId: string;
  readonly targetFirmId: string;
  /** Fields the person has decided to take from the source, resolving a conflict. */
  readonly resolutions?: Readonly<Record<string, string>> | undefined;
  readonly commandId?: string | undefined;
}

export async function mergeFirms(
  context: RepositoryContext,
  input: MergeFirmsInput,
): Promise<CrmResult<MergeOutcome>> {
  if (input.sourceFirmId === input.targetFirmId) return refuse('merge_same_record');

  // Lock in a stable order so two merges naming the same pair in opposite directions
  // cannot deadlock.
  const [firstId, secondId] =
    input.sourceFirmId < input.targetFirmId
      ? [input.sourceFirmId, input.targetFirmId]
      : [input.targetFirmId, input.sourceFirmId];
  const first = await loadFirmForUpdate(context, firstId);
  if (first === null) return refuse('firm_unknown');
  const second = await loadFirmForUpdate(context, secondId);
  if (second === null) return refuse('firm_unknown');

  const source = first.id === input.sourceFirmId ? first : second;
  const target = first.id === input.targetFirmId ? first : second;

  if (source.status === 'merged') return refuse('merge_already_performed');
  if (target.status === 'merged') return refuse('firm_merged');
  for (const record of [source, target]) {
    const decision = decideFirmMutation(context, record);
    if (!decision.permitted) return refuse(decision.reason);
  }

  const resolutions = input.resolutions ?? {};
  const unresolved = conflictsBetween(source, target, FIRM_CONFLICT_FIELDS).filter(
    conflict => resolutions[conflict.field] === undefined,
  );
  if (unresolved.length > 0) return refuseWithConflicts(unresolved);

  const preserved: Record<string, number> = {};

  /**
   * Move a table's rows from the source firm to the target.
   *
   * `uniqueColumns` are the rest of that table's uniqueness beside `firm_id`. A row
   * whose twin already exists on the target is *left on the source* rather than
   * moved: the source is a merged record, not a deleted one, so leaving it there
   * keeps its provenance while the target keeps the value it already had. Deleting it
   * would lose a retrieval time and a source; overwriting the target's would lose a
   * verification. Neither is a merge's business.
   */
  const move = async (table: string, uniqueColumns: readonly string[] = []): Promise<void> => {
    const twin =
      uniqueColumns.length === 0
        ? ''
        : ` AND NOT EXISTS (
             SELECT 1 FROM ${table} t
              WHERE t.workspace_id = r.workspace_id AND t.firm_id = $3
                AND ${uniqueColumns.map(column => `t.${column} IS NOT DISTINCT FROM r.${column}`).join(' AND ')})`;
    const { rowCount } = await context.db.query(
      `UPDATE ${table} AS r SET firm_id = $3 WHERE r.workspace_id = $1 AND r.firm_id = $2${twin}`,
      [context.scope.workspaceId, source.id, target.id],
    );
    preserved[table] = rowCount ?? 0;
  };

  // One firm may already have an active primary contact and so may the other; two at
  // one firm is refused by `contacts_one_active_primary`. The target's keeps the
  // badge, because the target is the record that survives.
  await demoteSourcePrimaryIfTargetHasOne(context, source.id, target.id);

  // Contacts move first, and the routes, evidence, aliases and events that name a
  // contact follow through `ON UPDATE CASCADE` on the semantic composite key — which
  // is the only way the append-only tables could move at all.
  await move('contacts');
  await move('phone_routes', ['contact_id', 'e164']);
  await move('email_addresses', ['contact_id', 'address']);
  await move('evidence_items', ['contact_id', 'provider', 'content_hash']);
  await move('record_aliases', ['contact_id', 'alias_kind', 'alias_value']);

  // The opportunities need care: the target may already have an open one, and only
  // one open opportunity per firm is allowed. The source's open opportunity is closed
  // as part of the merge rather than moved on top of it. Its stage events cascade.
  await closeOpenOpportunityForMerge(context, source.id, target.id);
  await move('opportunities');

  await preserveIdentifiers(context, source, target);
  await preserveFirmSuppressions(context, source.id, target.id, input.commandId);

  // Fill the target's blanks, and apply whatever the person decided.
  await applyFirmResolutions(context, source, target, resolutions);

  await context.db.query(
    "UPDATE firms SET status = 'merged', merged_into_firm_id = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2",
    [context.scope.workspaceId, source.id, target.id],
  );

  await context.db.query(
    `INSERT INTO record_merge_events
       (workspace_id, record_kind, source_id, target_id, firm_id, performed_by_user_id, command_id, preserved)
     VALUES ($1, 'firm', $2, $3, $3, $4, $5, $6::jsonb)`,
    [
      context.scope.workspaceId,
      source.id,
      target.id,
      actorUserId(context),
      input.commandId ?? null,
      JSON.stringify(preserved),
    ],
  );
  await emitCrmDomainEvent(context, {
    kind: 'firm.merged',
    firmId: target.id,
    dedupeKey: source.id,
    commandId: input.commandId,
    detail: { sourceFirmId: source.id },
  });
  await recordCrmAuditEvent(context, {
    action: 'firm.merged',
    subjectKind: 'firm',
    subjectId: target.id,
    detail: { sourceFirmId: source.id, preserved },
  });

  return accept({ sourceId: source.id, targetId: target.id, preserved });
}

export interface MergeContactsInput {
  readonly sourceContactId: string;
  readonly targetContactId: string;
  readonly resolutions?: Readonly<Record<string, string>> | undefined;
  readonly commandId?: string | undefined;
}

/**
 * Merge two contacts. They must already be at the same firm: folding a person from
 * one firm into a person at another would move a route across the semantic composite
 * key, which is the thing that key exists to prevent. The answer is to merge the
 * firms first, which is why `merge_cross_firm` is a refusal rather than a cascade.
 */
export async function mergeContacts(
  context: RepositoryContext,
  input: MergeContactsInput,
): Promise<CrmResult<MergeOutcome>> {
  if (input.sourceContactId === input.targetContactId) return refuse('merge_same_record');

  const source = await readContact(context, input.sourceContactId);
  if (source === null) return refuse('contact_unknown');
  const target = await readContact(context, input.targetContactId);
  if (target === null) return refuse('contact_unknown');
  if (source.firm_id !== target.firm_id) return refuse('merge_cross_firm');
  if (source.status === 'merged') return refuse('merge_already_performed');
  if (target.status === 'merged') return refuse('contact_merged');

  const firm = await loadFirmForUpdate(context, source.firm_id);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason);

  const resolutions = input.resolutions ?? {};
  const unresolved = conflictsBetween(source, target, CONTACT_CONFLICT_FIELDS).filter(
    conflict => resolutions[conflict.field] === undefined,
  );
  if (unresolved.length > 0) return refuseWithConflicts(unresolved);

  const preserved: Record<string, number> = {};
  for (const table of ['phone_routes', 'email_addresses', 'evidence_items', 'record_aliases']) {
    const { rowCount } = await context.db.query(
      `UPDATE ${table} SET contact_id = $3 WHERE workspace_id = $1 AND contact_id = $2`,
      [context.scope.workspaceId, source.id, target.id],
    );
    preserved[table] = rowCount ?? 0;
  }

  // The source's name and external ids keep reaching the target.
  await insertAlias(context, {
    recordKind: 'contact',
    firmId: target.firm_id,
    contactId: target.id,
    aliasKind: 'name',
    aliasValue: source.full_name,
    sourceRecordId: source.id,
  });

  await context.db.query(
    `UPDATE contacts
        SET title = COALESCE(title, $3), linkedin_url = COALESCE(linkedin_url, $4), updated_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [
      context.scope.workspaceId,
      target.id,
      resolutions['title'] ?? source.title,
      resolutions['linkedin_url'] ?? source.linkedin_url,
    ],
  );
  await context.db.query(
    `UPDATE contacts
        SET status = 'merged', merged_into_contact_id = $3, is_primary = false, updated_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, source.id, target.id],
  );

  await context.db.query(
    `INSERT INTO record_merge_events
       (workspace_id, record_kind, source_id, target_id, firm_id, performed_by_user_id, command_id, preserved)
     VALUES ($1, 'contact', $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      context.scope.workspaceId,
      source.id,
      target.id,
      target.firm_id,
      actorUserId(context),
      input.commandId ?? null,
      JSON.stringify(preserved),
    ],
  );
  await emitCrmDomainEvent(context, {
    kind: 'contact.merged',
    firmId: target.firm_id,
    contactId: target.id,
    dedupeKey: source.id,
    commandId: input.commandId,
    detail: { sourceContactId: source.id },
  });
  await recordCrmAuditEvent(context, {
    action: 'contact.merged',
    subjectKind: 'contact',
    subjectId: target.id,
    detail: { firmId: target.firm_id, sourceContactId: source.id, preserved },
  });

  return accept({ sourceId: source.id, targetId: target.id, preserved });
}

/** The target's primary contact keeps the badge; the source's is demoted first. */
async function demoteSourcePrimaryIfTargetHasOne(
  context: RepositoryContext,
  sourceFirmId: string,
  targetFirmId: string,
): Promise<void> {
  await context.db.query(
    `UPDATE contacts SET is_primary = false, updated_at = now()
      WHERE workspace_id = $1 AND firm_id = $2 AND is_primary AND status = 'active'
        AND EXISTS (
          SELECT 1 FROM contacts t
           WHERE t.workspace_id = $1 AND t.firm_id = $3 AND t.is_primary AND t.status = 'active')`,
    [context.scope.workspaceId, sourceFirmId, targetFirmId],
  );
}

/**
 * The source's open opportunity, if it has one and the target does too.
 *
 * Only one open opportunity per firm is allowed, and moving a second one onto the
 * target would break that index mid-merge. The source's is closed as Lost with a
 * reason naming the merge — a recorded outcome rather than a row that quietly
 * disappears — and its terminal stop is signalled like any other close.
 */
async function closeOpenOpportunityForMerge(
  context: RepositoryContext,
  sourceFirmId: string,
  targetFirmId: string,
): Promise<void> {
  const { rows } = await context.db.query<{ id: string; target_open: string | null }>(
    `SELECT s.id,
            (SELECT t.id FROM opportunities t
              WHERE t.workspace_id = $1 AND t.firm_id = $3 AND t.status = 'open') AS target_open
       FROM opportunities s
      WHERE s.workspace_id = $1 AND s.firm_id = $2 AND s.status = 'open'
        FOR UPDATE OF s`,
    [context.scope.workspaceId, sourceFirmId, targetFirmId],
  );
  const open = rows[0];
  if (open === undefined || open.target_open === null) return;

  const lost = await context.db.query<{ id: string }>(
    "SELECT id FROM pipeline_stages WHERE workspace_id = $1 AND terminal_kind = 'lost'",
    [context.scope.workspaceId],
  );
  const lostStageId = lost.rows[0]?.id;
  if (lostStageId === undefined) return;

  await context.db.query(
    `INSERT INTO opportunity_stage_events
       (workspace_id, opportunity_id, firm_id, from_stage_id, to_stage_id, actor_kind, actor_user_id, reason)
     SELECT $1, o.id, o.firm_id, NULLIF(o.stage_id, $3), $3, 'system', NULL, 'merged into another firm'
       FROM opportunities o WHERE o.workspace_id = $1 AND o.id = $2`,
    [context.scope.workspaceId, open.id, lostStageId],
  );
  await context.db.query(
    `UPDATE opportunities
        SET status = 'lost', stage_id = $3, closed_at = now(), close_reason = 'merged into another firm',
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, open.id, lostStageId],
  );
  await emitCrmDomainEvent(context, {
    kind: 'opportunity.terminal_stop',
    firmId: sourceFirmId,
    opportunityId: open.id,
    dedupeKey: `${open.id}:merge`,
    detail: { terminalKind: 'lost', cause: 'merge' },
  });
}

/** The source's canonical name, website and external ids become the target's aliases. */
async function preserveIdentifiers(
  context: RepositoryContext,
  source: FirmRow,
  target: FirmRow,
): Promise<void> {
  await insertAlias(context, {
    recordKind: 'firm',
    firmId: target.id,
    contactId: null,
    aliasKind: 'name',
    aliasValue: source.name,
    sourceRecordId: source.id,
  });
  if (source.website !== null && source.website !== target.website) {
    await insertAlias(context, {
      recordKind: 'firm',
      firmId: target.id,
      contactId: null,
      aliasKind: 'domain',
      aliasValue: source.website,
      sourceRecordId: source.id,
    });
  }
}

async function insertAlias(
  context: RepositoryContext,
  alias: {
    readonly recordKind: 'firm' | 'contact';
    readonly firmId: string;
    readonly contactId: string | null;
    readonly aliasKind: 'name' | 'external_id' | 'domain' | 'email' | 'phone';
    readonly aliasValue: string;
    readonly sourceRecordId: string;
  },
): Promise<void> {
  await context.db.query(
    `INSERT INTO record_aliases (workspace_id, record_kind, firm_id, contact_id, alias_kind, alias_value, source_record_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT ON CONSTRAINT record_aliases_unique DO NOTHING`,
    [
      context.scope.workspaceId,
      alias.recordKind,
      alias.firmId,
      alias.contactId,
      alias.aliasKind,
      alias.aliasValue,
      alias.sourceRecordId,
    ],
  );
}

/**
 * Re-assert the source firm's suppressions against the target.
 *
 * `suppression_events` is insert-only by privilege, so nothing is moved. Each
 * firm-scoped event on the source becomes a new event on the target with a
 * deterministic id derived from the original, so replaying the merge inserts nothing
 * twice. Handle-scoped suppressions need no work at all: section 10.2 makes a handle
 * suppression "global across the workspace", so it already covers the target.
 */
async function preserveFirmSuppressions(
  context: RepositoryContext,
  sourceFirmId: string,
  targetFirmId: string,
  commandId: string | undefined,
): Promise<void> {
  await context.db.query(
    `INSERT INTO suppression_events
       (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, actor_user_id, command_id)
     SELECT $1,
            'merge:' || e.event_id,
            'firm',
            $3,
            e.canonicalizer_version,
            e.source,
            e.actor_user_id,
            $4
       FROM suppression_events e
      WHERE e.workspace_id = $1 AND e.scope = 'firm' AND e.canonical_key = $2
        AND NOT EXISTS (
          SELECT 1 FROM suppression_events existing
           WHERE existing.workspace_id = $1 AND existing.event_id = 'merge:' || e.event_id
        )`,
    [context.scope.workspaceId, sourceFirmId, targetFirmId, commandId ?? null],
  );
}

/** Fill the target's blanks from the source, then apply the person's resolutions. */
async function applyFirmResolutions(
  context: RepositoryContext,
  source: FirmRow,
  target: FirmRow,
  resolutions: Readonly<Record<string, string>>,
): Promise<void> {
  const assignments: string[] = [];
  const values: unknown[] = [context.scope.workspaceId, target.id];
  for (const field of FIRM_CONFLICT_FIELDS) {
    const chosen = resolutions[field] ?? (target[field] === null ? source[field] : null);
    if (chosen === null || chosen === undefined) continue;
    values.push(chosen);
    assignments.push(`${field} = $${String(values.length)}`);
  }
  if (assignments.length === 0) return;
  await context.db.query(
    `UPDATE firms SET ${assignments.join(', ')}, updated_at = now() WHERE workspace_id = $1 AND id = $2`,
    values,
  );
}

/** A firm's aliases, for the read side and for search (G3b). */
export async function listFirmAliases(
  context: RepositoryContext,
  firmId: string,
): Promise<readonly { readonly aliasKind: string; readonly aliasValue: string }[]> {
  const { rows } = await context.db.query<{ alias_kind: string; alias_value: string }>(
    `SELECT alias_kind, alias_value FROM record_aliases
      WHERE workspace_id = $1 AND firm_id = $2
      ORDER BY alias_kind, alias_value`,
    [context.scope.workspaceId, firmId],
  );
  return rows.map(row => ({ aliasKind: row.alias_kind, aliasValue: row.alias_value }));
}

/** Whether this firm is still the canonical record, or where it went. */
export async function canonicalFirmOf(
  context: RepositoryContext,
  firmId: string,
): Promise<string | null> {
  let current = firmId;
  // A chain of merges is followed rather than assumed to be one link long, and bounded
  // so a cycle the database should have refused cannot hang a request.
  for (let hop = 0; hop < 16; hop += 1) {
    const firm = await readFirm(context, current);
    if (firm === null) return null;
    if (firm.status !== 'merged' || firm.merged_into_firm_id === null) return firm.id;
    current = firm.merged_into_firm_id;
  }
  return null;
}
