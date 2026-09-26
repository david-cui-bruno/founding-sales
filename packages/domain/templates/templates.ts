import { isAdminScope, type RepositoryContext } from '../db/workspaceScope.ts';
import { readPostalAddress } from '../settings/store.ts';
import {
  renderTemplate,
  templateContentHash,
  templateTextIssues,
  templateTextWarnings,
  type FooterConfiguration,
  type RenderDecision,
  type TemplateRules,
  type TemplateWarningCode,
} from '../src/index.ts';

/**
 * Template versions: created, edited in place, approved (specification 11.1, 12.6; wave 2, S3).
 *
 * The table is migration 0009's; this is the repository over it, and the rules it applies
 * are the pure ones in `packages/domain/src/rules/templates.ts`. Nothing here re-implements
 * a rule: the footer requirement, the copy warnings and the content hash are one function
 * that every save and approval calls and the send later re-checks against.
 *
 * Since migration 0019 an approved version is edited in place. The edit recomputes the
 * content hash and re-runs the refusal rules; the approval stays only if they still pass,
 * and "Save and approve" (`approve: true`) approves in the same command or, when a rule
 * fails, refuses and writes nothing — so a version in live use keeps sending its old text
 * until the new text passes. What freezes the bytes of a send is the outbound fence: a
 * fence already prepared keeps the text it was prepared with; a step not yet prepared
 * renders the edited text.
 *
 * A body or subject mentioning "unsubscribe" is refused by a CHECK (12.6, and David's
 * decision that there is no web unsubscribe anywhere); the save refuses it first, as
 * `invalid_input`, rather than letting the database answer with a 500.
 *
 * With the workspace's `postal_address` set, the worker composes the footer at send and
 * a body need not end with one (`footerComposedAtSend`); unset, it must, as before.
 */

export const TEMPLATE_REFUSAL_CODES = [
  'admin_only',
  'invalid_input',
  'template_unknown',
  'template_unapproved',
  'template_already_approved',
  'template_retired',
] as const;
export type TemplateRefusalCode = (typeof TEMPLATE_REFUSAL_CODES)[number];

export type TemplateResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: TemplateRefusalCode; readonly issues?: readonly string[] };

export interface TemplateVersionRow {
  readonly id: string;
  readonly templateId: string;
  readonly version: number;
  readonly name: string;
  readonly subject: string;
  readonly body: string;
  readonly contentHash: string;
  readonly footerSignOff: string;
  readonly requiredVariables: readonly string[];
  readonly approvedAt: string | null;
  readonly retiredAt: string | null;
  readonly personalizationStrategy: string | null;
}

/**
 * A version as a create or an approval answers it: the row, and the copy warnings its
 * text raises (`templateTextWarnings`). Warnings never refuse; they are for the author.
 */
export interface TemplateVersionWithWarnings extends TemplateVersionRow {
  readonly warnings: readonly TemplateWarningCode[];
}

function withWarnings(row: TemplateVersionRow): TemplateVersionWithWarnings {
  return { ...row, warnings: templateTextWarnings({ subject: row.subject, body: row.body }) };
}

const COLUMNS = `id, template_id, version, name, subject, body, content_hash, footer_sign_off,
  required_variables, approved_at, retired_at, personalization_strategy`;

interface TemplateDbRow {
  readonly id: string;
  readonly template_id: string;
  readonly version: number;
  readonly name: string;
  readonly subject: string;
  readonly body: string;
  readonly content_hash: string;
  readonly footer_sign_off: string;
  readonly required_variables: string[];
  readonly approved_at: Date | null;
  readonly retired_at: Date | null;
  readonly personalization_strategy: string | null;
  readonly [column: string]: unknown;
}

function toTemplate(row: TemplateDbRow): TemplateVersionRow {
  return {
    id: row.id,
    templateId: row.template_id,
    version: Number(row.version),
    name: row.name,
    subject: row.subject,
    body: row.body,
    contentHash: row.content_hash,
    footerSignOff: row.footer_sign_off,
    requiredVariables: row.required_variables,
    approvedAt: row.approved_at === null ? null : row.approved_at.toISOString(),
    retiredAt: row.retired_at === null ? null : row.retired_at.toISOString(),
    personalizationStrategy: row.personalization_strategy,
  };
}

