import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { StepExecutionRow } from './types.ts';

/**
 * Moving an unexecuted step, and the record of why (specification 4.3, 11.2).
 *
 * Its own module since lane g82, because both the step runner (`executions.ts`) and the
 * resume (`resume.ts`) move steps, and the runner now asks the resume first — a held
 * step woken by a released hold is resumed before it is run (audit C05).
 */

export interface RescheduleInput {
  readonly execution: StepExecutionRow;
  readonly toDueAt: string;
  readonly reason: 'hold_union' | 'send_window' | 'migration' | 'retry_call';
  readonly holdUnionMilliseconds?: number | undefined;
  readonly sourceEventId?: string | undefined;
}

/**
 * Move an unexecuted step forward and record why.
 *
 * `original_due_at` never moves, and the shift row is append-only, so "original and
 * shifted timing history" (11.2) survives every later move. A shift that would move
 * work earlier is refused by the database rather than clamped here, because a caller
 * asking to move a send earlier has a bug this should not hide.
 */
export async function rescheduleExecution(
  context: RepositoryContext,
  input: RescheduleInput,
): Promise<void> {
  const from = input.execution.dueAt;
  const shift = Date.parse(input.toDueAt) - Date.parse(from);
  if (shift <= 0) return;

  await context.db.query(
    `UPDATE step_executions
        SET due_at = $3::timestamptz,
            not_before = GREATEST(not_before, $3::timestamptz),
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND state IN ('pending', 'held')`,
    [context.scope.workspaceId, input.execution.id, input.toDueAt],
  );
  await context.db.query(
    `INSERT INTO step_execution_shifts
       (workspace_id, step_execution_id, enrollment_id, from_due_at, to_due_at,
        shift_milliseconds, reason, hold_union_milliseconds, source_event_id)
     VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8, $9)`,
    [
      context.scope.workspaceId,
      input.execution.id,
      input.execution.enrollmentId,
      from,
      input.toDueAt,
      shift,
      input.reason,
      input.holdUnionMilliseconds ?? null,
      input.sourceEventId ?? null,
    ],
  );
}
