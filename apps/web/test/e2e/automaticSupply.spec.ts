import { createHash } from 'node:crypto';
import type { Page } from 'playwright/test';
import { todayActionsV4ResponseSchema, todayActionOpenV4ResponseSchema, type TodayActionV4, type AutomaticResearchFirm } from '@fss/contracts';
import { openHold, releaseHold } from '@fss/domain/policy/holds.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { deleteAutomaticSupplyFirm } from '../support/automaticSupplyDeletion.ts';
import { browserRequest, browserSession } from '../support/browser.ts';
import { test, expect, startAutomaticSupplyApp, routeAutomaticSupplyProvider, loginAutomaticSupply } from '../support/automaticSupplyApp.ts';
import { ingestAutomaticSupply, ingestAutomaticApolloSupply, completeAutomaticSupply, supplyContext, supplyPass, supplyEvaluation, type SupplySeed } from '../support/automaticSupplySeed.ts';
let owned: Awaited<ReturnType<typeof startAutomaticSupplyApp>>;
test.beforeAll(async () => {
  owned = await startAutomaticSupplyApp();
  console.log('AUTOMATIC_SUPPLY_CATALOG', (await owned.app.fixture.db.query("SELECT conname FROM pg_constraint WHERE conrelid='sourcing_automatic_research_firms'::regclass ORDER BY conname")).rows);
});
test.afterAll(async () => {
  if (!owned) return;
  try { expect((await owned.app.fixture.db.query('SELECT 1 FROM outbound_messages')).rows).toEqual([]); }
  finally { await owned.stop(); }
});
test.beforeEach(async ({ supplyPage }) => { await routeAutomaticSupplyProvider(supplyPage, owned.app); });
async function queue(page: Page) {
  const response = await browserRequest(page, '/today/actions/v4');
  expect(response.status).toBe(200);
  return todayActionsV4ResponseSchema.parse(response.body);
}
async function actionFor(page: Page, seed: SupplySeed) {
  const action = (await queue(page)).actions.find(action => action.target.kind === 'automatic_research' && action.target.candidateId === seed.candidateId);
  expect(action, seed.name).toBeDefined();
  return action!;
}
async function open(page: Page, action: TodayActionV4) {
  const response = await browserRequest(page, '/today/actions/open/v4', { body: { actionId: action.actionId, target: action.target } });
  expect(response.status).toBe(200);
  return todayActionOpenV4ResponseSchema.parse(response.body);
}
async function refused(page: Page, action: TodayActionV4) {
  expect(await open(page, action)).toEqual({ version: 4, target: null, research: null, automaticResearch: null });
  expect((await queue(page)).actions.some(row => row.actionId === action.actionId)).toBe(false);
}
async function publications(seed: SupplySeed) {
  return (await owned.app.fixture.db.query('SELECT * FROM sourcing_automatic_research_firms WHERE workspace_id=$1 AND candidate_id=$2', [owned.app.fixture.alpha.workspaceId, seed.candidateId])).rows;
}
async function noAuthority(proof: AutomaticResearchFirm) {
  const f = owned.app.fixture;
  for (const table of ['contacts', 'email_addresses', 'phone_routes', 'sequence_enrollments', 'opportunities', 'sourcing_admissions']) expect((await f.db.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1 AND firm_id=$2`, [f.alpha.workspaceId, proof.target.firmId])).rows, table).toEqual([]);
  expect((await f.db.query('SELECT 1 FROM sourcing_discovery_promotions WHERE workspace_id=$1 AND legacy_candidate_id=$2', [f.alpha.workspaceId, proof.target.candidateId])).rows).toEqual([]);
  expect((await f.db.query('SELECT 1 FROM outbound_messages WHERE workspace_id=$1', [f.alpha.workspaceId])).rows).toEqual([]);
  for (const table of ['outreach_email_sources', 'outreach_email_campaign_admissions']) expect((await f.db.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1 AND candidate_id=$2`, [f.alpha.workspaceId, proof.target.candidateId])).rows, table).toEqual([]);
}