export async function readTemplateVersion(
  context: RepositoryContext,
  templateVersionId: string,
): Promise<TemplateVersionRow | null> {
  const { rows } = await context.db.query<TemplateDbRow>(
    `SELECT ${COLUMNS} FROM template_versions WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, templateVersionId],
  );
  const row = rows[0];
  return row === undefined ? null : toTemplate(row);
}

/** Every version of every template, newest first. The editor's list. */
export async function listTemplateVersions(
  context: RepositoryContext,
  input: { readonly templateId?: string | undefined } = {},
): Promise<readonly TemplateVersionRow[]> {
  const { rows } = await context.db.query<TemplateDbRow>(
    `SELECT ${COLUMNS} FROM template_versions
      WHERE workspace_id = $1 AND ($2::uuid IS NULL OR template_id = $2)
      ORDER BY created_at DESC, version DESC`,
    [context.scope.workspaceId, input.templateId ?? null],
  );
  return rows.map(toTemplate);
}

/**
 * A saved version and what its text raises: the copy warnings (never refusing) and the
 * refusal rules it does not pass, which is why a save left it unapproved.
 */
export interface TemplateSaveResult extends TemplateVersionWithWarnings {
  readonly issues: readonly string[];
}

export interface TemplateTextInput {
  readonly name: string;
  readonly subject: string;
  readonly body: string;
  readonly footer: FooterConfiguration;
  readonly requiredVariables: readonly string[];
  /** "Save and approve": approve in the same command, or refuse and write nothing. */
  readonly approve?: boolean | undefined;
}

export interface CreateTemplateVersionInput extends TemplateTextInput {
  /**
   * Absent starts a new template; present adds a version to an existing one.
   * @deprecated the "new version" path desktop 1.0.11 uses; edit in place instead.
   */
  readonly templateId?: string | undefined;
}

export interface UpdateTemplateVersionInput extends TemplateTextInput {
  readonly templateVersionId: string;
}

const UNSUBSCRIBE = /unsubscribe/iu;

/** The rules a save and an approval apply, with the footer requirement the workspace's postal address decides. */
async function rulesFor(
  context: RepositoryContext,
  input: { readonly footer: FooterConfiguration; readonly requiredVariables: readonly string[] },
): Promise<TemplateRules> {
  return {
    footer: input.footer,
    allowedVariables: input.requiredVariables,
    footerComposedAtSend: (await readPostalAddress(context)) !== null,
  };
}

/** Who may approve: an admin who is a person, never the tool. Null when the actor may not. */
function approverOf(context: RepositoryContext): string | null {
  const actor = context.scope.actor;
  return isAdminScope(context.scope) && actor.kind === 'user' ? actor.userId : null;
}

/**
 * Write a new version — unapproved, or approved in the same command (`approve: true`).
 *
 * Unapproved by default: 11.1 makes approval an act of its own, and the content hash is
 * computed now anyway, so the editor can show it before an approver commits to it.
 */
export async function createTemplateVersion(
  context: RepositoryContext,
  input: CreateTemplateVersionInput,
): Promise<TemplateResult<TemplateSaveResult>> {
  if (!isAdminScope(context.scope)) return { ok: false, reason: 'admin_only' };
  if (input.name.trim().length === 0) return { ok: false, reason: 'invalid_input' };
  if (UNSUBSCRIBE.test(input.subject) || UNSUBSCRIBE.test(input.body)) return { ok: false, reason: 'invalid_input' };
  const approver = approverOf(context);
  if (input.approve === true && approver === null) return { ok: false, reason: 'admin_only' };

  const issues = templateTextIssues(input, await rulesFor(context, input));
  if (input.approve === true && issues.length > 0) return { ok: false, reason: 'template_unapproved', issues };

  const templateId = input.templateId ?? (await newTemplateId(context));
  const { rows: existing } = await context.db.query<{ next: number }>(
    `SELECT coalesce(max(version), 0) + 1 AS next FROM template_versions
      WHERE workspace_id = $1 AND template_id = $2`,
    [context.scope.workspaceId, templateId],
  );
  const version = Number(existing[0]?.next ?? 1);
  const contentHash = templateContentHash({ templateId, version, subject: input.subject, body: input.body });
  const approvedBy = input.approve === true ? approver : null;

  const { rows } = await context.db.query<TemplateDbRow>(
    `INSERT INTO template_versions
       (workspace_id, template_id, version, name, subject, body, content_hash,
        footer_sign_off, required_variables, personalization_strategy, approved_at, approved_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], 'deterministic',
             CASE WHEN $10::uuid IS NULL THEN NULL ELSE now() END, $10::uuid)
     RETURNING ${COLUMNS}`,
    [
      context.scope.workspaceId,
      templateId,
      version,
      input.name.trim(),
      input.subject,
      input.body,
      contentHash,
      input.footer.signOff,
      [...input.requiredVariables],
      approvedBy,
    ],
  );
  const row = rows[0];
  if (row === undefined) return { ok: false, reason: 'invalid_input' };
  return { ok: true, value: { ...withWarnings(toTemplate(row)), issues } };
}

async function newTemplateId(context: RepositoryContext): Promise<string> {
  const { rows } = await context.db.query<{ id: string }>('SELECT gen_random_uuid() AS id');
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('the database refused to generate an identifier');
  return id;
}

/**
 * Edit a version in place (wave 2, S3; migration 0019 dropped the trigger that forbade it).
 *
 * Every check runs before anything is written, because a refusal commits with its
 * receipt. The content hash is recomputed over the new text. The approval:
 *
 *   * `approve: true` approves the new text, by this admin, now — or, when a refusal rule
 *     fails, refuses with every issue and leaves the row as it was;
 *   * otherwise an approved version stays approved only if the new text passes every
 *     refusal rule, and becomes unapproved (its steps hold `template_unapproved` at send)
 *     if it does not; an unapproved one stays unapproved.
 */
export async function updateTemplateVersion(
  context: RepositoryContext,
  input: UpdateTemplateVersionInput,
): Promise<TemplateResult<TemplateSaveResult>> {
  if (!isAdminScope(context.scope)) return { ok: false, reason: 'admin_only' };
  if (input.name.trim().length === 0) return { ok: false, reason: 'invalid_input' };
  if (UNSUBSCRIBE.test(input.subject) || UNSUBSCRIBE.test(input.body)) return { ok: false, reason: 'invalid_input' };
  const approver = approverOf(context);
  if (input.approve === true && approver === null) return { ok: false, reason: 'admin_only' };

  const { rows: locked } = await context.db.query<TemplateDbRow>(
    `SELECT ${COLUMNS}, approved_by_user_id FROM template_versions WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [context.scope.workspaceId, input.templateVersionId],
  );
  const current = locked[0];
  if (current === undefined) return { ok: false, reason: 'template_unknown' };
  if (current.retired_at !== null) return { ok: false, reason: 'template_retired' };

  const issues = templateTextIssues(input, await rulesFor(context, input));
  if (input.approve === true && issues.length > 0) return { ok: false, reason: 'template_unapproved', issues };

  const contentHash = templateContentHash({
    templateId: current.template_id,
    version: Number(current.version),
    subject: input.subject,
    body: input.body,
  });
  const keptApprover =
    current.approved_at !== null && issues.length === 0 ? (current['approved_by_user_id'] as string | null) : null;
  const approvedBy = input.approve === true ? approver : keptApprover;
  const approvedAt = input.approve === true ? 'now()' : keptApprover === null ? 'NULL' : 'approved_at';

  const { rows } = await context.db.query<TemplateDbRow>(
    `UPDATE template_versions
        SET name = $3, subject = $4, body = $5, content_hash = $6, footer_sign_off = $7,
            required_variables = $8::text[], approved_at = ${approvedAt}, approved_by_user_id = $9::uuid,
            updated_at = greatest(now(), created_at)
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${COLUMNS}`,
    [
      context.scope.workspaceId,
      input.templateVersionId,
      input.name.trim(),
      input.subject,
      input.body,
      contentHash,
      input.footer.signOff,
      [...input.requiredVariables],
      approvedBy,
    ],
  );
  const row = rows[0];
  if (row === undefined) return { ok: false, reason: 'template_unknown' };
  return { ok: true, value: { ...withWarnings(toTemplate(row)), issues } };
}

