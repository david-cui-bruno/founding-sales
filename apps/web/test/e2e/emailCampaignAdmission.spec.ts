import { createHash, randomUUID } from 'node:crypto';
import type { Page } from 'playwright/test';
import { emailCampaignControlSchema, emailCampaignCommandResultSchema, qualifiedResearchFirmSchema, qualifiedResearchListSchema, type EmailCampaignPolicy } from '@fss/contracts';
import { browserRequest, browserSession } from '../support/browser.ts';
import { test, expect, startEmailCampaignApp, routeCampaignProvider, loginCampaign } from '../support/emailCampaignApp.ts';
import { seedEmailCampaign, seedCampaignResearch } from '../support/emailCampaignSeed.ts';
import { suppressCampaignAddress, confirmCampaignReply } from '../support/emailCampaignStops.ts';
import { checkCampaignConstraints } from '../support/emailCampaignConstraints.ts';

let owned: Awaited<ReturnType<typeof startEmailCampaignApp>>;
const base = '/outreach/email-campaigns';
const pendingKey = 'callie.browser.pending-campaign.v1';
const stored = async (page: Page) => await page.evaluate(key => sessionStorage.getItem(key), pendingKey);
const control = async (page: Page) => {
  const response = await browserRequest(page, `${base}/control`, { body: {} });
  expect(response.status).toBe(200);
  expect(response.cache).toContain('no-store');
  return emailCampaignControlSchema.parse(response.body);
};
async function approve(page: Page, policy: EmailCampaignPolicy) {
  const payload = { ...policy, commandId: randomUUID() };
  const response = await browserRequest(page, `${base}/approve`, { body: payload });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return { ...emailCampaignCommandResultSchema.parse((response.body as { result: unknown }).result), payload };
}
async function create(page: Page, suffix: string) {
  const seed = await seedCampaignResearch(owned.app, suffix);
  const payload = { ...seed.selection, commandId: randomUUID() };
  const response = await browserRequest(page, '/sourcing/research-firms/create', { body: payload });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return { seed, payload, firm: qualifiedResearchFirmSchema.parse((response.body as { result: unknown }).result) };
}
async function off() {
  const f = owned.app.fixture;
  expect((await f.db.query('SELECT 1 FROM outbound_messages WHERE workspace_id=$1', [f.alpha.workspaceId])).rows).toEqual([]);
  expect((await f.db.query('SELECT 1 FROM outreach_settings WHERE workspace_id=$1 AND routine_replies_enabled', [f.alpha.workspaceId])).rows).toEqual([]);
  expect((await f.db.query('SELECT 1 FROM outreach_email_admission_settings WHERE workspace_id=$1 AND enabled', [f.alpha.workspaceId])).rows).toEqual([]);
  expect((await f.db.query("SELECT 1 FROM workspace_settings WHERE workspace_id=$1 AND setting_key='sending_enabled' AND value->>'enabled'='true'", [f.alpha.workspaceId])).rows).toEqual([]);
  expect((await f.db.query('SELECT 1 FROM sending_domains WHERE workspace_id=$1 AND automated_sending_enabled', [f.alpha.workspaceId])).rows).toEqual([]);
}
test.afterEach(async ({ campaignPage: page }) => {
  await page.context().close();
  if (owned) {
    try {
      await expect.poll(async () => Number((await owned.app.fixture.db.query<{ count: string }>("SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()" )).rows[0]?.count)).toBe(0);
    } finally { await owned.stop(); }
  }
});
test.beforeEach(async ({ campaignPage: page }) => {
  owned = await startEmailCampaignApp();
  await routeCampaignProvider(page, owned.app);
  await loginCampaign(page, owned.app);
  for (const campaign of (await control(page)).campaigns.filter(row => row.revokedAt === null)) {
    expect((await browserRequest(page, `${base}/revoke`, { body: { id: campaign.id, expectedRevision: campaign.revision, commandId: randomUUID() } })).status).toBe(200);
  }
});
async function fillPolicy(page: Page, policy: EmailCampaignPolicy) {
  await page.getByRole('button', { name: 'Refresh campaigns', exact: true }).click();
  await page.getByLabel('Approved sender', { exact: true }).selectOption(policy.mailboxId);
  await page.getByLabel('Approved email sequence', { exact: true }).selectOption(policy.sequenceVersionId);
  for (const region of ['TX', 'RI', 'MA']) await page.getByLabel(region, { exact: true }).setChecked(policy.regions.includes(region as 'TX' | 'RI' | 'MA'));
  await page.getByLabel('Daily admission limit', { exact: true }).fill(String(policy.dailyAdmissionLimit));
  await page.getByLabel('Lifetime enrollment cap', { exact: true }).fill(String(policy.maxEnrollments));
  await page.getByLabel('Campaign expiry', { exact: true }).fill(policy.expiresAt.slice(0, 16));
}

