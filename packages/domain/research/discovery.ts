import { createHash } from 'node:crypto';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { createFirm } from '../crm/firms.ts';
import { recordEvidence } from '../crm/evidence.ts';
import { addPhoneRoute } from '../crm/routes.ts';
import { claimResearchClearance, type ResearchClearance } from './ceilings.ts';
import { evidenceRetentionExpiry, recordProviderCall } from './configuration.ts';
import { findDuplicateCandidates, suggestDuplicate } from './duplicates.ts';
import { recordFirmCoordinate, resolveResearchFirmZone } from './firmZone.ts';
import { researchSourcePolicy } from './sourcePolicy.ts';
import { isFirmSuppressed } from './suppression.ts';
import type { DiscoveryCandidate, DiscoveryProvider } from './providers.ts';
import { accept, refuse, type ResearchRefusalCode, type ResearchResult } from './types.ts';

/**
 * Discovery: one page of one query, through one approved provider
 * (specification 7.4, 13.2, Appendix C; deliverable 1).
 *
 * > Discovery creates candidate firms and evidence through approved providers.
 *
 * And, from invariant 8, everything it must not do. A discovered firm arrives
 * **unassigned**, with **no opportunity**, with its listed number as a `candidate`
 * route and nothing that could send or dial. The next thing that happens to it is a
 * person looking at it.
 *
 * ## The shape of a run
 *
 * 1. Claim a clearance. This is where the day's ceiling and the provider's price stop
 *    the run, and it consumes a unit before any provider is touched.
 * 2. Open the `research_pages` row. `(workspace, query_hash, page_hash)` is Appendix
 *    C's key, so this row *is* the handler's business uniqueness — but the page hash
 *    is only known after the provider answers, which is why the row is inserted after
 *    the call and why a replay is recognised by finding it already there.
 * 3. Record the provider call in the ledger, cost and failure together.
 * 4. For each candidate: create the firm, record the listing as evidence, record the
 *    coordinate, resolve the zone, add the listed number as a candidate route, and
 *    look for duplicates.
 * 5. Close the page row with what happened.
 *
 * ## Why the page hash decides replay
 *
 * A job is at least once (13.2). The same job claimed twice must not create the same
 * twenty firms twice. The page hash is a digest of the provider's exact response
 * bytes, so the second run's provider call returns the same page, the insert of the
 * `research_pages` row conflicts, and the run stops without creating anything —
 * `already_recorded`. That costs one extra provider call on a replay, which is the
 * honest price of a provider that has no idempotency key of its own, and it is
 * accounted in the ledger like any other call.
 *
 * The firms themselves are protected a second time, by identity rather than by the
 * page: a candidate whose domain already exists in the workspace is skipped. So even a
 * provider that returned different bytes for the same query does not duplicate a firm.
 */

export interface DiscoveryRunInput {
  readonly provider: DiscoveryProvider;
  readonly query: string;
  readonly pageToken?: string | null | undefined;
  /** Database time. One run dates every write it makes identically. */
  readonly at: string;
  readonly maxCandidates?: number | undefined;
  /** Recorded on the page row when a person asked for the sweep. */
  readonly requestedByUserId?: string | null | undefined;
}

export interface DiscoveryRunReport {
  readonly pageId: string;
  readonly queryHash: string;
  readonly pageHash: string;
  readonly outcome: 'completed' | 'already_recorded';
  readonly candidateCount: number;
  readonly firmsCreated: number;
  readonly evidenceRecorded: number;
  readonly routesRecorded: number;
  readonly duplicatesSuggested: number;
  readonly zonesResolved: number;
  readonly zonesUnresolved: number;
  readonly costMicros: number;
  readonly nextPageToken: string | null;
  readonly skipped: Readonly<Record<string, number>>;
  /** The firms this run created, for the caller to enqueue enrichment for. */
  readonly createdFirmIds: readonly string[];
}

/** sha256 of a query, so the same query always produces the same Appendix C key. */
export function queryHash(query: string): string {
  return createHash('sha256').update(query.trim().toLowerCase(), 'utf8').digest('hex');
}

