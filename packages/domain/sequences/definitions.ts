import { isAdminScope, type RepositoryContext } from '../db/workspaceScope.ts';
import { readTemplateVersion } from '../templates/templates.ts';
import { underImmutabilityGuard } from './immutability.ts';
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
 * Sequence definition and publication (specification 11.1; wave 2, S3; send-path v2, S2).
 *
 * `sequences`, `sequence_versions` and ordered `sequence_steps` define email and
 * call-task plans with delays and step-specific behavior. A draft may change in every
 * way. **A published version never changes** (David, 30 September 2026: "Existing
 * enrollments keep their original steps, template versions, and cadence. Edits affect
 * new enrollments by default."). Saving steps against a published version writes them
 * to the sequence's draft — a new version, copied from the published one with the edit
 * applied — and leaves every published row as it was; publishing that draft is what
 * makes it the version new enrollments use. An enrollment already running keeps its
 * own version, and moves to a newer one only through the explicit, audited migration
 * (`migrateEnrollment.ts`). Migration 0026 puts the trigger that refuses an UPDATE or
 * DELETE of a published version's steps back, and `underImmutabilityGuard` answers it as
 * a refusal rather than a 500 should any path ever reach it.
 *
 * Wave 2 (S3, migration 0019) edited published steps in place so that a fix reached the
 * live enrollments; that is exactly the guarantee David's decision withdrew, because a
 * live enrollment could then run steps nobody had agreed to under its old agreement.
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
 *
 * Lock order for every command here that decides about a version: the sequence row,
 * then the version row, both `FOR UPDATE`, before the state is read. So a save and a
 * publication of the same draft serialize, and neither decides on a state the other is
 * about to change.
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
 * draft" on desktop 1.0.11). `saveSteps` against a published version comes here too,
 * with the edited steps: that is how an edit of a published version becomes a new one.
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

/** What a save answers: where the steps went, which is not always the version named. */
export interface SavedSteps {
  readonly steps: number;
  /** The version the steps were written to: the one named, or the draft a published edit became. */
  readonly sequenceVersionId: string;
  readonly version: number;
  /** True when the named version was published and the edit was written as a new draft. */
  readonly newVersion: boolean;
}

/**
 * A save's answer. `draft_exists` carries the draft it would have overwritten, so the
 * route can name it and the editor can offer it.
 */
export type SaveStepsResult =
  | SequenceResult<SavedSteps>
  | {
      readonly ok: false;
      readonly reason: 'draft_exists';
      readonly draft: { readonly sequenceVersionId: string; readonly version: number };
    };

interface LockedVersion {
  readonly id: string;
  readonly sequenceId: string;
  readonly version: number;
  readonly state: 'draft' | 'published' | 'retired';
}

/**
 * Lock a version for a decision about it: its sequence row, then the version row, both
 * `FOR UPDATE`, and the state read after the locks are held (the order in the header).
 */
async function lockVersion(context: RepositoryContext, sequenceVersionId: string): Promise<LockedVersion | null> {
  const { rows: owner } = await context.db.query<{ sequence_id: string }>(
    'SELECT sequence_id FROM sequence_versions WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, sequenceVersionId],
  );
  const sequenceId = owner[0]?.sequence_id;
  if (sequenceId === undefined) return null;
  await context.db.query('SELECT id FROM sequences WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
    context.scope.workspaceId,
    sequenceId,
  ]);
  const { rows } = await context.db.query<{ id: string; sequence_id: string; version: number; state: LockedVersion['state'] }>(
    `SELECT id, sequence_id, version, state FROM sequence_versions
      WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [context.scope.workspaceId, sequenceVersionId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return { id: row.id, sequenceId: row.sequence_id, version: Number(row.version), state: row.state };
}

/**
 * Save a version's steps (send-path v2, S2).
 *
 * The steps are the whole list, numbered 1..n by place, which is what the editor sends.
 *
 *   * **A draft** has its steps replaced wholesale.
 *   * **A published version** is not written to. The steps become a new draft version
 *     (copy + change) and the answer names it (`newVersion: true`). The published
 *     version, its steps, and every enrollment on it are exactly as they were. When the
 *     sequence already has a draft the save refuses `draft_exists`, naming it, rather
 *     than overwriting somebody's unpublished work (there is at most one per sequence).
 *   * **A retired version** refuses.
 *
 * A draft is held only to its shape; publication checks the rest (at least one step,
 * every email step on an approved template). The writes run under
 * `underImmutabilityGuard`, so 0026's trigger, should anything reach it, is the refusal
 * `version_not_draft` rather than a 500.
 */
export async function saveSteps(
  context: RepositoryContext,
  input: ReplaceDraftStepsInput,
): Promise<SaveStepsResult> {
  if (!isAdminScope(context.scope)) return refuseSequence('admin_only');
  const shape = validateSteps(input.steps);
  if (shape !== null) return refuseSequence(shape);

  return await underImmutabilityGuard(
    context,
    (): SaveStepsResult => refuseSequence<SavedSteps>('version_not_draft'),
    async () => {
      const version = await lockVersion(context, input.sequenceVersionId);
      if (version === null) return refuseSequence('version_unknown');
      if (version.state === 'retired') return refuseSequence('version_retired');
      if (version.state === 'draft') {
        const written = await replaceDraftSteps(context, input);
        if (!written.ok) return written;
        return acceptSequence({
          steps: written.value.steps,
          sequenceVersionId: version.id,
          version: version.version,
          newVersion: false,
        });
      }
      // One draft per sequence, and somebody else's draft is not overwritten (David,
      // 30 September 2026): the edit is refused, naming the draft, so the person makes it
      // there — or publishes that draft first.
      const { rows: drafts } = await context.db.query<{ id: string; version: number }>(
        `SELECT id, version FROM sequence_versions WHERE workspace_id = $1 AND sequence_id = $2 AND state = 'draft'`,
        [context.scope.workspaceId, version.sequenceId],
      );
      const existing = drafts[0];
      if (existing !== undefined) {
        return {
          ok: false,
          reason: 'draft_exists',
          draft: { sequenceVersionId: existing.id, version: Number(existing.version) },
        };
      }
      const draft = await createDraftVersion(context, { sequenceId: version.sequenceId, steps: input.steps });
      if (!draft.ok) return draft;
      return acceptSequence({
        steps: input.steps.length,
        sequenceVersionId: draft.value.sequenceVersionId,
        version: draft.value.version,
        newVersion: true,
      });
    },
  );
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
 * Publish a draft, which freezes it and everything under it, and retire the version
 * that was current before it (one current version per sequence).
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

  if ((await lockVersion(context, input.sequenceVersionId)) === null) return refuseSequence('version_unknown');
  const version = await readSequenceVersion(context, input.sequenceVersionId);
  if (version === null) return refuseSequence('version_unknown');
  if (version.state !== 'draft') return refuseSequence('version_not_draft');
  if (version.steps.length === 0) return refuseSequence('version_has_no_steps');

  const ordinals = version.steps.map(step => step.ordinal);
  if (!ordinals.every((ordinal, index) => ordinal === index + 1)) return refuseSequence('invalid_input');
  if (!version.steps.every(step => isStepChannel(step.channel))) return refuseSequence('invalid_input');

  const templates = await refuseUnpublishableTemplates(context, version.steps);
  if (templates !== null) return refuseSequence(templates);

  // One current version per sequence (David, 30 September 2026): the version published
  // before this one is retired in the same command. Retiring stops new enrollments and
  // nothing else — its running enrollments keep reading its steps, which 0026's trigger
  // keeps frozen — and the only way one of them moves is `migrateEnrollment`.
  await context.db.query(
    `UPDATE sequence_versions
        SET state = 'retired', retired_at = now(), retired_by_user_id = $4, updated_at = now()
      WHERE workspace_id = $1 AND sequence_id = $2 AND state = 'published' AND id <> $3`,
    [context.scope.workspaceId, version.sequenceId, input.sequenceVersionId, context.scope.actor.userId],
  );
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
 * a new version (`saveSteps`, then `publishVersion`), and an enrollment moves to it only
 * through the explicit migration (`migrateEnrollment.ts`).
 */
export async function retireVersion(
  context: RepositoryContext,
  input: { readonly sequenceVersionId: string },
): Promise<SequenceResult<SequenceVersionRow>> {
  if (!isAdminScope(context.scope)) return refuseSequence('admin_only');
  if (context.scope.actor.kind !== 'user') return refuseSequence('admin_only');

  if ((await lockVersion(context, input.sequenceVersionId)) === null) return refuseSequence('version_unknown');
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
