import { isAdminScope, type RepositoryContext } from '../db/workspaceScope.ts';
import {
  decideTemplateApproval,
  renderTemplate,
  templateContentHash,
  templateTextWarnings,
  type FooterConfiguration,
  type RenderDecision,
  type TemplateWarningCode,
} from '../src/index.ts';

/**
 * Approved immutable template versions (specification 11.1, 12.6).
 *
 * The table is migration 0009's, created by the mail lane one pull request early;
 * this is the repository over it, and the rules it applies are G0's pure ones in
 * `packages/domain/src/rules/templates.ts`. Nothing here re-implements a rule: the
 * footer requirement, the copy warnings and the content hash are one function that
 * the approval calls and the send later re-checks against.
 *
 * Three things are the database's rather than this file's, and are stated here so a
 * reader does not go looking for them:
 *
 *   * a body or subject containing "unsubscribe" is refused by a CHECK, in any case
 *     (12.6, and David's decision that there is no web unsubscribe anywhere);
 *   * an approved body carries `Reply "stop"`, by a second CHECK;
 *   * an approved row is immutable by trigger, across every column an approver
 *     approved — migration 0012 extended that trigger to the five personalization
 *     columns 11.1 reserves, and migration 0015 removed one column from it.
 *
 * The footer a version stores is its sign-off alone. Migration 0015 dropped
 * `footer_postal_address` under David's 22 September decision
 * (`docs/decisions/g20-automated-email-carries-no-postal-address.md`), so the block
 * an approval checks for is the sign-off and then the stop line.
 *
 * So this file can be wrong about a rule and the database will still refuse the row.
 * That is the intended division: 11.1's immutability is a property of the data, not
 * of the code that happens to write it.
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

export interface CreateTemplateVersionInput {
  /** Absent starts a new template; present adds a version to an existing one. */
  readonly templateId?: string | undefined;
  readonly name: string;
  readonly subject: string;
  readonly body: string;
  readonly footer: FooterConfiguration;
  readonly requiredVariables: readonly string[];
}

/**
 * Write an unapproved version.
 *
 * Unapproved on purpose: 11.1 makes approval a separate, audited act, and a create
 * that also approved would mean the person who typed the body is the person who
 * approved it. The content hash is computed now anyway, so the editor can show it
 * before an approver commits to it.
 */
export async function createTemplateVersion(
  context: RepositoryContext,
  input: CreateTemplateVersionInput,
): Promise<TemplateResult<TemplateVersionWithWarnings>> {
  if (!isAdminScope(context.scope)) return { ok: false, reason: 'admin_only' };
  if (input.name.trim().length === 0) return { ok: false, reason: 'invalid_input' };

  const templateId = input.templateId ?? (await newTemplateId(context));
  const { rows: existing } = await context.db.query<{ next: number }>(
    `SELECT coalesce(max(version), 0) + 1 AS next FROM template_versions
      WHERE workspace_id = $1 AND template_id = $2`,
    [context.scope.workspaceId, templateId],
  );
  const version = Number(existing[0]?.next ?? 1);
  const contentHash = templateContentHash({
    templateId,
    version,
    subject: input.subject,
    body: input.body,
  });

  const { rows } = await context.db.query<TemplateDbRow>(
    `INSERT INTO template_versions
       (workspace_id, template_id, version, name, subject, body, content_hash,
        footer_sign_off, required_variables, personalization_strategy)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], 'deterministic')
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
    ],
  );
  const row = rows[0];
  if (row === undefined) return { ok: false, reason: 'invalid_input' };
  return { ok: true, value: withWarnings(toTemplate(row)) };
}

async function newTemplateId(context: RepositoryContext): Promise<string> {
  const { rows } = await context.db.query<{ id: string }>('SELECT gen_random_uuid() AS id');
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('the database refused to generate an identifier');
  return id;
}

/**
 * Approve a version, which freezes it.
 *
 * `decideTemplateApproval` returns every issue rather than the first, and they travel
 * back on the refusal, because an author fixing one rule at a time is a worse day
 * than an author fixing four at once. An approved version comes back with its copy
 * warnings, which approve anyway.
 */
export async function approveTemplateVersion(
  context: RepositoryContext,
  input: { readonly templateVersionId: string },
): Promise<TemplateResult<TemplateVersionWithWarnings>> {
  if (!isAdminScope(context.scope)) return { ok: false, reason: 'admin_only' };
  if (context.scope.actor.kind !== 'user') return { ok: false, reason: 'admin_only' };

  const { rows: locked } = await context.db.query<TemplateDbRow>(
    `SELECT ${COLUMNS} FROM template_versions WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [context.scope.workspaceId, input.templateVersionId],
  );
  const current = locked[0];
  if (current === undefined) return { ok: false, reason: 'template_unknown' };
  if (current.retired_at !== null) return { ok: false, reason: 'template_retired' };
  if (current.approved_at !== null) return { ok: false, reason: 'template_already_approved' };

  const decision = decideTemplateApproval(
    {
      templateId: current.template_id,
      version: Number(current.version),
      subject: current.subject,
      body: current.body,
    },
    {
      footer: { signOff: current.footer_sign_off },
      allowedVariables: current.required_variables,
    },
  );
  if (!decision.approved) {
    return { ok: false, reason: 'template_unapproved', issues: decision.issues };
  }

  const { rows } = await context.db.query<TemplateDbRow>(
    `UPDATE template_versions
        SET approved_at = now(), approved_by_user_id = $3, updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${COLUMNS}`,
    [context.scope.workspaceId, input.templateVersionId, context.scope.actor.userId],
  );
  const row = rows[0];
  if (row === undefined) return { ok: false, reason: 'template_unknown' };
  return { ok: true, value: { ...toTemplate(row), warnings: decision.warnings } };
}

/**
 * Retire a version.
 *
 * Retiring is not a deletion and does not touch an enrollment: 11.2 freezes an
 * enrollment to a sequence version, and that version's steps still name this
 * template. What retiring stops is a *new* published version being built on it, which
 * `publishVersion` checks.
 */
export async function retireTemplateVersion(
  context: RepositoryContext,
  input: { readonly templateVersionId: string },
): Promise<TemplateResult<TemplateVersionRow>> {
  if (!isAdminScope(context.scope)) return { ok: false, reason: 'admin_only' };
  const { rows } = await context.db.query<TemplateDbRow>(
    `UPDATE template_versions SET retired_at = now(), updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND retired_at IS NULL
      RETURNING ${COLUMNS}`,
    [context.scope.workspaceId, input.templateVersionId],
  );
  const row = rows[0];
  if (row === undefined) return { ok: false, reason: 'template_unknown' };
  return { ok: true, value: toTemplate(row) };
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
