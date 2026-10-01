import type { RepositoryContext } from '../db/workspaceScope.ts';
import { authenticationPasses, readPrimarySendingDomain } from '../outbound/domainGuard.ts';
import { readResearchSettings } from '../research/settings.ts';
import { readClassifierSettings } from '../classification/settings.ts';

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
 *   * **research** — research runs under way: reservations in `calling`, marked before the
 *     run's first page request. A run that meets "off" stops before its next page or
 *     model request (fix round, finding 3), so this is runs, not model calls, and it falls
 *     to 0 as each one stops. One left by a worker that vanished is finalised by the sweep
 *     after half an hour.
 *   * **transcription** — transcription reservations in `calling`: from chunk 2 on a
 *     Deepgram request may be in flight; the final check before it releases one that has
 *     not started.
 *   * **classification** — reply-classification reservations in `calling`: chunk 2 marked
 *     the attempt and its request may be in flight (fix round 2).
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
  readonly transcriptionFinishing: number;
  readonly classificationFinishing: number;
  readonly classificationOn: boolean;
}

export async function readFinishing(context: RepositoryContext): Promise<FinishingCounts> {
  const { rows } = await context.db.query<{ sending: number; research: number; transcription: number; classification: number }>(
    `SELECT (SELECT count(*)::int FROM outbound_messages
              WHERE workspace_id = $1 AND state = 'dispatching') AS sending,
            (SELECT count(*)::int FROM provider_reservations
              WHERE workspace_id = $1 AND subject_kind = 'research_run' AND state = 'calling') AS research,
            (SELECT count(*)::int FROM provider_reservations
              WHERE workspace_id = $1 AND subject_kind = 'call_transcription' AND state = 'calling') AS transcription,
            (SELECT count(*)::int FROM provider_reservations
              WHERE workspace_id = $1 AND subject_kind = 'reply_classification' AND state = 'calling') AS classification`,
    [context.scope.workspaceId],
  );
  const domain = await readPrimarySendingDomain(context);
  return {
    sendingFinishing: Number(rows[0]?.sending ?? 0),
    sendingDomainOn: domain !== null && authenticationPasses(domain) && domain.automatedSendingEnabled,
    researchFinishing: Number(rows[0]?.research ?? 0),
    researchOn: (await readResearchSettings(context)).enabled,
    transcriptionFinishing: Number(rows[0]?.transcription ?? 0),
    classificationFinishing: Number(rows[0]?.classification ?? 0),
    classificationOn: (await readClassifierSettings(context)).enabled,
  };
}
