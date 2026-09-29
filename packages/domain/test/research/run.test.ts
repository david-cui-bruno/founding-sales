import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { claimResearchClearance, researchClearanceAvailable } from '../../research/ceilings.ts';
import { readSpend, recordProviderCall } from '../../research/ledger.ts';
import { runFirmResearch } from '../../research/enrichment.ts';
import { addFirmLink } from '../../research/links.ts';
import { enqueueFirmResearch } from '../../research/enqueue.ts';
import { readCallBrief, readFirmJudgments } from '../../research/brief.ts';
import { listRuns } from '../../research/runs.ts';
import { readResearchSettings, updateResearchSettings } from '../../research/settings.ts';
import { selectFirmsForSweep } from '../../research/sweep.ts';
import type { ExtractionProvider, PageFetchProvider } from '../../research/providers.ts';

/**
 * One run, against a real PostgreSQL 16 and two fake ports.
 *
 * No socket is opened by anything below: `fakeFetch` returns bytes a test wrote and
 * `fakeExtraction` returns selections a test wrote. That is the shape the whole
 * design is for — every rule about what may be fetched is decided in pure code the
 * adapter asks, so the run can be proved without a network.
 */

const AT = '2026-09-28T14:00:00.000Z';
const ZONE = 'America/New_York';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const hashOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function fakeFetch(
  pages: readonly { readonly url: string; readonly html: string; readonly firstParty?: boolean }[],
): PageFetchProvider {
  return {
    providerKey: 'company_page',
    fetchPages: async request => ({
      ok: true,
      costCents: 0,
      value: {
        pages: await Promise.all(
          pages
            .filter(page => request.urls.includes(page.url))
            .map(async page => ({
              url: page.url,
              contentHash: hashOf(page.html),
              contentType: 'text/html; charset=utf-8',
              body: bytes(page.html),
              retrievedAt: AT,
              firstParty: page.firstParty ?? true,
            })),
        ),
        skipped: {},
      },
    }),
  };
}

function fakeExtraction(
  selections: readonly { readonly key: string; readonly sourceReference: string; readonly blockId: string }[],
  options: { readonly costCents?: number; readonly generated?: boolean } = {},
): ExtractionProvider {
  return {
    providerKey: 'anthropic_extraction',
    extract: async () => ({
      ok: true,
      costCents: options.costCents ?? 1,
      value: {
        selections,
        questions:
          options.generated === false ? null : (['How do you take work orders?', 'Who handles them?'] as const),
        opening: options.generated === false ? null : 'I saw your maintenance page.',
        modelName: 'claude-haiku-4-5',
        inputTokens: 4_000,
        outputTokens: 200,
      },
    }),
  };
}

const failingExtraction: ExtractionProvider = {
  providerKey: 'anthropic_extraction',
  extract: async () => ({ ok: false, failureCode: 'malformed_answer', costCents: 1 }),
};

const HOME = '<p>We manage residential property for owners.</p><p>Our maintenance team handles every work order.</p>';

let database: TestDatabase;
let session: SessionQueryable;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let context: RepositoryContext;

const systemContext = (): RepositoryContext =>
  repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), session);

beforeAll(async () => {
  database = await createTestDatabase();
  session = database.session;
  seeded = await seedTwoWorkspaces(session);
  crm = await seedCrm(session, seeded);
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await session.query('DELETE FROM firm_judgments');
  await session.query('DELETE FROM firm_facts');
  await session.query('DELETE FROM firm_links');
  await session.query('DELETE FROM research_runs');
  await session.query('DELETE FROM evidence_items');
  await session.query('DELETE FROM provider_ledger');
  await session.query('DELETE FROM daily_counters');
  await session.query('DELETE FROM research_settings');
  await session.query('DELETE FROM jobs');
  await session.query('DELETE FROM funnel_facts');
  // The suppression one case records: `effective_suppressions` is a view over these
  // rows, so leaving it would suppress the firm for every case after it.
  await session.query("DELETE FROM suppression_events WHERE event_id = 'stop-research'");
  await session.query("UPDATE opportunities SET status = 'open', closed_at = NULL, close_reason = NULL WHERE workspace_id = $1", [seeded.alpha.workspaceId]);
  await session.query("UPDATE firms SET website = 'https://alpha.example.test/' WHERE id = $1", [crm.alpha.firmId]);
  context = systemContext();
});