test('one explicit campaign approval automatically enrolls a NEW qualified canonical Firm, exact IDs survive reload and OFF stays unchanged', async ({ campaignPage: page }) => {
  const { policy } = await seedEmailCampaign(owned.app);
  const exchange = owned.app.fixture.google.tokenExchanges().at(-1);
  expect(exchange?.clientSecretPresented).toBe(true);
  expect(owned.app.fixture.google.jwksFetches()).toBeGreaterThan(0);
  const oidc = await owned.app.fixture.db.query<{ code_challenge: string }>('SELECT code_challenge FROM oidc_authorization_requests ORDER BY created_at DESC LIMIT 1');
  expect(createHash('sha256').update(exchange?.codeVerifier ?? '').digest('base64url')).toBe(oidc.rows[0]?.code_challenge);
  await fillPolicy(page, policy);
  const approved = page.waitForResponse(response => response.url().endsWith(`${base}/approve`));
  await page.getByRole('button', { name: 'Approve campaign once', exact: true }).click();
  const response = await approved;
  expect(response.status()).toBe(200);
  const approval = emailCampaignCommandResultSchema.parse((await response.json() as { result: unknown }).result);
  expect((await control(page)).admissions).toEqual([]);
  const seed = await seedCampaignResearch(owned.app, 'New-After-Approval');
  const candidates = qualifiedResearchListSchema.parse((await browserRequest(page, '/sourcing/research-firms/list', { body: {} })).body);
  expect(candidates.candidates.find(row => row.selection.candidateId === seed.selection.candidateId)).toMatchObject({ emailFit: 'eligible', channelAuthority: 'not_granted', maintenanceNeed: 'not_established' });
  await page.getByRole('button', { name: 'Load research candidates', exact: true }).click();
  const created = page.waitForResponse(result => result.url().endsWith('/sourcing/research-firms/create'));
  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: seed.name, exact: true }) }).getByRole('button', { name: 'Create research Firm', exact: true }).click();
  const firm = qualifiedResearchFirmSchema.parse((await (await created).json() as { result: unknown }).result);
  const current = await control(page);
  const admission = current.admissions.find(row => row.firmId === firm.firmId);
  expect(admission).toMatchObject({ campaignId: approval.campaignId, candidateId: seed.selection.candidateId, qualificationRunId: seed.selection.runId });
  expect(admission).toBeDefined();
  const db = owned.app.fixture.db;
  for (const [table, id] of [['contacts', admission!.contactId], ['email_addresses', admission!.routeId], ['outreach_plans', admission!.planId], ['sequence_enrollments', admission!.enrollmentId]]) {
    expect((await db.query(`SELECT id FROM ${table} WHERE workspace_id=$1 AND firm_id=$2`, [owned.app.fixture.alpha.workspaceId, firm.firmId])).rows).toEqual([{ id }]);
  }
  expect((await db.query('SELECT 1 FROM step_executions WHERE enrollment_id=$1', [admission!.enrollmentId])).rows).toHaveLength(1);
  expect((await db.query('SELECT reviewed,campaign_id FROM outreach_email_sources WHERE candidate_id=$1', [seed.selection.candidateId])).rows).toEqual([{ reviewed: false, campaign_id: approval.campaignId }]);
  await checkCampaignConstraints(owned.app, admission!);
  await page.reload();
  expect((await control(page)).admissions.find(row => row.firmId === firm.firmId)).toEqual(admission);
  await off();
});