test('registered approved source automatically publishes one no-phone email-fit canonical Firm into actual TodayV4, exact proof survives reload and reads never create', async ({ supplyPage: page }) => {
  const app = owned.app;
  const [seed] = await ingestAutomaticSupply(app, ['Ready']);
  const completed = await completeAutomaticSupply(app);
  expect(completed.calls()).toEqual({ fetches: 1, extractions: 1 });
  await loginAutomaticSupply(page, app);
  const exchange = app.fixture.google.tokenExchanges().at(-1)!;
  expect(exchange.clientSecretPresented).toBe(true);
  expect(app.fixture.google.jwksFetches()).toBeGreaterThan(0);
  const oidc = await app.fixture.db.query<{ code_challenge: string }>('SELECT code_challenge FROM oidc_authorization_requests ORDER BY created_at DESC LIMIT 1');
  expect(createHash('sha256').update(exchange.codeVerifier ?? '').digest('base64url')).toBe(oidc.rows[0]?.code_challenge);
  const action = await actionFor(page, seed!);
  const proof = (await open(page, action)).automaticResearch!;
  expect(proof).toMatchObject({ source: { kind: 'search_hit', attemptId: seed!.attemptId, sourceUrl: seed!.website }, ownerUserId: app.fixture.alpha.admin.userId, firmName: seed!.name, website: seed!.website, locality: seed!.locality, region: seed!.region, emailFit: 'eligible', channelAuthority: 'not_granted', maintenanceNeed: 'not_established', nextStep: 'prepare_discovery_conversation' });
  expect(proof.target).toEqual(action.target);
  const currentCandidate = (await app.fixture.db.query<{ revision: number }>('SELECT revision FROM sourcing_candidates WHERE id=$1', [seed!.candidateId])).rows[0]!;
  expect(currentCandidate.revision).toBeGreaterThanOrEqual(seed!.candidateRevision);
  expect(proof.target).toMatchObject({ candidateId: seed!.candidateId, candidateRevision: currentCandidate.revision, publicationRevision: 1 });
  const lineage = (await publications(seed!))[0]!;
  expect(lineage).toMatchObject({ id: proof.target.publicationId, firm_id: proof.target.firmId, run_id: proof.target.runId, candidate_revision: currentCandidate.revision, owner_user_id: proof.ownerUserId, source_attempt_id: seed!.attemptId, evidence_fingerprint: proof.target.evidenceFingerprint });
  const run = (await app.fixture.db.query<{ observations: { id: string; url: string; contentHash: string; blocks: { id: string; text: string }[] }[]; facts: { kind: string }[] }>('SELECT observations,facts FROM sourcing_qualification_runs WHERE id=$1', [proof.target.runId])).rows[0]!;
  expect(run.facts.some(fact => fact.kind === 'business_phone')).toBe(false);
  for (const citation of proof.citations) {
    const observation = run.observations.find(row => row.id === citation.observationId)!;
    expect(citation).toMatchObject({ url: observation.url, contentHash: observation.contentHash, quote: observation.blocks.find(block => block.id === citation.blockId)!.text });
  }
  const count = (await app.fixture.db.query('SELECT id FROM firms WHERE workspace_id=$1', [app.fixture.alpha.workspaceId])).rows;
  const readState = async () => (await app.fixture.db.query('SELECT (SELECT count(*) FROM sourcing_automatic_research_firms) AS publications,(SELECT count(*) FROM jobs) AS jobs,(SELECT count(*) FROM command_receipts) AS receipts')).rows;
  const readBaseline = await readState();
  await page.reload();
  const opened = page.waitForResponse(response => response.url().endsWith('/browser/api/today/actions/open/v4'));
  await page.getByRole('article').filter({ hasText: seed!.name }).getByRole('button', { name: 'Review current research', exact: true }).click();
  expect(todayActionOpenV4ResponseSchema.parse(await (await opened).json()).automaticResearch).toMatchObject({ ...proof, checkedAt: expect.any(String) });
  await expect(page.getByRole('heading', { name: 'Current automatic research proof', exact: true })).toBeVisible();
  await expect(page.getByText(`Publication ${proof.target.publicationId} revision ${proof.target.publicationRevision}`, { exact: true })).toBeVisible();
  await expect(page.getByText(`Source ${proof.source.kind} · Attempt ${proof.source.attemptId} · ${proof.source.sourceUrl}`, { exact: true })).toBeVisible();
  for (const citation of proof.citations) await expect(page.getByText(citation.quote, { exact: true }).first()).toBeVisible();
  for (let i = 0; i < 2; i += 1) expect((await open(page, action)).automaticResearch).toMatchObject({ ...proof, checkedAt: expect.any(String) });
  expect((await app.fixture.db.query('SELECT id FROM firms WHERE workspace_id=$1', [app.fixture.alpha.workspaceId])).rows).toEqual(count);
  expect(await readState()).toEqual(readBaseline);
  expect(await publications(seed!)).toHaveLength(1);
  const storage = await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }));
  for (const privateText of [seed!.name, seed!.website, 'citations', proof.target.evidenceFingerprint]) expect(storage).not.toContain(privateText);
  await noAuthority(proof);
});

