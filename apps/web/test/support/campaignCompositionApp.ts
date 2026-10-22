import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright/test';
import { emailCampaignControlSchema, emailCampaignCommandResultSchema, type EmailCampaignPolicy } from '@fss/contracts';
import { browserRequest } from './browser.ts';
import { expect } from './automaticSupplyApp.ts';
import type { ThinHostApp } from './thinHostApp.ts';
export const campaignCompositionBase = '/outreach/email-campaigns';
export async function compositionControl(page: Page) {
  const response = await browserRequest(page, `${campaignCompositionBase}/control`, { body: {} });
  expect(response.status).toBe(200);
  return emailCampaignControlSchema.parse(response.body);
}
export async function approveComposition(page: Page, policy: EmailCampaignPolicy) {
  const response = await browserRequest(page, `${campaignCompositionBase}/approve`, { body: { ...policy, commandId: randomUUID() } });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return emailCampaignCommandResultSchema.parse((response.body as { result: unknown }).result);
}
export async function approveCompositionInUi(page: Page, policy: EmailCampaignPolicy) {
  await page.getByRole('button', { name: 'Refresh campaigns', exact: true }).click();
  await page.getByLabel('Approved sender', { exact: true }).selectOption(policy.mailboxId);
  await page.getByLabel('Approved email sequence', { exact: true }).selectOption(policy.sequenceVersionId);
  for (const region of ['TX', 'RI', 'MA'] as const) await page.getByLabel(region, { exact: true }).setChecked(policy.regions.includes(region));
  await page.getByLabel('Daily admission limit', { exact: true }).fill(String(policy.dailyAdmissionLimit));
  await page.getByLabel('Lifetime enrollment cap', { exact: true }).fill(String(policy.maxEnrollments));
  await page.getByLabel('Campaign expiry', { exact: true }).fill(policy.expiresAt.slice(0, 16));
  const response = page.waitForResponse(row => row.url().endsWith(`${campaignCompositionBase}/approve`));
  await page.getByRole('button', { name: 'Approve campaign once', exact: true }).click();
  const approved = await response;
  expect(approved.status()).toBe(200);
  return emailCampaignCommandResultSchema.parse((await approved.json() as { result: unknown }).result);
}
export async function compositionOff(app: ThinHostApp) {
  const f = app.fixture;
  for (const sql of [
    'SELECT 1 FROM outbound_messages',
    'SELECT 1 FROM outreach_settings WHERE routine_replies_enabled',
    'SELECT 1 FROM outreach_email_admission_settings WHERE enabled',
    "SELECT 1 FROM workspace_settings WHERE setting_key='sending_enabled' AND value->>'enabled'='true'",
    'SELECT 1 FROM sending_domains WHERE automated_sending_enabled',
  ]) expect((await f.db.query(sql)).rows, sql).toEqual([]);
}
