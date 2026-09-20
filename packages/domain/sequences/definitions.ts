import { isAdminScope, type RepositoryContext } from '../db/workspaceScope.ts';
import { readTemplateVersion } from '../templates/index.ts';
import { listSequenceVersions, readSequenceSteps, readSequenceVersion } from './rows.ts';
import {
  acceptSequence,
  refuseSequence,
  type SequenceDelay,
  type SequenceResult,
  type SequenceRow,
  type SequenceVersionRow,
  type StepChannel,
} from './types.ts';

/**
 * Sequence definition and publication (specification 11.1).
 *
 * "`sequences`, immutable `sequence_versions`, and ordered `sequence_steps` define
 * email, call-task, and LinkedIn-task plans with delays and step-specific behavior.
 * Draft versions may change; published versions and steps are immutable by trigger.
 * Editing a published sequence creates a new draft."
 *
 * The immutability is the database's — migration 0012's triggers refuse an edit to a
 * published version and refuse an insert, update or delete of its steps. So this file
 * is about the two things a trigger cannot decide: what a *draft* may contain, and
 * what has to be true before a draft becomes publishable.
 *
 * Publication checks three things a CHECK constraint cannot:
 *
 *   * the version has at least one step, because an empty published sequence is a
 *     sequence somebody can enrol a contact in that will never do anything;
 *   * the ordinals are 1..n with no gap, because a gap means a step was deleted from
 *     a draft and the editor did not renumber, and the cadence walks by ordinal;
 *   * every email step names an approved, unretired template version — 12.2's
 *     "automatic mail is permitted only for ... an approved immutable template", moved
 *     from the moment of sending to the moment of publishing, so a salesperson never
 *     enrols anybody in a plan that cannot send its first step.
 *
 * The third is the only one of the three that is a judgement call, and it is
 * deliberately the strict reading: a draft may name an unapproved template and be
 * saved, and cannot be published until somebody approves it.
 */

export interface DraftStepInput {
  readonly ordinal: number;
  readonly channel: StepChannel;
  readonly delay: SequenceDelay;
  /** Required on a call step, refused on any other (9.1). */
  readonly onNoAnswer?: 'advance' | 'retry_call' | undefined;
  /** Required on an email step, refused on any other (11.1). */
  readonly templateVersionId?: string | undefined;
  /** Required on a LinkedIn step, refused on any other (11.3). */
  readonly linkedInMessage?: string | undefined;
}

export interface CreateSequenceInput {
  readonly name: string;
  readonly description?: string | undefined;
}

/** Create the named plan. Versions are added to it; this row never carries a step. */
export async function createSequence(
  context: RepositoryContext,
  input: CreateSequenceInput,
): Promise<SequenceResult<SequenceRow>> {
  if (!isAdminScope(context.scope)) return refuseSequence('admin_only');
  if (context.scope.actor.kind !== 'user') return refuseSequence('admin_only');
  if (input.name.trim().length === 0) return refuseSequence('invalid_input');

  const { rows } = await context.db.query<{
    id: string;
    name: string;
    description: string | null;
    archived_at: Date | null;
  }>(
    `INSERT INTO sequences (workspace_id, name, description, created_by_user_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, description, archived_at`,
    [
      context.scope.workspaceId,
      input.name.trim(),
      input.description?.trim() ?? null,
      context.scope.actor.userId,
    ],
  );
  const row = rows[0];
  if (row === undefined) return refuseSequence('invalid_input');
  return acceptSequence({
    id: row.id,
    name: row.name,
    description: row.description,
    archivedAt: row.archived_at === null ? null : row.archived_at.toISOString(),
  });
}

export async function listSequences(context: RepositoryContext): Promise<readonly SequenceRow[]> {
  const { rows } = await context.db.query<{
    id: string;
    name: string;
    description: string | null;
    archived_at: Date | null;
  }>(
    'SELECT id, name, description, archived_at FROM sequences WHERE workspace_id = $1 ORDER BY name',
    [context.scope.workspaceId],
  );
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    description: row.description,
    archivedAt: row.archived_at === null ? null : row.archived_at.toISOString(),
  }));
}

export interface CreateDraftVersionInput {
  readonly sequenceId: string;
  /** The steps of the new draft. Absent copies the highest published version's steps. */
  readonly steps?: readonly DraftStepInput[] | undefined;
}

