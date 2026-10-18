import { mkdir } from 'node:fs/promises';
import { expect, test } from 'playwright/test';
import { adminState, sendingPosture } from './support/adminFixtures.ts';
import { startAppServer } from './support/appServer.ts';

const research = { firm: null, settings: { enabled: false, dailyFirmCeiling: 25, dailyCostCeilingCents: 300, monthlyCostCeilingCents: 5000, maxPagesPerFirm: 8, maxPageBytes: 1000000, modelName: 'claude-haiku-4-5', updatedByUserId: null, updatedAt: null }, worstCaseRunCents: 4, spend: { todayCents: 0, monthToDateCents: 0 }, notice: null, mayMutate: true, role: 'admin' };

test('compact owner settings retain operational forms and keyboard-accessible Advanced', async ({ page }) => {
  const app = await startAppServer({
    admin: adminState({ sendingAdmin: sendingPosture(), integrations: { callingProvider: 'tel', telephonyBudget: { dailyCeilingCents: 500, maxMinutesPerCall: 30, unitPriceMicros: 14000 }, calendarIntegration: 'off', voicemailScript: 'Hi {contactFirstName}, it is {callerName}.', configured: { twilioVoice: { ok: true, missing: [] }, calcom: { ok: true, missing: [] } }, spentTodayCents: 125 } }),
    operations: { 'sourcing.list': () => ({ view: { candidates: [], hasMore: false, discovery: { enabled: true, halted: false, dailyRemaining: 7, monthlyRemaining: 90, nextRunAt: '2026-10-19T10:00:00Z', lastResult: 'complete' } }, reason: null }), 'research.saveSettings': () => research, 'social.workspace': () => ({ view: { accounts: [], posts: [] }, notice: null }) },
  });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(app.url('#admin'));
    for (const title of ['Account', 'Calling', 'Email', 'Research & discovery', 'LinkedIn']) await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
    const advanced = page.getByTestId('settings-advanced');
    await expect(advanced).not.toHaveAttribute('open', '');
    await expect(page.getByTestId('setting-business_time_zone')).not.toBeVisible();
    await expect(page.getByTestId('research-dailyCostCeilingCents')).toHaveValue('300');
    await expect(page.getByTestId('research-monthlyCostCeilingCents')).toHaveValue('5000');
    await expect(page.getByTestId('setting-sending_enabled')).toBeVisible();
    await expect(page.getByTestId('setting-postal_address')).toBeVisible();
    await expect(page.getByText('Connection only. Connecting does not authorize outreach or posting.')).toBeVisible();
    await expect(page.getByTestId('discovery-status')).toContainText('7 searches remaining today');
    await expect(page.getByTestId('discovery-status')).toContainText('subject to research and holds');
    await expect(page.getByTestId('tabs')).toHaveCount(0);
    await expect(page.getByText('Booking capacity', { exact: true })).toHaveCount(0);
    const dir = process.env['FSS_SETTINGS_SCREENSHOT_DIR'];
    if (dir) {
      await mkdir(dir, { recursive: true });
      await page.screenshot({ path: `${dir}/settings-default.png`, fullPage: true });
      await page.setViewportSize({ width: 1440, height: 2400 });
      await page.screenshot({ path: `${dir}/settings-default-overview.png`, fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await advanced.locator(':scope > summary').focus();
    await page.keyboard.press('Enter');
    await expect(advanced).toHaveAttribute('open', '');
    await expect(page.getByTestId('setting-business_time_zone')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Diagnostics', exact: true })).toBeVisible();
    await advanced.evaluate(element => element.scrollIntoView({ block: 'start' }));
    if (dir) await page.screenshot({ path: `${dir}/settings-advanced.png`, fullPage: true });
    expect(app.calls.filter(call => /\.(saveSetting|saveIntegration|setSendingCap|connectAccount)$/.test(call.method))).toEqual([]);
  } finally { await app.stop(); }
});
