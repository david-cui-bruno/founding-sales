import type { RepositoryContext } from '../db/workspaceScope.ts';
import { authenticationPasses, readPrimarySendingDomain } from '../outbound/domainGuard.ts';
import { readResearchSettings } from '../research/settings.ts';

/**
 * What is still finishing after a switch went off (slice P1, invariant I1).
 *
 * Turning a sending or research switch off holds queued work and starts no new provider
 * request, but a request already submitted may finish, and its result is recorded. This
 * is the count of those, for the line Settings shows ("Sending is off. 1 message already
 * submitted is finishing."): nothing is recalled and nothing is reversed.
 *
 *   * **sending** — fences in `dispatching`: claimed, so Gmail has been or is being asked,
 *     and not yet recorded `sent` or moved to `reconciling`. A fence whose worker died is
 *     adopted into `reconciling` by the sweep after five minutes and leaves this count.
 *   * **research** — research reservations in `calling`: a model call may be in flight.
 *     One left by a worker that vanished is finalised by the sweep after half an hour.
 *
 * The domain half of "on" is the workspace's own facts: the primary domain's checklist and
 * enable for sending (the attestation half needs the process's identity, and the route
 * adds it), `research_settings.enabled` for research.
 */
export interface FinishingCounts {
  readonly sendingFinishing: number;
  readonly sendingDomainOn: boolean;
  readonly researchFinishing: number;
  readonly researchOn: boolean;
}

export async function readFinishing(context: RepositoryContext): Promise<FinishingCounts> {
  const { rows } = await context.db.query<{ sending: number; research: number }>(
    `SELECT (SELECT count(*)::int FROM outbound_messages
              WHERE workspace_id = $1 AND state = 'dispatching') AS sending,
            (SELECT count(*)::int FROM provider_reservations
              WHERE workspace_id = $1 AND subject_kind = 'research_run' AND state = 'calling') AS research`,
    [context.scope.workspaceId],
  );
  const domain = await readPrimarySendingDomain(context);
  return {
    sendingFinishing: Number(rows[0]?.sending ?? 0),
    sendingDomainOn: domain !== null && authenticationPasses(domain) && domain.automatedSendingEnabled,
    researchFinishing: Number(rows[0]?.research ?? 0),
    researchOn: (await readResearchSettings(context)).enabled,
  };
}
