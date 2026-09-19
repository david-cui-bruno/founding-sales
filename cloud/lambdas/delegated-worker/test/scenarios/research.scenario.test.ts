import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ownerResearchSourceKey } from '../../../../../src/shared/contracts/ownerCommandContract';
import { jobKey, jobRecordSchema, queueMessage, researchBackfillJobId, researchFirmJobId } from '../../src/queue/jobs';
import { runQueuedJob } from '../../src/runner';
import { listAttempts } from '../../src/v1/attempts';
import { runScheduledDayBuild } from '../../src/v1/dayBuild';
import { firmKey, firmRecordSchema } from '../../src/v1/firmsWrite';
import { enqueueResearch, pageHashOf, queryHashOf, readResearchQueryCursor, researchedFirmId, researchQueryKey,
  runResearchBackfillPage, runResearchFirmJob, RESEARCH_POOL_TARGET } from '../../src/v1/research';
import { planSuppress } from '../../src/v1/suppression';
import { deriveStateAndZone, evidenceKey, evidenceRecordSchema, evidenceSummaryLine, EVIDENCE_EXCERPT_MAX, EVIDENCE_MAX_SOURCES,
  readEvidence, writeEvidence } from '../../src/v1/evidence';
import { poolCounterKey, poolCounterSchema, readPoolCounter, readResearchCounter, readResearchSettings, researchCounterKey,
  RESEARCH_DAILY_BUDGET_CEILING, RESEARCH_DAILY_BUDGET_DEFAULT, RESEARCH_SETTINGS_KEY, spendResearch, writePoolCounter } from '../../src/v1/pool';
import { firmRecord, putFirm, putTerritoryPolicy, riFirm, setPosture } from './firmFixtures';
import { pageHttpOf, placesFetch, placesPage, recordingQueue, researchDeps } from './researchFixtures';
import { v1Fixture } from './v1Fixture';

/**
 * Research on the queue (FSS target design sections 2 and 4; slice S4), on the real store adapter with the
 * in-memory harness. Every provider call goes through an injected fetch; nothing here reaches Places, a web
 * page or a mailbox, and nothing dials, sends or books.
 */

const START = '2026-09-18T12:00:00.000Z';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const source = (n: number, excerpt: string) => ({ id: `page-${n}`, url: `https://firm-${n}.example/page`, fetchedAt: START, sha256: sha(excerpt), excerpt });

