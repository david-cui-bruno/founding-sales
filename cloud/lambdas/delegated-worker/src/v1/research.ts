import { z } from 'zod';
import { accountInstantSchema, type AccountSource } from '../../../../../src/shared/contracts/accountContract';
import { sha256Utf8 } from '../../../../../src/shared/crypto/sha256';
import { isExcludedNumber } from '../../../../../src/main/communications/excludedNumbers';
import { createCompanyPageProvider, type PageHttp } from '../../../../../src/main/research/companyPageProvider';
import { createFetchedReceiptPolicy } from '../../../../../src/main/research/companySourcePolicy';
import { requestCompanyFacts, type CompanyFactExtractor, type KnownCompanyExtraction } from '../../../../../src/main/research/companyFactExtraction';
import { PLACES_MAX_PAGES_PER_QUERY, placesPermittedSources, requestPlacesTextSearch, type PlacesCandidate } from '../../../../../src/main/research/placesDiscoveryProvider';
import { PLACES_MAX_COMPANIES } from '../../../../../src/main/research/companyResearchTypes';
import { keyPart, type DynamoStore } from '../dynamoStore';
import { jobEnqueueable, markQueued, readJobs, researchBackfillJobId, researchFirmJobId, type JobKind } from '../queue/jobs';
import type { QueueClient } from '../queue/queueClient';
import { recordAttempt } from './attempts';
import { deriveStateAndZoneFromAddress, evidenceSummaryLine, planFirmEvidenceSummary, readEvidence, writeEvidence,
  type EvidenceBusinessEmail, type EvidenceExtraction, type EvidenceSource } from './evidence';
import { listedFirmIds } from './dayBuild';
import { createAccountFirmSource } from './firms';
import { firmKey, firmRecordSchema, listFirmRecords, readFirmRecord, type FirmRecord, type FirmRoute } from './firmsWrite';
import { poolCountsOf, planPoolCounter, readPoolCounter, readResearchSettings, remainingResearchToday, spendResearch } from './pool';
import { posturesByState, readPostures } from './postures';
import { listSuppressedFirmIds, readFirmSuppression } from './suppression';

/**
 * Research as two queue jobs (FSS target design section 4; slice S4).
 *
 *   research.backfill_page   `backfill:<queryHash>:<pageHash>` — one Places page for one query, creating a
 *                            `FIRM#` per candidate with its state and zone derived from the listing address.
 *   research.firm            `research:<firmId>:<revision>` — the carried page fetch, extraction and business
 *                            email discovery for one firm, writing `EVIDENCE#` and the claim.
 *
 * Both take every provider as an argument. The Places call is the carried `requestPlacesTextSearch` over the
 * injected `fetch`; the page fetch is the carried `createCompanyPageProvider` over the injected `PageHttp` and
 * DNS resolver, which is also where the free-mail refusal and the on-domain business email rule live. Nothing
 * here dials, sends or books, and nothing here invents an address, a number or a fact.
 *
 * Neither job ever touches a firm carrying `SUPPRESS#FIRM#`. Suppression is permanent and has no undo, so a
 * refresh that re-admitted a route or moved a status would quietly reverse a decision David made once.
 *
 * What stops the same page being fetched twice is the `JOB#` claim, not a ledger of its own. The scheduler
 * offers exactly the frontier page of each query, the runner claims `JOB#backfill:<queryHash>:<pageHash>`
 * before any HTTP, the day's counter is spent before the call, and the query cursor only moves once the page
 * has actually come back. A page whose response was lost therefore keeps its spend and is retried under the
 * same job id — the same property the carried reservation ledger gives the old path, reached with the queue's
 * own machinery instead of a second ledger.
 */

const instant = accountInstantSchema;

