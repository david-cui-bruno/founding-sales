import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright/test';
import { emailCampaignControlSchema, emailCampaignCommandResultSchema, qualifiedResearchFirmSchema, type EmailCampaignPolicy } from '@fss/contracts';
import { browserRequest } from '../support/browser.ts';
import { test, expect, startEmailCampaignApp, routeCampaignProvider, loginCampaign } from '../support/emailCampaignApp.ts';
import { seedEmailCampaign, seedCampaignResearch } from '../support/emailCampaignSeed.ts';
import { deleteCampaignSubject, separateExpiringCampaignEmail, delayCampaignWrite } from '../support/emailCampaignReview.ts';

let owned: Awaited<ReturnType<typeof startEmailCampaignApp>>;
const base = '/outreach/email-campaigns';
async function control(page: Page) {
  const response = await browserRequest(page, `${base}/control`, { body: {} });
  expect(response.status).toBe(200);
  return emailCampaignControlSchema.parse(response.body);
}
async function approve(page: Page, policy: EmailCampaignPolicy) {
  const response = await browserRequest(page, `${base}/approve`, { body: { ...policy, commandId: randomUUID() } });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return emailCampaignCommandResultSchema.parse((response.body as { result: unknown }).result);
}
async function create(page: Page, suffix: string) {
  const seed = await seedCampaignResearch(owned.app, suffix);
  const response = await browserRequest(page, '/sourcing/research-firms/create', { body: { ...seed.selection, commandId: randomUUID() } });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return qualifiedResearchFirmSchema.parse((response.body as { result: unknown }).result);
}
async function noProvidersOrSending() {
  const f = owned.app.fixture;
  expect((await f.db.query('SELECT 1 FROM outbound_messages WHERE workspace_id=$1', [f.alpha.workspaceId])).rows).toEqual([]);
  expect((await f.db.query("SELECT 1 FROM workspace_settings WHERE workspace_id=$1 AND setting_key='sending_enabled' AND value->>'enabled'='true'", [f.alpha.workspaceId])).rows).toEqual([]);
}
test.beforeEach(async ({ campaignPage: page }) => {
  owned = await startEmailCampaignApp();
  await routeCampaignProvider(page, owned.app);
  await loginCampaign(page, owned.app);
});
test.afterEach(async ({ campaignPage: page }) => {
  await page.context().close();
  if (owned) {
    try {
      await expect.poll(async () => Number((await owned.app.fixture.db.query<{ count: string }>("SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()")).rows[0]?.count)).toBe(0);
    } finally { await owned.stop(); }
  }
});

for (const targetKind of ['contact', 'firm'] as const) {
  test(`finished review ordinary ${targetKind} deletion erases private campaign route/source but conserves opaque ledger and both caps`, async ({ campaignPage: page }) => {
    const { policy } = await seedEmailCampaign(owned.app, { maxEnrollments: 1, dailyAdmissionLimit: 5 });
    const campaign = await approve(page, policy);
    const firm = await create(page, `Review-Delete-${targetKind}`);
    const admission = (await control(page)).admissions.find(row => row.firmId === firm.firmId);
    expect(admission).toBeDefined();
    const f = owned.app.fixture;
    const before = (await f.db.query('SELECT * FROM outreach_email_campaign_admissions WHERE workspace_id=$1', [f.alpha.workspaceId])).rows;
    expect(before).toHaveLength(1);
    await deleteCampaignSubject(owned.app, admission!, targetKind);
    expect((await f.db.query('SELECT 1 FROM email_addresses WHERE workspace_id=$1 AND id=$2', [f.alpha.workspaceId, admission!.routeId])).rows).toEqual([]);
    expect((await f.db.query('SELECT 1 FROM outreach_email_sources WHERE workspace_id=$1 AND candidate_id=$2', [f.alpha.workspaceId, admission!.candidateId])).rows).toEqual([]);
    expect((await f.db.query('SELECT * FROM outreach_email_campaign_admissions WHERE workspace_id=$1', [f.alpha.workspaceId])).rows).toEqual(before);
    expect((await control(page)).campaigns.find(row => row.id === campaign.campaignId)?.admittedCount).toBe(1);
    const lifetimeBlocked = await create(page, `Review-Lifetime-${targetKind}`);
    expect((await control(page)).admissions.some(row => row.firmId === lifetimeBlocked.firmId)).toBe(false);
    expect((await browserRequest(page, `${base}/revoke`, { body: { id: campaign.campaignId, expectedRevision: 1, commandId: randomUUID() } })).status).toBe(200);
    const replacement = await approve(page, { ...policy, maxEnrollments: 25, dailyAdmissionLimit: 1 });
    const dailyBlocked = await create(page, `Review-Daily-${targetKind}`);
    const current = await control(page);
    expect(current.admissions.some(row => row.firmId === dailyBlocked.firmId)).toBe(false);
    expect(current.campaigns.find(row => row.id === replacement.campaignId)?.admittedCount).toBe(0);
    expect((await f.db.query('SELECT * FROM outreach_email_campaign_admissions WHERE workspace_id=$1', [f.alpha.workspaceId])).rows).toEqual(before);
    await noProvidersOrSending();
  });
}