test('lost runner completion after committed qualification recovers after owner refusal and concurrent publication without provider redispatch or duplicate canonical identity', async ({ supplyPage: page }) => {
  const app = owned.app, f = app.fixture;
  await f.db.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT(workspace_id,user_id) DO UPDATE SET role='admin'", [f.alpha.workspaceId, f.alpha.outsider.userId]);
  const [seed] = await ingestAutomaticSupply(app, ['Recovery']);
  const completed = await completeAutomaticSupply(app, { loseCompletion: true, afterExtraction: async () => { await f.db.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2", [f.alpha.workspaceId, f.alpha.admin.userId]); } });
  expect(completed.calls()).toEqual({ fetches: 1, extractions: 1 });
  expect(completed.completionLost).toBe(true);
  expect((await f.db.query("SELECT state FROM jobs WHERE workspace_id=$1 AND kind='sourcing.qualify' AND payload->>'candidateId'=$2", [f.alpha.workspaceId, seed!.candidateId])).rows).toEqual([{ state: 'running' }]);
  expect(await publications(seed!)).toEqual([]);
  expect((await f.db.query('SELECT state,reason FROM sourcing_qualification_runs WHERE candidate_id=$1', [seed!.candidateId])).rows).toEqual([{ state: 'review', reason: null }]);
  await f.db.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [f.alpha.workspaceId, f.alpha.admin.userId]);
  await completed.recover();
  await loginAutomaticSupply(page, app);
  const action = await actionFor(page, seed!);
  const proof = (await open(page, action)).automaticResearch!;
  const other = await f.database.appRuntimeSession();
  // TestDatabase owns and disconnects this independent runtime session at teardown.
  const { runSchedulerPass } = await import('../../../worker/src/scheduler/schedulerPass.ts');
  const { sourcingQualificationSource } = await import('../../../worker/src/handlers/sourcingQualification.ts');
  await Promise.all([completed.recover(), runSchedulerPass(other, { sources: [sourcingQualificationSource(true)], now: new Date().toISOString() })]);
  await completed.recover();
  const { advanceAutomaticResearchFirm } = await import('@fss/domain/sourcing/automaticResearch.ts');
  const { repositoryContext, workspaceScope } = await import('@fss/domain/db/workspaceScope.ts');
  const otherContext = repositoryContext(workspaceScope(f.alpha.workspaceId, { kind: 'system', component: 'scheduler' }), other);
  await Promise.all([
    withTransaction(f.db, () => advanceAutomaticResearchFirm(supplyContext(app), { runId: proof.target.runId })),
    withTransaction(other, () => advanceAutomaticResearchFirm(otherContext, { runId: proof.target.runId })),
  ]);
  expect(await publications(seed!)).toHaveLength(1);
  expect((await f.db.query('SELECT id FROM firms WHERE workspace_id=$1 AND website=$2', [f.alpha.workspaceId, seed!.website])).rows).toEqual([{ id: proof.target.firmId }]);
  expect(completed.calls()).toEqual({ fetches: 1, extractions: 1 });
  expect((await f.db.query('SELECT 1 FROM provider_reservations WHERE subject_id=$1', [proof.target.runId])).rows).toHaveLength(1);
  await noAuthority(proof);
});

test('current source, candidate, run, owner, settings and hold changes refuse exact existing targets without creation', async ({ supplyPage: page }) => {
  const app = owned.app, f = app.fixture;
  await f.db.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT(workspace_id,user_id) DO UPDATE SET role='admin'", [f.alpha.workspaceId, f.alpha.outsider.userId]);
  const seeds = await ingestAutomaticSupply(app, ['Source', 'Revision', 'Run', 'Owner', 'Settings']);
  await completeAutomaticSupply(app);
  await loginAutomaticSupply(page, app);
  for (const seed of seeds) {
    const action = await actionFor(page, seed);
    if (seed.name.endsWith('Source')) await f.db.query("UPDATE sourcing_discovery_hits SET native_result=jsonb_set(native_result,'{url}','\"https://unrelated.example.test/\"') WHERE candidate_id=$1", [seed.candidateId]);
    if (seed.name.endsWith('Revision')) await f.db.query('UPDATE sourcing_candidates SET revision=revision+1 WHERE id=$1', [seed.candidateId]);
    if (seed.name.endsWith('Run')) await f.db.query("UPDATE sourcing_qualification_runs SET policy_version='qualification-v4' WHERE candidate_id=$1", [seed.candidateId]);
    if (seed.name.endsWith('Owner')) await f.db.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2", [f.alpha.workspaceId, f.alpha.admin.userId]);
    if (seed.name.endsWith('Settings')) await f.db.query('UPDATE research_settings SET enabled=false WHERE workspace_id=$1', [f.alpha.workspaceId]);
    try { await refused(page, action); }
    finally {
      await f.db.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [f.alpha.workspaceId, f.alpha.admin.userId]);
      await f.db.query('UPDATE research_settings SET enabled=true WHERE workspace_id=$1', [f.alpha.workspaceId]);
    }
  }
  const settingsSeed = seeds.find(seed => seed.name.endsWith('Settings'))!;
  const settingsAction = await actionFor(page, settingsSeed);
  for (const change of ['automatic_approval', 'reviewed_evaluation', 'owner_assignment'] as const) {
    await test.step(change, async () => {
      if (change === 'automatic_approval') await f.db.query('UPDATE sourcing_discovery_settings SET auto_admission_enabled=false WHERE workspace_id=$1', [f.alpha.workspaceId]);
      if (change === 'reviewed_evaluation') await f.db.query("UPDATE sourcing_discovery_settings SET qualification_evaluation='{}'::jsonb WHERE workspace_id=$1", [f.alpha.workspaceId]);
      if (change === 'owner_assignment') await f.db.query('UPDATE sourcing_discovery_settings SET owner_user_id=$2 WHERE workspace_id=$1', [f.alpha.workspaceId, f.alpha.salesperson.userId]);
      try { await refused(page, settingsAction); }
      finally { await f.db.query('UPDATE sourcing_discovery_settings SET auto_admission_enabled=true,qualification_evaluation=$2::jsonb,owner_user_id=$3 WHERE workspace_id=$1', [f.alpha.workspaceId, JSON.stringify(supplyEvaluation), f.alpha.admin.userId]); }
    });
  }
  const [seed] = await ingestAutomaticSupply(app, ['Held']);
  await completeAutomaticSupply(app);
  const action = await actionFor(page, seed!);
  const hold = await withTransaction(f.db, () => openHold(supplyContext(app), { scopeKind: 'channel', scopeKey: 'research', reasonCode: 'scoped_pause', blockedActionKinds: ['research'], sourceEventKind: 'automatic_supply_test' }));
  await refused(page, action);
  await withTransaction(f.db, () => releaseHold(supplyContext(app), hold));
});

test('independent native and email evidence expire on fresh database wall time after waits, not fixture auth time', async ({ supplyPage: page }) => {
  const app = owned.app, f = app.fixture;
  const seeds = await ingestAutomaticSupply(app, ['NativeExpiry', 'EmailExpiry']);
  await completeAutomaticSupply(app);
  await loginAutomaticSupply(page, app);
  for (const seed of seeds) {
    const index = seed.name.endsWith('NativeExpiry') ? 0 : 1;
    const action = await actionFor(page, seed);
    expect(action.target.kind).toBe('automatic_research');
    // Native and email are independently retained observations. Refresh publication
    // against an otherwise current proof whose selected observation expires soon.
    await f.db.query("UPDATE sourcing_qualification_runs SET observations=jsonb_set(observations,ARRAY[$2::text,'retrievedAt'],to_jsonb(to_char((clock_timestamp()-interval '7 days'+interval '4 seconds') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))) WHERE candidate_id=$1", [seed.candidateId, index]);
    await f.db.query('UPDATE sourcing_qualification_runs SET admission_checked_at=NULL WHERE candidate_id=$1', [seed.candidateId]);
    await supplyPass(app);
    const fresh = await actionFor(page, seed);
    const proof = (await open(page, fresh)).automaticResearch!;
    expect(Date.parse(proof.validUntil) - Date.now()).toBeLessThanOrEqual(4000);
    const blocker = await f.database.appRuntimeSession();
    const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await blocker.query('BEGIN');
    let pending: ReturnType<typeof open> | undefined;
    try {
      await blocker.query('SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE', [f.alpha.workspaceId, f.alpha.admin.userId]);
      pending = open(page, fresh);
      await expect.poll(async () => (await f.db.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [blockerPid])).rows.length).toBeGreaterThan(0);
      await blocker.query('SELECT pg_sleep(4.1)');
    } finally { await blocker.query('ROLLBACK'); }
    expect(await pending).toEqual({ version: 4, target: null, research: null, automaticResearch: null });
    await refused(page, fresh);
  }
});

