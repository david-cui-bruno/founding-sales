import { isAdminScope, type RepositoryContext } from '../db/workspaceScope.ts';
import { resolveStepDue } from '../src/index.ts';
import { calendarOfEnrollment, stepForCadence } from './enrollments.ts';
import { loadEnrollmentForUpdate, readSequenceVersion, unexecutedExecutions } from './rows.ts';
import { acceptSequence, isStepChannel, refuseSequence, type SequenceResult } from './types.ts';

/**
 * The audited enrollment migration (specification 11.1, Appendix A "Migrate
 * enrollments").
 *
 * "A published correction in use requires an audited admin migration: pause selected
 * enrollments; map only unexecuted steps; preserve executed history; recompute due
 * times; validate version agreement; and require explicit approval."
 *
 * Six clauses, six behaviours, in that order:
 *
 *   * **pause** — every selected enrollment gets `migration_paused_at` before
 *     anything is remapped, so a due step cannot run against a half-migrated plan;
 *   * **map only unexecuted steps** — an execution in `completed` or `cancelled` is
 *     never touched, and the remap matches by *ordinal*;
 *   * **preserve executed history** — which is the same sentence from the other end:
 *     the executed rows keep their step id, pointing at the old version's step, and
 *     that step still exists because a published version is never deleted;
 *   * **recompute due times** — from the new step's delay, still start-anchored to
 *     the enrollment's own beginning;
 *   * **validate version agreement** — an enrollment on a different version than the
 *     one the migration names is refused, by name, and recorded as refused;
 *   * **require explicit approval** — `applyEnrollmentMigration` refuses anything
 *     that is not in state `approved`, and the database refuses an `applied` row with
 *     no approver at all.
 *
 * The three commands are separate on purpose. A propose-and-apply in one call would
 * make "explicit approval" a parameter, and a parameter is not an approval.
 */

export interface ProposeMigrationInput {
  readonly fromSequenceVersionId: string;
  readonly toSequenceVersionId: string;
  readonly enrollmentIds: readonly string[];
  readonly commandId?: string | undefined;
}

export interface MigrationItemOutcome {
  readonly enrollmentId: string;
  readonly outcome: 'selected' | 'remapped' | 'refused';
  readonly refusalCode: string | null;
  readonly executionsRemapped: number;
  readonly executionsPreserved: number;
}

export interface MigrationReport {
  readonly migrationId: string;
  readonly state: string;
  readonly items: readonly MigrationItemOutcome[];
}

/** Propose a migration and record which enrollments it would touch. Changes nothing else. */
export async function proposeEnrollmentMigration(
  context: RepositoryContext,
  input: ProposeMigrationInput,
): Promise<SequenceResult<MigrationReport>> {
  if (!isAdminScope(context.scope)) return refuseSequence('admin_only');
  if (context.scope.actor.kind !== 'user') return refuseSequence('admin_only');
  if (input.fromSequenceVersionId === input.toSequenceVersionId) return refuseSequence('invalid_input');

  const target = await readSequenceVersion(context, input.toSequenceVersionId);
  if (target === null) return refuseSequence('version_unknown');
  if (target.state !== 'published') return refuseSequence('version_not_published');
  // A version stored before 25 September 2026 may have a LinkedIn step, which nothing runs.
  if (!target.steps.every(step => isStepChannel(step.channel))) return refuseSequence('step_unknown');

  const { rows } = await context.db.query<{ id: string }>(
    `INSERT INTO enrollment_migrations
       (workspace_id, from_sequence_version_id, to_sequence_version_id, requested_by_user_id, command_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      context.scope.workspaceId,
      input.fromSequenceVersionId,
      input.toSequenceVersionId,
      context.scope.actor.userId,
      input.commandId ?? null,
    ],
  );
  const migrationId = rows[0]?.id;
  if (migrationId === undefined) return refuseSequence('invalid_input');

  const items: MigrationItemOutcome[] = [];
  for (const enrollmentId of input.enrollmentIds) {
    const enrollment = await loadEnrollmentForUpdate(context, enrollmentId);
    if (enrollment === null) continue;
    const refusal =
      enrollment.endedAt !== null
        ? 'enrollment_not_live'
        : enrollment.sequenceVersionId !== input.fromSequenceVersionId
          ? 'version_mismatch'
          : null;
    await context.db.query(
      `INSERT INTO enrollment_migration_items
         (workspace_id, migration_id, enrollment_id, firm_id, outcome, refusal_code)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        context.scope.workspaceId,
        migrationId,
        enrollment.id,
        enrollment.firmId,
        refusal === null ? 'selected' : 'refused',
        refusal,
      ],
    );
    items.push({
      enrollmentId: enrollment.id,
      outcome: refusal === null ? 'selected' : 'refused',
      refusalCode: refusal,
      executionsRemapped: 0,
      executionsPreserved: 0,
    });
    if (refusal === null) {
      await context.db.query(
        `UPDATE sequence_enrollments SET migration_paused_at = now(), updated_at = now()
          WHERE workspace_id = $1 AND id = $2`,
        [context.scope.workspaceId, enrollment.id],
      );
    }
  }
  return acceptSequence({ migrationId, state: 'proposed', items });
}

