import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordSuggestion, type RecordedSuggestion } from './suggestions.ts';
import type { ResearchResult } from './types.ts';

/**
 * Duplicate suggestions (specification 7.2; deliverable 4).
 *
 * > Research may suggest duplicates but never performs a destructive merge
 * > automatically.
 *
 * So this file finds candidates and writes a `duplicate_firm` suggestion, and that is
 * all it does. There is no code path from here to `mergeFirms`: a person reviews the
 * suggestion and then runs the merge, which is an audited command that refuses when
 * two canonical values disagree and asks them to choose (G3a, and
 * `docs/decisions/g3a-merge-preservation.md`). Automating the merge would be
 * automating that choice.
 *
 * ## What counts as a duplicate
 *
 * Three signals, in descending strength, and the strongest one found wins:
 *
 *   1. **the same website domain** — two firm rows whose `website` resolves to the
 *      same host. Nearly always the same firm under two spellings;
 *   2. **the same usable or candidate phone route** — a shared switchboard. Sometimes a
 *      real duplicate, sometimes a management company answering for two portfolios,
 *      which is exactly why it is a suggestion;
 *   3. **the same normalized name in the same locality** — the weakest, and the one a
 *      person most often rejects, so it is reported with the lowest confidence.
 *
 * A pair is suggested once, not twice. The dedupe key is the two firm ids in sorted
 * order, so whichever side research reaches first produces the same key and the second
 * visit is a no-op. The suggestion is attached to the *newer* firm — the one discovery
 * just created — because that is the record a person will be looking at.
 *
 * Confidence here is the confidence that the pair is a duplicate, and it is never used
 * to write anything: `research_suggestions_only_facts_apply` refuses an applied
 * duplicate row, so no threshold on this number can cause a merge.
 */

export type DuplicateSignal = 'same_domain' | 'shared_phone_route' | 'same_name_and_locality';

/** How much each signal is worth. Reported to a person; never a decision by itself. */
export const DUPLICATE_SIGNAL_CONFIDENCE: Readonly<Record<DuplicateSignal, number>> = Object.freeze({
  same_domain: 0.9,
  shared_phone_route: 0.6,
  same_name_and_locality: 0.4,
});

export interface DuplicateCandidate {
  readonly firmId: string;
  readonly otherFirmId: string;
  readonly signal: DuplicateSignal;
  readonly confidence: number;
  /** What matched, in a form a person can read. Never a full address. */
  readonly matched: string;
}

/** The two firm ids in a stable order, so one pair has one key whichever side asks. */
export function duplicatePairKey(firmId: string, otherFirmId: string): string {
  return [firmId, otherFirmId].sort().join(':');
}

