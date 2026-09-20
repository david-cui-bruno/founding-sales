import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing';
import { repositoryContext, workspaceScope, type SessionQueryable } from '@fss/domain/db';
import {
  HandlerRegistry,
  JOB_KIND_PROTECTION,
  claimJobs,
  enqueueJob,
  runTwiceUnderStolenLease,
} from '@fss/domain/jobs';
import {
  updateProvider,
  updateResearchSettings,
  type ResearchProviders,
} from '@fss/domain/research';
import {
  recordedDiscoveryProvider,
  recordedExtractionProvider,
  recordedPageFetchProvider,
} from '@fss/domain/research/testing';
import { runClaimedJob } from '../src/runner/jobRunner.ts';
import { ResearchHandlerError, researchHandlers } from '../src/handlers/research.ts';

/**
 * The research handlers under the real stolen-lease harness (Appendix G scenario 2,
 * and `docs/greenfield/jobs.md`: "A lane that registers a new handler adds a probe and
 * runs it. That is Appendix G scenario 2, and it is not optional.").
 *
 * The harness expires the lease, reclaims the row, lets a second worker finish, then
 * lets the first wake up and try, and counts the business effects. Both research kinds
 * are protected by `business_uniqueness`, so the first worker's completion affects zero
 * rows, its transaction rolls back, and the row its handler wrote goes with it.
 *
 * Every provider here is a recorded fixture. Nothing in this file opens a socket.
 */

const AT = '2026-09-21T14:00:00.000Z';