describe('the ledger and the spend', () => {
  it('upserts one row per provider per business date, and sums today and the month', async () => {
    await recordProviderCall(context, { providerKey: 'company_page', at: AT, businessTimeZone: ZONE, costCents: 0 });
    await recordProviderCall(context, {
      providerKey: 'anthropic_extraction',
      at: AT,
      businessTimeZone: ZONE,
      costCents: 3,
    });
    await recordProviderCall(context, {
      providerKey: 'anthropic_extraction',
      at: AT,
      businessTimeZone: ZONE,
      costCents: 4,
      failureCode: 'model_refusal',
    });
    const { rows } = await session.query<{ provider_key: string; calls: number; failures: number; cost_cents: number; last_failure_code: string | null }>(
      'SELECT provider_key, calls, failures, cost_cents, last_failure_code FROM provider_ledger ORDER BY provider_key',
    );
    expect(rows).toEqual([
      { provider_key: 'anthropic_extraction', calls: 2, failures: 1, cost_cents: 7, last_failure_code: 'model_refusal' },
      { provider_key: 'company_page', calls: 1, failures: 0, cost_cents: 0, last_failure_code: null },
    ]);
    expect(await readSpend(context, { businessTimeZone: ZONE, at: AT })).toEqual({ todayCents: 7, monthToDateCents: 7 });
  });

  it('counts the month in the workspace’s zone, so last month’s spend is not today’s budget', async () => {
    // 1 October, 00:30 UTC is still 30 September in New York, so this is September's.
    await recordProviderCall(context, {
      providerKey: 'anthropic_extraction',
      at: '2026-10-01T00:30:00.000Z',
      businessTimeZone: ZONE,
      costCents: 9,
    });
    const september = await readSpend(context, { businessTimeZone: ZONE, at: '2026-09-30T20:00:00.000Z' });
    expect(september.monthToDateCents).toBe(9);
    const october = await readSpend(context, { businessTimeZone: ZONE, at: '2026-10-02T14:00:00.000Z' });
    expect(october.monthToDateCents).toBe(0);
  });
});

describe('the ceilings', () => {
  it('refuses when research is disabled', async () => {
    const admin = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      session,
    );
    await updateResearchSettings(admin, { enabled: false });
    const claim = await claimResearchClearance(context, { at: AT });
    expect(claim).toEqual({ ok: false, reason: 'research_disabled' });
  });

  it('refuses the very first run at a zero count ceiling', async () => {
    const admin = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      session,
    );
    await updateResearchSettings(admin, { dailyFirmCeiling: 0 });
    expect(await claimResearchClearance(context, { at: AT })).toEqual({ ok: false, reason: 'daily_firm_ceiling' });
  });

  it('consumes the counter, so the clearance after the last one refuses', async () => {
    const admin = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      session,
    );
    await updateResearchSettings(admin, { dailyFirmCeiling: 2 });
    expect((await claimResearchClearance(context, { at: AT })).ok).toBe(true);
    expect((await claimResearchClearance(context, { at: AT })).ok).toBe(true);
    expect(await claimResearchClearance(context, { at: AT })).toEqual({ ok: false, reason: 'daily_firm_ceiling' });
  });

  it('refuses on the worst case before the call, not on the invoice after it', async () => {
    const admin = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      session,
    );
    // One cent a day, and a run's worst case is two.
    await updateResearchSettings(admin, { dailyCostCeilingCents: 1 });
    expect(await claimResearchClearance(context, { at: AT })).toEqual({ ok: false, reason: 'daily_cost_ceiling' });
    expect(await researchClearanceAvailable(context, { at: AT })).toEqual({ ok: false, reason: 'daily_cost_ceiling' });
  });

  it('refuses on the month, and the month boundary is the workspace’s', async () => {
    const admin = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      session,
    );
    await updateResearchSettings(admin, { dailyCostCeilingCents: 1000, monthlyCostCeilingCents: 10 });
    await recordProviderCall(context, {
      providerKey: 'anthropic_extraction',
      at: '2026-09-02T14:00:00.000Z',
      businessTimeZone: ZONE,
      costCents: 9,
    });
    expect(await claimResearchClearance(context, { at: AT })).toEqual({ ok: false, reason: 'monthly_cost_ceiling' });
    // A new month starts the budget again.
    expect((await claimResearchClearance(context, { at: '2026-10-05T14:00:00.000Z' })).ok).toBe(true);
  });

  it('does not consume a unit when it only asks', async () => {
    expect((await researchClearanceAvailable(context, { at: AT })).ok).toBe(true);
    const { rows } = await session.query<{ count: number }>('SELECT count(*)::int AS count FROM daily_counters');
    expect(rows[0]?.count).toBe(0);
  });
});