/** Design section 4: the runner has five minutes; one firm's research is given two of them. */
export const RESEARCH_FIRM_BUDGET_MS = 2 * 60_000;
/** Enough pool for the next morning's thirty, with room for the firms a posture or a suppression takes out. */
export const RESEARCH_POOL_TARGET = 40;
export const RESEARCH_PAGES_PER_TICK = 5;
export const RESEARCH_FIRM_JOBS_PER_TICK = 30;
/** The firm's own site, as far as the carried page provider walks it: `/`, `/services`, `/team`, `/careers`. */
export const RESEARCH_PAGES_PER_FIRM = 4;
export const RESEARCH_BYTES_PER_FIRM = 400_000;
/** Firm ids keep today's shape, so one id space spans both cores. */
export const RESEARCHED_FIRM_ID_PREFIX = 'account-';

// ---------------------------------------------------------------------------------------------------------
// Identifiers and the query cursor
// ---------------------------------------------------------------------------------------------------------

/** The query's identity inside a job id: short, stable and free of the colons and spaces a query contains. */
export const queryHashOf = (query: string): string => sha256Utf8(JSON.stringify({ kind: 'research_query', version: 1, query: query.trim() })).slice(0, 32);
/** The page's identity inside a job id. The first page of a query has no token, and says so rather than guessing one. */
export const pageHashOf = (pageToken: string | null): string =>
  pageToken === null ? 'first' : sha256Utf8(JSON.stringify({ kind: 'research_page', version: 1, pageToken })).slice(0, 32);
/** The id one Places listing becomes. Derived from the place id alone, so the same listing is always the same firm. */
export const researchedFirmId = (placeId: string): string =>
  `${RESEARCHED_FIRM_ID_PREFIX}${sha256Utf8(JSON.stringify({ kind: 'researched_firm', version: 1, placeId })).slice(0, 32)}`;

export const RESEARCH_QUERY_PREFIX = 'RESEARCH#QUERY#';
export const researchQueryKey = (queryHash: string): string => `${RESEARCH_QUERY_PREFIX}${keyPart(queryHash)}`;
/**
 * Where one query's sweep stands: the page the next job should fetch, and how many of the three Places allows
 * per query have already come back. Written by the scheduler when it offers a page and advanced by the job
 * that fetched it, never both at once.
 */
export const researchQueryCursorSchema = z.strictObject({
  version: z.literal(1),
  query: z.string().trim().min(1).max(500),
  queryHash: z.string().min(1).max(64),
  /** The page token the next fetch carries; null is the query's first page. */
  pageToken: z.string().min(1).max(4096).nullable(),
  /** How many pages of this query have come back. Never past `PLACES_MAX_PAGES_PER_QUERY`. */
  pagesDone: z.number().int().nonnegative().max(PLACES_MAX_PAGES_PER_QUERY),
  /** The query has no more pages to offer, or has used all three. Its sweep restarts only when the queries change. */
  exhausted: z.boolean(),
  updatedAt: instant,
});
export type ResearchQueryCursor = z.infer<typeof researchQueryCursorSchema>;

export async function readResearchQueryCursor(store: DynamoStore, queryHash: string): Promise<{ record: ResearchQueryCursor; rev: number } | null> {
  const row = await store.get<unknown>(researchQueryKey(queryHash));
  if (!row) return null;
  const parsed = researchQueryCursorSchema.safeParse(row.data);
  return parsed.success ? { record: parsed.data, rev: row.rev } : null;
}

/** Every query cursor now, by query hash. One prefix query; a row the schema refuses is skipped, never coerced. */
export async function listResearchQueryCursors(store: DynamoStore): Promise<Map<string, ResearchQueryCursor>> {
  const cursors = new Map<string, ResearchQueryCursor>();
  for (const row of await store.list<unknown>(RESEARCH_QUERY_PREFIX)) {
    const parsed = researchQueryCursorSchema.safeParse(row.stored.data);
    if (parsed.success) cursors.set(parsed.data.queryHash, parsed.data);
  }
  return cursors;
}

// ---------------------------------------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------------------------------------

