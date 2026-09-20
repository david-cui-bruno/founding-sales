import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import {
  repositoryContext,
  workspaceScope,
  type RepositoryContext,
  type WorkspaceScope,
} from '../../db/workspaceScope.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { mergeFirms } from '../../crm/index.ts';
import {
  activeRoutePolicy,
  claimResearchClearance,
  enqueueDiscoveryPage,
  enqueueFirmEnrichment,
  findDuplicateCandidates,
  firmIsResearchable,
  isFirmSuppressed,
  listProviders,
  listSuggestions,
  nextFirmResearchRevision,
  publishRoutePolicy,
  readFirmCoordinate,
  readProviderLedger,
  readResearchSettings,
  researchEnqueueAllowed,
  reviewSuggestion,
  routePolicyHistory,
  runDiscoveryPage,
  runFirmEnrichment,
  updateProvider,
  updateResearchSettings,
} from '../../research/index.ts';
import {
  recordedDiscoveryProvider,
  recordedExtractionProvider,
  recordedPageFetchProvider,
} from '../../research/testing/fixtures.ts';

/**
 * Research against a real PostgreSQL, with recorded providers.
 *
 * Every case in the lane's acceptance list is here: the two-workspace fixture,
 * "a suppressed firm is never refreshed", "the ceiling stops enqueues", and scenario
 * 37's concurrent-enrichment half. Invariant 8 is `invariant8.test.ts`, on its own,
 * because it is the one property that has to be re-proved for every path.
 */

const AT = '2026-09-21T14:00:00.000Z';