describe('EVIDENCE#<firmId>: the sources split off the firm record', () => {
  it('writes the sources, the extraction and the business email finding under one revision', async () => {
    const f = v1Fixture(START);
    const written = await writeEvidence(f.store, { firmId: 'account-ri-1', revision: 1,
      sources: [source(1, 'We manage 120 residential units in Providence.')],
      extraction: { facts: [{ key: 'portfolio_description', sourceId: 'page-1', quote: 'We manage 120 residential units' }], at: START },
      businessEmailFinding: { email: 'info@firm-1.example', sourceId: 'page-1', selection: 'role_mailbox',
        considered: ['info@firm-1.example'], refused: { free_mail: 1, off_domain: 0, withheld_contact: 0, unparsable: 0 } } });
    expect(written).toEqual({ written: true, revision: 1 });

    const stored = evidenceRecordSchema.parse(f.db.inspect(evidenceKey('account-ri-1')));
    expect(stored.sources).toHaveLength(1);
    expect(stored.businessEmailFinding?.email).toBe('info@firm-1.example');
    expect((await readEvidence(f.store, 'account-ri-1'))?.record.revision).toBe(1);
  });

  it('refuses a write over the store size limit rather than truncating, and records it as a research attempt', async () => {
    const f = v1Fixture(START);
    // Forty sources at the excerpt ceiling is past the item limit the store refuses at; nothing is cut to fit.
    const sources = Array.from({ length: EVIDENCE_MAX_SOURCES }, (_, n) => source(n, 'x'.repeat(EVIDENCE_EXCERPT_MAX)));
    const written = await writeEvidence(f.store, { firmId: 'account-ri-2', revision: 1, sources, extraction: null, businessEmailFinding: null });
    expect(written).toEqual({ written: false, reason: 'evidence_too_large' });
    expect(f.db.inspect(evidenceKey('account-ri-2'))).toBeUndefined();

    const attempts = await listAttempts(f.store, { kind: 'research' });
    expect(attempts[0]).toMatchObject({ kind: 'research', outcome: 'failed', reason: 'evidence_too_large',
      detail: { code: 'evidence_too_large', firmId: 'account-ri-2' } });
  });

  it('derives state and zone here, as the one implementation the firm adapter also calls', () => {
    const providence = deriveStateAndZone(firmRecord({ id: 'account-ri-3', name: 'Firm', address: '3 Hope St, Providence, RI 02906, USA', researchedAt: START }));
    expect(providence).toMatchObject({ city: 'Providence', state: 'RI', timeZone: 'America/New_York', hold: null });
    const unknown = deriveStateAndZone(firmRecord({ id: 'account-xx-1', name: 'Firm', address: null, researchedAt: START }));
    expect(unknown.state).toBeNull();
    expect(unknown.hold).toEqual({ reason: 'state_not_cleared', code: 'state_unknown' });
  });

  it('summarises the evidence in one line short enough for the firm record', () => {
    const line = evidenceSummaryLine({ sources: 4, businessEmail: 'info@firm.example', facts: 2, researchedAt: START });
    expect(line).toContain('4 sources');
    expect(line).toContain('business email');
    expect(line.length).toBeLessThanOrEqual(400);
  });
});

