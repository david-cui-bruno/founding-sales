import { isAdminScope, type RepositoryContext } from '../db/workspaceScope.ts';
import { readTemplateVersion } from '../templates/templates.ts';
import { listSequenceVersions, readSequenceSteps, readSequenceVersion } from './rows.ts';
import {
  acceptSequence,
  isStepChannel,
  refuseSequence,
  type SequenceDelay,
  type SequenceResult,
  type SequenceRow,
  type SequenceStepRow,
  type SequenceVersionRow,
} from './types.ts';
import type { StepChannel } from '@fss/contracts';

/**
 * Sequence definition and publication (specification 11.1; wave 2, S3).
 *
 * `sequences`, `sequence_versions` and ordered `sequence_steps` define email and
 * call-task plans with delays and step-specific behavior. A draft may change in every
 * way. Since migration 0019 a published version's steps are edited in place too
 * (`saveSteps`): the edit reaches every live enrollment on the version, because a step
 * not yet prepared for sending reads its step and template when it runs, and a send
 * already prepared keeps the bytes its outbound fence froze. What an in-place edit may
 * not do is rewrite history: a step that already has executions keeps its channel and
 * cannot be removed (`step_in_use`). "Edit as a new draft" (`createDraftVersion`) is
 * kept for desktop 1.0.11 and deprecated.
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
 * Start a draft: with no steps it copies the newest published version ("Edit as a new
 * draft" on desktop 1.0.11). @deprecated since wave 2 (S3): a published version is
 * edited in place with `saveSteps`, which reaches its live enrollments; a new version
 * does not. Kept until desktop 1.0.12 is in use.
 *
 * There is at most one draft per sequence (`sequence_versions_one_draft`), so a second
 * request answers the draft that is already there — with the steps it was given, when
 * it was given any — rather than inserting a second one. Until 26 September 2026 it
 * inserted, the constraint raised, and `runCommand` answered 500. The sequence row is
 * locked first, so two requests racing see the same draft.
 *
 * The steps are checked before the version row is written (lane D1): a refusal commits
 * with its receipt, so a check after the insert left an empty draft behind every time.
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

  const { rows: drafts } = await context.db.query<{ id: string; version: number }>(
    `SELECT id, version FROM sequence_versions WHERE workspace_id = $1 AND sequence_id = $2 AND state = 'draft'`,
    [context.scope.workspaceId, input.sequenceId],
  );
  const draft = drafts[0];
  if (draft !== undefined) {
    if (input.steps !== undefined) {
      const written = await replaceDraftSteps(context, { sequenceVersionId: draft.id, steps: input.steps });
      if (!written.ok) return written;
    }
    return acceptSequence({ sequenceVersionId: draft.id, version: Number(draft.version) });
  }

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

  const steps =
    input.steps ?? (copyFrom === null ? [] : stepsCopiedFrom(await readSequenceSteps(context, copyFrom)));
  const shape = validateSteps(steps);
  if (shape !== null) return refuseSequence(shape);

  const created = await context.db.query<{ id: string }>(
    `INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, $3) RETURNING id`,
    [context.scope.workspaceId, input.sequenceId, version],
  );
  const sequenceVersionId = created.rows[0]?.id;
  if (sequenceVersionId === undefined) return refuseSequence('invalid_input');

  const written = await replaceDraftSteps(context, { sequenceVersionId, steps });
  if (!written.ok) return written;
  return acceptSequence({ sequenceVersionId, version });
}

/** The steps a new draft copies from a published version, numbered 1..n by place. */
function stepsCopiedFrom(steps: readonly SequenceStepRow[]): DraftStepInput[] {
  return steps.map((step, index) => ({
    ordinal: index + 1,
    channel: step.channel,
    delay: step.delay,
    ...(step.onNoAnswer === null ? {} : { onNoAnswer: step.onNoAnswer }),
    ...(step.templateVersionId === null ? {} : { templateVersionId: step.templateVersionId }),
  }));
}

export interface ReplaceDraftStepsInput {
  readonly sequenceVersionId: string;
  readonly steps: readonly DraftStepInput[];
}

/**
 * Save a version's steps: a draft's wholesale, a published version's in place (wave 2, S3).
 *
 * The steps are the whole list, numbered 1..n by place, which is what the editor sends.
 * A retired version refuses. A published one is held to what publication checks — at
 * least one step, and every email step on an approved, unretired template — and is
 * matched to its stored steps by ordinal: a step at an ordinal that exists is updated in
 * place (delay, template, no-answer rule, and channel while it has no executions), a
 * new ordinal is added, and a trailing step is removed only while nothing has executed
 * it. Every check runs before anything is written, because a refusal commits with its
 * receipt. A delay edit moves the steps whose executions do not exist yet; one already
 * scheduled keeps its due instant.
 */
