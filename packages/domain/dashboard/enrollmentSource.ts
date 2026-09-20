import type { RepositoryContext } from '../db/workspaceScope.ts';
import type {
  DashboardAudience,
  DashboardWindow,
  EnrollmentFacts,
  KeyedCount,
} from './sources.ts';

/**
 * 13.4's enrollment and LinkedIn figures, read from G8's tables (migration 0012).
 *
 * ## What is counted over the window and what is counted now
 *
 * A *transition* belongs to the window it happened in: enrollments started,
 * enrollments ended, step executions completed, LinkedIn results recorded. A *state*
 * does not — "active" and "held" are facts about this instant, and reporting how
 * many were active during a window would mean either a figure that double-counts or
 * a history table G8 did not build. So the two kinds are named differently in the
 * DTO rather than blended: `started` and `ended` are the window's, `active`,
 * `reviewRequired` and `heldSteps` are now's.
 *
 * That distinction is the one an operator actually asks about. "Fourteen holds" is a
 * thing to go and clear; "fourteen holds at some point last month" is not.
 *
 * ## The read matrix
 *
 * `sequence_enrollments` carries both `assigned_user_id` and `firm_id`, and they
 * agree by construction — an enrollment is created against an opportunity on a firm.
 * The audience filter uses `firm_id` through `firms.assigned_user_id`, the same join
 * every other figure on this dashboard uses, so a firm that is reassigned moves all
 * of its figures at once rather than moving its calls and leaving its enrollments.
 */

const VISIBLE_ENROLLMENTS = `
  SELECT e.*
    FROM sequence_enrollments e
    JOIN firms f ON f.workspace_id = e.workspace_id AND f.id = e.firm_id
   WHERE e.workspace_id = $1
     AND ($4::uuid IS NULL OR f.assigned_user_id = $4::uuid)
`;

type CountsRow = {
  readonly [column: string]: unknown;
  started: string;
  active: string;
  review_required: string;
  linkedin_handoffs: string;
  linkedin_replied: string;
  linkedin_no_engagement: string;
};

type KeyedRow = {
  readonly [column: string]: unknown;
  dimension: string;
  key: string;
  count: string;
};

export async function enrollmentFacts(
  context: RepositoryContext,
  window: DashboardWindow,
  audience: DashboardAudience,
): Promise<EnrollmentFacts> {
  const scope = [context.scope.workspaceId, window.from, window.to, audience.onlyAssignedTo];

  const counts = await context.db.query<CountsRow>(
    `WITH visible AS (${VISIBLE_ENROLLMENTS})
     SELECT
       (SELECT count(*) FROM visible
         WHERE started_at >= $2::timestamptz AND started_at < $3::timestamptz)::text AS started,
       (SELECT count(*) FROM visible WHERE state = 'active')::text AS active,
       (SELECT count(*) FROM visible WHERE state = 'review_required')::text AS review_required,
       -- 11.4: the handoff is the moment the task stopped being the worker's. A
       -- cancelled LinkedIn step was never handed to anybody, so it is not one.
       (SELECT count(*) FROM step_executions x JOIN visible v ON v.id = x.enrollment_id
         WHERE x.workspace_id = $1 AND x.channel = 'linkedin_task'
           AND x.state IN ('dispatched', 'completed')
           AND x.due_at >= $2::timestamptz AND x.due_at < $3::timestamptz)::text
         AS linkedin_handoffs,
       (SELECT count(*) FROM enrollment_linkedin_results r JOIN visible v ON v.id = r.enrollment_id
         WHERE r.workspace_id = $1 AND r.result = 'replied'
           AND r.recorded_at >= $2::timestamptz AND r.recorded_at < $3::timestamptz)::text
         AS linkedin_replied,
       (SELECT count(*) FROM enrollment_linkedin_results r JOIN visible v ON v.id = r.enrollment_id
         WHERE r.workspace_id = $1 AND r.result = 'no_engagement'
           AND r.recorded_at >= $2::timestamptz AND r.recorded_at < $3::timestamptz)::text
         AS linkedin_no_engagement`,
    scope,
  );

  const keyed = await context.db.query<KeyedRow>(
    `WITH visible AS (${VISIBLE_ENROLLMENTS})
     SELECT 'ended' AS dimension, end_reason AS key, count(*)::text AS count
       FROM visible
      WHERE ended_at >= $2::timestamptz AND ended_at < $3::timestamptz AND end_reason IS NOT NULL
      GROUP BY 1, 2
     UNION ALL
     SELECT 'completed', x.channel, count(*)::text
       FROM step_executions x JOIN visible v ON v.id = x.enrollment_id
      WHERE x.workspace_id = $1 AND x.state = 'completed'
        AND x.completed_at >= $2::timestamptz AND x.completed_at < $3::timestamptz
      GROUP BY 1, 2
     UNION ALL
     SELECT 'held', x.hold_reason_code, count(*)::text
       FROM step_executions x JOIN visible v ON v.id = x.enrollment_id
      WHERE x.workspace_id = $1 AND x.state = 'held' AND x.hold_reason_code IS NOT NULL
      GROUP BY 1, 2
     ORDER BY 1, 2`,
    scope,
  );

  const row = counts.rows[0];
  const of = (dimension: string): readonly KeyedCount[] =>
    keyed.rows
      .filter(entry => entry.dimension === dimension)
      .map(entry => ({ key: entry.key, count: Number(entry.count) }));

  return {
    available: true,
    started: Number(row?.started ?? '0'),
    active: Number(row?.active ?? '0'),
    reviewRequired: Number(row?.review_required ?? '0'),
    ended: of('ended'),
    stepsCompleted: of('completed'),
    heldSteps: of('held'),
    linkedinHandoffs: Number(row?.linkedin_handoffs ?? '0'),
    linkedinRecordedReplies: Number(row?.linkedin_replied ?? '0'),
    linkedinNoEngagement: Number(row?.linkedin_no_engagement ?? '0'),
  };
}