export type ResearchDependencies = {
  store: DynamoStore;
  /** The Places text search's only boundary. The carried request function takes exactly this. */
  fetch: typeof globalThis.fetch;
  /** The Places key, or absent: the job is held as `places_not_configured` rather than pretending to have run. */
  places?: { apiKey: string } | null | undefined;
  /** The carried page provider's boundaries. Absent is a refusal to fetch, which is honest, not a silent success. */
  pageHttp?: PageHttp | undefined;
  resolve?: ((hostname: string) => Promise<string[]>) | undefined;
  /** The reviewed model extraction, when one is configured. Without it the firm keeps its regex facts and routes. */
  extraction?: { capability: KnownCompanyExtraction; credentials: { apiKey: string; model: string } } | null | undefined;
  /**
   * Where the backfill page puts the per-firm jobs it created. The production runner holds no queue permission,
   * so it passes none and the scheduler's next tick picks the new firms up instead; a caller that does hold one
   * (and the scenario tests) gets them enqueued the moment the page lands.
   */
  queue?: QueueClient | undefined;
  budgetMs?: number | undefined;
};

export type BackfillReport = {
  outcome: 'completed' | 'held' | 'no_op';
  reason: string | null;
  query: string | null;
  created: number;
  enqueued: number;
  skipped: { suppressed: number; existing: number; no_website: number; state_unknown: number };
};
export type FirmResearchReport = { outcome: 'completed' | 'held' | 'no_op'; reason: string | null; sources: number; businessEmail: boolean; revision: number | null };

// ---------------------------------------------------------------------------------------------------------
// research.backfill_page
// ---------------------------------------------------------------------------------------------------------

/**
 * One Places page for one query. Creates a `FIRM#` per candidate the page named that is neither suppressed nor
 * already known, with its state, city and zone derived from the listing's own formatted address: an unknown
 * state or zone is a hold on the firm, never a reason to refuse the firm. The listed phone becomes a route
 * with the verification word `listed` — a directory entry, not the company's own page — unless it is a number
 * the production launcher would never dial, which is refused here so it can never reach a card.
 */
export async function runResearchBackfillPage(deps: ResearchDependencies, input: { jobId: string; queryHash: string; pageHash: string }, signal: AbortSignal): Promise<BackfillReport> {
  const started = Date.now();
  const store = deps.store;
  const empty: BackfillReport['skipped'] = { suppressed: 0, existing: 0, no_website: 0, state_unknown: 0 };
  const settle = async (report: BackfillReport): Promise<BackfillReport> => {
    await recordAttempt(store, { kind: 'research', outcome: report.outcome === 'completed' ? 'ok' : report.outcome === 'held' ? 'held' : 'ok',
      reason: report.reason, detail: { code: 'research_backfill_page', count: report.created, jobId: input.jobId.slice(0, 80) },
      durationMs: Date.now() - started, ref: `backfill:${input.queryHash}` });
    return report;
  };

  const held = await readResearchQueryCursor(store, input.queryHash);
  if (!held) return settle({ outcome: 'no_op', reason: 'query_unknown', query: null, created: 0, enqueued: 0, skipped: empty });
  // The frontier moved on: this page has already come back, and the job id says so exactly. A no-op, not a refetch.
  if (held.record.exhausted || pageHashOf(held.record.pageToken) !== input.pageHash) {
    return settle({ outcome: 'no_op', reason: 'already_advanced', query: held.record.query, created: 0, enqueued: 0, skipped: empty });
  }
  if (!deps.places?.apiKey) return settle({ outcome: 'held', reason: 'places_not_configured', query: held.record.query, created: 0, enqueued: 0, skipped: empty });

  // Spent before the call it pays for: a page whose response is lost still costs what it reserved. A refused
  // spend means the day's budget was already gone, and nothing is fetched on a budget that was not charged.
  const spend = await spendResearch(store, { units: 1 });
  if (!spend.charged) return settle({ outcome: 'held', reason: 'budget_exhausted', query: held.record.query, created: 0, enqueued: 0, skipped: empty });

  const page = await requestPlacesTextSearch({ textQuery: held.record.query, pageToken: held.record.pageToken, pageSize: PLACES_MAX_COMPANIES,
    apiKey: deps.places.apiKey, fetch: deps.fetch, signal, fetchedAt: store.now() });
  signal.throwIfAborted();

  const [suppressed, existing] = await Promise.all([listSuppressedFirmIds(store), listFirmRecords(store)]);
  const knownDomains = new Set([...existing.values()].flatMap(record => record.domain ? [record.domain] : []));
  const skipped: BackfillReport['skipped'] = { ...empty, no_website: page.skipped.no_website + page.skipped.website_blocked };
  const created: FirmRecord[] = [];
  for (const candidate of page.candidates) {
    signal.throwIfAborted();
    const firmId = researchedFirmId(candidate.placeId);
    if (suppressed.has(firmId) || await readFirmSuppression(store, firmId)) { skipped.suppressed++; continue; }
    if (existing.has(firmId) || knownDomains.has(candidate.domain)) { skipped.existing++; continue; }
    const record = firmRecordOf(candidate, store.now());
    if (record.state === null || record.timeZone === null) skipped.state_unknown++;
    try { await store.transact([store.put(firmKey(firmId), record, null)]); }
    catch { skipped.existing++; continue; }
    existing.set(firmId, record); knownDomains.add(candidate.domain);
    created.push(record);
  }

  // The cursor moves only now that the page has actually come back, so the next frontier is a new job id.
  const pagesDone = Math.min(PLACES_MAX_PAGES_PER_QUERY, held.record.pagesDone + 1);
  const next = researchQueryCursorSchema.parse({ ...held.record, pageToken: page.nextPageToken, pagesDone,
    exhausted: page.nextPageToken === null || pagesDone >= PLACES_MAX_PAGES_PER_QUERY, updatedAt: store.now() });
  try { await store.transact([store.put(researchQueryKey(input.queryHash), next, held.rev)]); }
  catch { /* Another runner settled this page first; its cursor and ours name the same next page. */ }

  let enqueued = 0;
  if (deps.queue) {
    for (const record of created) {
      try { await deps.queue.enqueue({ jobId: researchFirmJobId(record.firmId, 1), kind: 'research.firm' satisfies JobKind }); enqueued++; }
      catch { /* The queue is unavailable; the scheduler offers the firm again on its next tick. */ }
    }
  }
  return settle({ outcome: 'completed', reason: null, query: held.record.query, created: created.length, enqueued, skipped });
}

