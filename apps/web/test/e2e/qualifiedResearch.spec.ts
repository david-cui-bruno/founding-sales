import { createHash, randomUUID } from 'node:crypto';
import type { Page, Request } from 'playwright/test';
import { qualifiedResearchListSchema, qualifiedResearchFirmSchema, todayActionsV3ResponseSchema, todayActionOpenV3ResponseSchema, type QualifiedResearchSelection } from '@fss/contracts';
import { CURRENT_CLIENT_VERSION } from '../../../api/test/support/authFixture.ts';
import { browserRequest, browserSession } from '../support/browser.ts';
import { test, expect, startQualifiedResearchApp, routeQualifiedResearchProvider, loginQualifiedResearch } from '../support/qualifiedResearchApp.ts';
import { seedQualifiedResearch, type QualifiedResearchSeed } from '../support/qualifiedResearchSeed.ts';

let owned: Awaited<ReturnType<typeof startQualifiedResearchApp>>;
const pendingKey = 'callie.browser.pending-research.v1';
const createPath = '/sourcing/research-firms/create';
const envelope = (selection: QualifiedResearchSelection) => ({ ...selection, commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION });
test.beforeAll(async () => { owned = await startQualifiedResearchApp(); });
test.afterAll(async () => { await owned?.stop(); });
test.beforeEach(async ({ researchPage }) => { await routeQualifiedResearchProvider(researchPage, owned.app); });
async function load(page: Page) {
  await page.getByRole('button', { name: 'Load research candidates', exact: true }).click();
}
function card(page: Page, seed: QualifiedResearchSeed) {
  return page.getByRole('article').filter({ has: page.getByRole('heading', { name: seed.name, exact: true }) });
}
async function stored(page: Page) {
  return await page.evaluate(key => sessionStorage.getItem(key), pendingKey);
}
async function list(page: Page) {
  const response = await browserRequest(page, '/sourcing/research-firms/list', { body: {} });
  expect(response.status).toBe(200);
  return qualifiedResearchListSchema.parse(response.body);
}
async function assertNoAuthority(firmId: string) {
  const f = owned.app.fixture;
  for (const table of ['contacts', 'email_addresses', 'phone_routes', 'sequence_enrollments', 'opportunities', 'sourcing_admissions']) {
    expect((await f.db.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1 AND firm_id=$2`, [f.alpha.workspaceId, firmId])).rows, table).toEqual([]);
  }
  expect((await f.db.query("SELECT 1 FROM jobs WHERE workspace_id=$1 AND kind='sourcing.qualify'", [f.alpha.workspaceId])).rows).toEqual([]);
  expect((await f.db.query("SELECT 1 FROM jobs WHERE workspace_id=$1 AND kind='research.firm' AND payload->>'firmId'=$2", [f.alpha.workspaceId, firmId])).rows).toEqual([]);
}
async function pendingIsIdsOnly(page: Page, seed: QualifiedResearchSeed) {
  const raw = await stored(page);
  expect(raw).not.toBeNull();
  const value = JSON.parse(raw!) as { commandId: string; selection: QualifiedResearchSelection; createdFirmId?: string; expiresAt: string };
  expect(Object.keys(value).sort()).toEqual((value.createdFirmId ? ['identity', 'commandId', 'selection', 'expiresAt', 'createdFirmId'] : ['identity', 'commandId', 'selection', 'expiresAt']).sort());
  expect(value.selection).toEqual(seed.selection);
  for (const privateText of [seed.name, seed.text, seed.email, seed.website, 'citations', 'quote', 'contentHash']) expect(raw).not.toContain(privateText);
  const session = await browserSession(page);
  if (session.status !== 'signed_in') throw new Error('Expected real signed session');
  expect(Date.parse(value.expiresAt)).toBeLessThanOrEqual(Date.parse(session.expiresAt));
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(seed.selection.candidateId);
  return value;
}

test('controlled no-phone evidence creates one canonical research Firm and opens exact current Today proof after reload', async ({ researchPage: page }) => {
  const app = owned.app;
  const ready = await seedQualifiedResearch(app, 'Ready');
  const ambiguous = await seedQualifiedResearch(app, 'Ambiguous', true);
  await loginQualifiedResearch(page, app);
  const exchange = app.fixture.google.tokenExchanges().at(-1);
  expect(exchange?.clientSecretPresented).toBe(true);
  expect(app.fixture.google.jwksFetches()).toBeGreaterThan(0);
  const oidc = await app.fixture.db.query<{ code_challenge: string }>('SELECT code_challenge FROM oidc_authorization_requests ORDER BY created_at DESC LIMIT 1');
  expect(createHash('sha256').update(exchange?.codeVerifier ?? '').digest('base64url')).toBe(oidc.rows[0]?.code_challenge);
  const candidates = await list(page);
  expect(candidates.candidates.find(row => row.selection.candidateId === ready.selection.candidateId)).toMatchObject({ selection: ready.selection, emailFit: 'eligible', channelAuthority: 'not_granted', maintenanceNeed: 'not_established' });
  expect(candidates.candidates.some(row => row.selection.candidateId === ambiguous.selection.candidateId)).toBe(false);
  await load(page);
  await expect(card(page, ambiguous)).toHaveCount(0);
  const sent = page.waitForResponse(response => response.url().endsWith(`/browser/api${createPath}`));
  await card(page, ready).getByRole('button', { name: 'Create research Firm', exact: true }).click();
  const response = await sent;
  expect(response.status()).toBe(200);
  const body = await response.json() as { result: unknown };
  const firm = qualifiedResearchFirmSchema.parse(body.result);
  expect(firm).toMatchObject({ selection: ready.selection, promotionId: ready.promotionId, channelAuthority: 'not_granted', maintenanceNeed: 'not_established' });
  await page.reload();
  const current = await browserRequest(page, '/sourcing/research-firms/read', { body: { firmId: firm.firmId } });
  expect(current.status).toBe(200);
  expect(qualifiedResearchFirmSchema.parse(current.body)).toEqual(firm);
  const queue = todayActionsV3ResponseSchema.parse((await browserRequest(page, '/today/actions/v3')).body);
  const action = queue.actions.find(row => row.target.kind === 'qualified_research' && row.target.firmId === firm.firmId);
  expect(action).toBeDefined();
  expect(action!.target).toMatchObject({ ...ready.selection, firmId: firm.firmId, promotionId: ready.promotionId, evidenceFingerprint: firm.evidenceFingerprint });
  const opened = page.waitForResponse(response => response.url().endsWith('/browser/api/today/actions/open/v3'));
  await page.getByRole('article').filter({ hasText: ready.name }).getByRole('button', { name: 'Review current research', exact: true }).click();
  const openResponse = await opened;
  expect(openResponse.request().postDataJSON()).toEqual({ actionId: action!.actionId, target: action!.target });
  const proof = todayActionOpenV3ResponseSchema.parse(await openResponse.json());
  expect(proof).toEqual({ version: 3, target: action!.target, research: firm });
  await expect(page.getByRole('heading', { name: 'Current research proof', exact: true })).toBeVisible();
  await expect(page.getByText(`Discovery preparation question: ${firm.question}`, { exact: true })).toBeVisible();
  expect(firm.question).not.toMatch(/you (?:need|promised)|meeting (?:booked|confirmed)|overwhelmed|understaffed/iu);
  for (const citation of firm.citations) {
    expect(citation).toMatchObject({ observationId: ready.observationId, blockId: 'native', quote: ready.text, url: ready.website });
    await expect(page.getByText(citation.quote, { exact: true }).first()).toBeVisible();
  }
  const storage = await page.evaluate(() => JSON.stringify({ session: { ...sessionStorage }, local: { ...localStorage } }));
  for (const text of [ready.text, ready.email, ready.website, 'citations']) expect(storage).not.toContain(text);
  await assertNoAuthority(firm.firmId);
});

test('current source/candidate/run/owner changes refuse exact opens and replay while committed Firm existence stays known', async ({ researchPage: page }) => {
  await loginQualifiedResearch(page, owned.app);
  for (const change of ['source', 'raw_revision', 'candidate_revision', 'run_revision', 'owner'] as const) {
    await test.step(change, async () => {
      const seed = await seedQualifiedResearch(owned.app, `Changed-${change.replaceAll('_', '-')}`);
      const command = envelope(seed.selection);
      const created = await browserRequest(page, createPath, { body: command });
      expect(created.status).toBe(200);
      const firm = qualifiedResearchFirmSchema.parse((created.body as { result: unknown }).result);
      const actions = todayActionsV3ResponseSchema.parse((await browserRequest(page, '/today/actions/v3')).body);
      const action = actions.actions.find(row => row.target.kind === 'qualified_research' && row.target.firmId === firm.firmId)!;
      expect(action).toBeDefined();
      const db = owned.app.fixture.db;
      if (change === 'source') await db.query('DELETE FROM sourcing_candidate_discovery_origins WHERE candidate_id=$1', [seed.selection.discoveryCandidateId]);
      if (change === 'raw_revision') await db.query('UPDATE sourcing_candidates SET revision=revision+1 WHERE id=$1', [seed.selection.discoveryCandidateId]);
      if (change === 'candidate_revision') await db.query('UPDATE sourcing_candidates SET revision=revision+1 WHERE id=$1', [seed.selection.candidateId]);
      if (change === 'run_revision') await db.query("UPDATE sourcing_qualification_runs SET policy_version='qualification-v4' WHERE id=$1", [seed.selection.runId]);
      if (change === 'owner') await db.query('UPDATE firms SET assigned_user_id=$2 WHERE id=$1', [firm.firmId, owned.app.fixture.alpha.salesperson.userId]);
      expect((await browserRequest(page, '/sourcing/research-firms/read', { body: { firmId: firm.firmId } })).status).toBe(404);
      expect((await list(page)).candidates.some(row => row.selection.candidateId === seed.selection.candidateId)).toBe(false);
      const open = await browserRequest(page, '/today/actions/open/v3', { body: { actionId: action.actionId, target: action.target } });
      expect(todayActionOpenV3ResponseSchema.parse(open.body)).toEqual({ version: 3, target: null, research: null });
      const replay = await browserRequest(page, createPath, { body: command });
      expect(replay.status).toBe(404);
      expect(replay.body).toEqual({ error: 'browser_request_refused' });
      // A failed current read does not mean the committed mutation never happened.
      expect((await db.query('SELECT id FROM firms WHERE id=$1', [firm.firmId])).rows).toEqual([{ id: firm.firmId }]);
      expect((await db.query('SELECT 1 FROM command_receipts WHERE command_id=$1', [command.commandId])).rows).toHaveLength(1);
      await assertNoAuthority(firm.firmId);
    });
  }
});

test('new pending research custody clears on device/member/revision/expiry/logout without replay or cross-identity resurrection', async ({ researchPage: page }) => {
  const f = owned.app.fixture;
  // Preserve the real DB last-admin invariant while revoking the signed-in owner.
  await f.db.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')", [f.alpha.workspaceId, f.alpha.outsider.userId]);
  for (const refusal of ['device', 'membership', 'revision', 'expiry', 'logout'] as const) {
    await test.step(refusal, async () => {
      f.setNow(new Date());
      await loginQualifiedResearch(page, owned.app);
      const seed = await seedQualifiedResearch(owned.app, `Custody-${refusal}`);
      await load(page);
      await page.route(`**/browser/api${createPath}`, async route => { await route.abort('failed'); }, { times: 1 });
      await card(page, seed).getByRole('button', { name: 'Create research Firm', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Retry exact research command', exact: true })).toBeVisible();
      const pending = await pendingIsIdsOnly(page, seed);
      const session = await browserSession(page);
      if (session.status !== 'signed_in') throw new Error('Expected signed-in session');
      let mutations = 0;
      const observe = (request: Request) => { if (request.url().endsWith(`/browser/api${createPath}`)) mutations += 1; };
      page.on('request', observe);
      try {
        if (refusal === 'device') await f.db.query("UPDATE devices SET status='revoked',revoked_at=now() WHERE workspace_id=$1 AND id=$2", [session.workspaceId, session.deviceId]);
        if (refusal === 'membership') await f.db.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=now() WHERE workspace_id=$1 AND user_id=$2", [session.workspaceId, session.userId]);
        if (refusal === 'revision') await f.db.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2", [session.workspaceId, session.userId]);
        if (refusal === 'expiry') f.advance(3600_001);
        if (refusal === 'logout') await page.getByRole('button', { name: 'Sign out', exact: true }).click();
        else await page.reload();
        await expect.poll(() => stored(page)).toBeNull();
        expect(mutations).toBe(0);
        await expect(page.getByRole('button', { name: 'Retry exact research command', exact: true })).toHaveCount(0);
        expect((await f.db.query('SELECT 1 FROM command_receipts WHERE command_id=$1', [pending.commandId])).rows).toEqual([]);
      } finally {
        page.off('request', observe);
        if (refusal === 'membership') await f.db.query("UPDATE workspace_memberships SET status='active',deactivated_at=NULL WHERE workspace_id=$1 AND user_id=$2", [session.workspaceId, session.userId]);
        if (refusal === 'revision') await f.db.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [session.workspaceId, session.userId]);
        f.setNow(new Date());
        await page.context().clearCookies();
      }
      await loginQualifiedResearch(page, owned.app, true);
      await expect.poll(() => stored(page)).toBeNull();
      await expect(page.getByText(seed.name, { exact: true })).toHaveCount(0);
      expect((await list(page)).candidates).toEqual([]);
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    });
  }
});

test('late current-proof response and second-tab logout cannot resurrect research projections or pending work', async ({ researchPage: page }) => {
  const seed = await seedQualifiedResearch(owned.app, 'Late');
  await loginQualifiedResearch(page, owned.app);
  await load(page);
  const second = await page.context().newPage();
  await second.goto(owned.app.origin);
  await expect(second.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await page.route(`**/browser/api${createPath}`, async route => { await route.abort('failed'); }, { times: 1 });
  await card(page, seed).getByRole('button', { name: 'Create research Firm', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry exact research command', exact: true })).toBeVisible();
  const pending = await pendingIsIdsOnly(page, seed);
  let releaseResponse = () => {};
  let observed = () => {};
  const held = new Promise<void>(resolve => { releaseResponse = resolve; });
  const received = new Promise<void>(resolve => { observed = resolve; });
  await page.route('**/browser/api/sourcing/research-firms/list', async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    observed();
    await held;
    await route.fulfill({ response });
  }, { times: 1 });
  await load(page);
  await received;
  const delivered = page.waitForResponse(response => response.url().endsWith('/browser/api/sourcing/research-firms/list'));
  try {
    await second.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
    await expect.poll(() => stored(page)).toBeNull();
  } finally { releaseResponse(); }
  expect((await delivered).status()).toBe(200);
  await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  await expect(page.getByRole('heading', { name: seed.name, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry exact research command', exact: true })).toHaveCount(0);
  expect((await owned.app.fixture.db.query('SELECT 1 FROM command_receipts WHERE command_id=$1', [pending.commandId])).rows).toEqual([]);
  await loginQualifiedResearch(page, owned.app, true);
  expect((await list(page)).candidates).toEqual([]);
  await second.close();
});

test('actual committed response loss retains exact UUID/payload and explicit recovery returns one Firm/link/body-free receipt', async ({ researchPage: page }) => {
  const seed = await seedQualifiedResearch(owned.app, 'Recovery');
  await loginQualifiedResearch(page, owned.app);
  await load(page);
  let committed = () => {};
  const committedResponse = new Promise<void>(resolve => { committed = resolve; });
  await page.route(`**/browser/api${createPath}`, async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committed();
    await route.abort('failed');
  }, { times: 1 });
  const sent = page.waitForRequest(request => request.url().endsWith(`/browser/api${createPath}`));
  await card(page, seed).getByRole('button', { name: 'Create research Firm', exact: true }).click();
  const original = (await sent).postDataJSON() as { commandId: string };
  await committedResponse;
  await expect(page.getByRole('button', { name: 'Retry exact research command', exact: true })).toBeEnabled();
  await expect(page.getByText(`Unresolved research request ${original.commandId}`, { exact: false })).toBeVisible();
  const pending = await pendingIsIdsOnly(page, seed);
  expect(pending.commandId).toBe(original.commandId);
  const receipts = await owned.app.fixture.db.query('SELECT result FROM command_receipts WHERE command_id=$1', [original.commandId]);
  expect(receipts.rows).toHaveLength(1);
  const receipt = JSON.stringify(receipts.rows[0]);
  for (const privateText of [seed.text, seed.name, seed.email, seed.website, 'citations', 'quote']) expect(receipt).not.toContain(privateText);
  let mutations = 0;
  page.on('request', request => { if (request.url().endsWith(`/browser/api${createPath}`)) mutations += 1; });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry exact research command', exact: true })).toBeVisible();
  expect(mutations).toBe(0);
  expect((await pendingIsIdsOnly(page, seed)).commandId).toBe(original.commandId);
  const replay = page.waitForResponse(response => response.url().endsWith(`/browser/api${createPath}`));
  await page.getByRole('button', { name: 'Retry exact research command', exact: true }).click();
  const recovered = await replay;
  expect(recovered.request().postDataJSON()).toEqual(original);
  const result = await recovered.json() as { replayed: boolean; result: unknown };
  expect(result.replayed).toBe(true);
  const firm = qualifiedResearchFirmSchema.parse(result.result);
  await expect.poll(async () => JSON.parse((await stored(page)) ?? '{}') as { createdFirmId?: string }).toMatchObject({ createdFirmId: firm.firmId });
  await pendingIsIdsOnly(page, seed);
  expect((await owned.app.fixture.db.query('SELECT id FROM firms WHERE workspace_id=$1 AND name=$2', [owned.app.fixture.alpha.workspaceId, seed.name])).rows).toEqual([{ id: firm.firmId }]);
  expect((await owned.app.fixture.db.query('SELECT firm_id FROM sourcing_discovery_research_firms WHERE workspace_id=$1 AND promotion_id=$2', [owned.app.fixture.alpha.workspaceId, seed.promotionId])).rows).toEqual([{ firm_id: firm.firmId }]);
  expect((await owned.app.fixture.db.query('SELECT 1 FROM command_receipts WHERE command_id=$1', [original.commandId])).rows).toHaveLength(1);
  await assertNoAuthority(firm.firmId);
  await owned.app.fixture.db.query('DELETE FROM sourcing_candidate_discovery_origins WHERE candidate_id=$1', [seed.selection.discoveryCandidateId]);
  expect((await browserRequest(page, '/sourcing/research-firms/read', { body: { firmId: firm.firmId } })).status).toBe(404);
  await page.getByRole('button', { name: 'Refresh action queue', exact: true }).click();
  expect((await pendingIsIdsOnly(page, seed)).createdFirmId).toBe(firm.firmId);
  expect(mutations).toBe(1);
});

test('R740-1 source loss before exact uncertain retry preserves UUID across 404 and reload until actual auth refusal', async ({ researchPage: page }) => {
  const app = owned.app;
  const seed = await seedQualifiedResearch(app, 'Source-Lost-Before-Retry');
  await loginQualifiedResearch(page, app);
  await load(page);
  let committed = () => {};
  const committedResponse = new Promise<void>(resolve => { committed = resolve; });
  await page.route(`**/browser/api${createPath}`, async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committed();
    await route.abort('failed');
  }, { times: 1 });
  const sent = page.waitForRequest(request => request.url().endsWith(`/browser/api${createPath}`));
  await card(page, seed).getByRole('button', { name: 'Create research Firm', exact: true }).click();
  const original = (await sent).postDataJSON() as { commandId: string };
  await committedResponse;
  await expect(page.getByRole('button', { name: 'Retry exact research command', exact: true })).toBeEnabled();
  const initialPending = await pendingIsIdsOnly(page, seed);
  expect(initialPending.commandId).toBe(original.commandId);
  expect(initialPending.createdFirmId).toBeUndefined();
  expect(original).toEqual({ ...seed.selection, commandId: original.commandId });
  const receipt = (await app.fixture.db.query<{ result: { firmId: string } }>('SELECT result FROM command_receipts WHERE command_id=$1', [original.commandId])).rows;
  expect(receipt).toHaveLength(1);
  const firmId = receipt[0]!.result.firmId;
  expect(firmId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(receipt).toEqual([{ result: { firmId } }]);
  const queueBefore = todayActionsV3ResponseSchema.parse((await browserRequest(page, '/today/actions/v3')).body);
  const action = queueBefore.actions.find(row => row.target.kind === 'qualified_research' && row.target.firmId === firmId)!;
  expect(action).toBeDefined();
  expect((await app.fixture.db.query('SELECT firm_id FROM sourcing_discovery_research_firms WHERE workspace_id=$1 AND promotion_id=$2', [app.fixture.alpha.workspaceId, seed.promotionId])).rows).toEqual([{ firm_id: firmId }]);
  // Missing-order regression: source disappears AFTER commit but BEFORE any retry.
  await app.fixture.db.query('DELETE FROM sourcing_candidate_discovery_origins WHERE candidate_id=$1', [seed.selection.discoveryCandidateId]);
  expect((await browserRequest(page, '/sourcing/research-firms/read', { body: { firmId } })).status).toBe(404);
  const queueAfter = todayActionsV3ResponseSchema.parse((await browserRequest(page, '/today/actions/v3')).body);
  expect(queueAfter.actions.some(row => row.target.kind === 'qualified_research' && row.target.firmId === firmId)).toBe(false);
  const staleOpen = await browserRequest(page, '/today/actions/open/v3', { body: { actionId: action.actionId, target: action.target } });
  expect(todayActionOpenV3ResponseSchema.parse(staleOpen.body)).toEqual({ version: 3, target: null, research: null });
  let mutations = 0;
  page.on('request', request => { if (request.url().endsWith(`/browser/api${createPath}`)) mutations += 1; });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry exact research command', exact: true })).toBeEnabled();
  expect(mutations).toBe(0);
  expect(await pendingIsIdsOnly(page, seed)).toEqual(initialPending);
  let unavailableBody: unknown;
  await page.route(`**/browser/api${createPath}`, async route => {
    const response = await route.fetch();
    unavailableBody = await response.json() as unknown;
    await route.fulfill({ response });
  }, { times: 1 });
  const replay = page.waitForResponse(response => response.url().endsWith(`/browser/api${createPath}`));
  await page.getByRole('button', { name: 'Retry exact research command', exact: true }).click();
  const unavailable = await replay;
  expect(unavailable.request().postDataJSON()).toEqual(original);
  expect(unavailable.status()).toBe(404);
  expect(unavailableBody).toEqual({ error: 'browser_request_refused' });
  await expect(page.getByRole('button', { name: 'Retry exact research command', exact: true })).toBeEnabled();
  expect(await pendingIsIdsOnly(page, seed)).toEqual(initialPending);
  await expect(page.getByRole('heading', { name: 'Current research proof', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry exact research command', exact: true })).toBeEnabled();
  expect(mutations).toBe(1);
  expect(await pendingIsIdsOnly(page, seed)).toEqual(initialPending);
  expect((await browserSession(page)).status).toBe('signed_in');
  expect((await app.fixture.db.query('SELECT id FROM firms WHERE workspace_id=$1 AND id=$2', [app.fixture.alpha.workspaceId, firmId])).rows).toEqual([{ id: firmId }]);
  // Origin deletion legitimately cascades promotion/link removal (migration0128).
  // Preserve command uncertainty, not a stale source association or a replacement.
  expect((await app.fixture.db.query('SELECT firm_id FROM sourcing_discovery_research_firms WHERE workspace_id=$1 AND firm_id=$2', [app.fixture.alpha.workspaceId, firmId])).rows).toEqual([]);
  expect((await app.fixture.db.query('SELECT result FROM command_receipts WHERE command_id=$1', [original.commandId])).rows).toEqual(receipt);
  for (const text of [seed.name, seed.text, seed.email, seed.website, 'citations', 'quote']) expect(JSON.stringify(receipt)).not.toContain(text);
  await assertNoAuthority(firmId);
  const session = await browserSession(page);
  if (session.status !== 'signed_in') throw new Error('Expected unchanged valid owner session before actual revocation');
  await app.fixture.db.query("UPDATE devices SET status='revoked',revoked_at=now() WHERE workspace_id=$1 AND id=$2", [session.workspaceId, session.deviceId]);
  const refused = page.waitForResponse(response => response.url().endsWith('/browser/session'), { timeout: 10_000 });
  await page.getByRole('button', { name: 'Refresh action queue', exact: true }).click();
  expect((await refused).status()).toBe(200);
  // Session refresh authenticates the revoked device first and blocks API dispatch.
  expect((await browserSession(page)).status).toBe('signed_out');
  await expect.poll(() => stored(page)).toBeNull();
  await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry exact research command', exact: true })).toHaveCount(0);
  expect((await browserRequest(page, '/today/actions/v3')).status).toBe(401);
  expect(mutations).toBe(1);
});