/**
 * Approve a version as it stands.
 *
 * `templateTextIssues` returns every issue rather than the first, and they travel back
 * on the refusal, because an author fixing one rule at a time is a worse day than an
 * author fixing four at once. An approved version comes back with its copy warnings,
 * which approve anyway. @deprecated desktop 1.0.11's route; `updateTemplateVersion` with
 * `approve: true` saves and approves in one command.
 */
export async function approveTemplateVersion(
  context: RepositoryContext,
  input: { readonly templateVersionId: string },
): Promise<TemplateResult<TemplateVersionWithWarnings>> {
  const approver = approverOf(context);
  if (approver === null) return { ok: false, reason: 'admin_only' };

  const { rows: locked } = await context.db.query<TemplateDbRow>(
    `SELECT ${COLUMNS} FROM template_versions WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [context.scope.workspaceId, input.templateVersionId],
  );
  const current = locked[0];
  if (current === undefined) return { ok: false, reason: 'template_unknown' };
  if (current.retired_at !== null) return { ok: false, reason: 'template_retired' };
  if (current.approved_at !== null) return { ok: false, reason: 'template_already_approved' };

  const text = { subject: current.subject, body: current.body };
  const issues = templateTextIssues(
    text,
    await rulesFor(context, { footer: { signOff: current.footer_sign_off }, requiredVariables: current.required_variables }),
  );
  if (issues.length > 0) return { ok: false, reason: 'template_unapproved', issues };

  const { rows } = await context.db.query<TemplateDbRow>(
    `UPDATE template_versions
        SET approved_at = now(), approved_by_user_id = $3, updated_at = greatest(now(), created_at)
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${COLUMNS}`,
    [context.scope.workspaceId, input.templateVersionId, approver],
  );
  const row = rows[0];
  if (row === undefined) return { ok: false, reason: 'template_unknown' };
  return { ok: true, value: { ...toTemplate(row), warnings: templateTextWarnings(text) } };
}

export type { RenderDecision };

/**
 * Render a version's subject and body for one contact.
 *
 * A required variable with no eligible value produces `missing_variables` and the
 * names, which is 11.1's "Missing required variables hold the step". It is never an
 * empty string and never a guess, because a template that reads "Hi ," is worse than
 * a step that did not go out.
 */
export function renderTemplateVersion(
  template: Pick<TemplateVersionRow, 'subject' | 'body'>,
  values: Readonly<Record<string, string>>,
): RenderDecision {
  return renderTemplate({ subject: template.subject, body: template.body }, values);
}