/** One Places candidate as a `FIRM#` record. Pure over the candidate and the instant. */
export function firmRecordOf(candidate: PlacesCandidate, now: string): FirmRecord {
  let formatted: string | null = null;
  try { formatted = z.object({ formattedAddress: z.string().optional() }).parse(JSON.parse(candidate.evidence.excerpt)).formattedAddress ?? null; } catch { formatted = null; }
  const firmId = researchedFirmId(candidate.placeId);
  const sourceId = `place-${candidate.placeId}`;
  const derived = deriveStateAndZoneFromAddress(formatted, sourceId);
  const routes: FirmRoute[] = [];
  // A number the production launcher refuses (service and short codes, the plant-test exchanges, the reserved
  // fictional 555-01XX block) is refused here, so it can never reach a card in the first place.
  if (candidate.listedPhone && isExcludedNumber(candidate.listedPhone) === false) {
    routes.push({ id: `route-listed-${sha256Utf8(JSON.stringify({ firmId, phone: candidate.listedPhone })).slice(0, 32)}`,
      channel: 'phone', value: candidate.listedPhone, purpose: 'business', verification: 'listed', version: 1, enteredAt: now });
  }
  return firmRecordSchema.parse({ version: 1, firmId, name: candidate.name.slice(0, 300), domain: candidate.domain,
    city: derived.city, state: derived.state, timeZone: derived.timeZone, derivedZoneFrom: derived.derivation.zoneFrom,
    status: 'new', enteredBy: 'research', evidenceSummary: '', researchRevision: 0, researchedAt: null,
    routes, enteredAt: now, updatedAt: now });
}

// ---------------------------------------------------------------------------------------------------------
// research.firm
// ---------------------------------------------------------------------------------------------------------

/**
 * One firm's research pass: the carried page fetch over the firm's own site, the regex facts and routes it
 * yields, the business email the on-domain finder selects (free mail refused, as the shared contract requires)
 * and, when a reviewed extraction is configured, one bounded model call over the same pages. What comes back is
 * split: the sources and the finding to `EVIDENCE#`, one line and the revision to `FIRM#`.
 */
