import { candidateListSchema, qualifiedResearchListSchema } from '@fss/contracts';
import type { Page, Request } from 'playwright/test';
import { browserRequest, browserSession } from '../support/browser.ts';
import { test, expect, routeQualifiedResearchProvider, loginQualifiedResearch } from '../support/qualifiedResearchApp.ts';
import { startCandidateInventoryApp } from '../support/candidateInventoryApp.ts';
import { seedCandidateInventory, inventoryProductSnapshot } from '../support/candidateInventorySeed.ts';

const path = '/sourcing/candidates/list';
let owned: Awaited<ReturnType<typeof startCandidateInventoryApp>>;
let rows: Awaited<ReturnType<typeof seedCandidateInventory>>;
let baseline: Awaited<ReturnType<typeof inventoryProductSnapshot>>;
const inventory = (page: Page) => page.getByRole('region', { name: 'Ordinary sourcing inventory', exact: true });
const cards = (page: Page) => inventory(page).getByRole('article');
const load = (page: Page) => inventory(page).getByRole('button', { name: 'Load ordinary inventory', exact: true });
const status = (page: Page) => inventory(page).getByRole('combobox', { name: 'Inventory status', exact: true });
async function read(page: Page) {
  const response = page.waitForResponse(response => response.url().endsWith(`/browser/api${path}`));
  await load(page).click();
  const answer = await response;
  expect(answer.status()).toBe(200);
  expect(answer.headers()['cache-control']).toContain('no-store');
  return candidateListSchema.parse(await answer.json());
}
async function privateStorageAbsent(page: Page) {
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  for (const row of rows) {
    expect(storage).not.toContain(row.id);
    expect(storage).not.toContain(row.input.firmName);
    expect(storage).not.toContain(row.input.evidence);
  }
}
test.beforeAll(async () => {
  owned = await startCandidateInventoryApp();
  rows = await seedCandidateInventory(owned.app);
  baseline = await inventoryProductSnapshot(owned.app);
});
test.afterAll(async () => {
  try { if (owned && baseline) expect(await inventoryProductSnapshot(owned.app)).toEqual(baseline); }
  finally { await owned?.stop(); }
});
test.beforeEach(async ({ researchPage: page }) => {
  await routeQualifiedResearchProvider(page, owned.app);
  // Browser network confinement aborts every non-local request in the reused helper.
  // Fail any product dispatch outside the closed read set, even if its DB effect is zero.
  page.on('request', (request: Request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/browser/api/')) {
      expect(['/browser/api/today', '/browser/api/today/actions/v4', '/browser/api/sourcing/research-firms/list', `/browser/api${path}`]).toContain(url.pathname);
    }
  });
});
test.afterEach(async ({ researchPage: page }) => {
  await privateStorageAbsent(page);
  expect(await inventoryProductSnapshot(owned.app)).toEqual(baseline);
});

test('ordinary retained inventory exists with empty qualified selection and exact source observations, without authority or automatic read', async ({ researchPage: page }) => {
  let reads = 0;
  page.on('request', request => { if (request.url().endsWith(`/browser/api${path}`)) reads += 1; });
  await loginQualifiedResearch(page, owned.app);
  expect(reads).toBe(0);
  expect(owned.app.fixture.google.jwksFetches()).toBeGreaterThan(0);
  expect(owned.app.fixture.google.tokenExchanges().at(-1)?.clientSecretPresented).toBe(true);
  const qualified = await browserRequest(page, '/sourcing/research-firms/list', { body: {} });
  expect(qualified.status).toBe(200);
  expect(qualifiedResearchListSchema.parse(qualified.body).candidates).toEqual([]);
  const answer = await read(page);
  expect(answer.candidates).toHaveLength(50);
  expect(answer.hasMore).toBe(true);
  await expect(cards(page)).toHaveCount(50);
  const first = answer.candidates[0]!;
  const card = inventory(page).getByRole('article', { name: `Candidate ${first.id}`, exact: true });
  for (const value of [first.id, `Revision ${first.revision}`, `Status ${first.status}`, first.locality, first.region, first.observedOn, first.preparedBy, first.evidence]) await expect(card).toContainText(value);
  for (const url of [first.website, first.sourceUrl]) {
    const link = card.getByRole('link', { name: url, exact: true });
    await expect(link).toHaveAttribute('href', url);
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
  }
  await expect(inventory(page)).toContainText('no current qualification, eligibility, consent, contact or sending authority');
  await expect(inventory(page).getByRole('img')).toHaveCount(0);
  await expect(inventory(page).getByRole('button', { name: 'Read source authority', exact: true })).toHaveCount(answer.candidates.length);
  // Inventory still never dispatches qualification automatically. Its bounded
  // extension offers explicit existing qualification controls per candidate.
  await expect(inventory(page).getByRole('button', { name: 'Read qualification', exact: true })).toHaveCount(answer.candidates.length);
  await expect(inventory(page).getByRole('button', { name: 'Request qualification', exact: true })).toHaveCount(answer.candidates.length);
  await expect(inventory(page).getByRole('button').filter({ hasNotText: /^(?:Read source authority|Read qualification|Request qualification)$/u })).toHaveCount(3);
});

