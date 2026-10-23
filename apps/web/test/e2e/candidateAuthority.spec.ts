import { candidateAuthorityViewSchema, qualifiedResearchListSchema, type CandidateInput } from '@fss/contracts';
import type { Page } from 'playwright/test';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { saveCandidate } from '@fss/domain/sourcing/candidates.ts';
import { openHold, releaseHold } from '@fss/domain/policy/holds.ts';
import { browserRequest, browserSession } from '../support/browser.ts';
import { test, expect, routeQualifiedResearchProvider, loginQualifiedResearch } from '../support/qualifiedResearchApp.ts';
import { ingestAutomaticSupply, supplyContext, type SupplySeed } from '../support/automaticSupplySeed.ts';
import { startCandidateAuthorityApp, candidateAuthoritySnapshot } from '../support/candidateAuthorityApp.ts';

const path = '/sourcing/candidates/authority/read';
let owned: Awaited<ReturnType<typeof startCandidateAuthorityApp>>;
let source: SupplySeed;
let labelOnly: { id: string; revision: number };
const card = (page: Page, id: string) => page.getByRole('article', { name: `Candidate ${id}`, exact: true });
const region = (page: Page, id: string) => card(page, id).getByRole('region', { name: 'Candidate source authority', exact: true });
async function stable<T>(work: () => Promise<T>): Promise<T> {
  const before = await candidateAuthoritySnapshot(owned.app);
  try { return await work(); }
  finally { expect(await candidateAuthoritySnapshot(owned.app)).toEqual(before); }
}
async function read(page: Page, candidateId = source.candidateId, expectedRevision = source.candidateRevision) {
  return await stable(async () => {
    const response = await browserRequest(page, path, { body: { candidateId, expectedRevision } });
    expect(response.status).toBe(200);
    expect(response.cache).toContain('no-store');
    const view = candidateAuthorityViewSchema.parse(response.body);
    expect(view.candidateId).toBe(candidateId);
    expect(view.candidateRevision).toBe(expectedRevision);
    expect(view.authority).toBe('not_granted');
    expect(Number.isFinite(Date.parse(view.checkedAt))).toBe(true);
    return view;
  });
}
async function load(page: Page) {
  const pending = page.waitForResponse(response => response.url().endsWith('/browser/api/sourcing/candidates/list'));
  await page.getByRole('button', { name: 'Load ordinary inventory', exact: true }).click();
  expect((await pending).status()).toBe(200);
}
test.beforeAll(async () => {
  owned = await startCandidateAuthorityApp();
  const seeds = await ingestAutomaticSupply(owned.app, ['Authority752']);
  expect(seeds).toHaveLength(1);
  source = seeds[0]!;
  const f = owned.app.fixture;
  const payload = (await f.db.query<{ payload: CandidateInput }>('SELECT payload FROM sourcing_candidates WHERE id=$1', [source.candidateId])).rows[0]!.payload;
  const context = repositoryContext(workspaceScope(f.alpha.workspaceId, { kind: 'user', userId: f.alpha.admin.userId, role: 'admin' }), f.db);
  const saved = await withTransaction(f.db, () => saveCandidate(context, { ...payload, firmName: 'Label Only Authority Fixture', website: 'https://label-only-authority.example.test/', sourceUrl: 'https://label-only-authority.example.test/' }));
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error('Synthetic retained candidate seed refused');
  labelOnly = { id: saved.value.id, revision: 1 };
  expect((await f.db.query('SELECT id FROM sourcing_qualification_runs')).rows).toEqual([]);
});
test.afterAll(async () => { await owned?.stop(); });
test.beforeEach(async ({ researchPage: page }) => {
  await routeQualifiedResearchProvider(page, owned.app);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/browser/api/')) expect(['/browser/api/today', '/browser/api/today/actions/v4', '/browser/api/sourcing/research-firms/list', '/browser/api/sourcing/candidates/list', `/browser/api${path}`]).toContain(url.pathname);
  });
});
test.afterEach(async ({ researchPage: page }) => {
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  for (const value of [source.candidateId, source.attemptId, source.name, labelOnly.id]) expect(storage).not.toContain(value);
  expect((await owned.app.fixture.db.query('SELECT id FROM sourcing_qualification_runs')).rows).toEqual([]);
});