describe('one run', () => {
  it('records evidence, facts, a judgment and a brief, and prices the call', async () => {
    const outcome = await runFirmResearch(context, {
      firmId: crm.alpha.firmId,
      revision: 1,
      trigger: 'firm_created',
      at: AT,
      pageFetch: fakeFetch([{ url: 'https://alpha.example.test/', html: HOME }]),
      extraction: fakeExtraction([
        { key: 'target_fit', sourceReference: 'https://alpha.example.test/', blockId: 'b1' },
        { key: 'maintenance_workflow', sourceReference: 'https://alpha.example.test/', blockId: 'b2' },
      ]),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.outcome).toBe('completed');
    expect(outcome.value.evidenceRecorded).toBe(1);
    expect(outcome.value.factsRecorded).toBe(2);
    expect(outcome.value.costCents).toBe(1);

    const judgments = await readFirmJudgments(context, crm.alpha.firmId);
    expect(judgments?.fit).toBe('yes');
    expect(judgments?.problemEvidence).toBe('yes');
    expect(judgments?.timing).toBe('unknown');

    const brief = await readCallBrief(context, crm.alpha.firmId);
    expect(brief?.whyFit.map(quote => quote.quote)).toEqual([
      'We manage residential property for owners.',
      'Our maintenance team handles every work order.',
    ]);
    expect(brief?.generated).toBe(true);
    expect(brief?.revision).toBe(1);

    const runs = await listRuns(context, crm.alpha.firmId);
    expect(runs[0]?.outcome).toBe('completed');
    expect(runs[0]?.costCents).toBe(1);
    expect(await readSpend(context, { businessTimeZone: ZONE, at: AT })).toEqual({ todayCents: 1, monthToDateCents: 1 });
  });

  it('completes with three judgments unknown when there is no extraction port', async () => {
    const outcome = await runFirmResearch(context, {
      firmId: crm.alpha.firmId,
      revision: 1,
      trigger: 'sweep',
      at: AT,
      pageFetch: fakeFetch([{ url: 'https://alpha.example.test/', html: HOME }]),
    });
    expect(outcome.ok).toBe(true);
    const judgments = await readFirmJudgments(context, crm.alpha.firmId);
    expect(judgments).toMatchObject({ fit: 'unknown', problemEvidence: 'unknown', timing: 'unknown' });
    // Reachability still comes from the firm's routes, which `seedCrm` gave it.
    expect(judgments?.reachability).toBe('yes');
    expect((await readCallBrief(context, crm.alpha.firmId))?.generated).toBe(false);
    // And the evidence is there for a later run's facts to point at.
    const { rows } = await session.query<{ count: number }>('SELECT count(*)::int AS count FROM evidence_items');
    expect(rows[0]?.count).toBe(1);
  });

  it('is idempotent on the revision: a second claim records nothing again', async () => {
    const first = await runFirmResearch(context, {
      firmId: crm.alpha.firmId,
      revision: 1,
      trigger: 'sweep',
      at: AT,
      pageFetch: fakeFetch([{ url: 'https://alpha.example.test/', html: HOME }]),
      extraction: fakeExtraction([{ key: 'target_fit', sourceReference: 'https://alpha.example.test/', blockId: 'b1' }]),
    });
    const second = await runFirmResearch(context, {
      firmId: crm.alpha.firmId,
      revision: 1,
      trigger: 'sweep',
      at: AT,
      pageFetch: fakeFetch([{ url: 'https://alpha.example.test/', html: HOME }]),
      extraction: fakeExtraction([{ key: 'target_fit', sourceReference: 'https://alpha.example.test/', blockId: 'b1' }]),
    });
    expect(first.ok && first.value.outcome).toBe('completed');
    expect(second.ok && second.value.outcome).toBe('already_recorded');

    const counts = await session.query<{ runs: number; facts: number; evidence: number }>(
      `SELECT (SELECT count(*) FROM research_runs)::int AS runs,
              (SELECT count(*) FROM firm_facts)::int AS facts,
              (SELECT count(*) FROM evidence_items)::int AS evidence`,
    );
    expect(counts.rows[0]).toEqual({ runs: 1, facts: 1, evidence: 1 });
  });

  it('records an unchanged page once, by its hash, across two revisions', async () => {
    const pageFetch = fakeFetch([{ url: 'https://alpha.example.test/', html: HOME }]);
    const extraction = fakeExtraction([
      { key: 'target_fit', sourceReference: 'https://alpha.example.test/', blockId: 'b1' },
    ]);
    await runFirmResearch(context, { firmId: crm.alpha.firmId, revision: 1, trigger: 'sweep', at: AT, pageFetch, extraction });
    await runFirmResearch(context, { firmId: crm.alpha.firmId, revision: 2, trigger: 'sweep', at: AT, pageFetch, extraction });
    const counts = await session.query<{ evidence: number; facts: number; runs: number }>(
      `SELECT (SELECT count(*) FROM evidence_items)::int AS evidence,
              (SELECT count(*) FROM firm_facts)::int AS facts,
              (SELECT count(*) FROM research_runs)::int AS runs`,
    );
    expect(counts.rows[0]).toEqual({ evidence: 1, facts: 1, runs: 2 });
  });

  it('refuses a firm with no website and no link, with `no_sources` on the run', async () => {
    await session.query('UPDATE firms SET website = NULL WHERE id = $1', [crm.alpha.firmId]);
    const outcome = await runFirmResearch(context, {
      firmId: crm.alpha.firmId,
      revision: 1,
      trigger: 'sweep',
      at: AT,
      pageFetch: fakeFetch([]),
    });
    expect(outcome).toEqual({ ok: false, reason: 'no_sources' });
    const runs = await listRuns(context, crm.alpha.firmId);
    expect(runs[0]).toMatchObject({ outcome: 'refused', refusalCode: 'no_sources' });
  });

  it('refuses a suppressed firm before it claims a unit or opens a run', async () => {
    await session.query(
      `INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source)
       VALUES ($1, 'stop-research', 'firm', $2, 'v1', 'prospect_opt_out')`,
      [seeded.alpha.workspaceId, crm.alpha.firmId],
    );
    const outcome = await runFirmResearch(context, {
      firmId: crm.alpha.firmId,
      revision: 1,
      trigger: 'sweep',
      at: AT,
      pageFetch: fakeFetch([{ url: 'https://alpha.example.test/', html: HOME }]),
    });
    expect(outcome).toEqual({ ok: false, reason: 'firm_suppressed' });
    expect((await listRuns(context, crm.alpha.firmId))[0]).toMatchObject({ refusalCode: 'firm_suppressed' });
    const { rows } = await session.query<{ count: number }>('SELECT count(*)::int AS count FROM daily_counters');
    expect(rows[0]?.count).toBe(0);
  });

  it('keeps the evidence when the extraction fails, and says provider_failure', async () => {
    const outcome = await runFirmResearch(context, {
      firmId: crm.alpha.firmId,
      revision: 1,
      trigger: 'sweep',
      at: AT,
      pageFetch: fakeFetch([{ url: 'https://alpha.example.test/', html: HOME }]),
      extraction: failingExtraction,
    });
    expect(outcome).toEqual({ ok: false, reason: 'provider_failure' });
    const counts = await session.query<{ evidence: number; facts: number }>(
      `SELECT (SELECT count(*) FROM evidence_items)::int AS evidence,
              (SELECT count(*) FROM firm_facts)::int AS facts`,
    );
    expect(counts.rows[0]).toEqual({ evidence: 1, facts: 0 });
    // The cents are still on the ledger: a model that burned tokens and gave nothing
    // back has spent the budget either way.
    expect((await readSpend(context, { businessTimeZone: ZONE, at: AT })).todayCents).toBe(1);
    expect((await listRuns(context, crm.alpha.firmId))[0]).toMatchObject({ outcome: 'failed', refusalCode: 'provider_failure' });
  });

  it('drops a selection naming a block nobody published', async () => {
    const outcome = await runFirmResearch(context, {
      firmId: crm.alpha.firmId,
      revision: 1,
      trigger: 'sweep',
      at: AT,
      pageFetch: fakeFetch([{ url: 'https://alpha.example.test/', html: HOME }]),
      extraction: fakeExtraction([
        { key: 'target_fit', sourceReference: 'https://alpha.example.test/', blockId: 'b99' },
        { key: 'ownership', sourceReference: 'https://alpha.example.test/', blockId: 'b1' },
      ]),
    });
    expect(outcome.ok && outcome.value.factsRecorded).toBe(1);
    expect(outcome.ok && outcome.value.factsRefused).toBe(1);
    expect(outcome.ok && outcome.value.skipped['fact_unknown_block']).toBe(1);
  });

  it('records the two funnel facts, once each, inside the run’s transaction', async () => {
    const pageFetch = fakeFetch([{ url: 'https://alpha.example.test/', html: HOME }]);
    const extraction = fakeExtraction([
      { key: 'target_fit', sourceReference: 'https://alpha.example.test/', blockId: 'b1' },
    ]);
    await runFirmResearch(context, { firmId: crm.alpha.firmId, revision: 1, trigger: 'sweep', at: AT, pageFetch, extraction });
    await runFirmResearch(context, { firmId: crm.alpha.firmId, revision: 2, trigger: 'sweep', at: AT, pageFetch, extraction });

    const { rows } = await session.query<{ kind: string; dedupe_key: string; source: string; detail: Record<string, unknown> }>(
      'SELECT kind, dedupe_key, source, detail FROM funnel_facts ORDER BY kind, dedupe_key',
    );
    expect(rows.map(row => `${row.kind} ${row.dedupe_key}`)).toEqual([
      // One per revision for the run…
      `firm.queued_for_call ${crm.alpha.firmId}`,
      `firm.researched ${crm.alpha.firmId}:1`,
      `firm.researched ${crm.alpha.firmId}:2`,
    ]);
    // …and exactly one for the queue, however many later runs agree.
    expect(rows.every(row => row.source === 'research')).toBe(true);
    expect(rows.find(row => row.kind === 'firm.researched')?.detail).toEqual({
      revision: 1,
      fit: 'yes',
      reachability: 'yes',
    });
  });

  it('records no funnel fact for a run that refused', async () => {
    await session.query('UPDATE firms SET website = NULL WHERE id = $1', [crm.alpha.firmId]);
    await runFirmResearch(context, {
      firmId: crm.alpha.firmId,
      revision: 1,
      trigger: 'sweep',
      at: AT,
      pageFetch: fakeFetch([]),
    });
    const { rows } = await session.query<{ count: number }>('SELECT count(*)::int AS count FROM funnel_facts');
    expect(rows[0]?.count).toBe(0);
  });

  it('says when call_first became true, and not when it already was', async () => {
    const pageFetch = fakeFetch([{ url: 'https://alpha.example.test/', html: HOME }]);
    const extraction = fakeExtraction([
      { key: 'target_fit', sourceReference: 'https://alpha.example.test/', blockId: 'b1' },
    ]);
    const first = await runFirmResearch(context, { firmId: crm.alpha.firmId, revision: 1, trigger: 'sweep', at: AT, pageFetch, extraction });
    expect(first.ok && first.value.callFirst).toBe(true);
    expect(first.ok && first.value.callFirstBecameTrue).toBe(true);
    const second = await runFirmResearch(context, { firmId: crm.alpha.firmId, revision: 2, trigger: 'sweep', at: AT, pageFetch, extraction });
    expect(second.ok && second.value.callFirst).toBe(true);
    expect(second.ok && second.value.callFirstBecameTrue).toBe(false);
  });
});

describe('links, the enqueue and the sweep', () => {
  const salesperson = (): RepositoryContext =>
    repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, {
        kind: 'user',
        userId: seeded.alpha.salesperson.userId,
        role: 'salesperson',
      }),
      session,
    );

  it('takes an https link on another public host and refuses the rest', async () => {
    const added = await addFirmLink(salesperson(), { firmId: crm.alpha.firmId, url: 'https://news.test/piece' });
    expect(added.ok).toBe(true);
    // A query string is refused rather than truncated: a link is stored, and it becomes
    // the source reference of every quote from the page, so a session token or an
    // address in it would outlive the run in a column retention cannot search.
    for (const url of [
      'http://news.test/piece',
      'https://linkedin.com/company/x',
      'https://127.0.0.1/',
      'https://news.test/piece?token=abc123',
    ]) {
      expect(await addFirmLink(salesperson(), { firmId: crm.alpha.firmId, url })).toEqual({
        ok: false,
        reason: 'link_not_permitted',
      });
    }
  });

  it('drops a fragment from a link rather than storing two URLs for one page', async () => {
    const added = await addFirmLink(salesperson(), { firmId: crm.alpha.firmId, url: 'https://news.test/piece#top' });
    expect(added.ok && added.value.url).toBe('https://news.test/piece');
  });

  it('reads a linked page in the same run as the firm’s own', async () => {
    await addFirmLink(salesperson(), { firmId: crm.alpha.firmId, url: 'https://news.test/piece' });
    const outcome = await runFirmResearch(context, {
      firmId: crm.alpha.firmId,
      revision: 1,
      trigger: 'link_added',
      requestedByUserId: seeded.alpha.salesperson.userId,
      at: AT,
      pageFetch: fakeFetch([
        { url: 'https://alpha.example.test/', html: HOME },
        { url: 'https://news.test/piece', html: '<p>Alpha has opened a second office.</p>' },
      ]),
      extraction: fakeExtraction([{ key: 'recent_change', sourceReference: 'https://news.test/piece', blockId: 'b1' }]),
    });
    expect(outcome.ok && outcome.value.pagesFetched).toBe(2);
    expect((await readFirmJudgments(context, crm.alpha.firmId))?.timing).toBe('yes');
  });

  it('enqueues one job per revision and refuses a second while one is running', async () => {
    const first = await enqueueFirmResearch(context, { firmId: crm.alpha.firmId, trigger: 'sweep' });
    expect(first.ok && first.value).toMatchObject({ revision: 1, inserted: true });
    // No run row yet, so a second enqueue is simply the same revision's key again.
    const again = await enqueueFirmResearch(context, { firmId: crm.alpha.firmId, trigger: 'sweep' });
    expect(again.ok && again.value).toMatchObject({ revision: 1, inserted: false });

    await session.query(
      `INSERT INTO research_runs (workspace_id, firm_id, revision, trigger) VALUES ($1, $2, 1, 'sweep')`,
      [seeded.alpha.workspaceId, crm.alpha.firmId],
    );
    expect(await enqueueFirmResearch(context, { firmId: crm.alpha.firmId, trigger: 'sweep' })).toEqual({
      ok: false,
      reason: 'run_in_progress',
    });
  });

  it('sweeps a firm never researched, and not one researched inside ninety days', async () => {
    expect((await selectFirmsForSweep(context, { limit: 10, at: AT })).map(row => row.firmId)).toEqual([crm.alpha.firmId]);
    await session.query(
      `INSERT INTO research_runs (workspace_id, firm_id, revision, trigger, completed_at, outcome)
       VALUES ($1, $2, 1, 'sweep', $3::timestamptz, 'completed')`,
      [seeded.alpha.workspaceId, crm.alpha.firmId, AT],
    );
    expect(await selectFirmsForSweep(context, { limit: 10, at: AT })).toEqual([]);
    // Ninety-one days later it is stale again.
    expect((await selectFirmsForSweep(context, { limit: 10, at: '2026-12-29T14:00:00.000Z' })).length).toBe(1);
  });

  it('sweeps a firm whose last run failed, on the next business day, three times at most', async () => {
    // A provider failure completes its job — throwing would roll back the accounting of
    // a call already paid for — so this is the retry ladder, and the sweep is it.
    const failed = async (revision: number, completedAt: string): Promise<void> => {
      await session.query(
        `INSERT INTO research_runs (workspace_id, firm_id, revision, trigger, completed_at, outcome, refusal_code)
         VALUES ($1, $2, $3, 'sweep', $4::timestamptz, 'failed', 'provider_failure')`,
        [seeded.alpha.workspaceId, crm.alpha.firmId, revision, completedAt],
      );
    };
    await failed(1, AT);
    // The same business day: a provider that failed this morning will fail again this
    // morning, and a unit of the day's budget is worth more than that.
    expect(await selectFirmsForSweep(context, { limit: 10, at: '2026-09-28T22:00:00.000Z' })).toEqual([]);
    // The next one: due.
    expect((await selectFirmsForSweep(context, { limit: 10, at: '2026-09-29T14:00:00.000Z' })).length).toBe(1);

    await failed(2, '2026-09-29T14:00:00.000Z');
    expect((await selectFirmsForSweep(context, { limit: 10, at: '2026-09-30T14:00:00.000Z' })).length).toBe(1);
    await failed(3, '2026-09-30T14:00:00.000Z');
    // Three in a row is a firm whose site cannot be read. The firm page says so; the
    // sweep stops spending a unit a day on it.
    expect(await selectFirmsForSweep(context, { limit: 10, at: '2026-10-01T14:00:00.000Z' })).toEqual([]);
  });

  it('sweeps a firm whose run completed with no model, once a model is configured', async () => {
    await session.query(
      `INSERT INTO research_runs (workspace_id, firm_id, revision, trigger, completed_at, outcome)
       VALUES ($1, $2, 1, 'sweep', $3::timestamptz, 'completed')`,
      [seeded.alpha.workspaceId, crm.alpha.firmId, AT],
    );
    // With no extraction port there is nothing to gain by reading the pages again.
    expect(await selectFirmsForSweep(context, { limit: 10, at: AT })).toEqual([]);
    // With one, the firm has pages recorded and no facts, and ninety days of silence
    // would be the shape of bug nobody finds until a quarter later.
    expect(
      (await selectFirmsForSweep(context, { limit: 10, at: AT, extractionConfigured: true })).length,
    ).toBe(1);
    // A run that did have a model is fresh either way.
    await session.query("UPDATE research_runs SET model_name = 'claude-haiku-4-5'");
    expect(await selectFirmsForSweep(context, { limit: 10, at: AT, extractionConfigured: true })).toEqual([]);
  });

  it('sweeps a firm whose link was added after its last run', async () => {
    await session.query(
      `INSERT INTO research_runs (workspace_id, firm_id, revision, trigger, started_at, completed_at, outcome, model_name)
       VALUES ($1, $2, 1, 'sweep', $3::timestamptz, $3::timestamptz, 'completed', 'claude-haiku-4-5')`,
      [seeded.alpha.workspaceId, crm.alpha.firmId, AT],
    );
    expect(await selectFirmsForSweep(context, { limit: 10, at: AT })).toEqual([]);
    // Adding a link enqueues a run of its own, and that run can refuse — a spent
    // ceiling, a run in flight. Without this the link would never be read.
    await session.query(
      `INSERT INTO firm_links (workspace_id, firm_id, url, added_by_user_id, added_at)
       VALUES ($1, $2, 'https://news.test/piece', $3, $4::timestamptz)`,
      [seeded.alpha.workspaceId, crm.alpha.firmId, seeded.alpha.salesperson.userId, '2026-09-28T15:00:00.000Z'],
    );
    expect((await selectFirmsForSweep(context, { limit: 10, at: AT })).length).toBe(1);
  });

  it('never sweeps a firm with a closed opportunity: a client or somebody who said no', async () => {
    await session.query("UPDATE opportunities SET status = 'won', closed_at = now() WHERE workspace_id = $1", [
      seeded.alpha.workspaceId,
    ]);
    expect(await selectFirmsForSweep(context, { limit: 10, at: AT })).toEqual([]);
  });
});