test('bounded replacement next/previous and explicit status reset use exact offsets and scope empty results', async ({ researchPage: page }) => {
  await loginQualifiedResearch(page, owned.app);
  const first = await read(page);
  const nextResponse = page.waitForResponse(response => response.url().endsWith(`/browser/api${path}`));
  await page.getByRole('button', { name: 'Next inventory page', exact: true }).click();
  const next = await nextResponse;
  expect(next.request().postDataJSON()).toEqual({ status: 'needs_review', offset: 50 });
  const second = candidateListSchema.parse(await next.json());
  expect(second.candidates).toHaveLength(1);
  await expect(cards(page)).toHaveCount(1);
  await expect(inventory(page).getByRole('article', { name: `Candidate ${first.candidates[0]!.id}`, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Next inventory page', exact: true })).toBeDisabled();
  const previous = page.waitForResponse(response => response.url().endsWith(`/browser/api${path}`));
  await page.getByRole('button', { name: 'Previous inventory page', exact: true }).click();
  expect((await previous).request().postDataJSON()).toEqual({ status: 'needs_review', offset: 0 });
  await expect(cards(page)).toHaveCount(50);
  for (const value of ['kept', 'dismissed']) {
    await status(page).selectOption(value);
    await expect(cards(page)).toHaveCount(0);
    const answer = await read(page);
    expect(answer.candidates.map(row => row.id)).toEqual(rows.filter(row => row.status === value).map(row => row.id));
    await expect(cards(page)).toHaveCount(1);
    await expect(inventory(page)).toContainText(`Status ${value} · Offset 0`);
  }
  const invalid = await browserRequest(page, path, { body: { status: 'dismissed', offset: -1 } });
  expect(invalid.status).toBe(400);
});

test('superseded filter responses cannot restore old private observations or steal current busy ownership', async ({ researchPage: page }) => {
  await loginQualifiedResearch(page, owned.app);
  let release = () => {};
  let reached = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const received = new Promise<void>(resolve => { reached = resolve; });
  await page.route(`**/browser/api${path}`, async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    reached();
    await held;
    await route.fulfill({ response });
  }, { times: 1 });
  await load(page).click();
  await received;
  const delivered = page.waitForResponse(response => response.url().endsWith(`/browser/api${path}`) && response.request().postDataJSON().status === 'needs_review');
  try {
    await status(page).selectOption('dismissed');
    const current = await read(page);
    expect(current.candidates.map(row => row.status)).toEqual(['dismissed']);
  } finally { release(); }
  expect((await delivered).status()).toBe(200);
  await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText(rows.find(row => row.status === 'dismissed')!.input.firmName);
  await expect(load(page)).toBeEnabled();
  let failures = 0;
  await page.route(`**/browser/api${path}`, async route => { failures += 1; await route.abort('failed'); });
  await load(page).click();
  await expect(inventory(page).getByRole('alert')).toContainText('This is not an empty result. No automatic retry.');
  await expect(cards(page)).toHaveCount(0);
  await expect(inventory(page)).not.toContainText('No observations returned');
  expect(failures).toBe(1);
});

test('workspace isolation, scoped empty page and current admin refusal never expose another workspace', async ({ researchPage: page }) => {
  await loginQualifiedResearch(page, owned.app, true);
  const beta = await read(page);
  expect(beta.candidates.map(row => row.firmName)).toEqual(['Inventory Beta 00']);
  for (const row of rows) await expect(inventory(page)).not.toContainText(row.input.firmName);
  await status(page).selectOption('kept');
  expect((await read(page)).candidates).toEqual([]);
  await expect(inventory(page)).toContainText('Other statuses or pages may contain inventory.');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const f = owned.app.fixture;
  owned.app.chooseIdentity(f.alpha.salesperson);
  await page.getByLabel('Workspace ID', { exact: true }).fill(f.alpha.workspaceId);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  const refusal = await browserRequest(page, path, { body: { status: 'needs_review', offset: 0 } });
  expect(refusal.status).toBe(403);
  expect(refusal.body).toEqual({ error: 'browser_request_refused' });
  await expect(cards(page)).toHaveCount(0);
});

test('revoked current device clears displayed data and late private response cannot resurrect after cross-tab logout', async ({ researchPage: page }) => {
  await loginQualifiedResearch(page, owned.app);
  await read(page);
  const session = await browserSession(page);
  if (session.status !== 'signed_in') throw new Error('Signed local OIDC session required');
  await owned.app.fixture.db.query("UPDATE devices SET status='revoked',revoked_at=now() WHERE workspace_id=$1 AND id=$2", [session.workspaceId, session.deviceId]);
  await load(page).click();
  await expect(cards(page)).toHaveCount(0);
  await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
  await loginQualifiedResearch(page, owned.app);
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
    reached();
    await held;
    await route.fulfill({ response });
  }, { times: 1 });
  await load(page).click();
  await received;
  const delivered = page.waitForResponse(response => response.url().endsWith(`/browser/api${path}`));
  try {
    await second.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
  } finally { release(); }
  expect((await delivered).status()).toBe(200);
  await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  await expect(cards(page)).toHaveCount(0);
  for (const row of rows) await expect(page.getByText(row.input.firmName, { exact: true })).toHaveCount(0);
  await second.close();
});