describe('research commands', () => {
  let database: TestDatabase;
  let session: SessionQueryable;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let adminScope: WorkspaceScope;
  let salespersonScope: WorkspaceScope;
  let betaAdminScope: WorkspaceScope;
  let workerScope: WorkspaceScope;

  const contextOn = (db: SessionQueryable, scope: WorkspaceScope): RepositoryContext =>
    repositoryContext(scope, db);

  beforeAll(async () => {
    database = await createTestDatabase();
    session = database.session;
    seeded = await seedTwoWorkspaces(session);
    crm = await seedCrm(session, seeded);

    adminScope = workspaceScope(seeded.alpha.workspaceId, {
      kind: 'user',
      userId: seeded.alpha.admin.userId,
      role: 'admin',
    });
    salespersonScope = workspaceScope(seeded.alpha.workspaceId, {
      kind: 'user',
      userId: seeded.alpha.salesperson.userId,
      role: 'salesperson',
    });
    betaAdminScope = workspaceScope(seeded.beta.workspaceId, {
      kind: 'user',
      userId: seeded.beta.admin.userId,
      role: 'admin',
    });
    workerScope = workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' });
  });

  afterAll(async () => {
    await database.drop();
  });

  /** Run `work` in its own transaction on a fresh app_runtime session, then roll back. */
  const inRolledBackTransaction = async <T>(
    scope: WorkspaceScope,
    work: (context: RepositoryContext) => Promise<T>,
  ): Promise<T> => {
    const other = await database.appRuntimeSession();
    await other.query('BEGIN');
    try {
      return await work(contextOn(other, scope));
    } finally {
      await other.query('ROLLBACK');
    }
  };

  /** Turn research on for one workspace inside the caller's transaction. */
  const enableResearch = async (
    context: RepositoryContext,
    overrides: { readonly dailyPageCeiling?: number; readonly dailyFirmCeiling?: number; readonly dailyCostCeilingMicros?: number } = {},
  ): Promise<void> => {
    const settings = await updateResearchSettings(context, {
      enabled: true,
      dailyPageCeiling: overrides.dailyPageCeiling ?? 20,
      dailyFirmCeiling: overrides.dailyFirmCeiling ?? 20,
      dailyCostCeilingMicros: overrides.dailyCostCeilingMicros ?? 2_000_000,
    });
    expect(settings).toMatchObject({ ok: true });
    for (const providerKey of ['places', 'company_page', 'page_facts']) {
      const provider = await updateProvider(context, {
        providerKey,
        patch: { enabled: true, costPerCallMicros: 32_000, dailyCallCeiling: 50 },
      });
      expect(provider, providerKey).toMatchObject({ ok: true });
    }
  };

  // ------------------------------------------------------------- seeding
  describe('what a workspace gets the moment it exists', () => {
    it('has settings, three disabled providers and route-policy.1', async () => {
      const context = contextOn(session, adminScope);
      const settings = await readResearchSettings(context);
      // Disabled: an unreviewed budget is no budget.
      expect(settings).toMatchObject({ enabled: false, dailyPageCeiling: 20 });

      const providers = await listProviders(context);
      expect(providers.map(provider => provider.providerKey).sort()).toEqual([
        'company_page',
        'page_facts',
        'places',
      ]);
      expect(providers.every(provider => !provider.enabled)).toBe(true);

      const policy = await activeRoutePolicy(context);
      expect(policy).toMatchObject({
        version: 'route-policy.1',
        minimumAssociationConfidence: 0.8,
        requireTechnicalValidation: true,
      });
      expect(policy?.trustedSources).toEqual(['salesperson', 'reply']);
    });

    it('seeds each workspace its own rows, and one cannot read the other', async () => {
      const alpha = await listProviders(contextOn(session, adminScope));
      const beta = await listProviders(contextOn(session, betaAdminScope));
      expect(alpha).toHaveLength(3);
      expect(beta).toHaveLength(3);

      // Alpha enables Places; beta's stays disabled. Two workspaces, one provider key.
      await inRolledBackTransaction(adminScope, async context => {
        await updateProvider(context, { providerKey: 'places', patch: { enabled: true } });
        const inAlpha = await listProviders(context);
        expect(inAlpha.find(p => p.providerKey === 'places')?.enabled).toBe(true);
        const inBeta = await listProviders(contextOn(context.db as SessionQueryable, betaAdminScope));
        expect(inBeta.find(p => p.providerKey === 'places')?.enabled).toBe(false);
      });
    });

    it('refuses a salesperson every configuration command', async () => {
      await inRolledBackTransaction(salespersonScope, async context => {
        expect(await updateResearchSettings(context, { enabled: true })).toMatchObject({
          ok: false,
          reason: 'admin_only',
        });
        expect(await updateProvider(context, { providerKey: 'places', patch: { enabled: true } })).toMatchObject({
          ok: false,
          reason: 'admin_only',
        });
        expect(
          await publishRoutePolicy(context, { version: 'route-policy.9', minimumAssociationConfidence: 0.9 }),
        ).toMatchObject({ ok: false, reason: 'admin_only' });
      });
    });
  });

  // --------------------------------------------- the versioned route policy
  describe('the versioned route-eligibility policy with history (7.4, deliverable 2)', () => {
    it('publishes a new version, keeps the old one, and makes the newest active', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        const published = await publishRoutePolicy(context, {
          version: 'route-policy.2',
          minimumAssociationConfidence: 0.95,
          note: 'Tightened after a wrong-number call.',
        });
        expect(published).toMatchObject({ ok: true });

        const active = await activeRoutePolicy(context);
        expect(active).toMatchObject({ version: 'route-policy.2', minimumAssociationConfidence: 0.95 });

        const history = await routePolicyHistory(context);
        expect(history.map(entry => entry.version)).toEqual(['route-policy.2', 'route-policy.1']);
        // The old version is unchanged, which is what a route that names it needs.
        expect(history[1]).toMatchObject({ minimumAssociationConfidence: 0.8 });
      });
    });

    it('refuses a version name that already exists rather than editing it', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        expect(
          await publishRoutePolicy(context, { version: 'route-policy.1', minimumAssociationConfidence: 0.5 }),
        ).toMatchObject({ ok: false, reason: 'policy_version_exists' });
      });
    });

    it('does not let a future version govern today', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        await publishRoutePolicy(context, {
          version: 'route-policy.3',
          minimumAssociationConfidence: 1,
          effectiveFrom: new Date(Date.now() + 86_400_000),
        });
        expect(await activeRoutePolicy(context)).toMatchObject({ version: 'route-policy.1' });
        expect((await routePolicyHistory(context)).map(entry => entry.version)).toContain('route-policy.3');
      });
    });

    it('cannot be edited or deleted, even by the application role', async () => {
      const runtime = await database.appRuntimeSession();
      await expect(
        runtime.query("UPDATE research_route_policies SET minimum_association_confidence = 0"),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(runtime.query('DELETE FROM research_route_policies')).rejects.toMatchObject({ code: '42501' });
    });

    it('refuses nonsense input rather than storing it', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        for (const input of [
          { version: 'Route Policy 9', minimumAssociationConfidence: 0.9 },
          { version: 'route-policy.9', minimumAssociationConfidence: 1.5 },
          { version: 'route-policy.9', minimumAssociationConfidence: 0.9, trustedSources: ['a_model'] as never },
        ]) {
          expect(await publishRoutePolicy(context, input)).toMatchObject({ ok: false, reason: 'invalid_input' });
        }
      });
    });
  });

  // ------------------------------------------------------------- discovery
  describe('discovery creates candidate firms, evidence, coordinates and zones (deliverable 1)', () => {
    it('creates unassigned firms with candidate routes and resolves the zone from coordinates', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        await enableResearch(context);
        const report = await runDiscoveryPage(context, {
          provider: recordedDiscoveryProvider(),
          query: 'property management in Nashville',
          at: AT,
        });
        expect(report).toMatchObject({ ok: true });
        if (!report.ok) return;

        expect(report.value).toMatchObject({ outcome: 'completed', firmsCreated: 3, evidenceRecorded: 3 });
        // Two of the three coordinates are inside a zone the table can place; the
        // third is in Tennessee's margin and stays unresolved.
        expect(report.value.zonesResolved).toBe(2);
        expect(report.value.zonesUnresolved).toBe(1);

        const firms = await context.db.query<{
          name: string;
          assigned_user_id: string | null;
          time_zone: string | null;
          time_zone_source: string | null;
          time_zone_unresolved_reason: string | null;
        }>(
          `SELECT name, assigned_user_id, time_zone, time_zone_source, time_zone_unresolved_reason
             FROM firms WHERE workspace_id = $1 AND id = ANY($2::uuid[]) ORDER BY name`,
          [seeded.alpha.workspaceId, [...report.value.createdFirmIds]],
        );
        expect(firms.rows).toHaveLength(3);
        // Unassigned, every one: a discovered firm belongs to nobody yet.
        expect(firms.rows.every(row => row.assigned_user_id === null)).toBe(true);
        const byName = new Map(firms.rows.map(row => [row.name, row]));
        expect(byName.get('Northgate Residential Management')).toMatchObject({
          time_zone: 'America/Denver',
          time_zone_source: 'coordinates',
        });
        expect(byName.get('Riverbend Property Group')).toMatchObject({
          time_zone: 'America/Chicago',
          time_zone_source: 'coordinates',
        });
        expect(byName.get('Seamwater Rentals')).toMatchObject({
          time_zone: null,
          time_zone_unresolved_reason: 'state_spans_zones',
        });

        // The listed numbers are candidates, never usable: a research provider is not
        // a trusted source and nothing has validated them.
        const routes = await context.db.query<{ eligibility: string; eligibility_policy_version: string | null }>(
          'SELECT eligibility, eligibility_policy_version FROM phone_routes WHERE workspace_id = $1 AND firm_id = ANY($2::uuid[])',
          [seeded.alpha.workspaceId, [...report.value.createdFirmIds]],
        );
        expect(routes.rows).toHaveLength(2);
        expect(routes.rows.every(row => row.eligibility === 'candidate')).toBe(true);
        expect(routes.rows.every(row => row.eligibility_policy_version === null)).toBe(true);

        const coordinate = await readFirmCoordinate(context, report.value.createdFirmIds[0] ?? '');
        expect(coordinate).toMatchObject({ providerKey: 'places' });
      });
    });

    it('records the page once, so a replay creates nothing twice (Appendix C)', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        await enableResearch(context);
        const calls = { count: 0 };
        const provider = recordedDiscoveryProvider({ calls });
        const first = await runDiscoveryPage(context, { provider, query: 'the same query', at: AT });
        const second = await runDiscoveryPage(context, { provider, query: 'the same query', at: AT });
        expect(first).toMatchObject({ ok: true });
        expect(second).toMatchObject({ ok: true });
        if (!first.ok || !second.ok) return;
        expect(first.value.outcome).toBe('completed');
        expect(second.value).toMatchObject({ outcome: 'already_recorded', firmsCreated: 0 });
        expect(second.value.pageHash).toBe(first.value.pageHash);
        expect(calls.count).toBe(2);

        const pages = await context.db.query<{ count: string }>(
          'SELECT count(*) AS count FROM research_pages WHERE workspace_id = $1',
          [seeded.alpha.workspaceId],
        );
        expect(Number(pages.rows[0]?.count)).toBe(1);
      });
    });

    it('skips a firm whose domain is already known rather than creating a second', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        await enableResearch(context);
        await runDiscoveryPage(context, { provider: recordedDiscoveryProvider(), query: 'first sweep', at: AT });
        const again = await runDiscoveryPage(context, {
          provider: recordedDiscoveryProvider({ nextPageToken: 'page-2' }),
          query: 'second sweep',
          at: AT,
        });
        expect(again).toMatchObject({ ok: true });
        if (!again.ok) return;
        expect(again.value.firmsCreated).toBe(0);
        expect(again.value.skipped['existing_domain']).toBe(3);
      });
    });

    it('records a provider refusal in the ledger and as a failed page', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        await enableResearch(context);
        const refused = await runDiscoveryPage(context, {
          provider: recordedDiscoveryProvider({ failureCode: 'http_rejected' }),
          query: 'a query the provider refuses',
          at: AT,
        });
        expect(refused).toMatchObject({ ok: false, reason: 'provider_refused' });

        const ledger = await readProviderLedger(context, { businessTimeZone: 'America/New_York', at: AT });
        expect(ledger.find(entry => entry.providerKey === 'places')).toMatchObject({
          calls: 1,
          failures: 1,
          lastFailureCode: 'http_rejected',
          costMicros: 32_000,
        });

        const page = await context.db.query<{ outcome: string; refusal_code: string }>(
          'SELECT outcome, refusal_code FROM research_pages WHERE workspace_id = $1',
          [seeded.alpha.workspaceId],
        );
        expect(page.rows[0]).toMatchObject({ outcome: 'failed', refusal_code: 'provider_refused' });
      });
    });

    it('prices the call before making it and refuses when the cost ceiling would break', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        await enableResearch(context, { dailyCostCeilingMicros: 10_000 });
        const calls = { count: 0 };
        const refused = await runDiscoveryPage(context, {
          provider: recordedDiscoveryProvider({ calls, costMicros: 32_000 }),
          query: 'too expensive',
          at: AT,
        });
        expect(refused).toMatchObject({ ok: false, reason: 'cost_ceiling_reached' });
        // The spend that would have broken the ceiling was never made.
        expect(calls.count).toBe(0);
      });
    });
  });

  // ------------------------------------------------------------ enrichment
  describe('enrichment adds evidence and suggestions (deliverable 1)', () => {
    const enrich = async (context: RepositoryContext, firmId: string, revision = 1) =>
      await runFirmEnrichment(context, {
        firmId,
        revision,
        pageFetch: recordedPageFetchProvider(),
        extraction: recordedExtractionProvider(),
        at: AT,
      });

    it('records the pages as evidence and the findings as suggestions, creating no route', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        await enableResearch(context);
        const discovered = await runDiscoveryPage(context, {
          provider: recordedDiscoveryProvider(),
          query: 'a sweep',
          at: AT,
        });
        expect(discovered).toMatchObject({ ok: true });
        if (!discovered.ok) return;
        const firmId = discovered.value.createdFirmIds[0] ?? '';

        const routesBefore = await context.db.query<{ count: string }>(
          'SELECT count(*) AS count FROM email_addresses WHERE workspace_id = $1 AND firm_id = $2',
          [seeded.alpha.workspaceId, firmId],
        );

        const report = await enrich(context, firmId);
        expect(report).toMatchObject({ ok: true });
        if (!report.ok) return;
        expect(report.value).toMatchObject({ outcome: 'completed', pagesFetched: 1, evidenceRecorded: 1 });
        expect(report.value.factsAdmitted).toBeGreaterThan(0);
        expect(report.value.suggestionsCreated).toBeGreaterThan(0);

        // The business email is a *suggestion*. No email route was created.
        const routesAfter = await context.db.query<{ count: string }>(
          'SELECT count(*) AS count FROM email_addresses WHERE workspace_id = $1 AND firm_id = $2',
          [seeded.alpha.workspaceId, firmId],
        );
        expect(routesAfter.rows[0]?.count).toBe(routesBefore.rows[0]?.count);

        const suggestions = await listSuggestions(context, { firmId });
        const email = suggestions.find(entry => entry.kind === 'email_route');
        expect(email).toMatchObject({
          proposedValue: 'info@northgate-residential.example.test',
          state: 'proposed',
        });
        expect(suggestions.some(entry => entry.kind === 'canonical_field')).toBe(true);
        expect(suggestions.every(entry => entry.state === 'proposed')).toBe(true);
      });
    });

    it('refuses a fact whose block the provider invented, and keeps the rest', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        await enableResearch(context);
        const discovered = await runDiscoveryPage(context, {
          provider: recordedDiscoveryProvider(),
          query: 'a sweep',
          at: AT,
        });
        if (!discovered.ok) return;
        const firmId = discovered.value.createdFirmIds[0] ?? '';
        const report = await runFirmEnrichment(context, {
          firmId,
          revision: 1,
          pageFetch: recordedPageFetchProvider(),
          extraction: recordedExtractionProvider({ returnUnknownBlock: true, returnUnknownKey: true }),
          at: AT,
        });
        expect(report).toMatchObject({ ok: true });
        if (!report.ok) return;
        expect(report.value.factsRefused).toBe(2);
        expect(report.value.factsAdmitted).toBeGreaterThan(0);
        expect(report.value.skipped['fact_unknown_block']).toBe(1);
        expect(report.value.skipped['fact_unknown_key']).toBe(1);
      });
    });

    it('keeps the pages and the evidence when the extraction provider fails', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        await enableResearch(context);
        const discovered = await runDiscoveryPage(context, {
          provider: recordedDiscoveryProvider(),
          query: 'a sweep',
          at: AT,
        });
        if (!discovered.ok) return;
        const firmId = discovered.value.createdFirmIds[0] ?? '';
        const report = await runFirmEnrichment(context, {
          firmId,
          revision: 1,
          pageFetch: recordedPageFetchProvider(),
          extraction: recordedExtractionProvider({ failureCode: 'provider_rejected' }),
          at: AT,
        });
        expect(report).toMatchObject({ ok: true });
        if (!report.ok) return;
        expect(report.value.evidenceRecorded).toBe(1);
        expect(report.value.factsAdmitted).toBe(0);
        expect(report.value.skipped['extraction_failed']).toBe(1);
        const ledger = await readProviderLedger(context, { businessTimeZone: 'America/New_York', at: AT });
        expect(ledger.find(entry => entry.providerKey === 'page_facts')).toMatchObject({
          failures: 1,
          lastFailureCode: 'provider_rejected',
        });
      });
    });

    it('is one run per revision, so a replay at the same revision does nothing again', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        await enableResearch(context);
        const discovered = await runDiscoveryPage(context, {
          provider: recordedDiscoveryProvider(),
          query: 'a sweep',
          at: AT,
        });
        if (!discovered.ok) return;
        const firmId = discovered.value.createdFirmIds[0] ?? '';

        expect(await nextFirmResearchRevision(context, firmId)).toBe(1);
        const first = await enrich(context, firmId, 1);
        expect(first).toMatchObject({ ok: true });
        const replay = await enrich(context, firmId, 1);
        expect(replay).toMatchObject({ ok: true });
        if (!replay.ok) return;
        expect(replay.value.outcome).toBe('already_recorded');
        expect(replay.value.evidenceRecorded).toBe(0);
        expect(await nextFirmResearchRevision(context, firmId)).toBe(2);

        const runs = await context.db.query<{ count: string }>(
          'SELECT count(*) AS count FROM research_firm_runs WHERE workspace_id = $1 AND firm_id = $2',
          [seeded.alpha.workspaceId, firmId],
        );
        expect(Number(runs.rows[0]?.count)).toBe(1);
      });
    });

    it('refuses a firm with no readable website rather than failing the queue', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        await enableResearch(context);
        const firm = await context.db.query<{ id: string }>(
          "INSERT INTO firms (workspace_id, name) VALUES ($1, 'No Website Test Firm') RETURNING id",
          [seeded.alpha.workspaceId],
        );
        const report = await enrich(context, firm.rows[0]?.id ?? '');
        expect(report).toMatchObject({ ok: false, reason: 'source_blocked' });
        const run = await context.db.query<{ outcome: string; refusal_code: string }>(
          'SELECT outcome, refusal_code FROM research_firm_runs WHERE workspace_id = $1 AND firm_id = $2',
          [seeded.alpha.workspaceId, firm.rows[0]?.id],
        );
        expect(run.rows[0]).toMatchObject({ outcome: 'refused', refusal_code: 'source_blocked' });
      });
    });
  });

  // ------------------------------------------- a suppressed firm is never refreshed
  describe('a suppressed firm is never refreshed (10.2, acceptance)', () => {
    const suppress = async (context: RepositoryContext, firmId: string, eventId: string): Promise<void> => {
      await context.db.query(
        `INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source)
         VALUES ($1, $2, 'firm', $3, 'e164-lower.1', 'prospect_do_not_call')`,
        [seeded.alpha.workspaceId, eventId, firmId],
      );
    };

    it('refuses the enrichment run, and records why', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        await enableResearch(context);
        await suppress(context, crm.alpha.firmId, 'suppress-alpha-1');
        expect(await isFirmSuppressed(context, crm.alpha.firmId)).toBe(true);
        expect(await firmIsResearchable(context, crm.alpha.firmId)).toMatchObject({
          ok: false,
          reason: 'firm_suppressed',
        });

        const calls = { count: 0 };
        const report = await runFirmEnrichment(context, {
          firmId: crm.alpha.firmId,
          revision: 1,
          pageFetch: recordedPageFetchProvider({ calls }),
          at: AT,
        });
        expect(report).toMatchObject({ ok: false, reason: 'firm_suppressed' });
        // No provider was touched, and no unit of the day's budget was spent.
        expect(calls.count).toBe(0);
        const ledger = await readProviderLedger(context, { businessTimeZone: 'America/New_York', at: AT });
        expect(ledger).toEqual([]);

        const run = await context.db.query<{ outcome: string; refusal_code: string }>(
          'SELECT outcome, refusal_code FROM research_firm_runs WHERE workspace_id = $1 AND firm_id = $2',
          [seeded.alpha.workspaceId, crm.alpha.firmId],
        );
        expect(run.rows[0]).toMatchObject({ outcome: 'refused', refusal_code: 'firm_suppressed' });
      });
    });

    it('refuses the enqueue too, so the job never reaches the queue', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        await enableResearch(context);
        await suppress(context, crm.alpha.firmId, 'suppress-alpha-2');
        const enqueued = await enqueueFirmEnrichment(context, context.db, {
          firmId: crm.alpha.firmId,
          providerKey: 'company_page',
          at: AT,
        });
        expect(enqueued).toMatchObject({ ok: false, reason: 'firm_suppressed' });
        const jobs = await context.db.query<{ count: string }>(
          "SELECT count(*) AS count FROM jobs WHERE workspace_id = $1 AND kind = 'research.firm'",
          [seeded.alpha.workspaceId],
        );
        expect(Number(jobs.rows[0]?.count)).toBe(0);
      });
    });

    it('does not suppress the other workspace\'s firm of the same name', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        await suppress(context, crm.alpha.firmId, 'suppress-alpha-3');
        expect(await isFirmSuppressed(context, crm.alpha.firmId)).toBe(true);
        const beta = contextOn(context.db as SessionQueryable, betaAdminScope);
        expect(await isFirmSuppressed(beta, crm.beta.firmId)).toBe(false);
      });
    });

    it('refreshes again once an admin has superseded the event', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        await suppress(context, crm.alpha.firmId, 'suppress-alpha-4');
        await context.db.query(
          `INSERT INTO suppression_events
             (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source,
              actor_user_id, supersedes_event_id, supersession_reason)
           VALUES ($1, 'supersede-alpha-4', 'firm', $2, 'e164-lower.1', 'admin_supersession',
                   $3, 'suppress-alpha-4', 'documented_reconsent')`,
          [seeded.alpha.workspaceId, crm.alpha.firmId, seeded.alpha.admin.userId],
        );
        expect(await isFirmSuppressed(context, crm.alpha.firmId)).toBe(false);
      });
    });
  });

  // ------------------------------------------------- the ceiling stops enqueues
  describe('the ceiling stops enqueues (7.4, Appendix D, acceptance)', () => {
    it('refuses to enqueue once the day\'s page ceiling is used', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        await enableResearch(context, { dailyPageCeiling: 2 });
        // Two pages consume the day's two units.
        for (const query of ['sweep one', 'sweep two']) {
          const claimed = await claimResearchClearance(context, {
            work: 'discovery_page',
            providerKey: 'places',
            at: AT,
          });
          expect(claimed, query).toMatchObject({ ok: true });
        }

        expect(await researchEnqueueAllowed(context, { work: 'discovery_page', at: AT })).toMatchObject({
          ok: false,
          reason: 'daily_ceiling_reached',
        });
        const enqueued = await enqueueDiscoveryPage(context, context.db, {
          query: 'one sweep too many',
          providerKey: 'places',
          at: AT,
        });
        expect(enqueued).toMatchObject({ ok: false, reason: 'daily_ceiling_reached' });

        const jobs = await context.db.query<{ count: string }>(
          "SELECT count(*) AS count FROM jobs WHERE workspace_id = $1 AND kind = 'research.page'",
          [seeded.alpha.workspaceId],
        );
        expect(Number(jobs.rows[0]?.count)).toBe(0);
      });
    });

    it('stops the run itself at the ceiling, before any provider call', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        await enableResearch(context, { dailyPageCeiling: 1 });
        const calls = { count: 0 };
        const provider = recordedDiscoveryProvider({ calls });
        expect(await runDiscoveryPage(context, { provider, query: 'the only one', at: AT })).toMatchObject({
          ok: true,
        });
        expect(
          await runDiscoveryPage(context, { provider, query: 'one too many', at: AT }),
        ).toMatchObject({ ok: false, reason: 'daily_ceiling_reached' });
        expect(calls.count).toBe(1);
      });
    });

    it('honours a provider\'s own ceiling before the workspace\'s', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        await enableResearch(context, { dailyPageCeiling: 50 });
        await updateProvider(context, { providerKey: 'places', patch: { dailyCallCeiling: 1 } });
        expect(
          await claimResearchClearance(context, { work: 'discovery_page', providerKey: 'places', at: AT }),
        ).toMatchObject({ ok: true });
        expect(
          await claimResearchClearance(context, { work: 'discovery_page', providerKey: 'places', at: AT }),
        ).toMatchObject({ ok: false, reason: 'provider_ceiling_reached' });
      });
    });

    it('refuses everything while research is disabled, or a provider is', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        expect(
          await claimResearchClearance(context, { work: 'discovery_page', providerKey: 'places', at: AT }),
        ).toMatchObject({ ok: false, reason: 'research_disabled' });
        await updateResearchSettings(context, { enabled: true });
        expect(
          await claimResearchClearance(context, { work: 'discovery_page', providerKey: 'places', at: AT }),
        ).toMatchObject({ ok: false, reason: 'provider_disabled' });
        expect(
          await claimResearchClearance(context, { work: 'discovery_page', providerKey: 'no_such', at: AT }),
        ).toMatchObject({ ok: false, reason: 'provider_unknown' });
      });
    });

    it('counts each workspace\'s ceiling separately', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        await enableResearch(context, { dailyPageCeiling: 1 });
        const beta = contextOn(context.db as SessionQueryable, betaAdminScope);
        await enableResearch(beta, { dailyPageCeiling: 1 });

        expect(
          await claimResearchClearance(context, { work: 'discovery_page', providerKey: 'places', at: AT }),
        ).toMatchObject({ ok: true });
        // Alpha is spent; beta's own unit is untouched.
        expect(
          await claimResearchClearance(context, { work: 'discovery_page', providerKey: 'places', at: AT }),
        ).toMatchObject({ ok: false, reason: 'daily_ceiling_reached' });
        expect(
          await claimResearchClearance(beta, { work: 'discovery_page', providerKey: 'places', at: AT }),
        ).toMatchObject({ ok: true });
      });
    });
  });

  // ----------------------------------------------------- duplicate suggestions
  describe('duplicate suggestions, never a merge (7.2, deliverable 4)', () => {
    it('suggests a duplicate on a shared domain and performs no merge', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        const twin = await context.db.query<{ id: string }>(
          `INSERT INTO firms (workspace_id, name, website, locality)
           VALUES ($1, 'Northwind Test Holdings (dup)', 'https://northwind.example.test/', 'Providence')
           RETURNING id`,
          [seeded.alpha.workspaceId],
        );
        const twinId = twin.rows[0]?.id ?? '';

        const candidates = await findDuplicateCandidates(context, { firmId: twinId });
        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toMatchObject({
          otherFirmId: crm.alpha.firmId,
          signal: 'same_domain',
          confidence: 0.9,
        });

        const enabled = await enableResearch(context);
        void enabled;
        const suggested = await listSuggestions(context, { firmId: twinId });
        expect(suggested).toEqual([]);

        const { suggestDuplicate } = await import('../../research/duplicates.ts');
        const first = candidates[0];
        expect(first).toBeDefined();
        if (first === undefined) return;
        expect(await suggestDuplicate(context, first, 'places')).toMatchObject({ ok: true });
        // Idempotent on the pair, whichever side asks.
        expect(
          await suggestDuplicate(
            context,
            { ...first, firmId: twinId, otherFirmId: crm.alpha.firmId },
            'places',
          ),
        ).toMatchObject({ ok: true });

        const rows = await context.db.query<{ count: string }>(
          "SELECT count(*) AS count FROM research_suggestions WHERE workspace_id = $1 AND kind = 'duplicate_firm'",
          [seeded.alpha.workspaceId],
        );
        expect(Number(rows.rows[0]?.count)).toBe(1);

        // Nothing merged. Both firms are still active and separate.
        const statuses = await context.db.query<{ status: string }>(
          'SELECT status FROM firms WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
          [seeded.alpha.workspaceId, [twinId, crm.alpha.firmId]],
        );
        expect(statuses.rows.map(row => row.status)).toEqual(['active', 'active']);
      });
    });

    it('accepting a duplicate suggestion still does not merge anything', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        const twin = await context.db.query<{ id: string }>(
          `INSERT INTO firms (workspace_id, name, website)
           VALUES ($1, 'Northwind Test Holdings (dup 2)', 'https://northwind.example.test/')
           RETURNING id`,
          [seeded.alpha.workspaceId],
        );
        const twinId = twin.rows[0]?.id ?? '';
        const { suggestDuplicate } = await import('../../research/duplicates.ts');
        const candidates = await findDuplicateCandidates(context, { firmId: twinId });
        const first = candidates[0];
        if (first === undefined) return;
        const suggested = await suggestDuplicate(context, first, 'places');
        expect(suggested).toMatchObject({ ok: true });
        if (!suggested.ok) return;

        const reviewed = await reviewSuggestion(context, {
          suggestionId: suggested.value.id,
          decision: 'accepted',
          note: 'Same firm, I will merge them.',
        });
        expect(reviewed).toMatchObject({ ok: true, value: { state: 'accepted', fieldWritten: false } });

        const statuses = await context.db.query<{ status: string }>(
          'SELECT status FROM firms WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
          [seeded.alpha.workspaceId, [twinId, crm.alpha.firmId]],
        );
        expect(statuses.rows.map(row => row.status)).toEqual(['active', 'active']);
        expect(
          await reviewSuggestion(context, { suggestionId: suggested.value.id, decision: 'rejected' }),
        ).toMatchObject({ ok: false, reason: 'suggestion_already_reviewed' });
      });
    });

    it('refuses a system actor the review, because a review is a person\'s', async () => {
      await inRolledBackTransaction(workerScope, async context => {
        const { suggestDuplicate } = await import('../../research/duplicates.ts');
        const twin = await context.db.query<{ id: string }>(
          `INSERT INTO firms (workspace_id, name, website)
           VALUES ($1, 'Northwind Test Holdings (dup 3)', 'https://northwind.example.test/')
           RETURNING id`,
          [seeded.alpha.workspaceId],
        );
        const twinId = twin.rows[0]?.id ?? '';
        const candidates = await findDuplicateCandidates(context, { firmId: twinId });
        const first = candidates[0];
        if (first === undefined) return;
        const suggested = await suggestDuplicate(context, first, 'places');
        if (!suggested.ok) return;
        expect(
          await reviewSuggestion(context, { suggestionId: suggested.value.id, decision: 'accepted' }),
        ).toMatchObject({ ok: false, reason: 'admin_only' });
      });
    });
  });

  // ----------------------------------------------------- suggestions and fills
  describe('suggestions never overwrite a confirmed value (7.4)', () => {
    it('fills an empty canonical field from a high-confidence fact and audits it', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        const { recordSuggestion } = await import('../../research/suggestions.ts');
        const firm = await context.db.query<{ id: string }>(
          "INSERT INTO firms (workspace_id, name) VALUES ($1, 'Empty Fields Test Firm') RETURNING id",
          [seeded.alpha.workspaceId],
        );
        const firmId = firm.rows[0]?.id ?? '';
        const recorded = await recordSuggestion(context, {
          firmId,
          kind: 'canonical_field',
          fieldKey: 'locality',
          proposedValue: 'Nashville',
          confidence: 0.95,
          providerKey: 'places',
          dedupeKey: 'locality:page-1',
        });
        expect(recorded).toMatchObject({ ok: true, value: { state: 'applied', applied: true } });

        const row = await context.db.query<{ locality: string }>(
          'SELECT locality FROM firms WHERE workspace_id = $1 AND id = $2',
          [seeded.alpha.workspaceId, firmId],
        );
        expect(row.rows[0]?.locality).toBe('Nashville');

        const audit = await context.db.query<{ action: string }>(
          "SELECT action FROM audit_events WHERE workspace_id = $1 AND subject_id = $2 AND action = 'research.canonical_field_filled'",
          [seeded.alpha.workspaceId, firmId],
        );
        expect(audit.rows).toHaveLength(1);
      });
    });

    it('proposes rather than overwrites when the field already has a value', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        const { recordSuggestion } = await import('../../research/suggestions.ts');
        const recorded = await recordSuggestion(context, {
          firmId: crm.alpha.firmId,
          kind: 'canonical_field',
          fieldKey: 'locality',
          proposedValue: 'Somewhere Else',
          confidence: 1,
          providerKey: 'places',
          dedupeKey: 'locality:page-1',
        });
        expect(recorded).toMatchObject({ ok: true, value: { state: 'proposed', applied: false } });
        const row = await context.db.query<{ locality: string }>(
          'SELECT locality FROM firms WHERE workspace_id = $1 AND id = $2',
          [seeded.alpha.workspaceId, crm.alpha.firmId],
        );
        // The seeded value survives.
        expect(row.rows[0]?.locality).toBe('Providence');
      });
    });

    it('lets a person accept an overwrite, and audits that it replaced a value', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        const { recordSuggestion } = await import('../../research/suggestions.ts');
        const recorded = await recordSuggestion(context, {
          firmId: crm.alpha.firmId,
          kind: 'canonical_field',
          fieldKey: 'locality',
          proposedValue: 'Pawtucket',
          confidence: 0.5,
          providerKey: 'places',
          dedupeKey: 'locality:page-2',
        });
        expect(recorded).toMatchObject({ ok: true });
        if (!recorded.ok) return;
        const reviewed = await reviewSuggestion(context, {
          suggestionId: recorded.value.id,
          decision: 'accepted',
        });
        expect(reviewed).toMatchObject({ ok: true, value: { fieldWritten: true } });
        const row = await context.db.query<{ locality: string }>(
          'SELECT locality FROM firms WHERE workspace_id = $1 AND id = $2',
          [seeded.alpha.workspaceId, crm.alpha.firmId],
        );
        expect(row.rows[0]?.locality).toBe('Pawtucket');
        const audit = await context.db.query<{ detail: { replacedExistingValue?: boolean } }>(
          "SELECT detail FROM audit_events WHERE workspace_id = $1 AND action = 'research.suggestion_field_written'",
          [seeded.alpha.workspaceId],
        );
        expect(audit.rows[0]?.detail.replacedExistingValue).toBe(true);
      });
    });

    it('shows a salesperson only their assigned firms\' suggestions', async () => {
      await inRolledBackTransaction(adminScope, async context => {
        const { recordSuggestion } = await import('../../research/suggestions.ts');
        const unassigned = await context.db.query<{ id: string }>(
          "INSERT INTO firms (workspace_id, name) VALUES ($1, 'Unassigned Test Firm') RETURNING id",
          [seeded.alpha.workspaceId],
        );
        for (const firmId of [crm.alpha.firmId, unassigned.rows[0]?.id ?? '']) {
          await recordSuggestion(context, {
            firmId,
            kind: 'contact',
            proposedValue: 'Someone Example',
            providerKey: 'page_facts',
            dedupeKey: 'contact:1',
          });
        }
        const asAdmin = await listSuggestions(context);
        const asSalesperson = await listSuggestions(
          contextOn(context.db as SessionQueryable, salespersonScope),
        );
        expect(asAdmin.length).toBeGreaterThan(asSalesperson.length);
        expect(asSalesperson.every(entry => entry.firmId === crm.alpha.firmId)).toBe(true);
      });
    });
  });

  // ------------------------------------------------------------ scenario 37
  describe('merge under concurrent research enrichment (Appendix G 37)', () => {
    let twinId = '';

    beforeEach(async () => {
      // The same website as the target, so the merge has no canonical conflict to
      // refuse: this case is about the lock order, not about conflict resolution.
      const twin = await session.query<{ id: string }>(
        `INSERT INTO firms (workspace_id, name, website, assigned_user_id)
         VALUES ($1, $2, 'https://northwind.example.test', $3) RETURNING id`,
        [seeded.alpha.workspaceId, `Scenario 37 Firm ${String(Date.now())}`, seeded.alpha.salesperson.userId],
      );
      twinId = twin.rows[0]?.id ?? '';
    });

    it('serializes: the merge waits for the enrichment and carries its rows over', async () => {
      const enriching = await database.appRuntimeSession();
      const merging = await database.appRuntimeSession();
      const enrichContext = contextOn(enriching, adminScope);
      const mergeContext = contextOn(merging, adminScope);

      await enriching.query('BEGIN');
      await merging.query('BEGIN');
      try {
        await enableResearch(enrichContext);
        // The enrichment's own inserts hold FOR KEY SHARE on the firm row.
        const suggestions = await import('../../research/suggestions.ts');
        const recorded = await suggestions.recordSuggestion(enrichContext, {
          firmId: twinId,
          kind: 'contact',
          proposedValue: 'Concurrent Example',
          providerKey: 'page_facts',
          dedupeKey: 'contact:concurrent',
        });
        expect(recorded).toMatchObject({ ok: true });

        // The merge takes the source firm's row lock first, so it blocks here until
        // the enrichment commits.
        const mergeAttempt = mergeFirms(mergeContext, { sourceFirmId: twinId, targetFirmId: crm.alpha.firmId });
        let settled = false;
        void mergeAttempt.then(() => {
          settled = true;
        });
        // Long enough for the blocked `SELECT ... FOR UPDATE` to have been sent and
        // to be waiting, short enough that a real deadlock still fails the test.
        await new Promise(resolve => setTimeout(resolve, 200));
        expect(settled, 'the merge should be waiting for the enrichment to commit').toBe(false);

        await enriching.query('COMMIT');
        const merged = await mergeAttempt;
        expect(merged, JSON.stringify(merged)).toMatchObject({ ok: true });
        // A merge is a canonical decision, so an identical website is not a conflict;
        // a *different* one would refuse and ask a person, which is G3a's contract.
        await merging.query('COMMIT');

        // The suggestion survived the merge. `mergeFirms` does not know about this
        // table, so the row stays on the source — which is what
        // docs/decisions/g3a-merge-preservation.md does with everything it cannot
        // move — and the read follows the merge pointer to the target instead.
        const rows = await session.query<{ firm_id: string; kind: string }>(
          "SELECT firm_id, kind FROM research_suggestions WHERE workspace_id = $1 AND dedupe_key = 'contact:concurrent'",
          [seeded.alpha.workspaceId],
        );
        expect(rows.rows).toHaveLength(1);
        expect(rows.rows[0]?.firm_id).toBe(twinId);

        const underTarget = await listSuggestions(contextOn(session, adminScope), {
          firmId: crm.alpha.firmId,
        });
        expect(underTarget.map(entry => entry.proposedValue)).toContain('Concurrent Example');

        // And it is still reviewable: the review authorizes against the firm the
        // source became, not the merged record.
        const suggestionId = underTarget.find(entry => entry.proposedValue === 'Concurrent Example')?.id ?? '';
        const reviewed = await reviewSuggestion(contextOn(session, adminScope), {
          suggestionId,
          decision: 'rejected',
        });
        expect(reviewed).toMatchObject({ ok: true });
      } finally {
        await enriching.query('ROLLBACK').catch(() => undefined);
        await merging.query('ROLLBACK').catch(() => undefined);
        await session.query('DELETE FROM research_suggestions WHERE workspace_id = $1', [
          seeded.alpha.workspaceId,
        ]);
      }
    });

    it('refuses the enrichment that arrives after the merge', async () => {
      await session.query(
        `UPDATE firms SET status = 'merged', merged_into_firm_id = $3 WHERE workspace_id = $1 AND id = $2`,
        [seeded.alpha.workspaceId, twinId, crm.alpha.firmId],
      );
      await inRolledBackTransaction(adminScope, async context => {
        await enableResearch(context);
        expect(await firmIsResearchable(context, twinId)).toMatchObject({ ok: false, reason: 'firm_merged' });
        expect(
          await runFirmEnrichment(context, {
            firmId: twinId,
            revision: 1,
            pageFetch: recordedPageFetchProvider(),
            at: AT,
          }),
        ).toMatchObject({ ok: false, reason: 'firm_merged' });
      });
      await session.query(
        `UPDATE firms SET status = 'active', merged_into_firm_id = NULL WHERE workspace_id = $1 AND id = $2`,
        [seeded.alpha.workspaceId, twinId],
      );
    });
  });
});
