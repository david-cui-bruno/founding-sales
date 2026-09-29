import type { RepositoryContext } from '../db/workspaceScope.ts';
import { workspaceBusinessZone } from './ledger.ts';

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
 *   * never researched, or **due** by one of the four reasons below;
 *   * oldest first, by `created_at`, so the backlog drains in the order it arrived
 *     and two sweeps of the same data choose the same firms.
 *
 * ## The four reasons a researched firm is due again
 *
 *   * **Stale.** The last completed run is more than ninety days old. A firm's own
 *     website does not change weekly, and re-reading one that has not is the cheapest
 *     way to spend a month's budget on nothing.
 *   * **The last run failed.** This is the retry ladder. A provider failure completes
 *     its job rather than throwing, because throwing would roll back the accounting of
 *     a call that was already paid for (`enrichment.ts`), so the retry has to be a new
 *     revision with a new clearance — and the sweep is what issues it, on the next
 *     business day rather than in the next minute, because a provider that failed this
 *     morning will most likely fail again this morning. Three consecutive failures and
 *     the sweep leaves the firm alone: a fourth attempt is a firm whose site cannot be
 *     read, and the firm page says so rather than spending a unit a day for ever.
 *   * **There was no model when it ran.** `research_runs.extraction` says why, and only
 *     `unconfigured` comes back: a run that recorded no readable pages (`no_pages`) will
 *     record none tomorrow either, and `model_name IS NULL` could not tell the two
 *     apart — so every firm with an unreachable site was re-selected every single day
 *     for ever, which is an unbounded spend with nothing to show for it. Without the
 *     condition at all, configuring the key would leave every firm already swept
 *     excluded for ninety days, which is the shape of bug nobody finds until a quarter
 *     later.
 *   * **A link was added after it ran.** Adding a link enqueues a run of its own, and
 *     that run can refuse — a spent ceiling, a run already in flight. The link would
 *     then never be read, because the firm looks fresh. Comparing against the latest
 *     run's `started_at` is what makes the enqueue's refusal recoverable. This branch
 *     is a **backstop**, not the prompt path, so it sits behind the same two gates as
 *     the failure branch: a firm whose site cannot be read does not become an
 *     every-morning expense because somebody pasted a URL at it.
 *
 * ## Every branch terminates
 *
 * The failure count and the next-business-day gate apply to the *whole* of the
 * "researched but due" test rather than to one branch of it. That is the property worth
 * stating on its own: with three consecutive failed revisions recorded, no condition
 * here selects the firm again, whatever else has happened to it.
 */

/** How long a completed run stays fresh. */
export const SWEEP_STALE_DAYS = 90;

/**
 * How many consecutive failed revisions the sweep will try before leaving a firm alone.
 *
 * Three, and it is the same number the job ladder would have used. `brief.ts` and the
 * firm page report "research failed, N tries" from the same count, so a firm that has
 * stopped being retried says so rather than looking merely stale.
 */
export const MAX_CONSECUTIVE_FAILED_RUNS = 3;

export interface SweepCandidate {
  readonly firmId: string;
}

export interface SweepInput {
  readonly limit: number;
  readonly at: string;
  /**
   * True when this deployment has an extraction port. A completed run with
   * `research_runs.extraction = 'unconfigured'` run is only due again if there is a
   * model to run it with now.
   */
  readonly extractionConfigured?: boolean | undefined;
}

export async function selectFirmsForSweep(
  context: RepositoryContext,
  input: SweepInput,
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
        AND (
          -- Never researched at all.
          NOT EXISTS (
            SELECT 1 FROM research_runs r
             WHERE r.workspace_id = f.workspace_id AND r.firm_id = f.id
               AND r.outcome IN ('completed', 'failed')
          )
          OR EXISTS (
            SELECT 1
              FROM (
                SELECT r.outcome, r.completed_at, r.started_at, r.extraction,
                       -- A later business day than the one the latest run closed on.
                       ((r.completed_at AT TIME ZONE $6)::date
                          < ($2::timestamptz AT TIME ZONE $6)::date) AS later_day
                  FROM research_runs r
                 WHERE r.workspace_id = f.workspace_id AND r.firm_id = f.id
                   AND r.outcome IN ('completed', 'failed')
                 ORDER BY r.revision DESC
                 LIMIT 1
              ) latest
             WHERE
               -- Stale: ninety days since the last completed run. No gate, because a
               -- firm with a completed run has no consecutive failures to count.
               (latest.outcome = 'completed'
                 AND latest.completed_at <= $2::timestamptz - ($3 || ' days')::interval)
               OR (
                 (
                   -- The last run failed, and not today: a provider that failed this
                   -- morning will most likely fail again this morning.
                   (latest.outcome = 'failed' AND latest.later_day)
                   -- It completed with no model configured, and there is one now.
                   -- no_pages and failed are deliberately not here: a firm whose site
                   -- cannot be read will be unreadable tomorrow too, and a null
                   -- model_name could not tell the two apart.
                   OR (latest.outcome = 'completed' AND latest.extraction = 'unconfigured' AND $7)
                   -- A link was added after the last run started. A backstop: adding a
                   -- link enqueues its own run through the link_added trigger, and this
                   -- is only for the case where that run refused.
                   OR (latest.later_day AND EXISTS (
                     SELECT 1 FROM firm_links l
                      WHERE l.workspace_id = f.workspace_id AND l.firm_id = f.id
                        AND l.added_at > latest.started_at
                   ))
                 )
                 -- The termination gate, over every branch above. Three consecutive
                 -- failed revisions and the sweep stops asking, whatever else has
                 -- happened to the firm — a pasted link included, which is why that
                 -- branch is inside this bracket and not beside it.
                 AND (
                   SELECT count(*) FROM research_runs c
                    WHERE c.workspace_id = f.workspace_id AND c.firm_id = f.id
                      AND c.outcome = 'failed'
                      AND c.revision > COALESCE((
                        SELECT max(d.revision) FROM research_runs d
                         WHERE d.workspace_id = f.workspace_id AND d.firm_id = f.id
                           AND d.outcome = 'completed'
                      ), 0)
                 ) < $5
               )
          )
        )
        -- And nothing already in flight, so a sweep that overlaps a click does not
        -- queue a second revision of work somebody is already waiting on.
        AND NOT EXISTS (
          SELECT 1 FROM research_runs r
           WHERE r.workspace_id = f.workspace_id AND r.firm_id = f.id AND r.outcome = 'running'
        )
      ORDER BY f.created_at, f.id
      LIMIT $4`,
    [
      context.scope.workspaceId,
      input.at,
      String(SWEEP_STALE_DAYS),
      Math.max(0, Math.trunc(input.limit)),
      MAX_CONSECUTIVE_FAILED_RUNS,
      await workspaceBusinessZone(context),
      input.extractionConfigured === true,
    ],
  );
  return rows.map(row => ({ firmId: row.id }));
}