describe('the settings', () => {
  it('reads the defaults when the workspace has no row', async () => {
    expect(await readResearchSettings(context)).toMatchObject({
      enabled: true,
      dailyFirmCeiling: 50,
      dailyCostCeilingCents: 50,
      monthlyCostCeilingCents: 1000,
      maxPagesPerFirm: 4,
      modelName: 'claude-haiku-4-5',
      updatedAt: null,
    });
  });

  it('is admin only, and refuses a model with no reviewed price', async () => {
    const salesperson = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, {
        kind: 'user',
        userId: seeded.alpha.salesperson.userId,
        role: 'salesperson',
      }),
      session,
    );
    expect(await updateResearchSettings(salesperson, { enabled: false })).toEqual({ ok: false, reason: 'admin_only' });
    const admin = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      session,
    );
    expect(await updateResearchSettings(admin, { modelName: 'claude-opus-5' })).toEqual({
      ok: false,
      reason: 'model_unpriced',
    });
    expect(await updateResearchSettings(admin, { maxPagesPerFirm: 9 })).toEqual({ ok: false, reason: 'invalid_input' });
    const updated = await updateResearchSettings(admin, { dailyFirmCeiling: 7 });
    expect(updated.ok && updated.value.dailyFirmCeiling).toBe(7);
    expect(updated.ok && updated.value.updatedByUserId).toBe(seeded.alpha.admin.userId);
  });
});
