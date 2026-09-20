import type { Queryable } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { decideAdminOnly } from '../crm/authorization.ts';
import { enqueueJob, jobIdempotencyKey } from '../jobs/index.ts';
import { researchEnqueueAllowed } from './ceilings.ts';
import { firmIsResearchable } from './discovery.ts';
import { queryHash } from './discovery.ts';
import { nextFirmResearchRevision } from './enrichment.ts';
import { accept, refuse, type ResearchResult } from './types.ts';

/**
 * Materializing research work (specification 13.2, Appendix C; deliverable 3's
 * "ceiling stops enqueues").
 *
 * Two job kinds, both already in `JOB_KINDS` and both already given
 * `business_uniqueness` by `JOB_KIND_PROTECTION`, so nothing here invents a kind or a
 * key: `jobIdempotencyKey.researchPage` and `.researchFirm` compose them.
 *
 * ## Why there is no scheduler source
 *
 * Every other job kind in Appendix C is materialized by the one-minute scheduler pass
 * from due business state. Research deliberately is not. A discovery sweep is a
 * decision to spend money on a territory, and an enrichment is a decision to re-read
 * somebody's website; neither becomes due on its own. So both are enqueued by an
 * admin command, or — for enrichment — by the discovery run that just created the
 * firm, which is a person's sweep continuing rather than a schedule.
 *
 * The consequence is worth stating plainly: research does nothing unless somebody asks
 * it to. That is the conservative reading of invariant 8 and it is recorded in
 * `docs/decisions/g10-no-scheduler-source.md`.
 *
 * ## The ceiling stops enqueues
 *
 * `researchEnqueueAllowed` is asked before the job row is written. A workspace at its
 * ceiling produces no queued work at all, rather than a queue of jobs that each refuse
 * and complete — which would burn a lease, a claim and a log line per firm, and would
 * make the queue depth alarm fire about work nobody wanted. The job still asks
 * `claimResearchClearance` when it runs, because the ceiling can be reached between
 * materialization and the claim.
 */

export interface DiscoveryPageJobPayload {
  readonly query: string;
  readonly pageToken: string | null;
  readonly providerKey: string;
  readonly requestedByUserId: string | null;
}

export interface EnrichmentJobPayload {
  readonly firmId: string;
  readonly revision: number;
  readonly providerKey: string;
  readonly extractionProviderKey: string | null;
}

export interface EnqueuedResearchJob {
  readonly jobId: string;
  readonly kind: 'research.page' | 'research.firm';
  readonly idempotencyKey: string;
  /** False when the key already existed. The normal case for a replayed request. */
  readonly inserted: boolean;
}

/**
 * Enqueue one discovery page. Admin-only: a sweep spends the workspace's research
 * budget, and section 5.2 gives limits and integrations to admins.
 *
 * The page hash is not known until the provider answers, so the job's key uses the
 * hash of the *page token* — the only thing that identifies which page of the query is
 * being asked for before it arrives. Appendix C's `{page_hash}` identifies the
 * *result*, and that is `research_pages`, which is where the run's real uniqueness
 * lives. Two jobs asking for the same page of the same query therefore collapse to
 * one, and two jobs that somehow both ran would still record one page row.
 */
export async function enqueueDiscoveryPage(
  context: RepositoryContext,
  db: Queryable,
  input: {
    readonly query: string;
    readonly pageToken?: string | null | undefined;
    readonly providerKey: string;
    readonly at: string;
  },
): Promise<ResearchResult<EnqueuedResearchJob>> {
  const admin = decideAdminOnly(context);
  if (!admin.permitted) return refuse(admin.reason === 'admin_only' ? 'admin_only' : 'not_assigned');

  const query = input.query.trim();
  if (query === '' || query.length > 500) return refuse('invalid_input');

  const allowed = await researchEnqueueAllowed(context, { work: 'discovery_page', at: input.at });
  if (!allowed.ok) return refuse(allowed.reason);

  const token = input.pageToken ?? null;
  const key = jobIdempotencyKey.researchPage(queryHash(query), requestHash(token));
  const payload: DiscoveryPageJobPayload = {
    query,
    pageToken: token,
    providerKey: input.providerKey,
    requestedByUserId: context.scope.actor.kind === 'user' ? context.scope.actor.userId : null,
  };
  const outcome = await enqueueJob(db, {
    workspaceId: context.scope.workspaceId,
    kind: 'research.page',
    idempotencyKey: key,
    payload: { ...payload },
  });
  return accept({ jobId: outcome.jobId, kind: 'research.page', idempotencyKey: key, inserted: outcome.inserted });
}