export async function saveSteps(
  context: RepositoryContext,
  input: ReplaceDraftStepsInput,
): Promise<SequenceResult<{ readonly steps: number }>> {
  if (!isAdminScope(context.scope)) return refuseSequence('admin_only');

  const version = await readSequenceVersion(context, input.sequenceVersionId);
  if (version === null) return refuseSequence('version_unknown');
  if (version.state === 'retired') return refuseSequence('version_retired');
  if (version.state === 'draft') return await replaceDraftSteps(context, input);

  const shape = validateSteps(input.steps);
  if (shape !== null) return refuseSequence(shape);
  if (input.steps.length === 0) return refuseSequence('version_has_no_steps');
  const templates = await refuseUnpublishableTemplates(context, input.steps);
  if (templates !== null) return refuseSequence(templates);

  const executed = await stepsWithExecutions(context, input.sequenceVersionId);
  const byOrdinal = new Map(version.steps.map(step => [step.ordinal, step]));
  const wanted = [...input.steps].sort((left, right) => left.ordinal - right.ordinal);
  for (const step of version.steps) {
    const replacement = wanted[step.ordinal - 1];
    if (!executed.has(step.id)) continue;
    if (replacement === undefined || replacement.channel !== step.channel) return refuseSequence('step_in_use');
  }

  for (const step of version.steps) {
    if (step.ordinal > wanted.length) {
      await context.db.query('DELETE FROM sequence_steps WHERE workspace_id = $1 AND id = $2', [
        context.scope.workspaceId,
        step.id,
      ]);
    }
  }
  for (const step of wanted) {
    const stored = byOrdinal.get(step.ordinal);
    const values = [
      step.channel,
      step.delay.unit,
      step.delay.unit === 'elapsed' ? step.delay.hours : step.delay.days,
      step.onNoAnswer ?? null,
      step.templateVersionId ?? null,
    ];
    if (stored === undefined) {
      await context.db.query(
        `INSERT INTO sequence_steps
           (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount,
            on_no_answer, template_version_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [context.scope.workspaceId, input.sequenceVersionId, step.ordinal, ...values],
      );
    } else {
      await context.db.query(
        `UPDATE sequence_steps
            SET channel = $3, delay_unit = $4, delay_amount = $5, on_no_answer = $6, template_version_id = $7
          WHERE workspace_id = $1 AND id = $2`,
        [context.scope.workspaceId, stored.id, ...values],
      );
    }
  }
  return acceptSequence({ steps: wanted.length });
}

/** The ids of a version's steps that any execution names. */
async function stepsWithExecutions(context: RepositoryContext, sequenceVersionId: string): Promise<ReadonlySet<string>> {
  const { rows } = await context.db.query<{ step_id: string }>(
    `SELECT DISTINCT e.step_id FROM step_executions e
       JOIN sequence_steps s ON s.workspace_id = e.workspace_id AND s.id = e.step_id
      WHERE e.workspace_id = $1 AND s.sequence_version_id = $2`,
    [context.scope.workspaceId, sequenceVersionId],
  );
  return new Set(rows.map(row => row.step_id));
}

/** 12.2 at publication: every email step names an approved, unretired template. Null means fine. */
async function refuseUnpublishableTemplates(
  context: RepositoryContext,
  steps: readonly { readonly templateVersionId?: string | null | undefined }[],
): Promise<'template_unknown' | 'template_retired' | 'template_unapproved' | null> {
  for (const step of steps) {
    if (step.templateVersionId === undefined || step.templateVersionId === null) continue;
    const template = await readTemplateVersion(context, step.templateVersionId);
    if (template === null) return 'template_unknown';
    if (template.retiredAt !== null) return 'template_retired';
    if (template.approvedAt === null) return 'template_unapproved';
  }
  return null;
}

/**
 * Replace a draft's steps wholesale.
 *
 * Wholesale rather than one edit at a time because the ordinals are a sequence and a
 * per-step edit has to renumber its neighbours anyway; doing it in one statement means
 * `sequence_steps_one_per_ordinal` never sees an intermediate state with two steps at
 * ordinal 2. A draft has no executions, so nothing points at the rows it replaces.
 */
async function replaceDraftSteps(
  context: RepositoryContext,
  input: ReplaceDraftStepsInput,
): Promise<SequenceResult<{ readonly steps: number }>> {
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
          on_no_answer, template_version_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        context.scope.workspaceId,
        input.sequenceVersionId,
        step.ordinal,
        step.channel,
        step.delay.unit,
        step.delay.unit === 'elapsed' ? step.delay.hours : step.delay.days,
        step.onNoAnswer ?? null,
        step.templateVersionId ?? null,
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
    if (!isStepChannel(step.channel)) return 'invalid_input';
    const needsTemplate = step.channel === 'email';
    const needsRetry = step.channel === 'call_task';
    if (needsTemplate !== (step.templateVersionId !== undefined)) return 'invalid_input';
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
  if (!version.steps.every(step => isStepChannel(step.channel))) return refuseSequence('invalid_input');

  const templates = await refuseUnpublishableTemplates(context, version.steps);
  if (templates !== null) return refuseSequence(templates);

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
 * halfway through a cadence is not a thing this system does. A fix to a plan in use is
 * an edit in place (`saveSteps`), which reaches the enrollments already on it.
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