test('finished review approval that expires during actual database write wait refuses with no policy admission or accepted receipt writes', async ({ campaignPage: page }) => {
  const { policy } = await seedEmailCampaign(owned.app);
  const removeWait = await delayCampaignWrite(owned.app, 'outreach_email_campaigns');
  const commandId = randomUUID();
  const expiresAt = new Date(Date.now() + 2000).toISOString();
  const began = Date.now();
  try {
    const response = await browserRequest(page, `${base}/approve`, { body: { ...policy, expiresAt, commandId } });
    expect(Date.now() - began).toBeGreaterThanOrEqual(2900);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    const f = owned.app.fixture;
    for (const table of ['outreach_email_campaigns', 'outreach_email_campaign_admissions']) expect((await f.db.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1`, [f.alpha.workspaceId])).rows, table).toEqual([]);
    expect((await f.db.query('SELECT result_status,result FROM command_receipts WHERE command_id=$1', [commandId])).rows).toEqual([{ result_status: 'refused', result: 'campaign_expiry_invalid' }]);
  } finally { await removeWait(); }
  await noProvidersOrSending();
});

test('finished review independent email observation expiring during final admission wait cannot enroll despite fresh native citations', async ({ campaignPage: page }) => {
  const { policy } = await seedEmailCampaign(owned.app);
  await approve(page, policy);
  const seed = await seedCampaignResearch(owned.app, 'Review-Independent-Email-Expiry');
  const removeWait = await delayCampaignWrite(owned.app, 'outreach_email_campaign_admissions');
  const evidence = await separateExpiringCampaignEmail(owned.app, seed, 2000);
  expect(Date.parse(String(evidence.nativeRetrievedAt))).toBeGreaterThan(Date.now() - 60_000);
  const began = Date.now();
  try {
    const response = await browserRequest(page, '/sourcing/research-firms/create', { body: { ...seed.selection, commandId: randomUUID() } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(Date.now() - began).toBeGreaterThanOrEqual(2900);
    expect(Date.now()).toBeGreaterThan(evidence.expiresAt.getTime());
    const firm = qualifiedResearchFirmSchema.parse((response.body as { result: unknown }).result);
    const f = owned.app.fixture;
    for (const table of ['contacts', 'email_addresses', 'outreach_plans', 'sequence_enrollments', 'outreach_email_campaign_admissions']) expect((await f.db.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1 AND firm_id=$2`, [f.alpha.workspaceId, firm.firmId])).rows, table).toEqual([]);
    expect((await f.db.query('SELECT 1 FROM outreach_email_sources WHERE workspace_id=$1 AND candidate_id=$2', [f.alpha.workspaceId, seed.selection.candidateId])).rows).toEqual([]);
    expect((await control(page)).admissions).toEqual([]);
  } finally { await removeWait(); }
  await noProvidersOrSending();
});
