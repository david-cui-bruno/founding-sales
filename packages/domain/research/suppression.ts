import type { RepositoryContext } from '../db/workspaceScope.ts';

/**
 * Whether a firm is suppressed, read conservatively (specification 10.2, invariant 4).
 *
 * The acceptance criterion is "a suppressed firm is never refreshed". A suppression is
 * a prospect's answer, and re-reading their website to add evidence and suggestions
 * against their record is not something to keep doing after it. Research is not
 * outreach, so this is not invariant 4's *enforcement* — it is the conservative
 * reading of a sentence the specification does not write, and the conservative option
 * is to stop.
 *
 * ## Why this is not `effective_suppressions`
 *
 * Section 10.2 names "one `effective_suppressions` view [as] authoritative for email
 * and dialing". Lane G4 owns it, and it does not exist yet. So this reads
 * `suppression_events` directly, with a rule chosen to be wrong only in the safe
 * direction: a firm-scoped event that has **no direct supersession** suppresses the
 * firm.
 *
 * Section 10.2 gives supersession the properties that make that safe: an event is
 * insert-only, "at most one direct supersession may reference an event", and the only
 * reasons are `mistaken_entry`, `correction` and `documented_reconsent`. So an event
 * with no supersession is a live request, and an event with one has been answered by
 * a person who was entitled to answer it.
 *
 * When G4's view lands, this function's body becomes a read of it. The signature is
 * the seam that makes that a one-file change, and `docs/decisions/g10-suppression-read.md`
 * records the swap.
 *
 * Handle suppressions are deliberately not consulted. Section 10.2 makes a handle
 * suppression global across the workspace, and its effect is that the *route* may not
 * be used; it says nothing about whether the firm's own website may be read. A firm
 * whose one published address is suppressed still has facts worth recording, and the
 * route it would have used is refused at the point of use, by G4.
 */

/** Firm-scoped suppression uses the firm id as its canonical key (see `mergeFirms`). */
export function firmSuppressionKey(firmId: string): string {
  return firmId.toLowerCase();
}

/**
 * True when a live firm-wide do-not-contact suppression covers this firm.
 *
 * Fails closed on purpose: anything that is not demonstrably superseded counts.
 */
export async function isFirmSuppressed(context: RepositoryContext, firmId: string): Promise<boolean> {
  const { rows } = await context.db.query<{ live: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM suppression_events e
        WHERE e.workspace_id = $1
          AND e.scope = 'firm'
          AND e.canonical_key = $2
          AND NOT EXISTS (
            SELECT 1 FROM suppression_events s
             WHERE s.workspace_id = e.workspace_id AND s.supersedes_event_id = e.event_id
          )
     ) AS live`,
    [context.scope.workspaceId, firmSuppressionKey(firmId)],
  );
  return rows[0]?.live === true;
}

/**
 * The subset of `firmIds` that is suppressed, in one statement.
 *
 * Discovery creates many firms at once and a sweep may revisit firms a person has
 * since suppressed, so asking per firm would be one round trip per candidate.
 */
export async function suppressedFirmIds(
  context: RepositoryContext,
  firmIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (firmIds.length === 0) return new Set();
  const { rows } = await context.db.query<{ canonical_key: string }>(
    `SELECT DISTINCT e.canonical_key
       FROM suppression_events e
      WHERE e.workspace_id = $1
        AND e.scope = 'firm'
        AND e.canonical_key = ANY($2::text[])
        AND NOT EXISTS (
          SELECT 1 FROM suppression_events s
           WHERE s.workspace_id = e.workspace_id AND s.supersedes_event_id = e.event_id
        )`,
    [context.scope.workspaceId, firmIds.map(firmSuppressionKey)],
  );
  return new Set(rows.map(row => row.canonical_key));
}