test('lost COMMITTED approval response preserves exact pending UUID/payload, never auto-dispatches and explicit retry returns one policy', async ({ campaignPage: page }) => {
  const { policy } = await seedEmailCampaign(owned.app);
  await fillPolicy(page, policy);
  await page.route(`**/browser/api${base}/approve`, async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.abort('failed');
  }, { times: 1 });
  const request = page.waitForRequest(row => row.url().endsWith(`${base}/approve`));
  await page.getByRole('button', { name: 'Approve campaign once', exact: true }).click();
  const original = (await request).postDataJSON() as { commandId: string };
  await expect(page.getByRole('button', { name: 'Retry same campaign command', exact: true })).toBeEnabled();
  const raw = await stored(page);
  expect(raw).not.toBeNull();
  const pending = JSON.parse(raw!) as { commandId: string; action: { kind: string; policy: EmailCampaignPolicy }; expiresAt: string };
  expect(pending.commandId).toBe(original.commandId);
  expect(original).toEqual({ ...pending.action.policy, commandId: pending.commandId });
  expect(Object.keys(pending).sort()).toEqual(['identity', 'commandId', 'expiresAt', 'action'].sort());
  expect(raw).not.toMatch(/@|subject|body|citations|quote|accessToken|secret/iu);
  const session = await browserSession(page);
  if (session.status !== 'signed_in') throw new Error('Signed OIDC session required');
  expect(Date.parse(pending.expiresAt)).toBeLessThanOrEqual(Date.parse(session.expiresAt));
  let dispatches = 0;
  page.on('request', row => { if (row.url().endsWith(`${base}/approve`)) dispatches += 1; });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry same campaign command', exact: true })).toBeEnabled();
  expect(dispatches).toBe(0);
  expect(await stored(page)).toBe(raw);
  const replay = page.waitForResponse(row => row.url().endsWith(`${base}/approve`));
  await page.getByRole('button', { name: 'Retry same campaign command', exact: true }).click();
  const response = await replay;
  expect(response.request().postDataJSON()).toEqual(original);
  expect(await response.json()).toMatchObject({ replayed: true });
  expect((await owned.app.fixture.db.query('SELECT 1 FROM command_receipts WHERE command_id=$1', [original.commandId])).rows).toHaveLength(1);
  expect((await control(page)).campaigns.filter(row => row.revokedAt === null)).toHaveLength(1);
  await off();
});

test('bounded existing canonical backlog and lifetime cap, replay and duplicate creation converge without recipient approval', async ({ campaignPage: page }) => {
  const a = await create(page, 'Backlog-A');
  const b = await create(page, 'Backlog-B');
  const c = await create(page, 'Backlog-C');
  const { policy } = await seedEmailCampaign(owned.app, { maxEnrollments: 2, dailyAdmissionLimit: 2 });
  const approval = await approve(page, policy);
  const admitted = (await control(page)).admissions.filter(row => row.campaignId === approval.campaignId);
  expect(admitted).toHaveLength(2);
  expect(admitted.every(row => [a.firm.firmId, b.firm.firmId, c.firm.firmId].includes(row.firmId))).toBe(true);
  const later = await create(page, 'Over-Lifetime-Cap');
  expect((await control(page)).admissions.some(row => row.firmId === later.firm.firmId)).toBe(false);
  const replay = await browserRequest(page, `${base}/approve`, { body: approval.payload });
  expect(replay.status).toBe(200);
  expect((await control(page)).admissions.filter(row => row.campaignId === approval.campaignId)).toEqual(admitted);
  await off();
});