test('explicit ordinary read observes registered completed search and current attested admin without qualification or grants', async ({ researchPage: page }) => {
  let reads = 0;
  page.on('request', request => { if (request.url().endsWith(`/browser/api${path}`)) reads += 1; });
  await stable(async () => {
    await loginQualifiedResearch(page, owned.app);
    await load(page);
    expect(reads).toBe(0);
    const qualified = await browserRequest(page, '/sourcing/research-firms/list', { body: {} });
    expect(qualified.status).toBe(200);
    expect(qualifiedResearchListSchema.parse(qualified.body).candidates).toEqual([]);
    const pending = page.waitForResponse(response => response.url().endsWith(`/browser/api${path}`));
    await card(page, source.candidateId).getByRole('button', { name: 'Read source authority', exact: true }).click();
    const response = await pending;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toEqual({ candidateId: source.candidateId, expectedRevision: source.candidateRevision });
    const view = candidateAuthorityViewSchema.parse(await response.json());
    expect(view).toMatchObject({ source: { status: 'matched', kind: 'search_hit', attemptId: source.attemptId }, owner: 'current_admin', holds: 'clear', researchEnabled: true, authority: 'not_granted' });
    await expect(region(page, source.candidateId)).toContainText(source.attemptId);
    await expect(region(page, source.candidateId)).toContainText(view.checkedAt);
    expect(reads).toBe(1);
  });
});

test('preparedBy label is not source proof and current holds/settings/attestation remain independent observations', async ({ researchPage: page }) => {
  await loginQualifiedResearch(page, owned.app);
  expect(await read(page, labelOnly.id, labelOnly.revision)).toMatchObject({ source: { status: 'unavailable' }, owner: 'current_admin', holds: 'clear', authority: 'not_granted' });
  const f = owned.app.fixture;
  const hold = await withTransaction(f.db, () => openHold(supplyContext(owned.app), { scopeKind: 'owner', scopeKey: f.alpha.admin.userId, reasonCode: 'scoped_pause', blockedActionKinds: ['research'], sourceEventKind: 'candidate_authority_local_fixture' }));
  try {
    expect(await read(page)).toMatchObject({ owner: 'current_admin', holds: 'held', researchEnabled: true });
    await f.db.query('UPDATE research_settings SET enabled=false WHERE workspace_id=$1', [f.alpha.workspaceId]);
    expect(await read(page)).toMatchObject({ owner: 'current_admin', holds: 'held', researchEnabled: false });
    await f.db.query('UPDATE sourcing_discovery_settings SET auto_admission_enabled=false WHERE workspace_id=$1', [f.alpha.workspaceId]);
    expect(await read(page)).toMatchObject({ owner: 'unavailable', holds: 'unknown', researchEnabled: false });
  } finally {
    await f.db.query('UPDATE research_settings SET enabled=true WHERE workspace_id=$1', [f.alpha.workspaceId]);
    await f.db.query('UPDATE sourcing_discovery_settings SET auto_admission_enabled=true WHERE workspace_id=$1', [f.alpha.workspaceId]);
    await withTransaction(f.db, () => releaseHold(supplyContext(owned.app), hold));
  }
});

test('current exact revision, workspace, session and administrator refusals do not mutate product state', async ({ researchPage: page }) => {
  await loginQualifiedResearch(page, owned.app);
  await stable(async () => {
    const stale = await browserRequest(page, path, { body: { candidateId: source.candidateId, expectedRevision: source.candidateRevision + 1 } });
    expect(stale.status).not.toBe(200);
    const wrongSession = await browserRequest(page, path, { body: { candidateId: source.candidateId, expectedRevision: source.candidateRevision }, revision: 'not-current' });
    expect(wrongSession.status).not.toBe(200);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await loginQualifiedResearch(page, owned.app, true);
    const foreign = await browserRequest(page, path, { body: { candidateId: source.candidateId, expectedRevision: source.candidateRevision } });
    expect(foreign.status).not.toBe(200);
    expect(JSON.stringify(foreign.body)).not.toContain(source.attemptId);
  });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const f = owned.app.fixture;
  owned.app.chooseIdentity(f.alpha.salesperson);
  await page.getByLabel('Workspace ID', { exact: true }).fill(f.alpha.workspaceId);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await stable(async () => {
    const refused = await browserRequest(page, path, { body: { candidateId: source.candidateId, expectedRevision: source.candidateRevision } });
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: 'browser_request_refused' });
  });
});

test('late explicit authority response cannot repopulate cleared inventory after cross-tab logout', async ({ researchPage: page }) => {
  await loginQualifiedResearch(page, owned.app);
  await load(page);
  const session = await browserSession(page);
  expect(session.status).toBe('signed_in');
  const second = await page.context().newPage();
  await second.goto(owned.app.origin);
  await expect(second.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  let release = () => {};
  let reached = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const received = new Promise<void>(resolve => { reached = resolve; });
  await page.route(`**/browser/api${path}`, async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    candidateAuthorityViewSchema.parse(await response.json());
    reached();
    await held;
    await route.fulfill({ response });
  }, { times: 1 });
  await stable(async () => {
    const delivered = page.waitForResponse(response => response.url().endsWith(`/browser/api${path}`));
    await card(page, source.candidateId).getByRole('button', { name: 'Read source authority', exact: true }).click();
    await received;
    try {
      await second.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
    } finally { release(); }
    expect((await delivered).status()).toBe(200);
    await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
    await expect(page.getByRole('region', { name: 'Candidate source authority', exact: true })).toHaveCount(0);
    await expect(card(page, source.candidateId)).toHaveCount(0);
    await second.close();
  });
});
