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
    const email = page.getByRole('region', { name: 'Email', exact: true });
    await expect(email.getByTestId('field-sending_enabled-releaseGateReference')).toHaveCount(0);
    await expect(email.locator('[data-testid^="history-"], [data-testid^="details-"], pre')).toHaveCount(0);
    await expect(advanced.getByTestId('field-sending_enabled-releaseGateReference')).not.toBeVisible();
    await expect(advanced.getByTestId('history-postal_address')).not.toBeVisible();
    await expect(page.getByTestId('cap-44444444-4444-4444-8444-444444444444').locator('..')).toHaveCSS('opacity', '1');
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

test('Email technical setup and actual history stay inside Advanced, and release refusal stays authoritative', async ({ page }) => {
  const state = adminState();
  const history = { settingKey: 'postal_address', current: { value: { address: null }, version: 0 }, versions: [{ settingKey: 'postal_address', version: 1, value: { address: '1 Example Way' }, changeNote: 'Fixture history', changedByUserId: '22222222-2222-4222-8222-222222222222', changedAt: '2026-10-01T10:00:00Z', supersededAt: null }] };
  const app = await startAppServer({ admin: state, operations: {
    'settings.saveSetting': () => ({ ...state, notice: 'release_record_unknown' }),
    'settings.openHistory': () => ({ ...state, history }),
  } });
  try {
    await page.goto(app.url('#admin'));
    const advanced = page.getByTestId('settings-advanced');
    const email = page.getByRole('region', { name: 'Email', exact: true });
    await page.getByTestId('field-sending_enabled-enabled').check();
    await expect(page.getByTestId('save-sending_enabled')).toBeDisabled();
    await expect(page.getByTestId('sending-release-guidance')).toContainText('add the release gate reference in Advanced');
    expect(app.called('settings.saveSetting')).toEqual([]);
    await page.getByTestId('advanced-sending_enabled').click();
    await expect(advanced).toHaveAttribute('open', '');
    await advanced.getByTestId('field-sending_enabled-releaseGateReference').fill('fixture-unreviewed-reference');
    expect(app.called('settings.saveSetting')).toEqual([]);
    await page.getByTestId('save-sending_enabled').click();
    await expect(email.getByTestId('notice')).toHaveText('release_record_unknown');
    await expect(email.getByTestId('summary-sending_enabled')).toHaveText('Off');
    expect(app.called('settings.saveSetting')).toEqual([{ settingKey: 'sending_enabled', value: { enabled: true, releaseGateReference: 'fixture-unreviewed-reference' }, changeNote: '' }]);
    await advanced.getByTestId('history-postal_address').click();
    await expect(advanced.getByTestId('setting-history')).toContainText('Fixture history');
    await expect(email.getByTestId('setting-history')).toHaveCount(0);
    await advanced.getByTestId('details-postal_address').locator('summary').click();
    await expect(advanced.getByTestId('json-postal_address')).toBeVisible();
    await advanced.locator(':scope > summary').click();
    await expect(page.getByTestId('setting-history')).not.toBeVisible();
    await expect(page.getByTestId('json-postal_address')).not.toBeVisible();
    await expect(page.getByTestId('field-sending_enabled-releaseGateReference')).not.toBeVisible();
    await expect(email.getByTestId('field-postal_address-address')).toBeVisible();
  } finally { await app.stop(); }
});
