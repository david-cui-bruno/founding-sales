import type { RepositoryContext } from '../db/workspaceScope.ts';

/**
 * Which enrollment a hold concerns, in words (call-to-booking R2).
 *
 * A hold is scoped to a firm, an opportunity or an enrollment, and records the event that
 * opened it. Where that names one enrollment, a person reading "held" wants to know which
 * sequence and which step, so the firm page and the reply card carry this beside the
 * reason. The resolution, in order:
 *
 *   1. the hold's scope is an enrollment (the step-execution holds);
 *   2. its source is a step execution, or an outbound message that came from one;
 *   3. its scope is an opportunity with exactly one live enrollment.
 *
 * A hold that does not concern an enrollment, or concerns more than one, maps to no entry
 * and the window shows no line for it. The step is the execution the hold names, else the
 * enrollment's earliest step that has not finished. `stepNumber` is that step's ordinal
 * (the first step is 1), or null when the enrollment has no unfinished step.
 */
export interface HoldEnrollmentDto {
  readonly id: string;
  readonly sequenceName: string;
  readonly stepNumber: number | null;
}

interface Row {
  readonly hold_id: string;
  readonly enrollment_id: string;
  readonly sequence_name: string;
  readonly step_number: number | null;
  readonly [column: string]: unknown;
}

export async function holdEnrollments(
  context: RepositoryContext,
  holdIds: readonly string[],
): Promise<ReadonlyMap<string, HoldEnrollmentDto>> {
  const found = new Map<string, HoldEnrollmentDto>();
  if (holdIds.length === 0) return found;
  const { rows } = await context.db.query<Row>(
    `WITH resolved AS (
       SELECT h.id AS hold_id,
              COALESCE(
                CASE WHEN h.scope_kind = 'enrollment' THEN
                       (SELECT n.id FROM sequence_enrollments n
                         WHERE n.workspace_id = h.workspace_id AND n.id::text = h.scope_key) END,
                CASE WHEN h.source_event_kind = 'sequence.step_execution' THEN
                       (SELECT e.enrollment_id FROM step_executions e
                         WHERE e.workspace_id = h.workspace_id AND e.id::text = h.source_event_id) END,
                CASE WHEN h.source_event_kind = 'outbound_message' THEN
                       (SELECT m.enrollment_id FROM outbound_messages m
                         WHERE m.workspace_id = h.workspace_id AND m.id::text = h.source_event_id) END,
                CASE WHEN h.scope_kind = 'opportunity' THEN
                       (SELECT CASE WHEN count(*) = 1 THEN min(n.id::text)::uuid END
                          FROM sequence_enrollments n
                         WHERE n.workspace_id = h.workspace_id AND n.opportunity_id::text = h.scope_key
                           AND n.ended_at IS NULL) END
              ) AS enrollment_id,
              CASE WHEN h.source_event_kind = 'sequence.step_execution' THEN
                     (SELECT e.ordinal FROM step_executions e
                       WHERE e.workspace_id = h.workspace_id AND e.id::text = h.source_event_id)
                   WHEN h.source_event_kind = 'outbound_message' THEN
                     (SELECT e.ordinal FROM outbound_messages m
                        JOIN step_executions e ON e.workspace_id = m.workspace_id AND e.id = m.step_execution_id
                       WHERE m.workspace_id = h.workspace_id AND m.id::text = h.source_event_id)
              END AS named_ordinal
         FROM active_holds h
        WHERE h.workspace_id = $1 AND h.id = ANY($2::uuid[])
     )
     SELECT r.hold_id::text AS hold_id, n.id::text AS enrollment_id, s.name AS sequence_name,
            COALESCE(r.named_ordinal,
                     (SELECT min(e.ordinal) FROM step_executions e
                       WHERE e.workspace_id = n.workspace_id AND e.enrollment_id = n.id
                         AND e.state IN ('pending', 'held'))) AS step_number
       FROM resolved r
       JOIN sequence_enrollments n ON n.workspace_id = $1 AND n.id = r.enrollment_id
       JOIN sequence_versions v ON v.workspace_id = n.workspace_id AND v.id = n.sequence_version_id
       JOIN sequences s ON s.workspace_id = v.workspace_id AND s.id = v.sequence_id`,
    [context.scope.workspaceId, holdIds],
  );
  for (const row of rows) {
    found.set(row.hold_id, {
      id: row.enrollment_id,
      sequenceName: row.sequence_name,
      stepNumber: row.step_number === null ? null : Number(row.step_number),
    });
  }
  return found;
}