test('ambiguous evidence and raw discovery-v1 stay internal, source/Firm deletion removes visibility but reads never recreate', async ({ supplyPage: page }) => {
  const app = owned.app, f = app.fixture;
  const seeds = await ingestAutomaticSupply(app, ['Ambiguous', 'Raw', 'DeleteSource', 'DeleteFirm']);
  const raw = seeds.find(row => row.name.endsWith('Raw'))!;
  await f.db.query("UPDATE sourcing_candidates SET payload='{" + '"kind":"discovery-v1"' + "}'::jsonb WHERE id=$1", [raw.candidateId]);
  const ambiguous = seeds.find(row => row.name.endsWith('Ambiguous'))!;
  const completed = await completeAutomaticSupply(app, { ambiguous: ambiguous.name });
  await loginAutomaticSupply(page, app);
  for (const seed of [raw, ambiguous]) {
    expect(await publications(seed)).toEqual([]);
    expect((await queue(page)).actions.some(row => row.target.kind === 'automatic_research' && row.target.candidateId === seed.candidateId)).toBe(false);
  }
  expect((await f.db.query('SELECT 1 FROM sourcing_qualification_runs WHERE candidate_id=$1', [raw.candidateId])).rows).toEqual([]);
  for (const seed of seeds.filter(row => row.name.includes('Delete'))) {
    const action = await actionFor(page, seed);
    const proof = (await open(page, action)).automaticResearch!;
    if (seed.name.endsWith('DeleteSource')) await f.db.query('DELETE FROM sourcing_discovery_hits WHERE candidate_id=$1', [seed.candidateId]);
    else await deleteAutomaticSupplyFirm(app, proof.target.firmId);
    await refused(page, action);
    await page.reload();
    await refused(page, action);
    expect(await publications(seed)).toEqual([]);
    await completed.recover();
    await refused(page, action);
    expect(await publications(seed)).toEqual([]);
    if (seed.name.endsWith('DeleteFirm')) expect((await f.db.query('SELECT name,website FROM firms WHERE id=$1', [proof.target.firmId])).rows).toEqual([{ name: '[deleted]', website: null }]);
    expect((await f.db.query('SELECT id FROM firms WHERE id=$1', [app.alphaFirmId])).rows).toHaveLength(1);
  }
});

