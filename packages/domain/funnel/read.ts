import type { RepositoryContext } from '../db/workspaceScope.ts';

/**
 * The minimal funnel read: the fourth source of `POST /dashboard`.
 *
 * Four figures and nothing else, because four is what a rate needs. `byKind` is how
 * many times a thing happened, `firmsByKind` is how many firms it happened to —
 * three calls to one firm is one firm, and a conversion is about firms — `uniqueFirms`
 * is how many firms the funnel touched at all, and `firmsInScope` is the denominator:
 * the active firms the caller may see **now**, which is the same aggregate
 * `readDashboard` already computes. A rate without its denominator is a number an
 * operator has to go and find the other half of.
 *
 * **Keys are kinds, never names.** Every row of every list is a dotted kind and a
 * count. There is no field a firm's name could appear in, which is the same
 * redaction by construction the rest of the dashboard DTO has.
 *
 * The audience rule is `docs/decisions/g9-dashboard-visibility.md`'s, and the
 * firm-less case is the one it does not state in so many words. A salesperson sees
 * only facts whose firm is assigned to them, and **no firm-less fact at all**: a demo
 * visitor or a published post belongs to the workspace rather than to a person, and a
 * workspace-wide figure on a salesperson's dashboard is a way to learn about a
 * colleague's work. An admin, whose audience is the workspace, sees every fact
 * including those.
 *
 * The window is `[from, to)` — inclusive lower, exclusive upper — and every
 * comparison is made by PostgreSQL against the window the caller named, with no
 * `now()` of its own except `firmsInScope`, which is a fact about this instant and
 * says so.
 */

/**
 * The window, the audience and the shape of the answer, declared here rather than
 * imported from `../dashboard/sources.ts`, and that is a packaging fact rather than
 * a style one. The worker reaches this directory through `crm/firms.ts`, and the
 * container images are allow-lists of domain subdirectories closed over their
 * imports (`test/policy/imageClosure.test.ts`): an import of the dashboard here,
 * even a type-only one, would make every worker image ship the dashboard. These are
 * structurally `DashboardWindow`, `DashboardAudience` and `KeyedCount`, and
 * `sources.ts` imports `FunnelFacts` from here to say so in one direction only.
 */

/** Inclusive lower bound, exclusive upper bound, UTC. */
export interface FunnelWindow {
  readonly from: string;
  readonly to: string;
}

/** Null for an admin or the system: every fact in the workspace, firm-less included. */
export interface FunnelAudience {
  readonly onlyAssignedTo: string | null;
}

/** A count against a kind. Never a name. */
export interface FunnelCount {
  readonly key: string;
  readonly count: number;
}

export interface FunnelFacts {
  readonly available: true;
  /** Facts with `occurred_at` in `[from, to)`, by kind. */
  readonly byKind: readonly FunnelCount[];
  /** Distinct firms per kind in the window — a firm counts once however many facts it has. */
  readonly firmsByKind: readonly FunnelCount[];
  /** Distinct firms with any fact in the window. */
  readonly uniqueFirms: number;
  /** Active firms in scope **now**: the denominator a rate needs. */
  readonly firmsInScope: number;
}

/**
 * Every fact the caller may see, in the window. One place the visibility rule is
 * written, as a nullable parameter rather than two query strings.
 */
const VISIBLE_FACTS = `
  SELECT ff.kind, ff.firm_id
    FROM funnel_facts ff
    LEFT JOIN firms f ON f.workspace_id = ff.workspace_id AND f.id = ff.firm_id
   WHERE ff.workspace_id = $1
     AND ff.occurred_at >= $2::timestamptz AND ff.occurred_at < $3::timestamptz
     AND ($4::uuid IS NULL OR (ff.firm_id IS NOT NULL AND f.assigned_user_id = $4::uuid))
`;

export async function funnelFacts(
  context: RepositoryContext,
  window: FunnelWindow,
  audience: FunnelAudience,
): Promise<FunnelFacts> {
  const scope = [context.scope.workspaceId, window.from, window.to, audience.onlyAssignedTo] as const;

  const byKind = await context.db.query<{ key: string; facts: string; firms: string }>(
    `WITH visible AS (${VISIBLE_FACTS})
     SELECT kind AS key, count(*)::text AS facts, count(DISTINCT firm_id)::text AS firms
       FROM visible
      GROUP BY kind
      ORDER BY kind`,
    [...scope],
  );

  const unique = await context.db.query<{ count: string }>(
    `WITH visible AS (${VISIBLE_FACTS})
     SELECT count(DISTINCT firm_id)::text AS count FROM visible WHERE firm_id IS NOT NULL`,
    [...scope],
  );

  // The denominator, as of now rather than over the window: how many active firms
  // the caller may see. The same query `readDashboard` runs for `firmsInScope`.
  const inScope = await context.db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM firms
      WHERE workspace_id = $1 AND status = 'active'
        AND ($2::uuid IS NULL OR assigned_user_id = $2::uuid)`,
    [context.scope.workspaceId, audience.onlyAssignedTo],
  );

  const counts: readonly FunnelCount[] = byKind.rows.map(row => ({ key: row.key, count: Number(row.facts) }));
  const firms: readonly FunnelCount[] = byKind.rows
    .map(row => ({ key: row.key, count: Number(row.firms) }))
    .filter(row => row.count > 0);

  return {
    available: true,
    byKind: counts,
    firmsByKind: firms,
    uniqueFirms: Number(unique.rows[0]?.count ?? '0'),
    firmsInScope: Number(inScope.rows[0]?.count ?? '0'),
  };
}