/**
 * Start a draft. "Editing a published sequence creates a new draft" (11.1), and this
 * is that command: with no steps it copies the newest published version, which is
 * what an editor's "edit" button does.
 *
 * There is at most one draft per sequence, refused by
 * `sequence_versions_one_draft`. Two editors racing get one draft and one refusal
 * rather than two drafts that silently diverge.
 */
export async function createDraftVersion(
  context: RepositoryContext,
  input: CreateDraftVersionInput,
): Promise<SequenceResult<{ readonly sequenceVersionId: string; readonly version: number }>> {
  if (!isAdminScope(context.scope)) return refuseSequence('admin_only');

  const { rows: sequence } = await context.db.query<{ id: string }>(
    'SELECT id FROM sequences WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
    [context.scope.workspaceId, input.sequenceId],
  );
  if (sequence.length === 0) return refuseSequence('sequence_unknown');

  const { rows: next } = await context.db.query<{ next: number; newest_published: string | null }>(
    `SELECT coalesce(max(version), 0) + 1 AS next,
            (SELECT id FROM sequence_versions
              WHERE workspace_id = $1 AND sequence_id = $2 AND state = 'published'
              ORDER BY version DESC LIMIT 1) AS newest_published
       FROM sequence_versions WHERE workspace_id = $1 AND sequence_id = $2`,
    [context.scope.workspaceId, input.sequenceId],
  );
  const version = Number(next[0]?.next ?? 1);
  const copyFrom = next[0]?.newest_published ?? null;

  const created = await context.db.query<{ id: string }>(
    `INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, $3) RETURNING id`,
    [context.scope.workspaceId, input.sequenceId, version],
  );
  const sequenceVersionId = created.rows[0]?.id;
  if (sequenceVersionId === undefined) return refuseSequence('invalid_input');

  const steps =
    input.steps ??
    (copyFrom === null
      ? []
      : (await readSequenceSteps(context, copyFrom)).map(step => ({
          ordinal: step.ordinal,
          channel: step.channel,
          delay: step.delay,
          ...(step.onNoAnswer === null ? {} : { onNoAnswer: step.onNoAnswer }),
          ...(step.templateVersionId === null ? {} : { templateVersionId: step.templateVersionId }),
          ...(step.linkedInMessage === null ? {} : { linkedInMessage: step.linkedInMessage }),
        })));

  const written = await replaceDraftSteps(context, { sequenceVersionId, steps });
  if (!written.ok) return written;
  return acceptSequence({ sequenceVersionId, version });
}

export interface ReplaceDraftStepsInput {
  readonly sequenceVersionId: string;
  readonly steps: readonly DraftStepInput[];
}

/**
 * Replace a draft's steps wholesale.
 *
 * Wholesale rather than one edit at a time because the ordinals are a sequence and a
 * per-step edit has to renumber its neighbours anyway; doing it in one statement means
 * `sequence_steps_one_per_ordinal` never sees an intermediate state with two steps at
 * ordinal 2. The trigger refuses this entirely on a published version, which is what
 * makes "editing a published sequence creates a new draft" true rather than advised.
 */