export async function runResearchFirmJob(deps: ResearchDependencies, input: { jobId: string; firmId: string; revision: number }, signal: AbortSignal): Promise<FirmResearchReport> {
  const started = Date.now();
  const store = deps.store;
  const settle = async (report: FirmResearchReport): Promise<FirmResearchReport> => {
    await recordAttempt(store, { kind: 'research', outcome: report.outcome === 'held' ? 'held' : 'ok', reason: report.reason,
      detail: { code: 'research_firm', firmId: input.firmId.slice(0, 80), count: report.sources, jobId: input.jobId.slice(0, 80) },
      durationMs: Date.now() - started, ref: input.firmId.slice(0, 80) });
    return report;
  };

  if (await readFirmSuppression(store, input.firmId)) return settle({ outcome: 'no_op', reason: 'suppressed', sources: 0, businessEmail: false, revision: null });
  const held = await readFirmRecord(store, input.firmId);
  if (!held) return settle({ outcome: 'no_op', reason: 'firm_unknown', sources: 0, businessEmail: false, revision: null });
  // A repeat of a revision already written is a no-op: the id names the pass, and the pass has happened.
  if ((held.record.researchRevision ?? 0) >= input.revision) {
    const evidence = await readEvidence(store, input.firmId);
    return settle({ outcome: 'no_op', reason: 'already_researched', sources: evidence?.record.sources.length ?? 0,
      businessEmail: evidence?.record.businessEmailFinding?.email !== undefined && evidence?.record.businessEmailFinding?.email !== null, revision: held.record.researchRevision ?? null });
  }
  if (!held.record.domain) return settle({ outcome: 'held', reason: 'no_site', sources: 0, businessEmail: false, revision: null });
  if (!deps.pageHttp || !deps.resolve) return settle({ outcome: 'held', reason: 'research_not_configured', sources: 0, businessEmail: false, revision: null });

  const spend = await spendResearch(store, { units: 1 });
  if (!spend.charged) return settle({ outcome: 'held', reason: 'budget_exhausted', sources: 0, businessEmail: false, revision: null });

  // Two minutes of the runner's five, and not a second more: one slow site never starves the rest of the queue.
  const budget = AbortSignal.any([signal, AbortSignal.timeout(deps.budgetMs ?? RESEARCH_FIRM_BUDGET_MS)]);
  const permitted = new Set(placesPermittedSources(held.record.domain, RESEARCH_PAGES_PER_FIRM));
  const extractFacts: CompanyFactExtractor | null = deps.extraction
    ? async (factInput, requestSignal) => requestCompanyFacts({ input: factInput, credentials: deps.extraction!.credentials, signal: requestSignal, fetch: deps.fetch })
    : null;
  const pages = createCompanyPageProvider({
    receipts: createFetchedReceiptPolicy(), clock: { now: () => store.now() },
    permitted: (url: string) => permitted.has(url),
    resolve: deps.resolve, http: deps.pageHttp,
    ...(deps.extraction && extractFacts ? { modelExtraction: { capability: deps.extraction.capability, extractFacts } } : {}),
  });

  const batch = await pages.research({ account: { id: input.firmId, name: held.record.name, domain: held.record.domain, version: 1 },
    claims: [], routes: [], portfolio: [], unknowns: [], conflicts: [], fingerprint: '' },
    { maxCompanies: PLACES_MAX_COMPANIES, maxPages: RESEARCH_PAGES_PER_FIRM, maxBytes: RESEARCH_BYTES_PER_FIRM,
      maxCostMicros: deps.extraction?.capability.maxCostMicros ?? 1 }, budget);

  const sources: EvidenceSource[] = batch.sources.slice(0, 40).map((source: AccountSource) =>
    ({ id: source.id, url: source.url, fetchedAt: source.fetchedAt, sha256: source.sha256, excerpt: source.excerpt }));
  const emailClaim = batch.claims.find(claim => claim.key === 'business_email');
  const businessEmail = emailClaim?.key === 'business_email' ? emailClaim.value : null;
  const finding: EvidenceBusinessEmail = {
    email: businessEmail, sourceId: emailClaim?.evidenceIds[0] ?? null,
    selection: emailClaim?.key === 'business_email' ? emailClaim.selection : null,
    considered: businessEmail ? [businessEmail] : [],
    // The finder's own counts stay inside the page provider; what is durable here is what it chose and what it did not.
    refused: { free_mail: 0, off_domain: 0, withheld_contact: 0, unparsable: businessEmail ? 0 : 1 },
  };
  const facts = batch.claims.flatMap(claim => claim.kind === 'fact' && claim.key !== 'business_email' && claim.key !== 'portfolio' && typeof claim.value === 'string'
    ? [{ key: claim.key, sourceId: claim.evidenceIds[0] ?? sources[0]?.id ?? 'unknown', quote: String(claim.value).slice(0, 2000) }] : []);
  const extraction: EvidenceExtraction | null = facts.length
    ? { facts: facts.filter(fact => isExtractionKey(fact.key)).slice(0, 60) as EvidenceExtraction['facts'], at: store.now() } : null;

  const written = await writeEvidence(store, { firmId: input.firmId, sources, extraction, businessEmailFinding: finding,
    revision: input.revision, jobId: input.jobId });
  if (!written.written) return settle({ outcome: 'held', reason: 'evidence_too_large', sources: sources.length, businessEmail: businessEmail !== null, revision: null });

  const researchedAt = store.now();
  const summary = evidenceSummaryLine({ sources: sources.length, businessEmail, facts: facts.length, researchedAt });
  const emailRoute = businessEmail ? firmRouteOf(input.firmId, 'email', businessEmail, 'published', researchedAt) : null;
  const carried = held.record.routes;
  const routes = emailRoute && !carried.some(route => route.channel === 'email' && route.value === emailRoute.value) ? [...carried, emailRoute] : carried;
  const record = firmRecordSchema.parse({ ...held.record, evidenceSummary: summary, researchRevision: input.revision,
    researchedAt, routes, updatedAt: researchedAt });
  try { await store.transact([store.put(firmKey(input.firmId), record, held.rev)]); }
  catch { await store.transact(await planFirmEvidenceSummary(store, { firmId: input.firmId, summary, revision: input.revision, researchedAt })); }

  await refreshPoolCounter(store);
  return settle({ outcome: 'completed', reason: null, sources: sources.length, businessEmail: businessEmail !== null, revision: written.revision });
}

