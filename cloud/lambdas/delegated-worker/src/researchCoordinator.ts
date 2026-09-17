import { ResearchDiscoveryError } from '../../../../src/main/research/researchDiscoveryError';
import { assertGuidedResearch, guardGuidedResearch, reviewedResearchProfile, guidedResearchMarkerKey, type ResearchSetupProfile } from './researchSetup';
import { TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { ownerResearchSourceSchema, ownerResearchSourceKey, type OwnerResearchSource } from '../../../../src/shared/contracts/ownerCommandContract';
import { PLACES_SEARCH_COST_MICROS } from '../../../../src/shared/contracts/researchSetupContract';
import type { AccountEvidenceBatch, AccountSource } from '../../../../src/shared/contracts/accountContract';
import { pairingKey, type WorkerAuth } from './workerAuth';
import { fingerprint, type DynamoAdapter, type DynamoStore, type RepositoryOptions } from './dynamoStore';
import { createCompanyPageProvider, type PageHttp } from '../../../../src/main/research/companyPageProvider';
import { createFetchedReceiptPolicy } from '../../../../src/main/research/companySourcePolicy';
import { createCompanyPreparation, createCompanyResearchWorker, derivedCommand } from '../../../../src/main/research/companyResearchWorker';
import { createCompanyDiscoveryProvider, requestCompanyDiscovery } from '../../../../src/main/research/companyDiscoveryProvider';
import { requestGuidedCompanyDiscovery, validateGuidedDiscoverySources } from '../../../../src/main/research/guidedCompanyDiscoveryProvider';
import { createPlacesDiscoveryProvider, placesPermittedSources, placesQueryGrid, PLACES_MAX_PAGES_PER_QUERY, type PlacesCandidate, type PlacesPage } from '../../../../src/main/research/placesDiscoveryProvider';
import { createWorkerAccountRepository, type DynamoWorkerAccountRepository } from './workerAccountRepository';
import { budgetSchema, createDiscoveryReservationStore, placesCursorKey, placesCursorSchema, type DynamoDiscoveryReservationStore, type PlacesCursor, type ReservedCandidate } from './discoveryReservationStore';
import type { PlacesBatchReport, SourceTickReport } from './sourceCoordinator';
import { effectiveDiscoveryProvider, type AccountResearchStore, type ResearchJob } from '../../../../src/main/research/companyResearchTypes';
import type { ResearchOnceRequest, ResearchOnceNextReceipt } from './researchOnceContract';
export type SourceResearchBoundaries = { loadCredentials(workspaceId: string, signal: AbortSignal): Promise<{ apiKey: string; model: string }>;
  /** Present only when the Places credential parameter is declared; a Places configuration is held without it. */
  loadPlacesCredentials?(workspaceId: string, signal: AbortSignal): Promise<{ apiKey: string }>;
  pageHttp: PageHttp; resolve(hostname: string): Promise<string[]> };
export type ResolvedResearchSuccessor = { runId: string; receipt: { key: string; rev: number; fingerprint: string }; parent: { key: string; rev: number; fingerprint: string } };
export type ResolvedResearchCycle = { runId: string; descriptorFingerprint: string; receipt: { key: string; rev: number; fingerprint: string }; head: { key: string; rev: number; fingerprint: string } };
export type ResearchCoordinatorOptions = { auth: WorkerAuth; fetch: typeof globalThis.fetch; research?: SourceResearchBoundaries; researchSetupProfile?: ResearchSetupProfile; resolvedSuccessor?: ResolvedResearchSuccessor; resolvedCycle?: ResolvedResearchCycle };
export function researchRunId(workspaceId: string, pairingId: string, research: unknown): string {
  const identity = fingerprint({ workspaceId, pairingId, research });
  return `${identity.slice(0,8)}-${identity.slice(8,12)}-4${identity.slice(13,16)}-a${identity.slice(17,20)}-${identity.slice(20,32)}`;
}

export function researchSuccessorRunId(request: ResearchOnceNextReceipt['request']): string {
  const hash = fingerprint({ version: 'research-once-next-v1', workspaceId: request.workspaceId, pairingId: request.pairingId,
    parentRunId: request.parentRunId, researchFingerprint: request.researchFingerprint, currentRevision: request.expectedSourceRevision,
    expectedExecutionRevision: 3, descriptorFingerprint: request.descriptorFingerprint });
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
export async function runResearch(input: ResearchCoordinatorOptions, signal: AbortSignal, report: SourceTickReport, once?: ResearchOnceRequest) {
    const store = input.auth.store;
    const boundaries = input.research; if (!boundaries) return;
    const row = await store.get<unknown>(ownerResearchSourceKey()); if (!row) return;
    const config = ownerResearchSourceSchema.parse(row.data);
    if (config.workspaceId !== store.options.workspaceId || config.state !== 'active' || !config.research) return;
    const guided = await guardGuidedResearch(store, config, input.researchSetupProfile ?? {});
    const settings = config.research;
    // Selected-account desktop opt-in is not a discovery or hosted-cycle capability.
    if (settings.researchLimits.knownCompanyExtraction) return;
    const provider = effectiveDiscoveryProvider(settings.discoveryProvider);
    // Places is a scheduled bulk source only; research.once and hosted cycles keep the cited single-company transport.
    if (once && provider === 'places') return;
    if (once && (!guided || config.pairingId !== once.pairingId || config.revision !== once.expectedSourceRevision
      || fingerprint(settings) !== once.researchFingerprint || settings.discoveryLimits.maxCompanies !== 1)) return;
    // Refuse missing page budget BEFORE reserving discovery/provider spend.
    const runId = input.resolvedCycle?.runId ?? input.resolvedSuccessor?.runId ?? researchRunId(config.workspaceId, config.pairingId, settings);
    if (once) {
      const row = await store.get('BUDGET#research');
      if (!row) return;
      const budget = budgetSchema.parse(row.data);
      const prior = await createDiscoveryReservationStore(store.options).readRun(runId);
      if (prior && (!prior.researchOnceBinding || prior.researchOnceBinding.pairingId !== once.pairingId
        || prior.researchOnceBinding.researchFingerprint !== once.researchFingerprint || prior.researchOnceBinding.sourceRevision !== once.expectedSourceRevision)) return;
      if (!prior && budget.limit - budget.spent < settings.researchLimits.maxCostMicros) return;
    }
    if (settings.workspaceId !== config.workspaceId || settings.researchLimits.maxCostMicros > settings.maxAccountBudgetMicros) throw new Error('research_config_mismatch');
    const pairing = await input.auth.activePairing(config.pairingId);
    async function guard() {
      signal.throwIfAborted();
      const marker = await guardGuidedResearch(store, config, input.researchSetupProfile ?? {});
      if (marker?.rev !== guided?.rev) throw new Error('research_setup_marker_changed');
      if (input.resolvedSuccessor) {
        for (const expected of [input.resolvedSuccessor.receipt, input.resolvedSuccessor.parent]) {
          const row = await store.get<unknown>(expected.key);
          if (!row || row.rev !== expected.rev || fingerprint(row.data) !== expected.fingerprint) throw new Error('research_next_binding_changed');
        }
      }
      if (input.resolvedCycle) {
        if (reviewedResearchProfile(input.researchSetupProfile ?? {}, store.now()).descriptorFingerprint !== input.resolvedCycle.descriptorFingerprint) throw new Error('research_cycle_binding_changed');
        for (const expected of [input.resolvedCycle.receipt, input.resolvedCycle.head]) {
          const row = await store.get<unknown>(expected.key);
          if (!row || row.rev !== expected.rev || fingerprint(row.data) !== expected.fingerprint) throw new Error('research_cycle_binding_changed');
        }
      }
      const current = await store.get<unknown>(ownerResearchSourceKey());
      if (!current || current.rev !== row!.rev || fingerprint(current.data) !== fingerprint(config)) throw new Error('research_source_changed');
      const active = await input.auth.activePairing(config.pairingId);
      if (active.rev !== pairing.rev) throw new Error('research_pairing_changed');
      // No await after this freshness/binding check before releasing the guard.
      if (marker) assertGuidedResearch(marker.data, config, input.researchSetupProfile ?? {}, store.now());
    }
    // The SDK boundary adds actual config and pairing CAS to every C1 mutation.
    // Reading a selector cannot approve budget, grant AUTH, or reset unknown spend.
    const dynamo: DynamoAdapter = { async send(command) {
      if (!(command instanceof TransactWriteItemsCommand)) return store.options.dynamo.send(command);
      await guard();
      return store.options.dynamo.send(new TransactWriteItemsCommand({ ...command.input, TransactItems: [...(command.input.TransactItems ?? []),
        store.check(ownerResearchSourceKey(), row.rev), store.check(pairingKey(config.pairingId), pairing.rev), guided ? store.check(guidedResearchMarkerKey, guided.rev) : store.absent(guidedResearchMarkerKey),
        ...(input.resolvedSuccessor ? [store.check(input.resolvedSuccessor.receipt.key, input.resolvedSuccessor.receipt.rev), store.check(input.resolvedSuccessor.parent.key, input.resolvedSuccessor.parent.rev)] : []),
        ...(input.resolvedCycle ? [store.check(input.resolvedCycle.receipt.key, input.resolvedCycle.receipt.rev), store.check(input.resolvedCycle.head.key, input.resolvedCycle.head.rev)] : [])] }));
    } };
    const options = { ...store.options, dynamo, ...(once ? { researchOnceBinding: {
      pairingId: config.pairingId, researchFingerprint: fingerprint(settings), sourceRevision: config.revision,
    } } : {}) };
    const accounts = createWorkerAccountRepository(options);
    const reservations = createDiscoveryReservationStore(options);
    if (provider === 'places') {
      await runPlacesBatch({ store, config, settings, guard, options, accounts, reservations, boundaries, fetch: input.fetch, signal, report });
      return;
    }
    // Only a trusted native cycle selects the cited single-company transport.
    // Existing receipts replay unchanged, including exhausted-budget settlement.
    // New unusable scopes must fail before a discovery reservation or credential read.
    const citedCycle = Boolean(once && input.resolvedCycle);
    if (citedCycle && !await reservations.readRun(runId)) validateGuidedDiscoverySources(settings.permittedSources);
    const discovery = createCompanyDiscoveryProvider({ capability: settings.capability, request: async (query, limits, requestSignal) => {
      await guard(); const credentials = await boundaries.loadCredentials(config.workspaceId, requestSignal);
      await guard();
      if (credentials.model !== settings.capability.model) throw new Error('research_model_mismatch');
      try {
        const request = { query, limits, capability: settings.capability, credentials, signal: requestSignal, fetch: input.fetch };
        return await (citedCycle
          ? requestGuidedCompanyDiscovery({ ...request, permittedSources: settings.permittedSources })
          : requestCompanyDiscovery(request));
      }
      catch (error) {
        if (!once || signal.aborted || error instanceof ResearchDiscoveryError) throw error;
        throw new Error('research_discovery_uncertain');
      }
    } });
    let selectedJobId: string | undefined;
    let selectedAccountId: string | undefined;
    const selectedAccounts: AccountResearchStore = once ? {
      create: value => accounts.create(value), snapshot: (id, at) => accounts.snapshot(id, at),
      admitEvidence: (batch, claim) => accounts.admitEvidence(batch, claim), settle: value => accounts.settle(value),
      enqueue: async (value: Parameters<typeof accounts.enqueue>[0]) => {
        if (selectedJobId && selectedJobId !== value.commandId) throw new Error('research_selection_conflict');
        selectedJobId = value.commandId; selectedAccountId = value.accountId;
        await accounts.enqueue(value);
      },
      claimNext: (asOf: string) => selectedJobId ? accounts.claimExact(selectedJobId, asOf, { accountId: selectedAccountId!, limits: settings.researchLimits }) : Promise.resolve(null),
    } : accounts;
    const prepared = await createCompanyPreparation({ store: selectedAccounts, reservations, discovery, configuration: settings }).prepare(runId, signal);
    report.status = 'completed';
    if (prepared.status !== 'prepared') { report.held++; return; }
    report.researchPrepared++;
    const pages = createCompanyPageProvider({ receipts: createFetchedReceiptPolicy(), clock: options.clock,
      permitted: (url) => settings.permittedSources.includes(url),
      resolve: async hostname => { await guard(); return boundaries.resolve(hostname); },
      http: async request => { await guard(); return boundaries.pageHttp(request); },
      onFetched: (source, accountId) => accounts.recordFetchedSource({ accountId, source }) });
    const worker = createCompanyResearchWorker({ store: selectedAccounts, clock: options.clock, pages: { async research(snapshot, limits, requestSignal) {
      await guard();
      if (!prepared.accountIds.includes(snapshot.account.id) || fingerprint(limits) !== fingerprint(settings.researchLimits)) throw new Error('research_job_config_mismatch');
      return pages.research(snapshot, limits, requestSignal);
    } } });
    const result = await worker.runNext(signal);
    if (result === 'completed') report.researchCompleted++;
    if (result === 'parked') report.held++;
  }

/** One Places page batch. The ordinal makes every batch its own reservation, so identical settings never replay a page. */
function placesBatchRunId(input: { workspaceId: string; pairingId: string; researchFingerprint: string; budgetId: string; ordinal: number }): string {
  const hash = fingerprint({ version: 'places-batch-v1', ...input });
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
type PlacesSettings = NonNullable<OwnerResearchSource['research']>;
type PlacesBatchContext = { store: DynamoStore; config: OwnerResearchSource; settings: PlacesSettings; guard(): Promise<void>; options: RepositoryOptions;
  accounts: DynamoWorkerAccountRepository; reservations: DynamoDiscoveryReservationStore; boundaries: SourceResearchBoundaries; fetch: typeof globalThis.fetch; signal: AbortSignal; report: SourceTickReport };
type Identities = Awaited<ReturnType<DynamoWorkerAccountRepository['listIdentities']>>;
const emptyPlacesReport = (): PlacesBatchReport => ({ outcome: 'held', runId: null, created: 0, routes: 0, enqueued: 0, drained: 0,
  skipped: { no_website: 0, website_blocked: 0, duplicate_domain: 0, duplicate_phone: 0, existing_domain: 0, existing_phone: 0, route_held: 0, enqueue_held: 0 } });
/** The next position after a page: the next page of the same query while Google offers a token and the per-query page cap allows, else the next query. */
function advancePlacesCursor(cursor: PlacesCursor, nextPageToken: string | null, gridLength: number): PlacesCursor {
  if (nextPageToken && cursor.page + 1 < PLACES_MAX_PAGES_PER_QUERY) return { ...cursor, page: cursor.page + 1, nextPageToken };
  const queryIndex = cursor.queryIndex + 1;
  return { ...cursor, queryIndex, page: 0, nextPageToken: null, exhausted: queryIndex >= gridLength };
}
/** Scheduled bulk discovery: settle the last batch, reserve one page, call Places once, persist the page with the advanced cursor,
 *  create accounts with their listed phone route and per-account research job, then drain page research until the phase deadline.
 *  Nothing here approves, enrolls or grants execution authority; it creates accounts, routes and research jobs only. */
async function runPlacesBatch(ctx: PlacesBatchContext): Promise<void> {
  const { store, config, settings, signal, report } = ctx;
  const places = emptyPlacesReport(); report.status = 'completed'; report.places = places;
  const budgetId = settings.budgetId; const cost = settings.discoveryLimits.maxCostMicros;
  const grid = placesQueryGrid(settings.audience); const gridFingerprint = fingerprint(grid);
  const identity = { workspaceId: config.workspaceId, pairingId: config.pairingId, researchFingerprint: fingerprint(settings), budgetId };
  const cursorRow = await store.get<unknown>(placesCursorKey(budgetId));
  let cursor: PlacesCursor = cursorRow ? placesCursorSchema.parse(cursorRow.data) : { version: 1, queryIndex: 0, page: 0, nextPageToken: null, exhausted: false, ordinal: 0, runId: null, gridFingerprint };
  let cursorRev = cursorRow?.rev ?? null;
  // A changed territory starts a new sweep from the first query; the ordinal keeps growing so no earlier batch id is reused.
  const gridChanged = cursor.gridFingerprint !== gridFingerprint;
  if (gridChanged) cursor = { ...cursor, queryIndex: 0, page: 0, nextPageToken: null, exhausted: false, gridFingerprint };
  const identities = await ctx.accounts.listIdentities();
  const drain = async () => { places.drained += await drainPageResearch(ctx); };
  if (cursor.runId) {
    const previous = await ctx.reservations.readRunWithRevision(cursor.runId);
    if (previous && !previous.data.completed) {
      // The last page's response was lost: its spend stays reserved, the page is never re-issued, and the sweep moves on.
      if (cursorRev === null) throw new Error('places_cursor_missing');
      const next = gridChanged ? cursor : advancePlacesCursor(cursor, null, grid.length);
      await ctx.reservations.completeBatch({ commandId: cursor.runId, workspaceId: config.workspaceId, budgetId, inputFingerprint: previous.data.inputFingerprint, candidates: [], costMicros: null }, { data: next, rev: cursorRev });
      places.outcome = 'uncertain'; places.runId = cursor.runId;
      await drain(); return;
    }
    // A completed page whose accounts were not all created (a crash after completion) is finished here without another call.
    if (previous?.data.completed && previous.data.candidates?.some(candidate => !identities.accountIds.has(`account-${fingerprint([config.workspaceId, derivedCommand(cursor.runId!, candidate.domain, 'create')])}`))) {
      await materialisePlacesCandidates(previous.data.candidates, cursor.runId, places, identities, ctx);
    }
  }
  if (cursor.exhausted || cursor.queryIndex >= grid.length) { places.outcome = 'exhausted'; await drain(); return; }
  if (!ctx.boundaries.loadPlacesCredentials || cost < PLACES_SEARCH_COST_MICROS) { places.outcome = 'held'; await drain(); return; }
  // Reserve the reviewed call cost and record the started batch on the cursor in one transaction, before any HTTP.
  const ordinal = cursor.ordinal + 1; const runId = placesBatchRunId({ ...identity, ordinal }); places.runId = runId;
  const started: PlacesCursor = { ...cursor, ordinal, runId };
  const inputFingerprint = fingerprint({ version: 'places-batch-v1', researchFingerprint: identity.researchFingerprint, queryIndex: cursor.queryIndex, page: cursor.page, pageToken: cursor.nextPageToken, ordinal });
  const reservation = await ctx.reservations.reserveBatch({ commandId: runId, workspaceId: config.workspaceId, budgetId, inputFingerprint, searchCostMicros: cost }, { data: started, rev: cursorRev });
  if (reservation.status === 'denied') { places.outcome = 'denied'; await drain(); return; }
  cursorRev = (cursorRev ?? 0) + 1;
  let candidates: ReservedCandidate[];
  if (reservation.status === 'replay') {
    // Another coordinator started this batch. In flight means hold; completed means create its accounts without another call.
    if (reservation.candidates === null) { places.outcome = 'held'; await drain(); return; }
    candidates = reservation.candidates;
  } else {
    places.outcome = 'uncertain';
    await ctx.guard();
    const credentials = await ctx.boundaries.loadPlacesCredentials(config.workspaceId, signal);
    await ctx.guard();
    let page: PlacesPage | undefined;
    const discovery = createPlacesDiscoveryProvider({ credentials, fetch: ctx.fetch, clock: ctx.options.clock,
      position: () => ({ queryIndex: cursor.queryIndex, pageToken: cursor.nextPageToken }), onPage: value => { page = value; } });
    const found = await discovery.discover(settings.audience, settings.discoveryLimits, signal) as PlacesCandidate[];
    signal.throwIfAborted();
    if (!page) throw new Error('places_page_missing');
    for (const reason of ['no_website', 'website_blocked', 'duplicate_domain', 'duplicate_phone'] as const) places.skipped[reason] += page.skipped[reason];
    // The page and the advanced cursor commit together; only then are accounts created, so a replay rebuilds the same accounts.
    await ctx.reservations.completeBatch({ commandId: runId, workspaceId: config.workspaceId, budgetId, inputFingerprint, candidates: found, costMicros: null },
      { data: advancePlacesCursor(started, page.nextPageToken, grid.length), rev: cursorRev });
    candidates = found;
  }
  await materialisePlacesCandidates(candidates, runId, places, identities, ctx);
  places.outcome = 'completed';
  await drain();
}
/** Idempotent per candidate: derived command ids make create, route admission and enqueue replay-safe after any interruption.
 *  Firms already known by domain or by listed phone are counted and skipped, never merged. */
async function materialisePlacesCandidates(candidates: ReservedCandidate[], runId: string, places: PlacesBatchReport, identities: Identities, ctx: PlacesBatchContext): Promise<void> {
  const { config, settings, signal } = ctx;
  for (const candidate of candidates) {
    signal.throwIfAborted();
    if (!candidate.placeId || !candidate.evidence) continue;
    const createId = derivedCommand(runId, candidate.domain, 'create');
    const accountId = `account-${fingerprint([config.workspaceId, createId])}`;
    const replay = identities.accountIds.has(accountId);
    if (!replay) {
      if (identities.domains.has(candidate.domain)) { places.skipped.existing_domain++; continue; }
      if (candidate.listedPhone && identities.phones.has(candidate.listedPhone)) { places.skipped.existing_phone++; continue; }
    }
    const account = await ctx.accounts.create({ commandId: createId, name: candidate.name, domain: candidate.domain });
    if (!replay) { places.created++; ctx.report.researchPrepared++; identities.accountIds.add(account.id); identities.domains.add(candidate.domain); }
    if (candidate.listedPhone && !(replay && identities.phones.has(candidate.listedPhone))) {
      // The listing is the evidence: a FETCHED attestation for the Places request and response hash, named by the place id.
      const source: AccountSource = { id: `place-${candidate.placeId}`, url: candidate.evidence.url, fetchedAt: candidate.evidence.fetchedAt, sha256: candidate.evidence.sha256, excerpt: candidate.evidence.excerpt, permitted: true };
      const route: AccountEvidenceBatch['routes'][number] = { id: `route-${fingerprint([account.id, 'listed-phone', candidate.listedPhone])}`, accountId: account.id, personId: null, channel: 'phone',
        value: candidate.listedPhone, purpose: 'business', evidenceIds: [source.id], verification: 'listed' };
      try {
        await ctx.accounts.recordFetchedSource({ accountId: account.id, source });
        await ctx.accounts.admitEvidence({ commandId: derivedCommand(runId, candidate.domain, 'listed-route'), accountId: account.id, expectedVersion: 1, sources: [source], claims: [], routes: [route] });
        places.routes++; identities.phones.add(candidate.listedPhone);
      } catch (error) { if (signal.aborted) throw error; places.skipped.route_held++; }
    }
    try {
      await ctx.accounts.enqueue({ commandId: derivedCommand(runId, candidate.domain, 'enqueue'), accountId: account.id, limits: settings.researchLimits,
        permittedSources: placesPermittedSources(candidate.domain, settings.researchLimits.maxPages) });
      places.enqueued++;
    } catch (error) { if (signal.aborted) throw error; places.skipped.enqueue_held++; }
  }
}
/** Run queued page research until the queue is empty or the phase deadline arrives. A job cut by the deadline settles as parked, as today.
 *  A Places-born job may fetch its own recorded sources; everything else about fetching is the existing bounded page provider. */
async function drainPageResearch(ctx: PlacesBatchContext): Promise<number> {
  const { settings, signal, report } = ctx;
  let current: ResearchJob | null = null;
  const draining: AccountResearchStore = {
    create: value => ctx.accounts.create(value), snapshot: (id, at) => ctx.accounts.snapshot(id, at), admitEvidence: (batch, claim) => ctx.accounts.admitEvidence(batch, claim),
    settle: value => ctx.accounts.settle(value), enqueue: value => ctx.accounts.enqueue(value),
    claimNext: async asOf => { current = await ctx.accounts.claimNext(asOf); return current; },
  };
  const pages = createCompanyPageProvider({ receipts: createFetchedReceiptPolicy(), clock: ctx.options.clock,
    permitted: url => settings.permittedSources.includes(url) || (current?.permittedSources?.includes(url) ?? false),
    resolve: async hostname => { await ctx.guard(); return ctx.boundaries.resolve(hostname); },
    http: async request => { await ctx.guard(); return ctx.boundaries.pageHttp(request); },
    onFetched: (source, accountId) => ctx.accounts.recordFetchedSource({ accountId, source }) });
  const worker = createCompanyResearchWorker({ store: draining, clock: ctx.options.clock, pages: { async research(snapshot, limits, requestSignal) {
    await ctx.guard();
    if (fingerprint(limits) !== fingerprint(settings.researchLimits)) throw new Error('research_job_config_mismatch');
    return pages.research(snapshot, limits, requestSignal);
  } } });
  let drained = 0;
  while (!signal.aborted) {
    const result = await worker.runNext(signal);
    if (result === 'idle') break;
    drained++;
    if (result === 'completed') report.researchCompleted++;
    if (result === 'parked') report.held++;
  }
  return drained;
}