export async function replaceDraftSteps(
  context: RepositoryContext,
  input: ReplaceDraftStepsInput,
): Promise<SequenceResult<{ readonly steps: number }>> {
  if (!isAdminScope(context.scope)) return refuseSequence('admin_only');

  const version = await readSequenceVersion(context, input.sequenceVersionId);
  if (version === null) return refuseSequence('version_unknown');
  if (version.state !== 'draft') return refuseSequence('version_not_draft');

  const shape = validateSteps(input.steps);
  if (shape !== null) return refuseSequence(shape);

  await context.db.query(
    'DELETE FROM sequence_steps WHERE workspace_id = $1 AND sequence_version_id = $2',
    [context.scope.workspaceId, input.sequenceVersionId],
  );
  for (const step of [...input.steps].sort((left, right) => left.ordinal - right.ordinal)) {
    await context.db.query(
      `INSERT INTO sequence_steps
         (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount,
          on_no_answer, template_version_id, linkedin_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        context.scope.workspaceId,
        input.sequenceVersionId,
        step.ordinal,
        step.channel,
        step.delay.unit,
        step.delay.unit === 'elapsed' ? step.delay.hours : step.delay.days,
        step.onNoAnswer ?? null,
        step.templateVersionId ?? null,
        step.linkedInMessage ?? null,
      ],
    );
  }
  return acceptSequence({ steps: input.steps.length });
}

/** What a step's shape has to satisfy before the database is asked. Null means fine. */
function validateSteps(steps: readonly DraftStepInput[]): 'invalid_input' | null {
  const ordinals = steps.map(step => step.ordinal).sort((left, right) => left - right);
  const contiguous = ordinals.every((ordinal, index) => ordinal === index + 1);
  if (!contiguous) return 'invalid_input';
  for (const step of steps) {
    const needsTemplate = step.channel === 'email';
    const needsMessage = step.channel === 'linkedin_task';
    const needsRetry = step.channel === 'call_task';
    if (needsTemplate !== (step.templateVersionId !== undefined)) return 'invalid_input';
    if (needsMessage !== (step.linkedInMessage !== undefined)) return 'invalid_input';
    if (needsRetry !== (step.onNoAnswer !== undefined)) return 'invalid_input';
    const amount = step.delay.unit === 'elapsed' ? step.delay.hours : step.delay.days;
    if (!Number.isInteger(amount) || amount < 0) return 'invalid_input';
  }
  return null;
}

/**
 * Publish a draft, which freezes it and everything under it.
 *
 * The three checks above, then one `UPDATE`. The trigger takes over from here: this
 * row and its steps cannot change again, and the only permitted later transition is
 * to `retired`.
 */
export async function publishVersion(
  context: RepositoryContext,
  input: { readonly sequenceVersionId: string },
): Promise<SequenceResult<SequenceVersionRow>> {
  if (!isAdminScope(context.scope)) return refuseSequence('admin_only');
  if (context.scope.actor.kind !== 'user') return refuseSequence('admin_only');

  const version = await readSequenceVersion(context, input.sequenceVersionId);
  if (version === null) return refuseSequence('version_unknown');
  if (version.state !== 'draft') return refuseSequence('version_not_draft');
  if (version.steps.length === 0) return refuseSequence('version_has_no_steps');

  const ordinals = version.steps.map(step => step.ordinal);
  if (!ordinals.every((ordinal, index) => ordinal === index + 1)) return refuseSequence('invalid_input');

  for (const step of version.steps) {
    if (step.templateVersionId === null) continue;
    const template = await readTemplateVersion(context, step.templateVersionId);
    if (template === null) return refuseSequence('template_unknown');
    if (template.retiredAt !== null) return refuseSequence('template_retired');
    if (template.approvedAt === null) return refuseSequence('template_unapproved');
  }

  await context.db.query(
    `UPDATE sequence_versions
        SET state = 'published', published_at = now(), published_by_user_id = $3, updated_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, input.sequenceVersionId, context.scope.actor.userId],
  );
  const published = await readSequenceVersion(context, input.sequenceVersionId);
  if (published === null) return refuseSequence('version_unknown');
  return acceptSequence(published);
}

/**
 * Retire a published version.
 *
 * Retiring stops new enrollments and does not touch the ones already running: 11.2
 * freezes an enrollment to its version, and pulling the plan out from under a firm
 * halfway through a cadence is not a thing this system does. The audited migration
 * command of 11.1 is how an admin moves live enrollments off a version.
 */
export async function retireVersion(
  context: RepositoryContext,
  input: { readonly sequenceVersionId: string },
): Promise<SequenceResult<SequenceVersionRow>> {
  if (!isAdminScope(context.scope)) return refuseSequence('admin_only');
  if (context.scope.actor.kind !== 'user') return refuseSequence('admin_only');

  const version = await readSequenceVersion(context, input.sequenceVersionId);
  if (version === null) return refuseSequence('version_unknown');
  if (version.state === 'retired') return refuseSequence('version_retired');
  if (version.state !== 'published') return refuseSequence('version_not_published');

  await context.db.query(
    `UPDATE sequence_versions
        SET state = 'retired', retired_at = now(), retired_by_user_id = $3, updated_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, input.sequenceVersionId, context.scope.actor.userId],
  );
  const retired = await readSequenceVersion(context, input.sequenceVersionId);
  if (retired === null) return refuseSequence('version_unknown');
  return acceptSequence(retired);
}

export { listSequenceVersions, readSequenceVersion };
