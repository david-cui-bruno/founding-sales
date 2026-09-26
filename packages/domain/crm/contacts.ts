import type { RepositoryContext } from '../db/workspaceScope.ts';
import { decideFirmMutation } from './authorization.ts';
import { recordCrmAuditEvent } from './audit.ts';
import { loadFirmForUpdate } from './firms.ts';
import { accept, refuse, type ContactRow, type CrmResult } from './types.ts';

/**
 * Contacts: the people at a firm (specification 7.2).
 *
 * "one active primary contact per firm is permitted but not required." The database
 * holds that as a partial unique index; this file's job is to make promoting a new
 * primary a single transaction that demotes the old one, rather than a refusal the
 * salesperson has to work around in two steps.
 *
 * Authorization is the firm's, not the contact's: a contact has no assignee of its
 * own, and section 5.2 gives a salesperson "assigned firms". So every command here
 * loads the firm `FOR UPDATE` first — which also serializes two commands racing to
 * make different contacts primary.
 *
 * `contacts.linkedin_url` (migration 0004) outlived LinkedIn, which was removed on 25
 * September 2026. Migration 0018 appended each stored URL to the contact's `title`,
 * where the desktop shows it and a person can edit it, and dropped the column; a
 * deletion blanks `title`, so the URL leaves with the person.
 */

const CONTACT_COLUMNS = `id, workspace_id, firm_id, full_name, title, status, is_primary,
  merged_into_contact_id, created_at, updated_at`;

export async function readContact(
  context: RepositoryContext,
  contactId: string,
): Promise<ContactRow | null> {
  const { rows } = await context.db.query<ContactRow>(
    `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, contactId],
  );
  return rows[0] ?? null;
}

export async function listContacts(
  context: RepositoryContext,
  firmId: string,
): Promise<readonly ContactRow[]> {
  const { rows } = await context.db.query<ContactRow>(
    `SELECT ${CONTACT_COLUMNS} FROM contacts
      WHERE workspace_id = $1 AND firm_id = $2 AND status <> 'merged'
      ORDER BY is_primary DESC, full_name`,
    [context.scope.workspaceId, firmId],
  );
  return rows;
}

export interface CreateContactInput {
  readonly firmId: string;
  readonly fullName: string;
  readonly title?: string | undefined;
  readonly isPrimary?: boolean | undefined;
  readonly externalId?: string | undefined;
}

export async function createContact(
  context: RepositoryContext,
  input: CreateContactInput,
): Promise<CrmResult<ContactRow>> {
  const firm = await loadFirmForUpdate(context, input.firmId);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason);
  if (input.fullName.trim().length === 0) return refuse('invalid_input');

  if (input.isPrimary === true) await demoteCurrentPrimary(context, input.firmId);

  const { rows } = await context.db.query<ContactRow>(
    `INSERT INTO contacts (workspace_id, firm_id, full_name, title, is_primary)
     VALUES ($1, $2, $3, $4, COALESCE($5, false))
     RETURNING ${CONTACT_COLUMNS}`,
    [
      context.scope.workspaceId,
      input.firmId,
      input.fullName.trim(),
      input.title ?? null,
      input.isPrimary ?? null,
    ],
  );
  const created = rows[0];
  if (created === undefined) return refuse('invalid_input');

  if (input.externalId !== undefined && input.externalId.trim().length > 0) {
    await context.db.query(
      `INSERT INTO record_aliases (workspace_id, record_kind, firm_id, contact_id, alias_kind, alias_value)
       VALUES ($1, 'contact', $2, $3, 'external_id', $4)
       ON CONFLICT ON CONSTRAINT record_aliases_unique DO NOTHING`,
      [context.scope.workspaceId, input.firmId, created.id, input.externalId.trim()],
    );
  }

  await recordCrmAuditEvent(context, {
    action: 'contact.created',
    subjectKind: 'contact',
    subjectId: created.id,
    detail: { firmId: input.firmId, primary: created.is_primary },
  });
  return accept(created);
}

export interface ContactPatch {
  readonly fullName?: string | undefined;
  readonly title?: string | null | undefined;
  readonly status?: 'active' | 'inactive' | undefined;
  readonly isPrimary?: boolean | undefined;
}

const CONTACT_PATCH_COLUMNS: Readonly<Record<string, string>> = Object.freeze({
  fullName: 'full_name',
  title: 'title',
  status: 'status',
  isPrimary: 'is_primary',
});

export async function updateContact(
  context: RepositoryContext,
  input: { readonly contactId: string; readonly patch: ContactPatch },
): Promise<CrmResult<ContactRow>> {
  const contact = await readContact(context, input.contactId);
  if (contact === null) return refuse('contact_unknown');
  if (contact.status === 'merged') return refuse('contact_merged');

  const firm = await loadFirmForUpdate(context, contact.firm_id);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason);

  // Promotion demotes whoever holds the badge now, in the same transaction, so the
  // partial unique index is never the thing a salesperson has to reason about.
  if (input.patch.isPrimary === true) await demoteCurrentPrimary(context, contact.firm_id, input.contactId);

  const assignments: string[] = [];
  const values: unknown[] = [context.scope.workspaceId, input.contactId];
  for (const [field, column] of Object.entries(CONTACT_PATCH_COLUMNS)) {
    const value = (input.patch as Readonly<Record<string, unknown>>)[field];
    if (value === undefined) continue;
    values.push(value);
    assignments.push(`${column} = $${String(values.length)}`);
  }
  if (assignments.length === 0) return accept(contact);

  const { rows } = await context.db.query<ContactRow>(
    `UPDATE contacts SET ${assignments.join(', ')}, updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${CONTACT_COLUMNS}`,
    values,
  );
  const updated = rows[0];
  if (updated === undefined) return refuse('contact_unknown');

  await recordCrmAuditEvent(context, {
    action: 'contact.updated',
    subjectKind: 'contact',
    subjectId: input.contactId,
    detail: { firmId: contact.firm_id, fields: Object.keys(input.patch).sort() },
  });
  return accept(updated);
}

/** Clear the firm's active primary, if there is one and it is not `except`. */
async function demoteCurrentPrimary(
  context: RepositoryContext,
  firmId: string,
  except?: string,
): Promise<void> {
  await context.db.query(
    `UPDATE contacts SET is_primary = false, updated_at = now()
      WHERE workspace_id = $1 AND firm_id = $2 AND is_primary AND status = 'active'
        AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [context.scope.workspaceId, firmId, except ?? null],
  );
}
