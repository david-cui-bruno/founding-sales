import type { RepositoryContext } from '../db/workspaceScope.ts';

/**
 * Which firms the daily sweep re-reads (`research.sweep`).
 *
 * Research is otherwise driven by events — a firm is created, a person clicks, a link
 * is added — and events do not cover the one case that matters most: a firm imported
 * on a day the ceiling was already spent, which would otherwise never be looked at
 * again. The sweep is the backstop, and it is why an import of two hundred rows
 * enqueues two hundred runs that the ceilings pace across days rather than dropping
 * a hundred and fifty of them.
 *
 * Five conditions, and each one is a thing that would otherwise be a wasted call:
 *
 *   * `active` and not merged — a merged firm's record is history;
 *   * no active firm-wide suppression — 10.2, the same rule the enqueue asks;
 *   * **no closed opportunity** — a firm that was Won is a client and one that was
 *     Lost has said no. Re-researching either is spending money to put somebody back
 *     on a morning list they have already left. This is the same sentence Today's
 *     lane 4 uses for "new", and deliberately the same one;
 *   * never researched, or last completed more than ninety days ago. A firm's own
 *     website does not change weekly, and re-reading one that has not is the cheapest
 *     way to spend a month's budget on nothing;
 *   * oldest first, by `created_at`, so the backlog drains in the order it arrived
 *     and two sweeps of the same data choose the same firms.
 */

/** How long a completed run stays fresh. */
export const SWEEP_STALE_DAYS = 90;

export interface SweepCandidate {
  readonly firmId: string;
}

export async function selectFirmsForSweep(
  context: RepositoryContext,
  input: { readonly limit: number; readonly at: string },
): Promise<readonly SweepCandidate[]> {
  const { rows } = await context.db.query<{ id: string }>(
    `SELECT f.id
       FROM firms f
      WHERE f.workspace_id = $1
        AND f.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM effective_suppressions e
           WHERE e.workspace_id = f.workspace_id AND e.scope = 'firm' AND e.canonical_key = f.id::text
        )
        AND NOT EXISTS (
          SELECT 1 FROM opportunities o
           WHERE o.workspace_id = f.workspace_id AND o.firm_id = f.id AND o.status <> 'open'
        )
        AND NOT EXISTS (
          SELECT 1 FROM research_runs r
           WHERE r.workspace_id = f.workspace_id AND r.firm_id = f.id
             AND r.outcome = 'completed'
             AND r.completed_at > $2::timestamptz - ($3 || ' days')::interval
        )
        -- And nothing already in flight, so a sweep that overlaps a click does not
        -- queue a second revision of work somebody is already waiting on.
        AND NOT EXISTS (
          SELECT 1 FROM research_runs r
           WHERE r.workspace_id = f.workspace_id AND r.firm_id = f.id AND r.outcome = 'running'
        )
      ORDER BY f.created_at, f.id
      LIMIT $4`,
    [context.scope.workspaceId, input.at, String(SWEEP_STALE_DAYS), Math.max(0, Math.trunc(input.limit))],
  );
  return rows.map(row => ({ firmId: row.id }));
}