test('existing Apollo organization intake completes registered qualification into exact automatic proof, immutable lineage and no campaign authority', async ({ supplyPage: page }) => {
  const app = owned.app, f = app.fixture;
  const seed = await ingestAutomaticApolloSupply(app);
  const completed = await completeAutomaticSupply(app);
  expect(completed.calls()).toEqual({ fetches: 1, extractions: 1 });
  await loginAutomaticSupply(page, app);
  const action = await actionFor(page, seed);
  const proof = (await open(page, action)).automaticResearch!;
  expect(proof).toMatchObject({ source: { kind: 'apollo_organization', attemptId: seed.attemptId, sourceUrl: seed.website }, ownerUserId: f.alpha.admin.userId, emailFit: 'eligible', channelAuthority: 'not_granted' });
  expect(proof.target).toEqual(action.target);
  await page.reload();
  await page.getByRole('article').filter({ hasText: seed.name }).getByRole('button', { name: 'Review current research', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Current automatic research proof', exact: true })).toBeVisible();
  await expect(withTransaction(f.db, () => f.db.query('UPDATE sourcing_automatic_research_firms SET source_attempt_id=$2,revision=revision+1 WHERE id=$1', [proof.target.publicationId, seed.candidateId]))).rejects.toMatchObject({ code: '23514' });
  await noAuthority(proof);
  await f.db.query('DELETE FROM sourcing_apollo_candidate_origins WHERE workspace_id=$1 AND candidate_id=$2', [f.alpha.workspaceId, seed.candidateId]);
  await refused(page, action);
  await completed.recover();
  expect(await publications(seed)).toEqual([]);
  expect(completed.calls()).toEqual({ fetches: 1, extractions: 1 });
});

test('real auth revocation and late successful proof cannot resurrect private automatic projections across logout or identity transition', async ({ supplyPage: page }) => {
  const app = owned.app, f = app.fixture;
  const [seed] = await ingestAutomaticSupply(app, ['LateAuth']);
  await completeAutomaticSupply(app);
  await loginAutomaticSupply(page, app);
  const action = await actionFor(page, seed!);
  let release = () => {}, seen = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const received = new Promise<void>(resolve => { seen = resolve; });
  await page.route('**/browser/api/today/actions/open/v4', async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    seen(); await held; await route.fulfill({ response });
  }, { times: 1 });
  const second = await page.context().newPage();
  await second.goto(app.origin);
  await page.getByRole('article').filter({ hasText: seed!.name }).getByRole('button', { name: 'Review current research', exact: true }).click();
  await received;
  const delivered = page.waitForResponse(response => response.url().endsWith('/browser/api/today/actions/open/v4'));
  try {
    await second.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
  } finally { release(); }
  expect((await delivered).status()).toBe(200);
  await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  await expect(page.getByRole('heading', { name: 'Current automatic research proof', exact: true })).toHaveCount(0);
  await loginAutomaticSupply(page, app, true);
  expect((await queue(page)).actions.some(row => row.actionId === action.actionId)).toBe(false);
  await expect(page.getByText(seed!.name, { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await loginAutomaticSupply(page, app);
  const session = await browserSession(page);
  if (session.status !== 'signed_in') throw new Error('Expected signed OIDC session');
  await f.db.query("UPDATE devices SET status='revoked',revoked_at=now() WHERE workspace_id=$1 AND id=$2", [session.workspaceId, session.deviceId]);
  expect((await browserRequest(page, '/today/actions/open/v4', { body: { actionId: action.actionId, target: action.target } })).status).not.toBe(200);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Current automatic research proof', exact: true })).toHaveCount(0);
  await second.close();
});
