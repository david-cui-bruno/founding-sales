import assert from 'node:assert/strict';
import type { Page } from 'playwright/test';
import { test, expect } from '../support/qualifiedResearchApp.ts';
import { startManualProspectApp } from '../support/manualProspectApp.ts';
import { routeManualProvider } from '../support/manualProspectSeed.ts';
import { seedEmailCampaign } from '../support/emailCampaignSeed.ts';
import type { ThinHostApp } from '../support/thinHostApp.ts';
import { approveEmailCampaign } from '../../../../packages/domain/outreach/emailCampaign.ts';
import { withTransaction } from '../../../../packages/domain/db/queryable.ts';
const phrase = 'Explicit fixture opening for {{firm_name}}.';
const region = (page: Page) => page.getByRole('region', { name: 'First-email opening policy', exact: true });
let app: Awaited<ReturnType<typeof startManualProspectApp>>, campaignId = '', templateId = '', baseline: Record<string, unknown[]>;
async function snapshot() {
  const value: Record<string, unknown[]> = {};
  for (const table of ['outreach_email_campaigns', 'outreach_email_campaign_admissions', 'sequence_enrollments', 'step_executions', 'outbound_messages', 'provider_reservations', 'jobs', 'workspace_settings']) value[table] = (await app.fixture.db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return value;
}
async function select(page: Page) {
  await page.getByRole('navigation', { name: 'Workspace sections', exact: true }).getByRole('button', { name: 'Email', exact: true }).click();
  await page.getByRole('navigation', { name: 'Email views', exact: true }).getByRole('button', { name: 'Automatic outreach', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh campaigns', exact: true }).click();
  await page.getByLabel('Opening policy campaign', { exact: true }).selectOption(campaignId); await expect(region(page)).toBeVisible();
}
async function login(page: Page) {
  await routeManualProvider(page, app); await page.goto(app.origin);
  await expect(page.getByLabel('Workspace ID', { exact: true })).toBeVisible(); await expect(page.getByText('Checking browser session…', { exact: true })).toHaveCount(0);
  await page.getByLabel('Workspace ID', { exact: true }).fill(app.fixture.alpha.workspaceId); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible(); await select(page);
}
async function read(page: Page) { await region(page).getByRole('button', { name: 'Read current opening policy', exact: true }).click(); await expect(region(page).getByLabel('Approved opening lines', { exact: true })).toBeVisible(); }
async function enter(page: Page) {
  await region(page).getByLabel('Approved opening lines', { exact: true }).fill(phrase);
  const local = await page.evaluate(() => new Date(Date.now() + 3600000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  await region(page).getByLabel('Opening policy expiry', { exact: true }).fill(local);
  await region(page).getByRole('checkbox', { name: /I reviewed the exact baseline/u }).check();
}
async function opaque(page: Page) { const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })); expect(storage).not.toContain(phrase); expect(storage).not.toMatch(/accessToken|deviceSecret|csrfToken|A controlled local example/u); return storage; }
// Authored only. Existing registered 773 harness is not a grant. Root must
// explicitly allocate its sole PG/HTTPS/OIDC/Chrome slot before invoking this file.
test.beforeEach(async ({ researchPage: page }) => {
  assert.equal(process.env['FSS_CAMPAIGN_OPENING_CONTROL_RUNTIME_GRANT'], 'opening-control-20261027');
  app = await startManualProspectApp('773'); const prepared = await seedEmailCampaign({ fixture: app.fixture } as ThinHostApp);
  const approved = await withTransaction(app.fixture.db, () => approveEmailCampaign(prepared.context, prepared.policy)); assert(approved.ok);
  campaignId = approved.value.campaignId; templateId = prepared.templateIds[0]!; baseline = await snapshot(); await login(page);
});
test.afterEach(async ({ researchPage: page }) => { try { if (app) { expect(await snapshot()).toEqual(baseline); await opaque(page); } } finally { await app?.stop(); } });
test('signed admin exact baseline -> explicit one-time opening approval -> current provenance -> revocation tombstone', async ({ researchPage: page }) => {
  await read(page); await expect(region(page).getByLabel('Approved opening lines', { exact: true })).toHaveValue(''); await expect(region(page).getByLabel('Opening policy expiry', { exact: true })).toHaveValue('');
  const template = (await app.fixture.db.query<{ subject: string; body: string }>('SELECT subject,body FROM template_versions WHERE id=$1', [templateId])).rows[0]!;
  expect(await region(page).locator('pre').allTextContents()).toEqual([template.subject, template.body]); await enter(page);
  await region(page).getByRole('button', { name: 'Approve opening policy once', exact: true }).click(); await expect(region(page).getByRole('article', { name: 'Configured opening policy', exact: true })).toBeVisible();
  const policy = (await app.fixture.db.query<{ policy: { ownerUserId: string; variants: unknown[] } }>('SELECT policy FROM outreach_campaign_opening_policies WHERE campaign_id=$1', [campaignId])).rows[0]!.policy;
  expect(policy.ownerUserId).toBe(app.fixture.alpha.admin.userId); expect(policy.variants).toEqual([{ id: 'line_1', text: phrase }]); await expect(region(page)).toContainText('not_established');
  await region(page).getByRole('button', { name: 'Revoke opening policy', exact: true }).click(); await expect(region(page).getByRole('button', { name: 'Revoke opening policy', exact: true })).toBeDisabled();
  await expect(region(page).getByRole('button', { name: 'Approve opening policy once', exact: true })).toHaveCount(0);
  expect((await app.fixture.db.query('SELECT revoked_at FROM outreach_campaign_opening_policies WHERE campaign_id=$1', [campaignId])).rows[0]?.['revoked_at']).not.toBeNull();
  expect((await app.fixture.db.query('SELECT subject,body FROM template_versions WHERE id=$1', [templateId])).rows[0]).toEqual(template);
});
test('lost accepted write response survives reload and another tab then recovers only exact read-only receipt', async ({ researchPage: page }) => {
  let writes = 0; await page.route('**/browser/api/outreach/email-campaigns/opening/approve', async route => { writes += 1; await route.fetch(); await route.abort('failed'); });
  await read(page); await enter(page); await region(page).getByRole('button', { name: 'Approve opening policy once', exact: true }).click();
  await expect(region(page).getByRole('button', { name: 'Reconcile opening receipt only', exact: true })).toBeEnabled(); const retained = await opaque(page);
  expect((await app.fixture.db.query('SELECT id FROM outreach_campaign_opening_policies WHERE campaign_id=$1', [campaignId])).rows).toHaveLength(1);
  await page.reload(); await select(page); expect(await opaque(page)).toBe(retained);
  const second = await page.context().newPage(); try {
    await second.goto(app.origin); await expect(second.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible(); await select(second);
    await expect(region(second).getByRole('button', { name: 'Reconcile opening receipt only', exact: true })).toBeVisible();
    await region(second).getByRole('button', { name: 'Reconcile opening receipt only', exact: true }).click(); await expect(region(second).getByRole('article', { name: 'Configured opening policy', exact: true })).toBeVisible();
    await expect(region(page).getByRole('button', { name: 'Reconcile opening receipt only', exact: true })).toHaveCount(0); expect(writes).toBe(1);
  } finally { await second.close(); }
  const receipts = await app.fixture.db.query("SELECT result FROM command_receipts WHERE command_kind='outreach.campaign_opening_approve'"); expect(receipts.rows).toHaveLength(1); expect(JSON.stringify(receipts.rows)).not.toContain(phrase);
});
test('true UNKNOWN excludes replacement after reload/current read and never remints a command', async ({ researchPage: page }) => {
  let writes = 0; await page.route('**/browser/api/outreach/email-campaigns/opening/approve', async route => { writes += 1; await route.abort('failed'); });
  await read(page); await enter(page); await region(page).getByRole('button', { name: 'Approve opening policy once', exact: true }).click();
  await expect(region(page).getByRole('button', { name: 'Reconcile opening receipt only', exact: true })).toBeEnabled(); const retained = await opaque(page);
  await page.reload(); await select(page); await region(page).getByRole('button', { name: 'Reconcile opening receipt only', exact: true }).click(); await expect(region(page)).toContainText('outcome UNKNOWN');
  await read(page); await expect(region(page).getByLabel('Approved opening lines', { exact: true })).toBeDisabled(); expect(await opaque(page)).toBe(retained); expect(writes).toBe(1);
  expect((await app.fixture.db.query('SELECT id FROM outreach_campaign_opening_policies WHERE campaign_id=$1', [campaignId])).rows).toEqual([]);
  expect((await app.fixture.db.query("SELECT command_id FROM command_receipts WHERE command_kind='outreach.campaign_opening_approve'")).rows).toEqual([]);
});
test('stale full baseline refuses before dispatch without copy retention or implicit new selection', async ({ researchPage: page }) => {
  await read(page); await enter(page); await app.fixture.db.query('UPDATE template_versions SET retired_at=clock_timestamp() WHERE id=$1', [templateId]);
  let writes = 0; page.on('request', request => { if (request.url().endsWith('/opening/approve')) writes += 1; });
  await region(page).getByRole('button', { name: 'Approve opening policy once', exact: true }).click(); await expect(region(page)).toContainText('Copy cleared');
  expect(writes).toBe(0); await expect(region(page).getByLabel('Approved opening lines', { exact: true })).toHaveCount(0);
  expect((await app.fixture.db.query('SELECT id FROM outreach_campaign_opening_policies WHERE campaign_id=$1', [campaignId])).rows).toEqual([]); await opaque(page);
});
