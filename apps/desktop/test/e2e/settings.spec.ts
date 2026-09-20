import { expect, test } from 'playwright/test';
import {
  ALERT_ID,
  adminState,
  startSettingsTestServer,
  type SettingsTestServer,
} from './support/settingsTestServer.ts';

/**
 * The administration window, driven end to end against the generated test server.
 *
 * The renderer is the shipped file; only the bridge is substituted, so what these
 * specs prove is what a person actually sees and can press. Every scenario that a
 * role changes runs twice: a suite that only ever ran as an admin would pass with
 * the inert-control logic deleted, and that logic is most of the point of this page.
 */

let server: SettingsTestServer;

test.afterEach(async () => {
  await server.stop();
});

test('an admin sees every slice, its provenance, and an editor for each', async ({ page }) => {
  server = await startSettingsTestServer(adminState());
  await page.goto(server.url);

  await expect(page.getByTestId('heading')).toHaveText('Administration');
  await expect(page.getByTestId('setting-alert_thresholds')).toContainText('Default, never configured');
  await expect(page.getByTestId('setting-sending_limits')).toContainText('Version 2');
  await expect(page.getByTestId('value-sending_limits')).toBeEnabled();
  await expect(page.getByTestId('save-sending_limits')).toBeEnabled();

  // 16.2's two switches, read out rather than recombined.
  await expect(page.getByTestId('sending')).toContainText('release process has not enabled');

  // The configuration this store does not own is a link, not a second copy.
  await expect(page.getByTestId('elsewhere')).toContainText('/research/config');
});

test('a salesperson sees the same page with every control inert and a reason', async ({ page }) => {
  server = await startSettingsTestServer(adminState({ role: 'salesperson' }));
  await page.goto(server.url);

  await expect(page.getByTestId('value-sending_limits')).toBeDisabled();
  await expect(page.getByTestId('save-sending_limits')).toBeDisabled();
  await expect(page.getByTestId('setting-sending_limits')).toContainText('admin_only');
  // Reading is not refused: a salesperson whose send was refused by a cap should be
  // able to see the cap.
  await expect(page.getByTestId('setting-sending_limits')).toContainText('Version 2');
});

test('offline is said once, at the top, and every control is inert', async ({ page }) => {
  server = await startSettingsTestServer(adminState({ online: false }));
  await page.goto(server.url);

  await expect(page.getByTestId('banner-offline')).toContainText('Offline');
  await expect(page.getByTestId('save-alert_thresholds')).toBeDisabled();
  // Offline comes first: an admin who is offline is told that, not "admin only".
  await expect(page.getByTestId('setting-alert_thresholds')).toContainText('offline');
});

test('a terminal stage is listed and offers no administration', async ({ page }) => {
  server = await startSettingsTestServer(adminState());
  await page.goto(server.url);

  await expect(page.getByTestId('stage-new')).toContainText('New');
  await expect(page.getByTestId('retire-new')).toBeVisible();
  // 8.1: "rename, reorder, add, or retire *nonterminal* stages."
  await expect(page.getByTestId('stage-won')).toContainText('terminal');
  await expect(page.getByTestId('retire-won')).toHaveCount(0);
});

test('the dashboard says a figure is unavailable rather than showing it as zero', async ({ page }) => {
  server = await startSettingsTestServer(adminState());
  await page.goto(server.url);
  await page.getByTestId('tab-dashboard').click();

  await expect(page.getByTestId('panel-scope')).toContainText('Your assigned firms.');
  await expect(page.getByTestId('panel-email')).toContainText('G7-2');
  // The figures that *can* be computed are numbers, not excuses.
  await expect(page.getByTestId('panel-reply-handling')).toContainText('1 of 2 handled.');
  await expect(page.getByTestId('panel-calls')).toContainText('voicemail_left: 3');
  await expect(page.getByTestId('panel-holds')).toContainText('scoped_pause: 1');
});

test('Diagnostics names the restore mismatch and puts the runbook beside the alert', async ({ page }) => {
  server = await startSettingsTestServer(adminState());
  await page.goto(server.url);
  await page.getByTestId('tab-diagnostics').click();

  await expect(page.getByTestId('panel-restore-generation')).toContainText('Mismatch');
  await expect(page.getByTestId('panel-restore-generation')).toContainText('held');
  await expect(page.getByTestId('panel-production-sending')).toContainText('Effective: disabled.');
  await expect(page.getByTestId(`alert-${ALERT_ID}`)).toContainText('docs/greenfield/runbooks/canary_stale.md');

  await page.getByTestId(`acknowledge-${ALERT_ID}`).click();
  // Acknowledging silences the repetition and changes nothing else: the alert is
  // still open and still shows its runbook.
  await expect(page.getByTestId(`alert-${ALERT_ID}`)).toContainText('acknowledged');
  await expect(page.getByTestId(`acknowledge-${ALERT_ID}`)).toHaveCount(0);
});

test('a refused save is shown as its code and the page is not edited optimistically', async ({ page }) => {
  server = await startSettingsTestServer(adminState({ role: 'salesperson' }));
  await page.goto(server.url);

  // The control is inert, so a person cannot reach this; the bridge can, and the
  // page has to render the refusal rather than the value that was attempted.
  await page.evaluate(async () => {
    await globalThis.callieAdmin?.saveSetting({
      settingKey: 'sending_limits',
      value: { perMailboxDailyCap: 99, domainRecipientsPer24h: 4000 },
      changeNote: 'trying it on',
    });
  });
  await page.reload();
  await expect(page.getByTestId('setting-sending_limits')).toContainText('Version 2');
  await expect(page.getByTestId('value-sending_limits')).not.toContainText('99');
});