describe('COUNTER#pool and COUNTER#<date>#research: what is available and what is left to spend', () => {
  it('keeps the pool counts under one key and reads them back', async () => {
    const f = v1Fixture(START);
    expect(await readPoolCounter(f.store)).toEqual({ researched: 0, unlisted: 0, postureCleared: 0, updatedAt: null });
    await writePoolCounter(f.store, { researched: 31, unlisted: 12, postureCleared: 9 });
    expect(await readPoolCounter(f.store)).toMatchObject({ researched: 31, unlisted: 12, postureCleared: 9 });
    expect(poolCounterSchema.parse(f.db.inspect(poolCounterKey())).unlisted).toBe(12);
  });

  it("spends today's research counter against the budget and says budget_exhausted at the ceiling", async () => {
    const f = v1Fixture(START);
    // 12:00 UTC on 18 September 2026 is 08:00 Eastern; the counter is named by the Eastern date.
    const first = await spendResearch(f.store, { units: 2 });
    expect(first).toMatchObject({ spent: 2, budget: RESEARCH_DAILY_BUDGET_DEFAULT, exhausted: false });
    expect(f.db.inspect(researchCounterKey('2026-09-18'))).toBeDefined();

    const filled = await spendResearch(f.store, { units: RESEARCH_DAILY_BUDGET_DEFAULT });
    expect(filled.exhausted).toBe(true);
    expect((await readResearchCounter(f.store, '2026-09-18'))?.spent).toBe(RESEARCH_DAILY_BUDGET_DEFAULT + 2);
    // A counter that has run out refuses more spend rather than going further past the budget.
    expect(await spendResearch(f.store, { units: 1 })).toMatchObject({ exhausted: true, reason: 'budget_exhausted' });
  });

  it('migrates the queries out of the old research configuration on first read, without deleting it', async () => {
    const f = v1Fixture(START);
    await f.store.transact([f.store.put(ownerResearchSourceKey(), { version: 1, workspaceId: 'ws', pairingId: 'fictional-pairing', revision: 1, state: 'active',
      research: { workspaceId: 'ws', budgetId: 'places-territory-v1',
        audience: { residential: true, regions: ['Providence, RI', 'Boston, MA'], terms: ['property management company'] },
        audienceRevision: 1, sourceRevision: 1, budgetRevision: 1,
        discoveryLimits: { maxCompanies: 20, maxPages: 1, maxBytes: 10000, maxCostMicros: 35000 },
        researchLimits: { maxCompanies: 20, maxPages: 4, maxBytes: 200000, maxCostMicros: 1000 },
        capability: { model: 'fictional-reviewed-model', webSearch: true, searchCostMicros: 35000, modelCostMicros: 1000 }, maxAccountBudgetMicros: 1000,
        permittedSources: [], preparationCommandId: '00000000-0000-4000-8000-000000000001', discoveryProvider: 'places' } }, null)]);

    const settings = await readResearchSettings(f.store);
    expect(settings.record.queries).toEqual(['property management company in Providence, RI', 'property management company in Boston, MA']);
    expect(settings.record.dailyBudget).toBe(RESEARCH_DAILY_BUDGET_DEFAULT);
    expect(settings.record.descriptor).toBeNull();
    // The old item is still there: the migration reads it, it never consumes it.
    expect(f.db.inspect(ownerResearchSourceKey())).toBeDefined();
    expect(f.db.inspect(RESEARCH_SETTINGS_KEY)).toBeDefined();
    // A second read is the stored record, not a second migration.
    expect((await readResearchSettings(f.store)).record.revision).toBe(settings.record.revision);
  });

  it('narrows or replaces the configuration through set_research_config, and refuses a budget past the ceiling', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const send = (body: Record<string, unknown>) => f.request('POST', '/v1/commands', { authorization: bearer,
      body: { commandId: randomUUID(), kind: 'set_research_config', ...body } });

    // The first read migrates the configuration into existence at revision 1; a client always reads before it writes.
    const before = await readResearchSettings(f.store);
    const applied = f.json(await send({ expectedRevision: before.record.revision, queries: ['property manager in Providence, RI'], dailyBudget: 12 }));
    expect(applied).toMatchObject({ outcome: 'applied', reason: null });
    const after = await readResearchSettings(f.store);
    expect(after.record.queries).toEqual(['property manager in Providence, RI']);
    expect(after.record.dailyBudget).toBe(12);

    const refused = f.json(await send({ expectedRevision: after.record.revision, dailyBudget: RESEARCH_DAILY_BUDGET_CEILING + 1 }));
    expect(refused).toMatchObject({ outcome: 'refused', reason: 'budget_above_ceiling' });
    expect((await readResearchSettings(f.store)).record.dailyBudget).toBe(12);

    const stale = f.json(await send({ expectedRevision: 0, dailyBudget: 5 }));
    expect(stale).toMatchObject({ outcome: 'refused', reason: 'revision_stale' });
  });
});

