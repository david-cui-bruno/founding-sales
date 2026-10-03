import type { StageSuggestion } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';

/**
 * "Move to Demo booked", offered rather than done (lane M1, decision E2).
 *
 * David, 3 October 2026: deal-stage changes are manual. A Cal.com booking used to move the
 * firm's deal to Demo booked, or open one there, by itself (`applyStageEvidence`); now the
 * board card and the firm page offer the move as one click, and the click is the ordinary
 * stage command (`POST /opportunities/stage`, or `POST /opportunities/open` at the stage when
 * the firm has no deal).
 *
 * Offered for a firm when all of these hold:
 *
 *   * it has a live booking: a meeting `booked` or `rescheduled` whose scheduled end has not
 *     passed;
 *   * the workspace's `demo_booked` stage exists, is not retired and is not terminal;
 *   * its open deal sits in an earlier, non-terminal stage — or it has no deal at all, open
 *     or closed. A firm with only a closed (Lost or Live) deal is offered nothing: reopening
 *     one is a person's deliberate act, not a booking's suggestion.
 *
 * The caller decides who sees it: only a person who could make the move (an administrator
 * or the firm's assignee), as the board decides who gets an opportunity id.
 */

export const DEMO_BOOKED_STAGE_KEY = 'demo_booked';

export async function readDemoBookedSuggestions(
  context: RepositoryContext,
  firmIds: readonly string[],
): Promise<ReadonlyMap<string, StageSuggestion>> {
  if (firmIds.length === 0) return new Map();
  const { rows } = await context.db.query<{ firm_id: string; opportunity_id: string | null }>(
    `WITH target AS (
       SELECT position FROM pipeline_stages
        WHERE workspace_id = $1 AND key = $3 AND NOT retired AND terminal_kind IS NULL
     )
     SELECT f.id AS firm_id, o.id AS opportunity_id
       FROM firms f
      CROSS JOIN target t
       LEFT JOIN opportunities o ON o.workspace_id = f.workspace_id AND o.firm_id = f.id AND o.status = 'open'
       LEFT JOIN pipeline_stages s ON s.workspace_id = o.workspace_id AND s.id = o.stage_id
      WHERE f.workspace_id = $1 AND f.id = ANY($2::uuid[]) AND f.status = 'active'
        AND EXISTS (
          SELECT 1 FROM meetings m
           WHERE m.workspace_id = f.workspace_id AND m.firm_id = f.id
             AND m.state IN ('booked', 'rescheduled') AND m.ends_at > now())
        AND ((o.id IS NOT NULL AND s.terminal_kind IS NULL AND s.position < t.position)
             OR (o.id IS NULL AND NOT EXISTS (
                   SELECT 1 FROM opportunities x WHERE x.workspace_id = f.workspace_id AND x.firm_id = f.id)))`,
    [context.scope.workspaceId, [...firmIds], DEMO_BOOKED_STAGE_KEY],
  );
  return new Map(rows.map(row => [row.firm_id, { stageKey: DEMO_BOOKED_STAGE_KEY, opportunityId: row.opportunity_id }]));
}