describe('the research handlers', () => {
  let database: TestDatabase;
  let session: SessionQueryable;
  let workspaceId: string;
  let firmId: string;
  let providers: ResearchProviders;

  beforeAll(async () => {
    database = await createTestDatabase();
    session = database.session;
    const workspace = await session.query<{ id: string }>(
      "INSERT INTO workspaces (slug, display_name) VALUES ('alpha', 'Alpha') RETURNING id",
    );
    workspaceId = workspace.rows[0]?.id ?? '';

    const firm = await session.query<{ id: string }>(
      `INSERT INTO firms (workspace_id, name, website, region_code, postal_code)
       VALUES ($1, 'Northgate Residential Management', 'https://northgate-residential.example.test/', 'TX', '79901')
       RETURNING id`,
      [workspaceId],
    );
    firmId = firm.rows[0]?.id ?? '';

    const context = repositoryContext(
      workspaceScope(workspaceId, { kind: 'system', component: 'worker' }),
      session,
    );
    await updateResearchSettings(context, {
      enabled: true,
      dailyPageCeiling: 50,
      dailyFirmCeiling: 50,
      dailyCostCeilingMicros: 10_000_000,
    });
    for (const providerKey of ['places', 'company_page', 'page_facts']) {
      await updateProvider(context, {
        providerKey,
        patch: { enabled: true, costPerCallMicros: 1_000, dailyCallCeiling: 100 },
      });
    }

    providers = {
      discovery: recordedDiscoveryProvider(),
      pageFetch: recordedPageFetchProvider(),
      extraction: recordedExtractionProvider(),
    };
  });

  afterAll(async () => {
    await database.drop();
  });

  const registryFor = (): HandlerRegistry => {
    const registry = new HandlerRegistry();
    for (const handler of researchHandlers({ providers, now: () => new Date(AT) })) {
      registry.register(handler);
    }
    return registry;
  };

  it('declares the protection Appendix C gives each kind, or the registry refuses it', () => {
    const handlers = researchHandlers({ providers });
    expect(handlers.map(handler => handler.kind).sort()).toEqual(['research.firm', 'research.page']);
    for (const handler of handlers) {
      expect(handler.protection, handler.kind).toBe(JOB_KIND_PROTECTION[handler.kind]);
    }
    // Registering is where a disagreement with Appendix C is caught.
    expect(() => registryFor()).not.toThrow();
  });

  it('registers no handler for a kind whose provider this worker was not given', () => {
    expect(researchHandlers({ providers: {} })).toEqual([]);
    expect(researchHandlers({ providers: { discovery: providers.discovery } }).map(h => h.kind)).toEqual([
      'research.page',
    ]);
  });

  // ------------------------------------------------ Appendix G scenario 2
  it('produces one discovery page under a stolen lease, not two', async () => {
    const countPages = async (): Promise<number> => {
      const { rows } = await session.query<{ count: string }>(
        'SELECT count(*) AS count FROM research_pages WHERE workspace_id = $1',
        [workspaceId],
      );
      return Number(rows[0]?.count ?? '0');
    };

    const report = await runTwiceUnderStolenLease({
      session,
      registry: registryFor(),
      run: runClaimedJob,
      workspaceId,
      kind: 'research.page',
      idempotencyKey: 'research:stolen-lease:page',
      payload: {
        query: 'property management in the fictional county',
        pageToken: null,
        providerKey: 'places',
        requestedByUserId: null,
      },
      countEffects: countPages,
    });

    expect(report.freshOutcome).toBe('completed');
    expect(report.staleOutcome).toBe('lease_lost');
    expect(report.effectsAfter - report.effectsBefore).toBe(1);
    expect(BigInt(report.freshFencingToken)).toBeGreaterThan(BigInt(report.staleFencingToken));
  });

  it('produces one enrichment run under a stolen lease, not two', async () => {
    const countRuns = async (): Promise<number> => {
      const { rows } = await session.query<{ count: string }>(
        'SELECT count(*) AS count FROM research_firm_runs WHERE workspace_id = $1',
        [workspaceId],
      );
      return Number(rows[0]?.count ?? '0');
    };

    const report = await runTwiceUnderStolenLease({
      session,
      registry: registryFor(),
      run: runClaimedJob,
      workspaceId,
      kind: 'research.firm',
      idempotencyKey: `research-firm:${firmId}:1`,
      payload: { firmId, revision: 1, providerKey: 'company_page', extractionProviderKey: 'page_facts' },
      countEffects: countRuns,
    });

    expect(report.freshOutcome).toBe('completed');
    expect(report.staleOutcome).toBe('lease_lost');
    expect(report.effectsAfter - report.effectsBefore).toBe(1);
  });

  // --------------------------------------------------------- payload validation
  it('fails a payload it cannot validate rather than running a query from a row', async () => {
    const registry = registryFor();
    for (const payload of [
      {},
      { query: '', pageToken: null, providerKey: 'places', requestedByUserId: null },
      { query: 'fine', pageToken: null, providerKey: 'Places', requestedByUserId: null },
      { query: 'fine', pageToken: 42, providerKey: 'places', requestedByUserId: null },
    ]) {
      await enqueueJob(session, {
        workspaceId,
        kind: 'research.page',
        idempotencyKey: `research:invalid:${JSON.stringify(payload)}`,
        payload,
      });
    }
    const claims = await claimJobs(session, {
      owner: 'payload-worker',
      kinds: ['research.page'],
      limit: 10,
      leaseSeconds: 30,
    });
    expect(claims.length).toBeGreaterThanOrEqual(4);
    for (const job of claims) {
      const outcome = await runClaimedJob(session, { registry, job });
      expect(outcome, JSON.stringify(job.payload)).toBe('retryable');
    }
    const errors = await session.query<{ error_code: string }>(
      "SELECT DISTINCT error_code FROM jobs WHERE workspace_id = $1 AND kind = 'research.page' AND error_code IS NOT NULL",
      [workspaceId],
    );
    expect(errors.rows.map(row => row.error_code)).toContain('research_handler_error');
  });

  it('refuses to substitute a provider the job did not ask for', async () => {
    const handler = researchHandlers({
      providers: { discovery: recordedDiscoveryProvider({ providerKey: 'another_provider' }) },
    })[0];
    expect(handler).toBeDefined();
    if (handler === undefined) return;
    await expect(
      handler.handle({
        session,
        scope: workspaceScope(workspaceId, { kind: 'system', component: 'worker' }),
        job: {
          id: '11111111-1111-4111-8111-111111111111',
          workspaceId,
          kind: 'research.page',
          idempotencyKey: 'research:substitution',
          payload: { query: 'a query', pageToken: null, providerKey: 'places', requestedByUserId: null },
          attempt: 1,
          maxAttempts: 4,
          fencingToken: '1',
          leaseOwner: 'substitution-worker',
          leaseExpiresAt: new Date().toISOString(),
        },
      }),
    ).rejects.toBeInstanceOf(ResearchHandlerError);
  });

  // ------------------------------------------------- a refusal completes the job
  it('completes the job when a ceiling refuses the work, rather than burning attempts', async () => {
    const context = repositoryContext(
      workspaceScope(workspaceId, { kind: 'system', component: 'worker' }),
      session,
    );
    await updateResearchSettings(context, { enabled: false });
    try {
      const registry = registryFor();
      await enqueueJob(session, {
        workspaceId,
        kind: 'research.page',
        idempotencyKey: 'research:disabled',
        payload: { query: 'while research is off', pageToken: null, providerKey: 'places', requestedByUserId: null },
      });
      const [job] = await claimJobs(session, {
        owner: 'ceiling-worker',
        kinds: ['research.page'],
        limit: 1,
        leaseSeconds: 30,
      });
      expect(job).toBeDefined();
      if (job === undefined) return;
      // A configured outcome, not a failure: the queue does not retry a day that is
      // over, and no dead job means no critical alert about working as configured.
      expect(await runClaimedJob(session, { registry, job })).toBe('completed');
    } finally {
      await updateResearchSettings(context, { enabled: true });
    }
  });
});