/** The host a firm's website names, lower case and without `www.`, or null. */
export function websiteHost(website: string | null): string | null {
  if (website === null) return null;
  try {
    const host = new URL(website).hostname.toLowerCase().replace(/^www\./u, '').replace(/\.$/u, '');
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

/**
 * Duplicate candidates for one firm, strongest signal first, at most `limit` pairs.
 *
 * Only active firms are considered on both sides: a firm already merged into another
 * is history, and suggesting a merge into history would send a person to a record that
 * every subsequent command refuses as `firm_merged`.
 */
export async function findDuplicateCandidates(
  context: RepositoryContext,
  input: { readonly firmId: string; readonly limit?: number | undefined },
): Promise<readonly DuplicateCandidate[]> {
  const limit = Math.trunc(input.limit ?? 5);
  const { rows } = await context.db.query<{
    other_firm_id: string;
    signal: DuplicateSignal;
    matched: string;
  }>(
    `WITH subject AS (
       SELECT id, name, website, locality
         FROM firms
        WHERE workspace_id = $1 AND id = $2 AND status = 'active'
     ),
     -- Two firms whose website names the same host. regexp_replace strips the
     -- scheme, any leading www. and everything from the first path separator, which
     -- is all a comparison of hosts needs and is cheaper than a URL parse.
     by_domain AS (
       SELECT f.id AS other_firm_id, 'same_domain'::text AS signal,
              regexp_replace(lower(f.website), '^https?://(www\\.)?([^/]+).*$', '\\2') AS matched
         FROM firms f, subject s
        WHERE f.workspace_id = $1 AND f.status = 'active' AND f.id <> s.id
          AND f.website IS NOT NULL AND s.website IS NOT NULL
          AND regexp_replace(lower(f.website), '^https?://(www\\.)?([^/]+).*$', '\\2')
            = regexp_replace(lower(s.website), '^https?://(www\\.)?([^/]+).*$', '\\2')
     ),
     by_phone AS (
       SELECT DISTINCT other.firm_id AS other_firm_id, 'shared_phone_route'::text AS signal,
              'a shared number'::text AS matched
         FROM phone_routes mine
         JOIN phone_routes other
           ON other.workspace_id = mine.workspace_id AND other.e164 = mine.e164
              AND other.firm_id <> mine.firm_id
         JOIN firms f ON f.workspace_id = other.workspace_id AND f.id = other.firm_id
        WHERE mine.workspace_id = $1 AND mine.firm_id = $2
          AND mine.eligibility IN ('candidate', 'usable')
          AND other.eligibility IN ('candidate', 'usable')
          AND f.status = 'active'
     ),
     by_name AS (
       SELECT f.id AS other_firm_id, 'same_name_and_locality'::text AS signal,
              lower(btrim(f.name)) AS matched
         FROM firms f, subject s
        WHERE f.workspace_id = $1 AND f.status = 'active' AND f.id <> s.id
          AND lower(btrim(f.name)) = lower(btrim(s.name))
          AND f.locality IS NOT NULL AND s.locality IS NOT NULL
          AND lower(btrim(f.locality)) = lower(btrim(s.locality))
     ),
     combined AS (
       SELECT * FROM by_domain UNION ALL SELECT * FROM by_phone UNION ALL SELECT * FROM by_name
     ),
     ranked AS (
       SELECT other_firm_id, signal, matched,
              row_number() OVER (
                PARTITION BY other_firm_id
                ORDER BY CASE signal
                           WHEN 'same_domain' THEN 1
                           WHEN 'shared_phone_route' THEN 2
                           ELSE 3
                         END
              ) AS rank
         FROM combined
     )
     SELECT other_firm_id, signal, matched FROM ranked WHERE rank = 1
      ORDER BY CASE signal WHEN 'same_domain' THEN 1 WHEN 'shared_phone_route' THEN 2 ELSE 3 END, other_firm_id
      LIMIT $3`,
    [context.scope.workspaceId, input.firmId, limit],
  );

  return rows.map(row => ({
    firmId: input.firmId,
    otherFirmId: row.other_firm_id,
    signal: row.signal,
    confidence: DUPLICATE_SIGNAL_CONFIDENCE[row.signal],
    matched: row.matched,
  }));
}

/**
 * Record a duplicate candidate as a suggestion. Never merges.
 *
 * The value a person reads is the signal and what matched, not a recommendation: the
 * suggestion says "these two look like the same firm because they publish the same
 * host", and the merge command is where the consequences are decided.
 */
export async function suggestDuplicate(
  context: RepositoryContext,
  candidate: DuplicateCandidate,
  providerKey: string,
): Promise<ResearchResult<RecordedSuggestion>> {
  return await recordSuggestion(context, {
    firmId: candidate.firmId,
    kind: 'duplicate_firm',
    proposedValue: `${candidate.signal}: ${candidate.matched}`.slice(0, 500),
    confidence: candidate.confidence,
    providerKey,
    duplicateFirmId: candidate.otherFirmId,
    dedupeKey: duplicatePairKey(candidate.firmId, candidate.otherFirmId),
  });
}
