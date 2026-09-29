import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { claimResearchClearance, researchClearanceAvailable } from '../../research/ceilings.ts';
import { readSpend, recordProviderCall } from '../../research/ledger.ts';
import {
  finaliseSubjectReservations,
  markCalling,
  reserveAttempt,
  settleAttempt,
} from '../../research/reservations.ts';
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

/**
 * Attempt 1's clearance for the seeded firm.
 *
 * One clearance function prices every reservation, attempt 1 and retry alike, so every
 * call names the firm (its three rows a day are part of the decision) and which of the
 * two it is (only attempt 1 consumes a unit of the day's firm count).
 */
const firstAttempt = (at: string): { firmId: string; at: string; attemptKind: 'first' } => ({
  firmId: crm.alpha.firmId,
  at,
  attemptKind: 'first',
});

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

/** A counter that always fits. The budget cases have their own fakes. */
const fitsBudget = async (): Promise<number> => 100;

function fakeExtraction(
  selections: readonly { readonly key: string; readonly sourceReference: string; readonly blockId: string }[],
  options: { readonly costCents?: number; readonly generated?: boolean } = {},
): ExtractionProvider {
  return {
    providerKey: 'anthropic_extraction',
    countInputTokens: fitsBudget,
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
  countInputTokens: fitsBudget,
  extract: async () => ({ ok: false, failureCode: 'malformed_answer', costCents: 1 }),
};

/** A call nobody priced: the socket broke, or the response carried no usage. */
const unpricedExtraction: ExtractionProvider = {
  providerKey: 'anthropic_extraction',
  countInputTokens: fitsBudget,
  extract: async () => ({ ok: false, failureCode: 'provider_error', costCents: 0, costEstimated: true }),
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
  await session.query('DELETE FROM provider_reservations');
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

describe('one reservation per paid attempt', () => {
  const subject = (runId: string) => ({ subjectKind: 'research_run' as const, subjectId: runId });

  /** A run row to hang reservations on. */
  const openRunRow = async (revision: number): Promise<string> => {
    const { rows } = await session.query<{ id: string }>(
      `INSERT INTO research_runs (workspace_id, firm_id, revision, trigger) VALUES ($1, $2, $3, 'sweep')
       RETURNING id`,
      [seeded.alpha.workspaceId, crm.alpha.firmId, revision],
    );
    return rows[0]?.id ?? '';
  };

  it('counts an open reservation as spend, and settles it once by id', async () => {
    const runId = await openRunRow(1);
    const reserved = await reserveAttempt(context, {
      providerKey: 'anthropic_extraction',
      ...subject(runId),
      attempt: 1,
      at: AT,
      businessTimeZone: ZONE,
      cents: 30,
    });
    // Authorized and not invoiced: the next clearance sees it as spent, which is the
    // only arrangement under which two runs cannot be cleared against the same cents.
    expect(await readSpend(context, { businessTimeZone: ZONE, at: AT })).toEqual({
      todayCents: 30,
      monthToDateCents: 30,
    });

    expect(await markCalling(context, reserved.id)).toBe(true);
    // Idempotent and narrow: only a `reserved` row moves, so a second call is a no.
    expect(await markCalling(context, reserved.id)).toBe(false);

    const settled = await settleAttempt(context, {
      reservationId: reserved.id,
      at: AT,
      outcome: { kind: 'settled', cents: 4 },
    });
    expect(settled).toEqual({ recordedCents: 4, state: 'settled' });
    // Settled exactly once: a caller that runs twice adds cents once.
    expect(await settleAttempt(context, { reservationId: reserved.id, at: AT, outcome: { kind: 'settled', cents: 4 } })).toBeNull();
    expect(await readSpend(context, { businessTimeZone: ZONE, at: AT })).toEqual({
      todayCents: 4,
      monthToDateCents: 4,
    });
  });

  it('settles on the reservation’s own date, not the settling day’s', async () => {
    // The defect a `reserved_cents` column could not avoid: a run authorized yesterday
    // released *today's* number, silently giving away the cents another run was holding.
    const yesterday = await openRunRow(1);
    const reserved = await reserveAttempt(context, {
      providerKey: 'anthropic_extraction',
      ...subject(yesterday),
      attempt: 1,
      at: '2026-09-28T14:00:00.000Z',
      businessTimeZone: ZONE,
      cents: 3,
    });
    await markCalling(context, reserved.id);

    // A second run, authorized the next day, holding its own cents.
    const today = await openRunRow(2);
    await reserveAttempt(context, {
      providerKey: 'anthropic_extraction',
      ...subject(today),
      attempt: 1,
      at: '2026-09-29T14:00:00.000Z',
      businessTimeZone: ZONE,
      cents: 3,
    });

    // Yesterday's run settles today.
    await settleAttempt(context, {
      reservationId: reserved.id,
      at: '2026-09-29T15:00:00.000Z',
      outcome: { kind: 'settled', cents: 2 },
    });

    const { rows } = await session.query<{ business_date: string; cost: number }>(
      `SELECT business_date::text AS business_date, cost_cents AS cost FROM provider_ledger
        WHERE provider_key = 'anthropic_extraction' ORDER BY business_date`,
    );
    // The invoice landed on the day whose budget cleared it.
    expect(rows).toEqual([{ business_date: '2026-09-28', cost: 2 }]);
    // And the other run's authorization is untouched.
    expect((await readSpend(context, { businessTimeZone: ZONE, at: '2026-09-29T15:00:00.000Z' })).todayCents).toBe(3);
  });

  it('closes an abandoned run’s reservations by whether a call could have happened', async () => {
    const runId = await openRunRow(1);
    const called = await reserveAttempt(context, {
      providerKey: 'anthropic_extraction',
      ...subject(runId),
      attempt: 1,
      at: AT,
      businessTimeZone: ZONE,
      cents: 3,
    });
    await markCalling(context, called.id);
    await reserveAttempt(context, {
      providerKey: 'anthropic_extraction',
      ...subject(runId),
      attempt: 2,
      at: AT,
      businessTimeZone: ZONE,
      cents: 3,
    });

    const finalised = await finaliseSubjectReservations(context, { ...subject(runId), at: AT });
    // The one that reached `calling` is estimated; the one that did not is released,
    // because no call could have happened against it.
    expect(finalised).toEqual({ cents: 3, estimated: true });
    const { rows } = await session.query<{ attempt: number; state: string; settled: number }>(
      `SELECT attempt, state, settled_cents AS settled FROM provider_reservations ORDER BY attempt`,
    );
    expect(rows).toEqual([
      { attempt: 1, state: 'estimated', settled: 3 },
      { attempt: 2, state: 'released', settled: 0 },
    ]);
  });

  it('refuses the next clearance on cents that are authorized and not yet invoiced', async () => {
    const admin = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      session,
    );
    await updateResearchSettings(admin, { dailyCostCeilingCents: 5 });
    const runId = await openRunRow(1);
    await reserveAttempt(context, {
      providerKey: 'anthropic_extraction',
      ...subject(runId),
      attempt: 1,
      at: AT,
      businessTimeZone: ZONE,
      cents: 4,
    });
    expect(await claimResearchClearance(context, firstAttempt(AT))).toEqual({ ok: false, reason: 'daily_cost_ceiling' });
  });
});

describe('the ceilings', () => {
  it('refuses when research is disabled', async () => {
    const admin = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      session,
    );
    await updateResearchSettings(admin, { enabled: false });
    const claim = await claimResearchClearance(context, firstAttempt(AT));
    expect(claim).toEqual({ ok: false, reason: 'research_disabled' });
  });

  it('refuses the very first run at a zero count ceiling', async () => {
    const admin = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      session,
    );
    await updateResearchSettings(admin, { dailyFirmCeiling: 0 });
    expect(await claimResearchClearance(context, firstAttempt(AT))).toEqual({ ok: false, reason: 'daily_firm_ceiling' });
  });

  it('consumes the counter, so the clearance after the last one refuses', async () => {
    const admin = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      session,
    );
    await updateResearchSettings(admin, { dailyFirmCeiling: 2 });
    expect((await claimResearchClearance(context, firstAttempt(AT))).ok).toBe(true);
    expect((await claimResearchClearance(context, firstAttempt(AT))).ok).toBe(true);
    expect(await claimResearchClearance(context, firstAttempt(AT))).toEqual({ ok: false, reason: 'daily_firm_ceiling' });
  });

  it('refuses on the worst case before the call, not on the invoice after it', async () => {
    const admin = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      session,
    );
    // One cent a day, and a run's worst case is two.
    await updateResearchSettings(admin, { dailyCostCeilingCents: 1 });
    expect(await claimResearchClearance(context, firstAttempt(AT))).toEqual({ ok: false, reason: 'daily_cost_ceiling' });
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
    expect(await claimResearchClearance(context, firstAttempt(AT))).toEqual({ ok: false, reason: 'monthly_cost_ceiling' });
    // A new month starts the budget again.
    expect((await claimResearchClearance(context, firstAttempt('2026-10-05T14:00:00.000Z'))).ok).toBe(true);
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
    expect((await listRuns(context, crm.alpha.firmId))[0]).toMatchObject({
      outcome: 'failed',
      refusalCode: 'provider_failure',
      // The model was asked and broke, which is not the same fact as "nobody had
      // configured one" — and only one of the two is worth a sweep coming back for.
      extraction: 'failed',
    });
  });

  it('records the reservation, not zero, when nobody said what the call cost', async () => {
    // A transport that threw and a response with no usage may both have been billed.
    // Zero is the one answer that is certainly wrong: a budget that reads a burned call
    // as free is a budget a broken provider walks straight through.
    const outcome = await runFirmResearch(context, {
      firmId: crm.alpha.firmId,
      revision: 1,
      trigger: 'sweep',
      at: AT,
      pageFetch: fakeFetch([{ url: 'https://alpha.example.test/', html: HOME }]),
      extraction: unpricedExtraction,
    });
    expect(outcome).toEqual({ ok: false, reason: 'provider_failure' });
    const run = (await listRuns(context, crm.alpha.firmId))[0];
    // Three cents at the defaults: what the ceiling authorized, which is the best
    // available figure for a call whose invoice never arrived.
    expect(run).toMatchObject({ outcome: 'failed', refusalCode: 'provider_failure', costCents: 3, costEstimated: true });
    expect((await readSpend(context, { businessTimeZone: ZONE, at: AT })).todayCents).toBe(3);
    const { rows } = await session.query<{ state: string; settled: number }>(
      'SELECT state, settled_cents AS settled FROM provider_reservations',
    );
    // Closed as `estimated` rather than left open, so the figure is counted once: the
    // ledger holds it and the reservation no longer does.
    expect(rows).toEqual([{ state: 'estimated', settled: 3 }]);
  });

  it('counts the request before it calls, drops trailing blocks, and refuses to call what will not fit', async () => {
    // The reservation is sized by characters per token, which is the right way to decide
    // what to *hold* and the wrong way to decide what to *send*: a page of dense script
    // tokenizes several times worse than 2.5 characters a token. So the exact count is
    // what admits the call.
    const counts: number[] = [];
    const sizes: number[] = [];
    let calls = 0;
    const overThenUnder: ExtractionProvider = {
      providerKey: 'anthropic_extraction',
      countInputTokens: async request => {
        sizes.push(request.sources.reduce((total, source) => total + source.blocks.length, 0));
        const answer = counts.length === 0 ? 1_000_000 : 100;
        counts.push(answer);
        return answer;
      },
      extract: async () => {
        calls += 1;
        return {
          ok: true,
          costCents: 1,
          value: {
            selections: [],
            questions: null,
            opening: null,
            modelName: 'claude-haiku-4-5',
            inputTokens: 100,
            outputTokens: 10,
          },
        };
      },
    };
    const outcome = await runFirmResearch(context, {
      firmId: crm.alpha.firmId,
      revision: 1,
      trigger: 'sweep',
      at: AT,
      pageFetch: fakeFetch([{ url: 'https://alpha.example.test/', html: HOME }]),
      extraction: overThenUnder,
    });
    expect(outcome.ok).toBe(true);
    // Counted twice — once over, once under after a drop — and called once.
    expect(counts.length).toBe(2);
    expect(sizes[1]).toBeLessThan(sizes[0] ?? 0);
    expect(calls).toBe(1);
    expect((await listRuns(context, crm.alpha.firmId))[0]).toMatchObject({ outcome: 'completed', extraction: 'used' });
  });

  it('never calls a request that will not fit, and records it as over_budget at no cost', async () => {
    let calls = 0;
    const alwaysOver: ExtractionProvider = {
      providerKey: 'anthropic_extraction',
      countInputTokens: async () => 1_000_000,
      extract: async () => {
        calls += 1;
        return { ok: false, failureCode: 'provider_error', costCents: 0 };
      },
    };
    const outcome = await runFirmResearch(context, {
      firmId: crm.alpha.firmId,
      revision: 1,
      trigger: 'sweep',
      at: AT,
      pageFetch: fakeFetch([{ url: 'https://alpha.example.test/', html: HOME }]),
      extraction: alwaysOver,
    });
    // A completion, not a failure: the pages are recorded, the judgments come from the
    // firm's routes and its suppression, and a person can raise the ceiling.
    expect(outcome.ok).toBe(true);
    expect(calls).toBe(0);
    expect((await listRuns(context, crm.alpha.firmId))[0]).toMatchObject({
      outcome: 'completed',
      extraction: 'over_budget',
      costCents: 0,
    });
    // The cents came back rather than being recorded against a call nobody made.
    expect((await readSpend(context, { businessTimeZone: ZONE, at: AT })).todayCents).toBe(0);
    const { rows } = await session.query<{ state: string }>('SELECT state FROM provider_reservations');
    expect(rows).toEqual([{ state: 'released' }]);
  });

  it('does not call when the counter itself fails', async () => {
    let calls = 0;
    const brokenCounter: ExtractionProvider = {
      providerKey: 'anthropic_extraction',
      countInputTokens: async () => {
        throw new Error('count_tokens: 503');
      },
      extract: async () => {
        calls += 1;
        return { ok: false, failureCode: 'provider_error', costCents: 0 };
      },
    };
    const outcome = await runFirmResearch(context, {
      firmId: crm.alpha.firmId,
      revision: 1,
      trigger: 'sweep',
      at: AT,
      pageFetch: fakeFetch([{ url: 'https://alpha.example.test/', html: HOME }]),
      extraction: brokenCounter,
    });
    // Spending against a number nobody has is the one thing worse than not spending.
    expect(outcome).toEqual({ ok: false, reason: 'provider_failure' });
    expect(calls).toBe(0);
    expect((await listRuns(context, crm.alpha.firmId))[0]).toMatchObject({
      outcome: 'failed',
      extraction: 'failed',
      costCents: 0,
    });
    const { rows } = await session.query<{ state: string }>('SELECT state FROM provider_reservations');
    expect(rows).toEqual([{ state: 'released' }]);
  });

  it('says why the model was not used, so the sweep can tell the two cases apart', async () => {
    // No extraction port at all.
    await runFirmResearch(context, {
      firmId: crm.alpha.firmId,
      revision: 1,
      trigger: 'sweep',
      at: AT,
      pageFetch: fakeFetch([{ url: 'https://alpha.example.test/', html: HOME }]),
    });
    expect((await listRuns(context, crm.alpha.firmId))[0]).toMatchObject({
      outcome: 'completed',
      extraction: 'unconfigured',
    });

    // A port, and nothing readable to send it.
    await runFirmResearch(context, {
      firmId: crm.alpha.firmId,
      revision: 2,
      trigger: 'sweep',
      at: AT,
      pageFetch: fakeFetch([]),
      extraction: fakeExtraction([]),
    });
    expect((await listRuns(context, crm.alpha.firmId))[0]).toMatchObject({
      outcome: 'completed',
      extraction: 'no_pages',
    });
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
      `INSERT INTO research_runs (workspace_id, firm_id, revision, trigger, completed_at, outcome, extraction)
       VALUES ($1, $2, 1, 'sweep', $3::timestamptz, 'completed', 'unconfigured')`,
      [seeded.alpha.workspaceId, crm.alpha.firmId, AT],
    );
    // With no extraction port there is nothing to gain by reading the pages again.
    expect(await selectFirmsForSweep(context, { limit: 10, at: AT })).toEqual([]);
    // With one, the firm has pages recorded and no facts, and ninety days of silence
    // would be the shape of bug nobody finds until a quarter later — but not on the
    // same business day the run completed on, which is the gate every branch but
    // staleness now sits behind.
    expect(await selectFirmsForSweep(context, { limit: 10, at: AT, extractionConfigured: true })).toEqual([]);
    expect(
      (await selectFirmsForSweep(context, { limit: 10, at: '2026-09-29T14:00:00.000Z', extractionConfigured: true }))
        .length,
    ).toBe(1);
    // A run that did have a model is fresh either way.
    await session.query("UPDATE research_runs SET model_name = 'claude-haiku-4-5', extraction = 'used'");
    expect(
      await selectFirmsForSweep(context, { limit: 10, at: '2026-09-29T14:00:00.000Z', extractionConfigured: true }),
    ).toEqual([]);
  });

  it('never sweeps again a firm whose pages could not be read, model or no model', async () => {
    // The difference a null model_name could not express. A run that recorded no
    // readable pages will record none tomorrow, so re-selecting it whenever a key is
    // configured was a unit of the day's budget spent on the same nothing, every day,
    // for ever.
    await session.query(
      `INSERT INTO research_runs (workspace_id, firm_id, revision, trigger, completed_at, outcome, extraction)
       VALUES ($1, $2, 1, 'sweep', $3::timestamptz, 'completed', 'no_pages')`,
      [seeded.alpha.workspaceId, crm.alpha.firmId, AT],
    );
    expect(await selectFirmsForSweep(context, { limit: 10, at: AT })).toEqual([]);
    expect(await selectFirmsForSweep(context, { limit: 10, at: AT, extractionConfigured: true })).toEqual([]);
    // Ninety days later it is stale, and stale is a different question.
    expect((await selectFirmsForSweep(context, { limit: 10, at: '2026-12-29T14:00:00.000Z' })).length).toBe(1);
  });

  it('sweeps a firm whose link was added after its last run, on a later day', async () => {
    await session.query(
      `INSERT INTO research_runs
         (workspace_id, firm_id, revision, trigger, started_at, completed_at, outcome, model_name, extraction)
       VALUES ($1, $2, 1, 'sweep', $3::timestamptz, $3::timestamptz, 'completed', 'claude-haiku-4-5', 'used')`,
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
    // Not the same business day as the run: the link's own enqueue is the prompt path,
    // and this branch is the backstop the next morning.
    expect(await selectFirmsForSweep(context, { limit: 10, at: '2026-09-28T22:00:00.000Z' })).toEqual([]);
    expect((await selectFirmsForSweep(context, { limit: 10, at: '2026-09-29T14:00:00.000Z' })).length).toBe(1);
  });

  it('stops sweeping after three failures, even when a link is added', async () => {
    // The branch that used to bypass the ladder. A firm whose site cannot be read does
    // not become an every-morning expense because somebody pasted a URL at it.
    for (const revision of [1, 2, 3]) {
      await session.query(
        `INSERT INTO research_runs
           (workspace_id, firm_id, revision, trigger, started_at, completed_at, outcome, refusal_code)
         VALUES ($1, $2, $3, 'sweep', $4::timestamptz, $4::timestamptz, 'failed', 'provider_failure')`,
        [seeded.alpha.workspaceId, crm.alpha.firmId, revision, AT],
      );
    }
    await session.query(
      `INSERT INTO firm_links (workspace_id, firm_id, url, added_by_user_id, added_at)
       VALUES ($1, $2, 'https://news.test/fresh', $3, $4::timestamptz)`,
      [seeded.alpha.workspaceId, crm.alpha.firmId, seeded.alpha.salesperson.userId, '2026-09-29T09:00:00.000Z'],
    );
    expect(await selectFirmsForSweep(context, { limit: 10, at: '2026-09-30T14:00:00.000Z' })).toEqual([]);
  });

  it('does not sweep a firm with nothing to read twice, and does once a website appears', async () => {
    // The branch that used to loop for ever: a firm with no website and no links was
    // selected, refused `no_sources`, and — because a refused run was not "researched" —
    // selected again the next morning, and every morning after that.
    await session.query('UPDATE firms SET website = NULL WHERE id = $1', [crm.alpha.firmId]);
    const first = await runFirmResearch(context, {
      firmId: crm.alpha.firmId,
      revision: 1,
      trigger: 'sweep',
      at: AT,
      pageFetch: fakeFetch([]),
    });
    expect(first).toEqual({ ok: false, reason: 'no_sources' });
    expect(await selectFirmsForSweep(context, { limit: 10, at: AT })).toEqual([]);
    expect(await selectFirmsForSweep(context, { limit: 10, at: '2026-10-05T14:00:00.000Z' })).toEqual([]);

    // A website typed in is the thing that changed, and it is worth reading at once
    // rather than tomorrow: it can only happen once per edit.
    await session.query(
      "UPDATE firms SET website = 'https://alpha.example.test/', updated_at = now() WHERE id = $1",
      [crm.alpha.firmId],
    );
    expect((await selectFirmsForSweep(context, { limit: 10, at: AT })).map(row => row.firmId)).toEqual([
      crm.alpha.firmId,
    ]);
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