/** The explicit approval 11.1 requires. A separate command, by a person, with a name on it. */
export async function approveEnrollmentMigration(
  context: RepositoryContext,
  input: { readonly migrationId: string },
): Promise<SequenceResult<{ readonly migrationId: string; readonly state: string }>> {
  if (!isAdminScope(context.scope)) return refuseSequence('admin_only');
  if (context.scope.actor.kind !== 'user') return refuseSequence('admin_only');

  const { rows } = await context.db.query<{ state: string }>(
    `UPDATE enrollment_migrations
        SET state = 'approved', approved_at = now(), approved_by_user_id = $3
      WHERE workspace_id = $1 AND id = $2 AND state = 'proposed'
      RETURNING state`,
    [context.scope.workspaceId, input.migrationId, context.scope.actor.userId],
  );
  const state = rows[0]?.state;
  if (state === undefined) return refuseSequence('migration_unknown');
  return acceptSequence({ migrationId: input.migrationId, state });
}

/**
 * Apply an approved migration.
 *
 * Every unexecuted execution is matched to the new version by ordinal. A step the new
 * version does not have at that ordinal is cancelled rather than left pointing at the
 * old plan — an enrollment half on one version and half on another is the state this
 * command exists to prevent.
 */
export async function applyEnrollmentMigration(
  context: RepositoryContext,
  input: { readonly migrationId: string },
): Promise<SequenceResult<MigrationReport>> {
  if (!isAdminScope(context.scope)) return refuseSequence('admin_only');

  const { rows: migrations } = await context.db.query<{
    state: string;
    to_sequence_version_id: string;
  }>(
    `SELECT state, to_sequence_version_id FROM enrollment_migrations
      WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [context.scope.workspaceId, input.migrationId],
  );
  const migration = migrations[0];
  if (migration === undefined) return refuseSequence('migration_unknown');
  if (migration.state === 'applied') return refuseSequence('migration_already_applied');
  if (migration.state !== 'approved') return refuseSequence('migration_not_approved');

  const target = await readSequenceVersion(context, migration.to_sequence_version_id);
  if (target === null) return refuseSequence('version_unknown');

  const { rows: selected } = await context.db.query<{ id: string; enrollment_id: string }>(
    `SELECT id, enrollment_id FROM enrollment_migration_items
      WHERE workspace_id = $1 AND migration_id = $2 AND outcome = 'selected'
      ORDER BY enrollment_id`,
    [context.scope.workspaceId, input.migrationId],
  );

  const items: MigrationItemOutcome[] = [];
  for (const item of selected) {
    const enrollment = await loadEnrollmentForUpdate(context, item.enrollment_id);
    if (enrollment === null) continue;
    const calendar = await calendarOfEnrollment(context, enrollment);
    const pending = await unexecutedExecutions(context, enrollment.id);

    let remapped = 0;
    for (const execution of pending) {
      const step = target.steps.find(candidate => candidate.ordinal === execution.ordinal);
      if (step === undefined) {
        await context.db.query(
          `UPDATE step_executions
              SET state = 'cancelled', cancelled_at = now(), cancel_reason = 'migration',
                  hold_reason_code = NULL, updated_at = now()
            WHERE workspace_id = $1 AND id = $2`,
          [context.scope.workspaceId, execution.id],
        );
        continue;
      }
      const due = resolveStepDue(
        stepForCadence(step),
        enrollment.startedAt,
        enrollment.firmTimeZone,
        calendar,
      );
      await context.db.query(
        `UPDATE step_executions
            SET step_id = $3, channel = $4, due_at = $5::timestamptz,
                not_before = GREATEST(not_before, $5::timestamptz),
                source_zone = $6, rule_version = $7, updated_at = now()
          WHERE workspace_id = $1 AND id = $2`,
        [
          context.scope.workspaceId,
          execution.id,
          step.id,
          step.channel,
          due.dueAt,
          due.sourceZone,
          due.ruleVersion,
        ],
      );
      remapped += 1;
    }

    const preserved = await context.db.query(
      `SELECT 1 FROM step_executions
        WHERE workspace_id = $1 AND enrollment_id = $2 AND state IN ('completed', 'dispatched')`,
      [context.scope.workspaceId, enrollment.id],
    );

    await context.db.query(
      `UPDATE sequence_enrollments
          SET sequence_version_id = $3, migration_paused_at = NULL, updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [context.scope.workspaceId, enrollment.id, migration.to_sequence_version_id],
    );
    await context.db.query(
      `UPDATE enrollment_migration_items
          SET outcome = 'remapped', executions_remapped = $3, executions_preserved = $4
        WHERE workspace_id = $1 AND id = $2`,
      [context.scope.workspaceId, item.id, remapped, preserved.rows.length],
    );
    items.push({
      enrollmentId: enrollment.id,
      outcome: 'remapped',
      refusalCode: null,
      executionsRemapped: remapped,
      executionsPreserved: preserved.rows.length,
    });
  }

  await context.db.query(
    `UPDATE enrollment_migrations SET state = 'applied', applied_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, input.migrationId],
  );
  return acceptSequence({ migrationId: input.migrationId, state: 'applied', items });
}
