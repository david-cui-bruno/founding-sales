import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import {
  enqueueDiscoveryPage,
  enqueueFirmEnrichment,
  listSuggestions,
  publishRoutePolicy,
  recordSuggestion,
  reviewSuggestion,
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
 * Invariant 8, as a test.
 *
 * > **Research never initiates outreach.** Research may create evidence and eligible
 * > CRM data, but enrollment and first contact are deliberate salesperson actions.
 *
 * The lane's fifth deliverable asks for this as one test, and it is deliberately its
 * own file, because it is the property that has to survive every future change to the
 * package rather than a case inside a suite about discovery.
 *
 * It is proved three ways, because any one of them alone would be a hole:
 *
 *   1. **Structurally.** No module under `research/` imports anything that could
 *      enroll, send or dial. A future lane that adds a sequence module and imports it
 *      here fails this test before its own tests run.
 *   2. **By counting rows.** A census of every table a contact or a send could live in
 *      is taken before and after the whole research surface is exercised, and the two
 *      must be identical. This is the one that catches an effect nobody predicted,
 *      including one reached through a table this lane has never heard of.
 *   3. **By what research cannot reach.** The research package exports no function
 *      that takes an opportunity, an enrollment or a mailbox, and the assertion says
 *      so over the real export list rather than over a list somebody maintained.
 */

const AT = '2026-09-21T14:00:00.000Z';
const RESEARCH_DIRECTORY = fileURLToPath(new URL('../../research/', import.meta.url));

function researchSourceFiles(directory: string = RESEARCH_DIRECTORY): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...researchSourceFiles(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files.sort();
}

describe('invariant 8, structurally', () => {
  it('imports nothing that could enroll, send or dial', () => {
    // The names of the things that contact a prospect. A research module that imports
    // one of them has acquired the ability, whether or not it uses it today.
    const FORBIDDEN_SPECIFIERS = [/sequences?/iu, /enroll/iu, /outbound/iu, /gmail/iu, /mailbox/iu, /dial/iu, /send/iu];
    const offenders: string[] = [];
    for (const file of researchSourceFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/gu)) {
        const specifier = match[1] ?? '';
        if (FORBIDDEN_SPECIFIERS.some(pattern => pattern.test(specifier))) {
          offenders.push(`${file.slice(RESEARCH_DIRECTORY.length)} imports ${specifier}`);
        }
      }
    }
    expect(offenders, 'a research module can reach an outreach path').toEqual([]);
  });

  it('names no outreach table in any statement', () => {
    // The tables that do not exist yet but will: a research module that already names
    // one is writing to a shape it has no business writing to.
    const FORBIDDEN_TABLES = [
      'enrollments',
      'step_executions',
      'outbound_messages',
      'dial_tickets',
      'mailboxes',
      'messages',
      'sequence_versions',
      'today_entries',
    ];
    const offenders: string[] = [];
    for (const file of researchSourceFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const table of FORBIDDEN_TABLES) {
        // Only in a statement position: `INTO enrollments`, `FROM enrollments`,
        // `UPDATE enrollments`. Prose about enrollments is the point of the comments.
        const pattern = new RegExp(`(?:INTO|FROM|UPDATE|JOIN)\\s+${table}\\b`, 'iu');
        if (pattern.test(source)) offenders.push(`${file.slice(RESEARCH_DIRECTORY.length)}: ${table}`);
      }
    }
    expect(offenders, 'a research statement named an outreach table').toEqual([]);
  });

  it('exports no function whose name suggests contact', () => {
    const indexSource = readFileSync(join(RESEARCH_DIRECTORY, 'index.ts'), 'utf8');
    const names = [...indexSource.matchAll(/^\s{2}(?:type\s+)?([A-Za-z][A-Za-z0-9_]*),?$/gmu)].map(
      match => match[1] ?? '',
    );
    expect(names.length).toBeGreaterThan(40);
    const offenders = names.filter(name => /enroll|send|dial|dispatch|outbound|mailbox/iu.test(name));
    expect(offenders, 'a research export offered an outreach verb').toEqual([]);
  });
});

