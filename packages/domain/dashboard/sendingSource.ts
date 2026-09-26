import type { RepositoryContext } from '../db/workspaceScope.ts';
import { classifierFacts } from './classifierSource.ts';
import { enrollmentFacts } from './enrollmentSource.ts';
import {
  type DashboardAudience,
  type DashboardSources,
  type DashboardWindow,
  type SendingFacts,
} from './sources.ts';

/**
 * 13.4's sending figures, read from G7-2's tables (migration 0010): the two the Mac
 * shows (`apps/desktop/src/renderer/homeView.ts`), each counted by the instant it
 * happened at rather than by the fence's creation:
 *
 *   * `sent` — `state = 'sent'`, by `sent_at`;
 *   * `held` — `state = 'held'`, by `held_at`.
 *
 * Wave 2 (S6) cut the rest — the unknown/skipped/delivered counts, provider deferrals,
 * reputation warnings, the domain and ramp posture, and the template, sequence,
 * weekday, hour and segment breakdowns. Nothing read them; the sending section reads
 * `/outbound/status` for the posture.
 *
 * Counts follow the dashboard's audience rule (`docs/decisions/g9-dashboard-visibility.md`):
 * an admin's figures are the workspace's, a salesperson's are their own assigned
 * firms'.
 */

type CountRow = {
  readonly [column: string]: unknown;
  sent: string;
  held: string;
};

/**
 * Every fence on a firm the caller may see, as a common table expression the query
 * below starts from. The audience is a nullable parameter rather than two
 * query strings so there is one place the visibility rule is written.
 */
const VISIBLE_FENCES = `
  SELECT om.*
    FROM outbound_messages om
    JOIN firms f ON f.workspace_id = om.workspace_id AND f.id = om.firm_id
   WHERE om.workspace_id = $1
     AND ($4::uuid IS NULL OR f.assigned_user_id = $4::uuid)
`;

export async function sendingFacts(
  context: RepositoryContext,
  window: DashboardWindow,
  audience: DashboardAudience,
): Promise<SendingFacts> {
  const counts = await context.db.query<CountRow>(
    `WITH visible AS (${VISIBLE_FENCES})
     SELECT count(*) FILTER (WHERE state = 'sent'
                               AND sent_at >= $2::timestamptz AND sent_at < $3::timestamptz)::text AS sent,
            count(*) FILTER (WHERE state = 'held'
                               AND held_at >= $2::timestamptz AND held_at < $3::timestamptz)::text AS held
       FROM visible`,
    [context.scope.workspaceId, window.from, window.to, audience.onlyAssignedTo],
  );
  const count = counts.rows[0];
  return {
    available: true,
    sent: Number(count?.sent ?? '0'),
    held: Number(count?.held ?? '0'),
  };
}

/**
 * What the API supplies. Every method reads a table that exists.
 *
 * `unavailableDashboardSources()` stays exported and stays tested: it is what a
 * caller uses when a source is deliberately not wired, and it is the shape the next
 * figure whose table does not exist yet will take.
 */
export function liveDashboardSources(): DashboardSources {
  return { sending: sendingFacts, enrollments: enrollmentFacts, classifier: classifierFacts };
}