export async function runDiscoveryPage(
  context: RepositoryContext,
  input: DiscoveryRunInput,
): Promise<ResearchResult<DiscoveryRunReport>> {
  const query = input.query.trim();
  if (query === '' || query.length > 500) return refuse('invalid_input');

  const clearance = await claimResearchClearance(context, {
    work: 'discovery_page',
    providerKey: input.provider.providerKey,
    at: input.at,
  });
  if (!clearance.ok) return refuse(clearance.reason);
  if (clearance.value.provider.kind !== 'discovery') return refuse('provider_unknown');

  const outcome = await input.provider.discover({
    query,
    pageToken: input.pageToken ?? null,
    maxCandidates: input.maxCandidates ?? 20,
  });

  await recordProviderCall(context, {
    providerKey: input.provider.providerKey,
    costMicros: outcome.costMicros,
    ...(outcome.ok ? {} : { failureCode: outcome.failureCode }),
    businessTimeZone: clearance.value.businessTimeZone,
    at: input.at,
  });

  if (!outcome.ok) {
    await recordFailedPage(context, {
      providerKey: input.provider.providerKey,
      query,
      queryHash: queryHash(query),
      // A failed call produced no bytes to hash, so the page is identified by the
      // attempt: the query, the token and the failure. It is still one row per
      // distinct attempt, and a retry of the same attempt finds it.
      pageHash: createHash('sha256')
        .update(`failed:${queryHash(query)}:${input.pageToken ?? ''}:${outcome.failureCode}`, 'utf8')
        .digest('hex'),
      pageToken: input.pageToken ?? null,
      requestedByUserId: input.requestedByUserId ?? null,
      refusalCode: 'provider_refused',
      costMicros: outcome.costMicros,
    });
    return refuse('provider_refused');
  }

  const page = outcome.value;
  const hash = queryHash(query);
  const opened = await openPage(context, {
    providerKey: input.provider.providerKey,
    query,
    queryHash: hash,
    pageHash: page.responseHash,
    pageToken: input.pageToken ?? null,
    requestedByUserId: input.requestedByUserId ?? null,
    candidateCount: page.candidates.length,
  });
  if (opened === null) {
    // Appendix C's uniqueness, doing its job: this exact page has been materialized
    // before, so nothing is created again.
    return accept({
      pageId: '',
      queryHash: hash,
      pageHash: page.responseHash,
      outcome: 'already_recorded',
      candidateCount: page.candidates.length,
      firmsCreated: 0,
      evidenceRecorded: 0,
      routesRecorded: 0,
      duplicatesSuggested: 0,
      zonesResolved: 0,
      zonesUnresolved: 0,
      costMicros: outcome.costMicros,
      nextPageToken: page.nextPageToken,
      skipped: page.skipped,
      createdFirmIds: [],
    });
  }

  const skipped: Record<string, number> = { ...page.skipped };
  const bump = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  let firmsCreated = 0;
  let evidenceRecorded = 0;
  let routesRecorded = 0;
  let duplicatesSuggested = 0;
  let zonesResolved = 0;
  let zonesUnresolved = 0;
  const createdFirmIds: string[] = [];

  for (const candidate of page.candidates) {
    if (researchSourcePolicy(candidate.sourceUrl) !== 'candidate') {
      bump('source_blocked');
      continue;
    }
    const existing = await firmIdByDomain(context, candidate.domain);
    if (existing !== null) {
      // Already known. Not an error and not a merge: the firm is here, and a duplicate
      // suggestion is the most this path may do about it.
      bump('existing_domain');
      continue;
    }

    const created = await createFirm(context, {
      name: candidate.name,
      website: candidate.sourceUrl,
      addressLine: candidate.addressLine ?? undefined,
      locality: candidate.locality ?? undefined,
      regionCode: candidate.regionCode ?? undefined,
      postalCode: candidate.postalCode ?? undefined,
      // Deliberately unassigned. A discovered firm belongs to nobody until an admin
      // assigns it, which is the first half of invariant 8 in one omitted field.
    });
    if (!created.ok) {
      bump(`firm_${created.reason}`);
      continue;
    }
    const firmId = created.value.id;
    firmsCreated += 1;
    createdFirmIds.push(firmId);

    const evidence = await recordListingEvidence(context, {
      firmId,
      candidate,
      clearance: clearance.value,
      at: input.at,
      responseHash: page.responseHash,
    });
    if (evidence) evidenceRecorded += 1;

    if (candidate.latitude !== null && candidate.longitude !== null) {
      const coordinate = await recordFirmCoordinate(context, {
        firmId,
        latitude: candidate.latitude,
        longitude: candidate.longitude,
        providerKey: input.provider.providerKey,
        sourceReference: candidate.listingReference,
        retrievedAt: new Date(input.at),
      });
      if (!coordinate.ok) bump('coordinate_refused');
    }

    const zone = await resolveResearchFirmZone(context, { firmId });
    if (zone.ok) {
      if (zone.value.timeZone === null) zonesUnresolved += 1;
      else zonesResolved += 1;
    }

    if (candidate.listedPhone !== null) {
      // `research_provider` is not a trusted source and no technical validation has
      // happened, so `decideRouteEligibility` makes this a `candidate` route. That is
      // section 7.4's "weak routes remain candidate", and it is why discovery cannot
      // produce something dialable.
      const route = await addPhoneRoute(context, {
        firmId,
        e164: candidate.listedPhone,
        source: 'research_provider',
        retrievedAt: new Date(input.at),
        associationConfidence: 0.7,
        technicalValidation: 'unknown',
      });
      if (route.ok) routesRecorded += 1;
      else bump('route_refused');
    }

    for (const duplicate of await findDuplicateCandidates(context, { firmId })) {
      const suggested = await suggestDuplicate(context, duplicate, input.provider.providerKey);
      if (suggested.ok) duplicatesSuggested += 1;
    }
  }

  await closePage(context, {
    pageId: opened,
    outcome: 'completed',
    firmsCreated,
    evidenceRecorded,
    skipped,
    costMicros: outcome.costMicros,
  });

  return accept({
    pageId: opened,
    queryHash: hash,
    pageHash: page.responseHash,
    outcome: 'completed',
    candidateCount: page.candidates.length,
    firmsCreated,
    evidenceRecorded,
    routesRecorded,
    duplicatesSuggested,
    zonesResolved,
    zonesUnresolved,
    costMicros: outcome.costMicros,
    nextPageToken: page.nextPageToken,
    skipped,
    createdFirmIds,
  });
}

