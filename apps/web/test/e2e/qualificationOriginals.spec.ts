import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright/test';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { saveCandidate } from '@fss/domain/sourcing/candidates.ts';
import { finishQualification, QUALIFICATION_POLICY_VERSION, QUALIFICATION_PROMPT_VERSION } from '@fss/domain/sourcing/qualificationStore.ts';
import { test, expect, startQualifiedResearchApp, routeQualifiedResearchProvider, loginQualifiedResearch } from '../support/qualifiedResearchApp.ts';

let owned: Awaited<ReturnType<typeof startQualifiedResearchApp>>;
let candidateId: string;
const runId = randomUUID(), observationId = randomUUID(), partialId = randomUUID();
const captured = new Date().toISOString();
const hostile = '<img src="https://never-fetch.example.test/retained-pixel" onerror="alert(1)"><script>alert(2)</script> & original capture';
const original = 'Synthetic retained original label. This is not a verified business identity.';
const inventory = (page: Page) => page.getByRole('region', { name: 'Ordinary sourcing inventory', exact: true });
const card = (page: Page) => inventory(page).getByRole('article', { name: `Candidate ${candidateId}`, exact: true });
const show = (page: Page, id = observationId) => card(page).getByRole('button', { name: `Show captured original blocks for observation ${id}`, exact: true });
async function load(page: Page) {
  const response = page.waitForResponse(r => r.url().endsWith('/browser/api/sourcing/candidates/list'));
  await inventory(page).getByRole('button', { name: 'Load ordinary inventory', exact: true }).click();
  expect((await response).status()).toBe(200);
}
async function read(page: Page) {
  const response = page.waitForResponse(r => r.url().endsWith('/browser/api/sourcing/qualification/read'));
  await card(page).getByRole('button', { name: 'Read qualification', exact: true }).click();
  const answer = await response;
  expect(answer.status()).toBe(200); expect(answer.headers()['cache-control']).toContain('no-store');
  expect(await answer.json()).toMatchObject({ candidateId, runId, status: 'unavailable', reason: 'invalid_evidence', facts: [], verdict: null });
  await expect(card(page)).toContainText('No current verdict.');
}
async function unchangedState() {
  const db = owned.app.fixture.db;
  const tables = ['sourcing_candidates', 'sourcing_qualification_runs', 'sourcing_admissions', 'provider_reservations', 'jobs', 'firms', 'contacts', 'sequence_enrollments', 'outbound_messages'];
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = (await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return result;
}

test.beforeAll(async () => {
  assert.equal(process.env['FSS_RETAINED_ORIGINALS_EXCLUSIVE_LANE'], 'issue757-retained-read', 'Root sole disposable PG/Chrome lane grant required');
  owned = await startQualifiedResearchApp();
  const f = owned.app.fixture;
  const ctx = repositoryContext(workspaceScope(f.alpha.workspaceId, { kind: 'user', userId: f.alpha.admin.userId, role: 'admin' }), f.db);
  const saved = await withTransaction(f.db, () => saveCandidate(ctx, { firmName: 'Controlled Retained Originals Search Heading', website: 'https://never-fetch.example.test/',
    locality: 'Dallas', region: 'TX', signal: 'fit_only', evidence: 'Controlled unavailable original capture, not accepted facts.', sourceUrl: 'https://never-fetch.example.test/',
    observedOn: new Date().toISOString().slice(0, 10), preparedBy: 'Controlled retained-only browser acceptance' }));
  assert(saved.ok); candidateId = saved.value.id;
  // Fixture-only retained run creation. Never invoke requestQualification, a qualifier or a provider.
  await f.db.query(`INSERT INTO sourcing_qualification_runs(workspace_id,id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name)
    VALUES($1,$2,$3,1,$4,$5,$6,'controlled-no-provider-fixture')`, [f.alpha.workspaceId, runId, candidateId, 'f'.repeat(64), QUALIFICATION_PROMPT_VERSION, QUALIFICATION_POLICY_VERSION]);
  const finished = await withTransaction(f.db, () => finishQualification(ctx, { runId, reason: 'invalid_evidence', facts: [], observations: [
    { id: observationId, url: 'https://never-fetch.example.test/', contentHash: 'a'.repeat(64), relevantTextHash: 'b'.repeat(64), retrievedAt: captured,
      publishedAt: null, publishedAtBlockId: null, firstParty: true, truncated: false, blocks: [{ id: 'retained-label', text: original }, { id: 'hostile-markup', text: hostile }] },
    { id: partialId, url: 'https://never-fetch.example.test/partial', contentHash: 'c'.repeat(64), relevantTextHash: 'd'.repeat(64), retrievedAt: captured,
      publishedAt: null, publishedAtBlockId: null, firstParty: false, truncated: true, blocks: [{ id: 'partial-capture', text: 'Synthetic partial retained original' }] },
  ] }));
  assert(finished.ok);
});
test.afterAll(async () => { await owned?.stop(); });

test('new retained-only browser journey discloses empty-fact originals without fetches, writes or unsafe markup and clears on refresh/logout/late read', async ({ researchPage: page }) => {
  await routeQualifiedResearchProvider(page, owned.app);
  const external: string[] = [], mutations: string[] = [], dialogs: string[] = [];
  let reads = 0;
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== owned.app.origin) external.push(url.origin);
    if (url.pathname === '/browser/api/sourcing/qualification/read') reads += 1;
    if (/\/sourcing\/(?:qualification\/(?:request|admit)|candidates\/(?:save|correct-name|check|review|delete))$/u.test(url.pathname)) mutations.push(url.pathname);
  });
  page.on('dialog', dialog => { dialogs.push(dialog.type()); void dialog.dismiss(); });
  await loginQualifiedResearch(page, owned.app);
  expect(owned.app.fixture.google.jwksFetches()).toBeGreaterThan(0);
  const before = await unchangedState();
  await load(page); await read(page);
  await expect(card(page).getByRole('button', { name: 'Admit reviewed qualification', exact: true })).toHaveCount(0);
  await expect(card(page).getByText(original, { exact: true })).toHaveCount(0);
  await show(page).click();
  const originals = card(page).getByRole('region', { name: `Captured original blocks for observation ${observationId}`, exact: true });
  await expect(originals).toContainText('not accepted facts or verified identity');
  await expect(originals).toContainText(`Retrieved ${captured} · Published unknown · First party true · Truncated false`);
  await expect(originals).toContainText('Block retained-label');
  await expect(originals.getByText(original, { exact: true })).toBeVisible();
  await expect(originals.getByText(hostile, { exact: true })).toBeVisible();
  await expect(originals.locator('img,script,iframe')).toHaveCount(0);
  await expect(card(page).getByText('Synthetic partial retained original', { exact: true })).toHaveCount(0);
  await show(page, partialId).click();
  await expect(card(page).getByRole('region', { name: `Captured original blocks for observation ${partialId}`, exact: true })).toContainText('First party false · Truncated true');
  expect(reads).toBe(1); expect(external).toEqual([]); expect(dialogs).toEqual([]);
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage).not.toContain(original); expect(storage).not.toContain(hostile); expect(storage).not.toContain('retained-label');
  await read(page);
  await expect(show(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(card(page).getByText(original, { exact: true })).toHaveCount(0);
  await show(page).click();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/browser/api/sourcing/qualification/read', async route => {
    const response = await route.fetch(); entered(); await gate; await route.fulfill({ response }).catch(() => {});
  }, { times: 1 });
  await card(page).getByRole('button', { name: 'Read qualification', exact: true }).click();
  await waiting;
  await expect(card(page).getByText(original, { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  release();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByText(original, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: /Captured original blocks/u })).toHaveCount(0);
  expect(await unchangedState()).toEqual(before);
  for (const table of ['provider_reservations', 'jobs', 'sourcing_admissions', 'contacts', 'sequence_enrollments', 'outbound_messages']) {
    expect((await owned.app.fixture.db.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0]?.['count']).toBe(0);
  }
  expect(mutations).toEqual([]); expect(external).toEqual([]); expect(dialogs).toEqual([]);
});