/**
 * Enqueue one firm enrichment at the firm's next revision.
 *
 * A suppressed firm is refused here as well as in the run. Both matter: refusing in
 * the run is the guarantee, and refusing here is what keeps a suppressed firm out of
 * the queue entirely, so an operator reading the queue does not see work that will
 * refuse.
 */
export async function enqueueFirmEnrichment(
  context: RepositoryContext,
  db: Queryable,
  input: {
    readonly firmId: string;
    readonly providerKey: string;
    readonly extractionProviderKey?: string | null | undefined;
    readonly at: string;
    /** Supply the revision to re-materialize a specific one; otherwise the next. */
    readonly revision?: number | undefined;
  },
): Promise<ResearchResult<EnqueuedResearchJob>> {
  const researchable = await firmIsResearchable(context, input.firmId);
  if (!researchable.ok) return refuse(researchable.reason);

  const allowed = await researchEnqueueAllowed(context, { work: 'firm_enrichment', at: input.at });
  if (!allowed.ok) return refuse(allowed.reason);

  const revision = input.revision ?? (await nextFirmResearchRevision(context, input.firmId));
  const key = jobIdempotencyKey.researchFirm(input.firmId, revision);
  const payload: EnrichmentJobPayload = {
    firmId: input.firmId,
    revision,
    providerKey: input.providerKey,
    extractionProviderKey: input.extractionProviderKey ?? null,
  };
  const outcome = await enqueueJob(db, {
    workspaceId: context.scope.workspaceId,
    kind: 'research.firm',
    idempotencyKey: key,
    payload: { ...payload },
  });
  return accept({ jobId: outcome.jobId, kind: 'research.firm', idempotencyKey: key, inserted: outcome.inserted });
}

/**
 * Parse a `research.page` payload. Section 13.2 calls the payload "validated JSON";
 * a handler that trusted it would run a provider query somebody could have written
 * into the row.
 */
export function parseDiscoveryPagePayload(payload: Readonly<Record<string, unknown>>): DiscoveryPageJobPayload | null {
  const query = payload['query'];
  const pageToken = payload['pageToken'];
  const providerKey = payload['providerKey'];
  const requestedByUserId = payload['requestedByUserId'];
  if (typeof query !== 'string' || query.trim() === '' || query.length > 500) return null;
  if (pageToken !== null && (typeof pageToken !== 'string' || pageToken.length > 4096)) return null;
  if (typeof providerKey !== 'string' || !/^[a-z][a-z0-9_.-]{1,63}$/u.test(providerKey)) return null;
  if (requestedByUserId !== null && typeof requestedByUserId !== 'string') return null;
  return { query, pageToken, providerKey, requestedByUserId };
}

/** Parse a `research.firm` payload, for the same reason. */
export function parseEnrichmentPayload(payload: Readonly<Record<string, unknown>>): EnrichmentJobPayload | null {
  const firmId = payload['firmId'];
  const revision = payload['revision'];
  const providerKey = payload['providerKey'];
  const extractionProviderKey = payload['extractionProviderKey'];
  if (typeof firmId !== 'string' || firmId.length !== 36) return null;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return null;
  if (typeof providerKey !== 'string' || !/^[a-z][a-z0-9_.-]{1,63}$/u.test(providerKey)) return null;
  if (extractionProviderKey !== null && typeof extractionProviderKey !== 'string') return null;
  return { firmId, revision, providerKey, extractionProviderKey };
}

/**
 * A digest of the page request, so `research:{query_hash}:{page_hash}` is a fixed
 * width whether or not there is a continuation token. The first page of a query has
 * the digest of the empty string, which is a constant, so the first page of a query is
 * always the same job.
 */
function requestHash(pageToken: string | null): string {
  return queryHash(`page-token:${pageToken ?? ''}`);
}