/**
 * The listing itself, as evidence.
 *
 * `source_reference` is the provider's own identifier for the listing, and
 * `content_hash` is the digest of the response the listing arrived in, so the evidence
 * names a record that was actually read rather than a URL somebody might read later.
 * The retention expiry comes from the provider's reviewed terms (10.3).
 */
async function recordListingEvidence(
  context: RepositoryContext,
  input: {
    readonly firmId: string;
    readonly candidate: DiscoveryCandidate;
    readonly clearance: ResearchClearance;
    readonly at: string;
    readonly responseHash: string;
  },
): Promise<boolean> {
  const retrievedAt = new Date(input.at);
  const expiry = evidenceRetentionExpiry(input.clearance.provider, retrievedAt);
  const recorded = await recordEvidence(context, {
    firmId: input.firmId,
    provider: input.clearance.provider.providerKey,
    sourceReference: input.candidate.listingReference,
    contentHash: input.responseHash,
    retrievedAt,
    confidence: 0.7,
    termsAllowRetention: input.clearance.provider.termsAllowRetention,
    ...(expiry === null ? {} : { retentionExpiresAt: expiry }),
    detail: { kind: 'discovery_listing', domain: input.candidate.domain },
  });
  return recorded.ok;
}

async function firmIdByDomain(context: RepositoryContext, domain: string): Promise<string | null> {
  const { rows } = await context.db.query<{ id: string }>(
    `SELECT id FROM firms
      WHERE workspace_id = $1 AND status = 'active'
        AND regexp_replace(lower(website), '^https?://(www\\.)?([^/]+).*$', '\\2') = $2
      LIMIT 1`,
    [context.scope.workspaceId, domain.toLowerCase()],
  );
  return rows[0]?.id ?? null;
}