describe('research.backfill_page and research.firm on the real runner', () => {
  const QUERY = 'property management company in Providence, RI';
  const listings = [
    { id: 'place-alpha', name: 'Alpha Residential Management', address: '1 Fictional St, Providence, RI 02906, USA', phone: '(401) 555-0201', website: 'https://alpha-pm.example/' },
    { id: 'place-beta', name: 'Beta Property Group', address: '2 Fictional Ave, Boston, MA 02116, USA', phone: '(617) 555-0202', website: 'https://beta-group.example/contact' },
  ];

  /** Seed the query cursor the scheduler would have written, and return the job id its frontier page carries. */
  const seedQuery = async (f: ReturnType<typeof v1Fixture>, query = QUERY) => {
    const queryHash = queryHashOf(query);
    await f.store.transact([f.store.put(researchQueryKey(queryHash), { version: 1, query, queryHash, pageToken: null,
      pagesDone: 0, exhausted: false, updatedAt: f.now() }, null)]);
    return { queryHash, pageHash: pageHashOf(null), jobId: researchBackfillJobId(queryHash, pageHashOf(null)) };
  };

  it('creates firms with derived state and zone from one page, and enqueues a per-firm job for each', async () => {
    const f = v1Fixture(START);
    const { queryHash, pageHash, jobId } = await seedQuery(f);
    const places = placesFetch({ pages: [placesPage(listings)] });
    const queue = recordingQueue();

    const report = await runResearchBackfillPage(researchDeps(f, { fetch: places.fetch, queue }), { jobId, queryHash, pageHash }, AbortSignal.timeout(5000));
    expect(report).toMatchObject({ outcome: 'completed', created: 2, enqueued: 2 });
    expect(places.calls[0]?.body).toMatchObject({ textQuery: QUERY });

    const alpha = firmRecordSchema.parse(f.db.inspect(firmKey(researchedFirmId('place-alpha'))));
    expect(alpha).toMatchObject({ name: 'Alpha Residential Management', domain: 'alpha-pm.example', city: 'Providence',
      state: 'RI', timeZone: 'America/New_York', derivedZoneFrom: 'territory_state_map', status: 'new', enteredBy: 'research', researchRevision: 0 });
    expect(alpha.routes.map(route => [route.channel, route.value, route.verification]))
      .toEqual([['phone', '+14015550201', 'listed']]);
    expect(firmRecordSchema.parse(f.db.inspect(firmKey(researchedFirmId('place-beta')))).state).toBe('MA');

    expect(queue.sent.map(job => job.jobId).sort()).toEqual([researchFirmJobId(researchedFirmId('place-alpha'), 1),
      researchFirmJobId(researchedFirmId('place-beta'), 1)].sort());
    expect(queue.sent.every(job => job.kind === 'research.firm')).toBe(true);
    // The day's counter was spent before the call, and the query cursor only moved once the page came back.
    expect((await readResearchCounter(f.store, '2026-09-18'))?.spent).toBe(1);
    expect((await readResearchQueryCursor(f.store, queryHash))?.record).toMatchObject({ pagesDone: 1, exhausted: true, pageToken: null });
  });

  it('holds a firm whose listing names no state it can place, rather than refusing the firm', async () => {
    const f = v1Fixture(START);
    const { queryHash, pageHash, jobId } = await seedQuery(f);
    const places = placesFetch({ pages: [placesPage([{ id: 'place-nowhere', name: 'Nowhere Management', website: 'https://nowhere-pm.example/' }])] });

    const report = await runResearchBackfillPage(researchDeps(f, { fetch: places.fetch }), { jobId, queryHash, pageHash }, AbortSignal.timeout(5000));
    expect(report).toMatchObject({ outcome: 'completed', created: 1 });
    expect(report.skipped.state_unknown).toBe(1);
    const record = firmRecordSchema.parse(f.db.inspect(firmKey(researchedFirmId('place-nowhere'))));
    expect(record).toMatchObject({ state: null, timeZone: null, derivedZoneFrom: null, status: 'new' });
  });

  it('never creates or refreshes a suppressed firm, and never repeats a page under the same job id', async () => {
    const f = v1Fixture(START);
    const { queryHash, pageHash, jobId } = await seedQuery(f);
    const suppressedId = researchedFirmId('place-alpha');
    const plan = await planSuppress(f.store, { firmId: suppressedId, handle: null, routes: [], reason: 'asked to stop',
      source: 'manual', evidenceRef: null, recordedBy: 'David MacBook' });
    if (plan.outcome === 'refused') throw new Error(plan.reason);
    await f.store.transact(plan.items);

    const places = placesFetch({ pages: [placesPage(listings)] });
    const report = await runResearchBackfillPage(researchDeps(f, { fetch: places.fetch }), { jobId, queryHash, pageHash }, AbortSignal.timeout(5000));
    expect(report).toMatchObject({ outcome: 'completed', created: 1 });
    expect(report.skipped.suppressed).toBe(1);
    expect(f.db.inspect(firmKey(suppressedId))).toBeUndefined();

    // The same job id again: the frontier has moved, so this is a no-op and the injected fetch is never called twice.
    const second = await runResearchBackfillPage(researchDeps(f, { fetch: places.fetch }), { jobId, queryHash, pageHash }, AbortSignal.timeout(5000));
    expect(second).toMatchObject({ outcome: 'no_op', reason: 'already_advanced', created: 0 });
    expect(places.calls).toHaveLength(1);

    // And a suppressed firm is never researched either, whatever the job says.
    await f.store.transact([f.store.put(firmKey(suppressedId), { version: 1, firmId: suppressedId, name: 'Alpha', domain: 'alpha-pm.example',
      city: 'Providence', state: 'RI', timeZone: 'America/New_York', derivedZoneFrom: 'territory_state_map', status: 'new',
      enteredBy: 'research', evidenceSummary: '', researchRevision: 0, researchedAt: null, routes: [], enteredAt: START, updatedAt: START }, null)]);
    const refused = await runResearchFirmJob(researchDeps(f, { pageHttp: pageHttpOf(() => '<p>hello</p>').pageHttp }),
      { jobId: researchFirmJobId(suppressedId, 1), firmId: suppressedId, revision: 1 }, AbortSignal.timeout(5000));
    expect(refused).toMatchObject({ outcome: 'no_op', reason: 'suppressed' });
  });

  it('researches one firm through the carried page fetch, writing EVIDENCE# and a small FIRM#', async () => {
    const f = v1Fixture(START);
    const { queryHash, pageHash, jobId } = await seedQuery(f);
    const places = placesFetch({ pages: [placesPage([listings[0]!])] });
    await runResearchBackfillPage(researchDeps(f, { fetch: places.fetch }), { jobId, queryHash, pageHash }, AbortSignal.timeout(5000));
    const firmId = researchedFirmId('place-alpha');

    const pages = pageHttpOf(url => url.endsWith('/') || url.endsWith('/services')
      ? '<p>We manage 120 residential units in Providence. Reach us at info@alpha-pm.example or postmaster@gmail.com.</p>' : null);
    const report = await runResearchFirmJob(researchDeps(f, { pageHttp: pages.pageHttp }),
      { jobId: researchFirmJobId(firmId, 1), firmId, revision: 1 }, AbortSignal.timeout(10000));
    expect(report).toMatchObject({ outcome: 'completed', businessEmail: true, revision: 1 });
    expect(report.sources).toBeGreaterThan(0);

    const evidence = evidenceRecordSchema.parse(f.db.inspect(evidenceKey(firmId)));
    expect(evidence.revision).toBe(1);
    // The free-mail address is refused; the on-domain one is the claim.
    expect(evidence.businessEmailFinding?.email).toBe('info@alpha-pm.example');
    expect(evidence.sources.length).toBe(report.sources);

    const record = firmRecordSchema.parse(f.db.inspect(firmKey(firmId)));
    expect(record).toMatchObject({ researchRevision: 1, researchedAt: expect.any(String) });
    expect(record.evidenceSummary).toContain('business email found');
    // The firm record stays small: the excerpts live in EVIDENCE#, not here.
    expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThan(2048);
    expect(record.routes.some(route => route.channel === 'email' && route.value === 'info@alpha-pm.example')).toBe(true);

    // A repeat of the same revision is a no-op, and fetches nothing.
    const fetched = pages.urls.length;
    const again = await runResearchFirmJob(researchDeps(f, { pageHttp: pages.pageHttp }),
      { jobId: researchFirmJobId(firmId, 1), firmId, revision: 1 }, AbortSignal.timeout(10000));
    expect(again).toMatchObject({ outcome: 'no_op', reason: 'already_researched' });
    expect(pages.urls).toHaveLength(fetched);

    // And the pool counter knows about it.
    expect((await readPoolCounter(f.store)).researched).toBeGreaterThanOrEqual(1);
  });

  it('stops enqueueing when the budget is spent, and says which hold it stopped under', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const before = await readResearchSettings(f.store);
    await f.request('POST', '/v1/commands', { authorization: bearer, body: { commandId: randomUUID(), kind: 'set_research_config',
      expectedRevision: before.record.revision, queries: [QUERY], dailyBudget: 1 } });

    const queue = recordingQueue();
    const first = await enqueueResearch(f.store, queue, f.now());
    expect(first.held).toBeNull();
    expect(first.enqueued.map(job => job.kind)).toEqual(['research.backfill_page']);

    await spendResearch(f.store, { units: 1 });
    const second = await enqueueResearch(f.store, queue, f.now());
    expect(second.held).toBe('budget_exhausted');
    expect(second.enqueued).toEqual([]);
  });

  it('stops enqueueing pages once the posture-cleared pool has forty firms', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const before = await readResearchSettings(f.store);
    await f.request('POST', '/v1/commands', { authorization: bearer, body: { commandId: randomUUID(), kind: 'set_research_config',
      expectedRevision: before.record.revision, queries: [QUERY] } });
    await writePoolCounter(f.store, { researched: 60, unlisted: 45, postureCleared: RESEARCH_POOL_TARGET });

    const report = await enqueueResearch(f.store, recordingQueue(), f.now());
    expect(report).toMatchObject({ held: 'pool_full', pool: RESEARCH_POOL_TARGET });
    expect(report.enqueued).toEqual([]);
  });

  it('runs both kinds through the real runner and settles their JOB# records', async () => {
    const f = v1Fixture(START);
    const { queryHash, pageHash, jobId } = await seedQuery(f);
    const places = placesFetch({ pages: [placesPage([listings[0]!])] });
    const deps = researchDeps(f, { fetch: places.fetch, pageHttp: pageHttpOf(() => '<p>Reach us at info@alpha-pm.example.</p>').pageHttp });

    const backfill = await runQueuedJob({ store: f.store, mailbox: { access: async () => ({ connected: false, reason: 'mailbox_not_connected' }) },
      fetch: deps.fetch, places: deps.places, pageHttp: deps.pageHttp, resolve: deps.resolve },
      JSON.stringify(queueMessage(jobId, 'research.backfill_page')));
    expect(backfill).toMatchObject({ state: 'done' });
    expect(jobRecordSchema.parse(f.db.inspect(jobKey(jobId))).state).toBe('done');

    const firmId = researchedFirmId('place-alpha');
    const firmJobId = researchFirmJobId(firmId, 1);
    const research = await runQueuedJob({ store: f.store, mailbox: { access: async () => ({ connected: false, reason: 'mailbox_not_connected' }) },
      fetch: deps.fetch, places: deps.places, pageHttp: deps.pageHttp, resolve: deps.resolve },
      JSON.stringify(queueMessage(firmJobId, 'research.firm')));
    expect(research).toMatchObject({ state: 'done' });
    expect(firmRecordSchema.parse(f.db.inspect(firmKey(firmId))).researchRevision).toBe(1);

    // Both left a research attempt David can read in Diagnostics.
    const attempts = await listAttempts(f.store, { kind: 'research' });
    expect(attempts.map(attempt => attempt.detail?.code)).toContain('research_firm');
    expect(attempts.map(attempt => attempt.detail?.code)).toContain('research_backfill_page');
  });

  it('recounts the pool from the firms the morning build read', async () => {
    const f = v1Fixture('2026-09-18T10:00:00.000Z');
    const { bearer } = await f.pairDevice();
    await setPosture(f, bearer, 'RI', 'calling');
    await putTerritoryPolicy(f.store, START);
    for (let n = 1; n <= 3; n++) await putFirm(f.store, riFirm(n));

    const built = await runScheduledDayBuild(f.store);
    expect(built.outcome).toBe('built');
    expect(await readPoolCounter(f.store)).toMatchObject({ researched: 3, unlisted: 3, postureCleared: 3 });
  });
});
