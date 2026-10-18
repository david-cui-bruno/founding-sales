import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { databaseNow } from '../../policy/clock.ts';
import { listFirmFacts, readCallBrief, readFirmJudgments } from '../../research/brief.ts';
import { runFirmResearch } from '../../research/enrichment.ts';
import type { FactSelection } from '../../research/facts.ts';
import type { ExtractionProvider, PageFetchProvider } from '../../research/providers.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';

// Real migrated PostgreSQL, synthetic page/extraction ports only. Never calls a provider.
const URL = 'https://northwind.example.test/';
const COMPANY = 'We manage residential property for owners.';
const MAINTENANCE = 'Our maintenance team handles every work order.';
const PERSON = 'Dana Example is the Operations Lead.';
const HOME = `<p>${COMPANY}</p><p>${MAINTENANCE}</p><p>${PERSON}</p>`;
const SUGGESTIONS = {
  questions: ['How do your 900 units use AppFolio?', 'Does your Texas office handle repairs?'],
  opening: 'I saw you manage 900 units on AppFolio in Texas.',
  generated: true,
};

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let context: RepositoryContext;
let at: string;

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
  context = repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }),
    database.session,
  );
});

beforeEach(async () => {
  await database.session.query('BEGIN');
  at = await databaseNow(context);
});
afterEach(async () => { await database.session.query('ROLLBACK'); });
afterAll(async () => { await database.drop(); });

const selection = (key: string, blockId: string): FactSelection => ({ key, blockId, sourceReference: URL });

async function run(selections: readonly FactSelection[], html = HOME) {
  const pageFetch: PageFetchProvider = {
    providerKey: 'company_page',
    fetchPages: async () => ({
      ok: true,
      costCents: 0,
      value: {
        pages: [{
          url: URL,
          contentHash: createHash('sha256').update(html).digest('hex'),
          contentType: 'text/html',
          body: new TextEncoder().encode(html),
          retrievedAt: at,
          firstParty: true,
        }],
        skipped: {},
      },
    }),
  };
  const extraction: ExtractionProvider = {
    providerKey: 'anthropic_extraction',
    countInputTokens: async () => 100,
    extract: async () => ({
      ok: true,
      costCents: 1,
      value: {
        selections,
        questions: [SUGGESTIONS.questions[0] ?? '', SUGGESTIONS.questions[1] ?? ''],
        opening: SUGGESTIONS.opening,
        modelName: 'claude-haiku-4-5',
        inputTokens: 100,
        outputTokens: 100,
      },
    }),
  };
  const outcome = await runFirmResearch(context, {
    firmId: crm.alpha.firmId, revision: 1, trigger: 'sweep', at, pageFetch, extraction,
  });
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error(`Synthetic research refused: ${outcome.reason}`);
  expect(outcome.value.outcome).toBe('completed');
  return outcome.value;
}

async function expectNoSuggestions() {
  const brief = await readCallBrief(context, crm.alpha.firmId);
  expect(brief).not.toBeNull();
  expect(brief).toMatchObject({ opening: null, questions: null, generated: false });
  expect(JSON.stringify(brief)).not.toMatch(/900|AppFolio|Texas/);
  return brief;
}

describe('grounded call brief persistence and historical reads', () => {
  it.each([
    { name: 'no selections', selections: [], refused: 0, html: HOME },
    { name: 'unknown block', selections: [selection('target_fit', 'absent')], refused: 1, html: HOME },
    { name: 'unknown key', selections: [selection('invented', 'b1')], refused: 1, html: HOME },
    {
      name: 'overlong quote', selections: [selection('target_fit', 'b1')], refused: 1,
      html: `<p>${'We manage property for owners. '.repeat(30)}</p>`,
    },
  ])('does not persist suggestions when $name leaves no accepted facts', async ({ selections, refused, html }) => {
    const report = await run(selections, html);
    expect(report.factsRecorded).toBe(0);
    expect(report.factsRefused).toBe(refused);
    const stored = await database.session.query<{ brief: unknown; extraction: string; facts_recorded: number }>(
      'SELECT brief, extraction, facts_recorded FROM research_runs WHERE id = $1', [report.runId],
    );
    expect(stored.rows).toEqual([{ brief: null, extraction: 'used', facts_recorded: 0 }]);
    const brief = await expectNoSuggestions();
    expect(brief?.whyFit).toEqual([]);
    expect(brief?.whatChanged).toEqual([]);
    expect(brief?.sources).toEqual([]);
    expect(await listFirmFacts(context, crm.alpha.firmId)).toEqual([]);
  });

  it('preserves exact company quotes, sources and judgments without persisting unrelated claims', async () => {
    const report = await run([selection('target_fit', 'b1'), selection('maintenance_workflow', 'b2')]);
    expect(report.factsRecorded).toBe(2);
    const stored = await database.session.query<{ brief: unknown }>(
      'SELECT brief FROM research_runs WHERE id = $1', [report.runId],
    );
    expect(stored.rows).toEqual([{ brief: null }]);
    const brief = await expectNoSuggestions();
    expect(brief?.whyFit).toEqual([COMPANY, MAINTENANCE].map(quote => ({
      quote, sourceReference: URL, retrievedAt: at, firstParty: true, attribution: null,
    })));
    expect(brief?.sources).toEqual([{ sourceReference: URL, retrievedAt: at }]);
    expect(brief?.judgments).toMatchObject({ fit: 'yes', problemEvidence: 'yes' });
    expect(await readCallBrief(context, crm.beta.firmId)).toBeNull();
  });

  it('keeps person facts quote-free and separate from company quotations', async () => {
    const report = await run([selection('target_fit', 'b1'), selection('named_role', 'b3')]);
    expect(report.factsRecorded).toBe(2);
    const facts = await listFirmFacts(context, crm.alpha.firmId);
    expect(facts.find(fact => fact.key === 'named_role')?.quote).toBeNull();
    expect(JSON.stringify(facts)).not.toContain(PERSON);
    const brief = await expectNoSuggestions();
    expect(brief?.whyFit.map(quote => quote.quote)).toEqual([COMPANY]);
    expect(brief?.sources).toEqual([{ sourceReference: URL, retrievedAt: at }]);
    expect((await readFirmJudgments(context, crm.alpha.firmId))?.reachability).toBe('yes');
  });

  it.each([false, true])('hides historical suggestions with company evidence=%s without rewriting history', async hasFacts => {
    const report = await run(hasFacts ? [selection('target_fit', 'b1')] : []);
    await database.session.query('UPDATE research_runs SET brief = $2::jsonb WHERE id = $1', [
      report.runId, JSON.stringify(SUGGESTIONS),
    ]);
    const brief = await expectNoSuggestions();
    expect(brief?.whyFit.map(quote => quote.quote)).toEqual(hasFacts ? [COMPANY] : []);
    const stored = await database.session.query<{ brief: unknown }>(
      'SELECT brief FROM research_runs WHERE id = $1', [report.runId],
    );
    expect(stored.rows).toEqual([{ brief: SUGGESTIONS }]);
  });
});