const EXTRACTION_KEYS = new Set(['ownership', 'portfolio_description', 'residential_scope', 'operating_footprint', 'maintenance_workflow', 'role', 'target_fit', 'not_target']);
const isExtractionKey = (key: string): boolean => EXTRACTION_KEYS.has(key);

function firmRouteOf(firmId: string, channel: 'phone' | 'email', value: string, verification: FirmRoute['verification'], enteredAt: string): FirmRoute {
  return { id: `route-${channel}-${sha256Utf8(JSON.stringify({ firmId, channel, value })).slice(0, 32)}`,
    channel, value, purpose: 'business', verification, version: 1, enteredAt };
}

/**
 * The pool counter after one firm changed. Recounted from the firm source rather than incremented, because the
 * research job already holds the reads that make the count true and a wrong number here would quietly stop the
 * scheduler enqueueing. `day.build` recounts the same way every morning.
 */
async function refreshPoolCounter(store: DynamoStore): Promise<void> {
  const [firms, postures, listedBefore] = await Promise.all([createAccountFirmSource(store).listFirms(), readPostures(store), listedFirmIds(store)]);
  const counts = poolCountsOf({ firms, postures: posturesByState(postures), listedBefore, now: store.now() });
  try { await store.transact(await planPoolCounter(store, counts)); }
  catch { /* Another job counted first. The morning recount is what makes the number true either way. */ }
}

// ---------------------------------------------------------------------------------------------------------
// The scheduler's research decision
// ---------------------------------------------------------------------------------------------------------