async function openPage(
  context: RepositoryContext,
  input: {
    readonly providerKey: string;
    readonly query: string;
    readonly queryHash: string;
    readonly pageHash: string;
    readonly pageToken: string | null;
    readonly requestedByUserId: string | null;
    readonly candidateCount: number;
  },
): Promise<string | null> {
  const { rows } = await context.db.query<{ id: string }>(
    `INSERT INTO research_pages
       (workspace_id, provider_key, query_hash, page_hash, query_text, page_token,
        requested_by_user_id, candidate_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT ON CONSTRAINT research_pages_one_per_result DO NOTHING
     RETURNING id`,
    [
      context.scope.workspaceId,
      input.providerKey,
      input.queryHash,
      input.pageHash,
      input.query,
      input.pageToken,
      input.requestedByUserId,
      input.candidateCount,
    ],
  );
  return rows[0]?.id ?? null;
}

async function closePage(
  context: RepositoryContext,
  input: {
    readonly pageId: string;
    readonly outcome: 'completed';
    readonly firmsCreated: number;
    readonly evidenceRecorded: number;
    readonly skipped: Readonly<Record<string, number>>;
    readonly costMicros: number;
  },
): Promise<void> {
  await context.db.query(
    `UPDATE research_pages
        SET outcome = $3, completed_at = now(), firms_created = $4, evidence_recorded = $5,
            skipped = $6::jsonb, cost_micros = $7::bigint
      WHERE workspace_id = $1 AND id = $2`,
    [
      context.scope.workspaceId,
      input.pageId,
      input.outcome,
      input.firmsCreated,
      input.evidenceRecorded,
      JSON.stringify(input.skipped),
      Math.max(0, Math.trunc(input.costMicros)),
    ],
  );
}

async function recordFailedPage(
  context: RepositoryContext,
  input: {
    readonly providerKey: string;
    readonly query: string;
    readonly queryHash: string;
    readonly pageHash: string;
    readonly pageToken: string | null;
    readonly requestedByUserId: string | null;
    readonly refusalCode: ResearchRefusalCode;
    readonly costMicros: number;
  },
): Promise<void> {
  await context.db.query(
    `INSERT INTO research_pages
       (workspace_id, provider_key, query_hash, page_hash, query_text, page_token,
        requested_by_user_id, completed_at, outcome, refusal_code, cost_micros)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), 'failed', $8, $9::bigint)
     ON CONFLICT ON CONSTRAINT research_pages_one_per_result DO NOTHING`,
    [
      context.scope.workspaceId,
      input.providerKey,
      input.queryHash,
      input.pageHash,
      input.query,
      input.pageToken,
      input.requestedByUserId,
      input.refusalCode,
      Math.max(0, Math.trunc(input.costMicros)),
    ],
  );
}

/**
 * Whether this firm may be enriched at all: it must exist, be active, and not be
 * suppressed. Exported because both the enrichment run and the enqueue path ask it,
 * and the enqueue path asking it is what stops a suppressed firm being queued in the
 * first place.
 */
export async function firmIsResearchable(
  context: RepositoryContext,
  firmId: string,
): Promise<ResearchResult<{ readonly firmId: string }>> {
  const { rows } = await context.db.query<{ status: string }>(
    'SELECT status FROM firms WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, firmId],
  );
  const status = rows[0]?.status;
  if (status === undefined) return refuse('firm_unknown');
  if (status === 'merged') return refuse('firm_merged');
  if (await isFirmSuppressed(context, firmId)) return refuse('firm_suppressed');
  return accept({ firmId });
}