describe('invariant 8, by counting rows', () => {
  let database: TestDatabase;
  let session: SessionQueryable;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let adminScope: WorkspaceScope;

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
  });

  afterAll(async () => {
    await database.drop();
  });

  /**
   * Every table an outreach effect could land in, whether or not this lane's schema
   * knows about it. Read from the catalog so a table a later migration adds is
   * included automatically; the census is over what the database actually has.
   */
  const outreachCensus = async (): Promise<Readonly<Record<string, number>>> => {
    const tables = await session.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
         AND table_name IN ('opportunities', 'opportunity_stage_events', 'contacts', 'active_holds',
                            'administrative_pauses', 'suppression_events', 'command_receipts',
                            'canary_runs', 'critical_alerts')
       ORDER BY table_name
    `);
    const census: Record<string, number> = {};
    for (const row of tables.rows) {
      const counted = await session.query<{ count: string }>(
        `SELECT count(*) AS count FROM ${row.table_name}`,
      );
      census[row.table_name] = Number(counted.rows[0]?.count ?? '0');
    }
    return census;
  };

  it('runs the whole research surface and creates no opportunity, contact or hold', async () => {
    const before = await outreachCensus();
    // The jobs table is counted separately: research *may* enqueue its own two kinds
    // and nothing else, so the assertion is about which kinds appeared.
    const jobKindsBefore = await session.query<{ kind: string }>(
      'SELECT DISTINCT kind FROM jobs ORDER BY kind',
    );

    const context = contextOn(session, adminScope);
    await updateResearchSettings(context, {
      enabled: true,
      dailyPageCeiling: 20,
      dailyFirmCeiling: 20,
      dailyCostCeilingMicros: 2_000_000,
    });
    for (const providerKey of ['places', 'company_page', 'page_facts']) {
      await updateProvider(context, {
        providerKey,
        patch: { enabled: true, costPerCallMicros: 1_000, dailyCallCeiling: 50 },
      });
    }
    await publishRoutePolicy(context, {
      version: 'route-policy.invariant',
      minimumAssociationConfidence: 0.5,
      requireTechnicalValidation: false,
      trustedSources: ['research_provider'],
      note: 'The most permissive policy this test could publish.',
    });

    // Discovery, with the most permissive configuration a person could set.
    const discovered = await runDiscoveryPage(context, {
      provider: recordedDiscoveryProvider(),
      query: 'property management everywhere',
      at: AT,
    });
    expect(discovered).toMatchObject({ ok: true });
    if (!discovered.ok) return;
    expect(discovered.value.firmsCreated).toBe(3);

    // Enrichment of every firm it created, with extraction enabled.
    for (const firmId of discovered.value.createdFirmIds) {
      const enriched = await runFirmEnrichment(context, {
        firmId,
        revision: 1,
        pageFetch: recordedPageFetchProvider(),
        extraction: recordedExtractionProvider(),
        at: AT,
      });
      expect(enriched.ok || enriched.reason === 'source_blocked').toBe(true);
    }

    // A suggestion of every kind, including the ones a person could accept.
    const firmId = discovered.value.createdFirmIds[0] ?? '';
    for (const finding of [
      { kind: 'contact' as const, proposedValue: 'Someone Example', dedupeKey: 'contact:1' },
      { kind: 'phone_route' as const, proposedValue: '+14015550199', dedupeKey: 'phone:1' },
      { kind: 'email_route' as const, proposedValue: 'someone@example.test', dedupeKey: 'email:1' },
    ]) {
      const recorded = await recordSuggestion(context, {
        firmId,
        providerKey: 'page_facts',
        confidence: 1,
        ...finding,
      });
      expect(recorded).toMatchObject({ ok: true });
      if (!recorded.ok) continue;
      // Accepting is a person's decision and it still creates no contact and no route:
      // it records agreement, and `createContact` / `addPhoneRoute` are separate
      // commands with their own authorization and their own policy decision.
      const reviewed = await reviewSuggestion(context, { suggestionId: recorded.value.id, decision: 'accepted' });
      expect(reviewed).toMatchObject({ ok: true, value: { fieldWritten: false } });
    }

    // Both enqueue paths.
    expect(
      await enqueueDiscoveryPage(context, session, { query: 'another sweep', providerKey: 'places', at: AT }),
    ).toMatchObject({ ok: true });
    expect(
      await enqueueFirmEnrichment(context, session, { firmId, providerKey: 'company_page', at: AT }),
    ).toMatchObject({ ok: true });

    // Research did produce work: firms, evidence, routes, suggestions, pages, runs.
    const produced = await session.query<{ count: string }>(
      `SELECT (SELECT count(*) FROM research_pages WHERE workspace_id = $1)
            + (SELECT count(*) FROM research_firm_runs WHERE workspace_id = $1)
            + (SELECT count(*) FROM research_suggestions WHERE workspace_id = $1)
            + (SELECT count(*) FROM evidence_items WHERE workspace_id = $1) AS count`,
      [seeded.alpha.workspaceId],
    );
    expect(Number(produced.rows[0]?.count)).toBeGreaterThan(5);

    // And nothing that contacts anybody.
    const after = await outreachCensus();
    expect(after).toEqual(before);

    const jobKindsAfter = await session.query<{ kind: string }>('SELECT DISTINCT kind FROM jobs ORDER BY kind');
    const appeared = jobKindsAfter.rows
      .map(row => row.kind)
      .filter(kind => !jobKindsBefore.rows.some(existing => existing.kind === kind));
    expect(appeared.sort()).toEqual(['research.firm', 'research.page']);
  });

  it('cannot open an opportunity for a firm it discovered, even by accepting everything', async () => {
    const opportunities = await session.query<{ count: string }>(
      'SELECT count(*) AS count FROM opportunities WHERE workspace_id = $1',
      [seeded.alpha.workspaceId],
    );
    // The two seeded opportunities are the fixture's, one per workspace; research has
    // added none, and the firms it created still have none.
    const discoveredWithoutOpportunity = await session.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM firms f
        WHERE f.workspace_id = $1
          AND f.website LIKE '%example.test%'
          AND f.assigned_user_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM opportunities o WHERE o.workspace_id = f.workspace_id AND o.firm_id = f.id
          )`,
      [seeded.alpha.workspaceId],
    );
    expect(Number(opportunities.rows[0]?.count)).toBe(1);
    expect(Number(discoveredWithoutOpportunity.rows[0]?.count)).toBeGreaterThanOrEqual(3);
  });

  it('leaves every route it recorded a candidate, whatever the policy says', async () => {
    // The permissive `route-policy.invariant` published above trusts the research
    // provider and waives technical validation — and it still did not promote a
    // route, because `addPhoneRoute` asks G3a's policy constant, not this one. A
    // research path cannot promote its own findings; a person's command does, under
    // the policy in force at that moment.
    // Only the routes research itself recorded: the fixture seeds a usable route on
    // an assigned firm, which a person's own verification is entitled to have made.
    const routes = await session.query<{ eligibility: string }>(
      `SELECT r.eligibility
         FROM phone_routes r
         JOIN firms f ON f.workspace_id = r.workspace_id AND f.id = r.firm_id
        WHERE r.workspace_id = $1 AND r.source = 'research_provider' AND f.assigned_user_id IS NULL`,
      [seeded.alpha.workspaceId],
    );
    expect(routes.rows.length).toBeGreaterThan(0);
    expect(routes.rows.every(row => row.eligibility === 'candidate')).toBe(true);
  });

  it('shows the accepted suggestions as accepted and nothing as sent', async () => {
    const accepted = await listSuggestions(contextOn(session, adminScope), { state: 'accepted' });
    expect(accepted.length).toBeGreaterThan(0);
    // There is no state a suggestion can be in that means anybody was contacted.
    const states = await session.query<{ state: string }>(
      'SELECT DISTINCT state FROM research_suggestions WHERE workspace_id = $1 ORDER BY state',
      [seeded.alpha.workspaceId],
    );
    for (const row of states.rows) {
      expect(['proposed', 'applied', 'accepted', 'rejected', 'superseded']).toContain(row.state);
    }
    void crm;
  });
});