export type ResearchEnqueueReport = {
  enqueued: { jobId: string; kind: JobKind }[];
  skipped: { jobId: string; reason: string }[];
  /** Why no page was offered at all, when that is the answer: the pool is full, the budget is gone, or nothing is configured. */
  held: 'pool_full' | 'budget_exhausted' | 'no_queries' | 'descriptor_expired' | null;
  pool: number;
  remaining: number;
};

/**
 * What research the scheduler should put on the queue this tick. Backfill pages while the posture-cleared pool
 * is under forty and today's budget has room, at most five of them; then the firms that have a record but no
 * research yet, at most thirty. A job already queued, running under a live lease, or failed inside its backoff
 * window is never offered again — the decision is exactly the one the scheduler makes for a send.
 *
 * Nothing here fetches anything. It reads counters and cursors, writes the cursor row a page needs to identify
 * itself, and enqueues.
 */
export async function enqueueResearch(store: DynamoStore, queue: QueueClient, now: string): Promise<ResearchEnqueueReport> {
  const report: ResearchEnqueueReport = { enqueued: [], skipped: [], held: null, pool: 0, remaining: 0 };
  const [settings, pool, budget, jobs] = await Promise.all([readResearchSettings(store, now), readPoolCounter(store), remainingResearchToday(store, now), readJobs(store)]);
  report.pool = pool.postureCleared;
  report.remaining = budget.remaining;

  const offer = async (jobId: string, kind: JobKind): Promise<boolean> => {
    const decision = jobEnqueueable(jobs.get(jobId) ?? null, now);
    if (!decision.enqueue) { report.skipped.push({ jobId, reason: decision.reason }); return false; }
    try { await queue.enqueue({ jobId, kind }); } catch { report.skipped.push({ jobId, reason: 'queue_unavailable' }); return false; }
    await markQueued(store, { jobId, kind });
    report.enqueued.push({ jobId, kind });
    return true;
  };

  if (budget.remaining <= 0) report.held = 'budget_exhausted';
  else if (settings.record.descriptor !== null && settings.record.descriptor.status === 'expired') report.held = 'descriptor_expired';
  else if (pool.postureCleared >= RESEARCH_POOL_TARGET) report.held = 'pool_full';
  else if (settings.record.queries.length === 0) report.held = 'no_queries';

  if (report.held === null) {
    const cursors = await listResearchQueryCursors(store);
    let pages = 0;
    for (const query of settings.record.queries) {
      if (pages >= RESEARCH_PAGES_PER_TICK || pages >= budget.remaining) break;
      const queryHash = queryHashOf(query);
      const cursor = cursors.get(queryHash);
      if (cursor?.exhausted) continue;
      if (!cursor) {
        const seed = researchQueryCursorSchema.parse({ version: 1, query, queryHash, pageToken: null, pagesDone: 0, exhausted: false, updatedAt: store.now() });
        try { await store.transact([store.put(researchQueryKey(queryHash), seed, null)]); }
        catch { /* Another tick seeded it; the frontier it names is the same one. */ }
      }
      const frontier = cursor ?? (await readResearchQueryCursor(store, queryHash))?.record;
      if (!frontier || frontier.exhausted) continue;
      if (await offer(researchBackfillJobId(queryHash, pageHashOf(frontier.pageToken)), 'research.backfill_page')) pages++;
    }
  }

  // The firms a page created but nothing has researched yet. Offered whatever the pool says: a firm with a
  // record and no evidence is work already paid for once, and leaving it unresearched wastes the page that found it.
  if (budget.remaining > 0) {
    let firms = 0;
    const suppressed = await listSuppressedFirmIds(store);
    for (const record of (await listFirmRecords(store)).values()) {
      if (firms >= RESEARCH_FIRM_JOBS_PER_TICK || firms >= budget.remaining) break;
      if (record.enteredBy !== 'research' || (record.researchRevision ?? 0) > 0) continue;
      if (suppressed.has(record.firmId) || record.status === 'suppressed') continue;
      if (await offer(researchFirmJobId(record.firmId, 1), 'research.firm')) firms++;
    }
  }
  return report;
}