for (const change of ['revoked', 'mailbox_revision', 'retired_template', 'region', 'source', 'candidate_revision', 'owner', 'suppression', 'stale_evidence', 'ambiguous'] as const) {
  test(`current ${change} prevents automatic admission without partial recipient writes`, async ({ campaignPage: page }) => {
    const { policy, templateIds } = await seedEmailCampaign(owned.app, change === 'region' ? { regions: ['RI'] } : {});
    const approval = await approve(page, policy);
    const seed = await seedCampaignResearch(owned.app, `Refusal-${change.replaceAll('_', '-')}`, change === 'ambiguous');
    const f = owned.app.fixture;
    if (change === 'revoked') expect((await browserRequest(page, `${base}/revoke`, { body: { id: approval.campaignId, expectedRevision: 1, commandId: randomUUID() } })).status).toBe(200);
    if (change === 'mailbox_revision') await f.db.query('UPDATE gmail_prospecting_authorizations SET revision=revision+1 WHERE mailbox_id=$1', [policy.mailboxId]);
    if (change === 'retired_template') await f.db.query('UPDATE template_versions SET retired_at=now() WHERE id=$1', [templateIds[0]]);
    if (change === 'source') await f.db.query('DELETE FROM sourcing_candidate_discovery_origins WHERE candidate_id=$1', [seed.selection.discoveryCandidateId]);
    if (change === 'candidate_revision') await f.db.query('UPDATE sourcing_candidates SET revision=revision+1 WHERE id=$1', [seed.selection.candidateId]);
    if (change === 'suppression') await suppressCampaignAddress(owned.app, seed.email);
    if (change === 'stale_evidence') await f.db.query("UPDATE sourcing_qualification_runs SET observations=(SELECT jsonb_agg(o || jsonb_build_object('retrievedAt',to_jsonb((now()-interval '8 days')::text))) FROM jsonb_array_elements(observations) o) WHERE id=$1", [seed.selection.runId]);
    if (change === 'owner') {
      await f.db.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')", [f.alpha.workspaceId, f.alpha.outsider.userId]);
      await f.db.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2", [f.alpha.workspaceId, f.alpha.admin.userId]);
    }
    const response = await browserRequest(page, '/sourcing/research-firms/create', { body: { ...seed.selection, commandId: randomUUID() } });
    if (change === 'source' || change === 'candidate_revision' || change === 'owner' || change === 'stale_evidence' || change === 'ambiguous') expect(response.status).not.toBe(200);
    else {
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const firm = qualifiedResearchFirmSchema.parse((response.body as { result: unknown }).result);
      for (const table of ['contacts', 'email_addresses', 'outreach_plans', 'sequence_enrollments']) expect((await f.db.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1 AND firm_id=$2`, [f.alpha.workspaceId, firm.firmId])).rows, table).toEqual([]);
    }
    expect((await f.db.query('SELECT 1 FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND campaign_id=$2', [f.alpha.workspaceId, approval.campaignId])).rows).toEqual([]);
    await off();
  });
}

test('late campaign control and cross-tab logout cannot resurrect pending approval or current private projections', async ({ campaignPage: page }) => {
  const { policy } = await seedEmailCampaign(owned.app);
  await fillPolicy(page, policy);
  await page.route(`**/browser/api${base}/approve`, async route => { await route.abort('failed'); }, { times: 1 });
  await page.getByRole('button', { name: 'Approve campaign once', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry same campaign command', exact: true })).toBeEnabled();
  const raw = await stored(page);
  expect(raw).not.toBeNull();
  const pending = JSON.parse(raw!) as { commandId: string };
  const second = await page.context().newPage();
  await second.goto(owned.app.origin);
  await expect(second.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  let release = () => {};
  let observed = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  const received = new Promise<void>(resolve => { observed = resolve; });
  await page.route(`**/browser/api${base}/control`, async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    observed();
    await hold;
    await route.fulfill({ response });
  }, { times: 1 });
  await page.getByRole('button', { name: 'Refresh campaigns', exact: true }).click();
  await received;
  try {
    await second.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
    await expect.poll(() => stored(page)).toBeNull();
  } finally { release(); }
  await expect(page.getByRole('button', { name: 'Retry same campaign command', exact: true })).toHaveCount(0);
  expect((await owned.app.fixture.db.query('SELECT 1 FROM command_receipts WHERE command_id=$1', [pending.commandId])).rows).toEqual([]);
  await loginCampaign(page, owned.app, true);
  expect((await control(page)).campaigns).toEqual([]);
  await second.close();
  await off();
});

for (const disposition of ['not_interested', 'opt_out'] as const) {
  test(`ordinary confirmed ${disposition} terminally stops campaign enrollment and exact creation replay cannot restart it`, async ({ campaignPage: page }) => {
    const { policy } = await seedEmailCampaign(owned.app);
    await approve(page, policy);
    const created = await create(page, `Reply-${disposition.replaceAll('_', '-')}`);
    const admission = (await control(page)).admissions.find(row => row.firmId === created.firm.firmId);
    expect(admission).toBeDefined();
    await confirmCampaignReply(owned.app, policy.mailboxId, created.seed.email, admission!, disposition);
    const stopped = await owned.app.fixture.db.query('SELECT state,ended_at FROM sequence_enrollments WHERE id=$1', [admission!.enrollmentId]);
    expect(stopped.rows[0]).toMatchObject({ state: 'stopped' });
    expect(stopped.rows[0]?.['ended_at']).not.toBeNull();
    expect((await browserRequest(page, '/sourcing/research-firms/create', { body: created.payload })).status).toBe(200);
    expect((await owned.app.fixture.db.query('SELECT id,state FROM sequence_enrollments WHERE firm_id=$1', [created.firm.firmId])).rows).toEqual([{ id: admission!.enrollmentId, state: 'stopped' }]);
    await off();
  });
}

test('owner daily admission allowance survives revoke and replacement policy instead of resetting the daily count', async ({ campaignPage: page }) => {
  const { policy } = await seedEmailCampaign(owned.app, { dailyAdmissionLimit: 1 });
  const first = await approve(page, policy);
  const admitted = await create(page, 'Daily-First');
  expect((await control(page)).admissions.some(row => row.firmId === admitted.firm.firmId)).toBe(true);
  expect((await browserRequest(page, `${base}/revoke`, { body: { id: first.campaignId, expectedRevision: 1, commandId: randomUUID() } })).status).toBe(200);
  const replacement = await approve(page, policy);
  const blocked = await create(page, 'Daily-Replacement');
  expect((await control(page)).admissions.some(row => row.firmId === blocked.firm.firmId)).toBe(false);
  expect((await control(page)).campaigns.find(row => row.id === replacement.campaignId)?.admittedCount).toBe(0);
  await off();
});

test('two concurrent actual create commands converge to one canonical Firm/contact/route/plan/enrollment/admission', async ({ campaignPage: page }) => {
  const { policy } = await seedEmailCampaign(owned.app);
  const approval = await approve(page, policy);
  const seed = await seedCampaignResearch(owned.app, 'Concurrent-Canonical');
  const responses = await Promise.all([randomUUID(), randomUUID()].map(commandId => browserRequest(page, '/sourcing/research-firms/create', { body: { ...seed.selection, commandId } })));
  for (const response of responses) expect(response.status, JSON.stringify(response.body)).toBe(200);
  const firms = responses.map(response => qualifiedResearchFirmSchema.parse((response.body as { result: unknown }).result));
  expect(firms[0]?.firmId).toBe(firms[1]?.firmId);
  const admissions = (await control(page)).admissions.filter(row => row.campaignId === approval.campaignId);
  expect(admissions).toHaveLength(1);
  const f = owned.app.fixture;
  expect((await f.db.query('SELECT id FROM firms WHERE workspace_id=$1 AND name=$2', [f.alpha.workspaceId, seed.name])).rows).toEqual([{ id: firms[0]!.firmId }]);
  for (const table of ['contacts', 'email_addresses', 'outreach_plans', 'sequence_enrollments']) expect((await f.db.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1 AND firm_id=$2`, [f.alpha.workspaceId, firms[0]!.firmId])).rows, table).toHaveLength(1);
  await off();
});

test('unknown failure at durable admission insertion rolls back the whole parent honestly, never leaving partial recipient or canonical writes', async ({ campaignPage: page }) => {
  const { policy } = await seedEmailCampaign(owned.app);
  await approve(page, policy);
  const seed = await seedCampaignResearch(owned.app, 'Rollback-Unknown');
  const f = owned.app.fixture;
  // Disposable DB-only fault at the last write, after ordinary contact/plan/enroll
  // composition. No product source hook or alternate admission implementation.
  await f.db.query("CREATE FUNCTION campaign_acceptance_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled campaign acceptance rollback'; END; $$");
  await f.db.query('CREATE TRIGGER campaign_acceptance_fail BEFORE INSERT ON outreach_email_campaign_admissions FOR EACH ROW EXECUTE FUNCTION campaign_acceptance_fail()');
  const commandId = randomUUID();
  try {
    const result = await browserRequest(page, '/sourcing/research-firms/create', { body: { ...seed.selection, commandId } });
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: 'browser_request_refused' });
    expect((await f.db.query('SELECT 1 FROM firms WHERE workspace_id=$1 AND name=$2', [f.alpha.workspaceId, seed.name])).rows).toEqual([]);
    expect((await f.db.query('SELECT 1 FROM outreach_email_campaign_admissions WHERE workspace_id=$1', [f.alpha.workspaceId])).rows).toEqual([]);
    expect((await f.db.query('SELECT 1 FROM outreach_email_sources WHERE candidate_id=$1', [seed.selection.candidateId])).rows).toEqual([]);
    expect((await f.db.query('SELECT 1 FROM command_receipts WHERE command_id=$1', [commandId])).rows).toEqual([]);
    for (const table of ['contacts', 'email_addresses', 'outreach_plans', 'sequence_enrollments']) expect((await f.db.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1`, [f.alpha.workspaceId])).rows, table).toEqual([]);
  } finally {
    await f.db.query('DROP TRIGGER campaign_acceptance_fail ON outreach_email_campaign_admissions');
    await f.db.query('DROP FUNCTION campaign_acceptance_fail()');
  }
  await off();
});

test('expired approval never revives or admits a newly qualified Firm', async ({ campaignPage: page }) => {
  const { policy } = await seedEmailCampaign(owned.app);
  policy.expiresAt = new Date(Date.now() + 1_000).toISOString();
  const approval = await approve(page, policy);
  await expect.poll(async () => (await owned.app.fixture.db.query<{ expired: boolean }>('SELECT clock_timestamp()>expires_at AS expired FROM outreach_email_campaigns WHERE id=$1', [approval.campaignId])).rows[0]?.expired).toBe(true);
  const created = await create(page, 'After-Expiry');
  const current = await control(page);
  expect(current.campaigns.find(row => row.id === approval.campaignId)?.state).toBe('expired');
  expect(current.admissions.some(row => row.firmId === created.firm.firmId)).toBe(false);
  expect((await browserRequest(page, `${base}/approve`, { body: approval.payload })).status).toBe(200);
  expect((await control(page)).campaigns.find(row => row.id === approval.campaignId)?.state).toBe('expired');
  await off();
});

test('actual revoked device clears unresolved pending campaign custody and never dispatches a fresh or replacement command', async ({ campaignPage: page }) => {
  const { policy } = await seedEmailCampaign(owned.app);
  await fillPolicy(page, policy);
  await page.route(`**/browser/api${base}/approve`, async route => { await route.abort('failed'); }, { times: 1 });
  await page.getByRole('button', { name: 'Approve campaign once', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry same campaign command', exact: true })).toBeEnabled();
  expect(await stored(page)).not.toBeNull();
  const session = await browserSession(page);
  if (session.status !== 'signed_in') throw new Error('Signed-in device required');
  let dispatches = 0;
  page.on('request', request => { if (request.url().endsWith(`${base}/approve`)) dispatches += 1; });
  await owned.app.fixture.db.query("UPDATE devices SET status='revoked',revoked_at=now() WHERE workspace_id=$1 AND id=$2", [session.workspaceId, session.deviceId]);
  await page.reload();
  await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible();
  await expect.poll(() => stored(page)).toBeNull();
  expect(dispatches).toBe(0);
  expect((await owned.app.fixture.db.query('SELECT 1 FROM outreach_email_campaigns WHERE workspace_id=$1', [session.workspaceId])).rows).toEqual([]);
  await off();
});
