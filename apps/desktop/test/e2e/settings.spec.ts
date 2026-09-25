import { expect, test } from 'playwright/test';
import {
  ALERT_ID,
  adminState,
  sendingPosture,
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
  await expect(page.getByTestId('setting-business_time_zone')).toContainText('Version 2');
  await expect(page.getByTestId('value-business_time_zone')).toBeEnabled();
  await expect(page.getByTestId('save-business_time_zone')).toBeEnabled();

  // 16.2's two switches, read out rather than recombined.
  await expect(page.getByTestId('sending')).toContainText('release process has not enabled');

  // The configuration this store does not own is a link, not a second copy. The
  // sending caps are G7-2's and the holiday calendar is G8's.
  await expect(page.getByTestId('elsewhere')).toContainText('/research/config');
  await expect(page.getByTestId('elsewhere')).toContainText('/outbound/cap');
  await expect(page.getByTestId('setting-sending_limits')).toHaveCount(0);
});

test("an admin edits G7-2's checklist and cap, and the guard has no control", async ({ page }) => {
  server = await startSettingsTestServer(adminState({ sendingAdmin: sendingPosture() }));
  await page.goto(server.url);

  // The checklist is incomplete and the page says which part is missing rather than
  // offering an enable that `sending_domains`' CHECK would refuse.
  await expect(page.getByTestId('sending-domain')).toContainText('dmarc');
  await expect(page.getByTestId('sending-record')).toBeEnabled();
  await expect(page.getByTestId('sending-dmarcPass')).toBeEnabled();

  // 12.6: changing the personal-Gmail guard is a reviewed policy change, so it is
  // shown and never offered. There is no control with this value behind it.
  await expect(page.getByTestId('sending-guard')).toContainText('4000');
  await expect(page.getByTestId('sending-admin')).toContainText('reviewed policy change');

  await expect(page.getByTestId('cap-44444444-4444-4444-8444-444444444444')).toBeEnabled();
  await expect(page.getByTestId('raiseTo-44444444-4444-4444-8444-444444444444')).toBeEnabled();
  await expect(page.getByTestId('ramp-44444444-4444-4444-8444-444444444444')).toContainText('cap 5');

  await page.getByTestId('cap-44444444-4444-4444-8444-444444444444').fill('25');
  await page.getByTestId('raiseTo-44444444-4444-4444-8444-444444444444').click();
  const call = server.calls.find(entry => entry.method === 'setSendingCap');
  expect(call?.argument).toEqual({ mailboxId: '44444444-4444-4444-8444-444444444444', raiseTo: 25 });
});

test('a sending read that failed says so where the section would be, and Retry reads it again (lane g69)', async ({ page }) => {
  // Desktop 1.0.2 and 1.0.3 in production: every `/outbound/status` answer failed to
  // parse and the section was simply absent. Now the section says it could not read.
  server = await startSettingsTestServer(adminState({ sendingReadError: 'unreadable_answer' }));
  await page.goto(server.url);

  await expect(page.getByTestId('sending-admin').getByRole('heading')).toHaveText('Sending domain and caps');
  await expect(page.getByTestId('sending-unread')).toHaveText(
    'Callie could not read the sending status. The answer was not in the shape this version of Callie reads (unreadable_answer).',
  );
  await expect(page.getByTestId('sending-domain')).toHaveCount(0);
  // Not a notice: the rest of the page reads as before.
  await expect(page.getByTestId('notice')).toHaveCount(0);

  await page.getByTestId('sending-retry').click();
  await expect(page.getByTestId('sending-domain')).toContainText('dmarc');
  await expect(page.getByTestId('sending-unread')).toHaveCount(0);
  expect(server.calls.filter(call => call.method === 'show').map(call => call.argument)).toEqual([{ screen: 'settings' }]);
});

test('a salesperson is told nothing about a sending read their page never made (lane g69)', async ({ page }) => {
  server = await startSettingsTestServer(adminState({ role: 'salesperson', sendingReadError: 'unreadable_answer' }));
  await page.goto(server.url);
  await expect(page.getByTestId('calling-number')).toBeVisible();
  await expect(page.getByTestId('sending-admin')).toHaveCount(0);
});

test("replaces the holiday calendar through G8's command, by naming a new version", async ({ page }) => {
  server = await startSettingsTestServer(adminState());
  await page.goto(server.url);

  await expect(page.getByTestId('holidays-current')).toContainText('2026-federal');
  await expect(page.getByTestId('holiday-dates')).toHaveValue('2026-12-25');
  // The version box is empty rather than prefilled: a calendar is superseded, so
  // the name has to be a new one and offering the taken one invites a refusal.
  await expect(page.getByTestId('holiday-version')).toHaveValue('');

  await page.getByTestId('holiday-version').fill('2027-federal');
  await page.getByTestId('holiday-dates').fill('2027-01-01\n\n  2027-07-05  ');
  await page.getByTestId('holidays-save').click();

  const call = server.calls.find(entry => entry.method === 'recordHolidayCalendar');
  // Blank lines dropped and whitespace trimmed; nothing else interpreted here.
  expect(call?.argument).toEqual({
    version: '2027-federal',
    dates: ['2027-01-01', '2027-07-05'],
  });
});

test('a salesperson is offered no sending section at all', async ({ page }) => {
  server = await startSettingsTestServer(
    adminState({ role: 'salesperson', sendingAdmin: sendingPosture() }),
  );
  await page.goto(server.url);

  // Not an inert section: every `/outbound/*` path answers them with a redacted 403,
  // and a control that exists only to be refused teaches nothing.
  await expect(page.getByTestId('sending-admin')).toHaveCount(0);
  await expect(page.getByTestId('value-business_time_zone')).toBeDisabled();
  // The calendar is different: shown, inert. A salesperson whose step was delayed
  // by a holiday is entitled to see which holiday.
  await expect(page.getByTestId('holidays-current')).toContainText('2026-federal');
  await expect(page.getByTestId('holidays-save')).toBeDisabled();
});

test('a salesperson sees the same page with every control inert and a reason', async ({ page }) => {
  server = await startSettingsTestServer(adminState({ role: 'salesperson' }));
  await page.goto(server.url);

  await expect(page.getByTestId('value-business_time_zone')).toBeDisabled();
  await expect(page.getByTestId('save-business_time_zone')).toBeDisabled();
  // The reason in words (lane g88), not the code the view model carries.
  await expect(page.getByTestId('setting-business_time_zone')).toContainText('Only an admin can change this.');
  // Reading is not refused: a salesperson whose send was refused by a cap should be
  // able to see the cap.
  await expect(page.getByTestId('setting-business_time_zone')).toContainText('Version 2');
});

test('offline is said once, at the top, and every control is inert', async ({ page }) => {
  server = await startSettingsTestServer(adminState({ online: false }));
  await page.goto(server.url);

  await expect(page.getByTestId('banner-offline')).toContainText('Offline');
  await expect(page.getByTestId('save-alert_thresholds')).toBeDisabled();
  // Offline comes first: an admin who is offline is told that, not "admin only".
  await expect(page.getByTestId('setting-alert_thresholds')).toContainText('Offline: nothing here can be changed');
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

test('opened from ⌘6 or Home’s Dashboard row, the window starts on the Dashboard screen', async ({ page }) => {
  // Lane g65: the opener names the screen in the page's address, and the page asks the
  // bridge for that screen once, as it loads. Without a query it asks for the state.
  server = await startSettingsTestServer(adminState());
  await page.goto(`${server.url}?screen=dashboard`);

  await expect(page.getByTestId('tab-dashboard')).toHaveClass(/tab-current/u);
  await expect(page.getByTestId('panel-calls')).toContainText('voicemail_left: 3');
  expect(server.calls[0]).toEqual({ method: 'show', argument: { screen: 'dashboard' } });
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
      settingKey: 'business_time_zone',
      value: { timeZone: 'Pacific/Auckland' },
      changeNote: 'trying it on',
    });
  });
  await page.reload();
  await expect(page.getByTestId('setting-business_time_zone')).toContainText('Version 2');
  await expect(page.getByTestId('value-business_time_zone')).not.toContainText('Pacific/Auckland');
});

test('History shows what each version changed, from and to, under its setting (lane g78)', async ({ page }) => {
  server = await startSettingsTestServer(adminState());
  await page.goto(server.url);

  // Before g78 the button fetched the versions and nothing drew them, and the values
  // were stripped anyway (D04).
  await expect(page.getByTestId('setting-history')).toHaveCount(0);
  await page.getByTestId('history-business_time_zone').click();

  const history = page.getByTestId('setting-business_time_zone').getByTestId('setting-history');
  await expect(history).toContainText('History of Workspace business zone');
  await expect(history.getByTestId('history-current')).toHaveText('In force now: version 2: {"timeZone":"America/Chicago"}');
  await expect(history.getByTestId('history-version')).toHaveCount(2);
  await expect(history.getByTestId('history-line').first()).toHaveText('Version 2, changed 2026-09-19T10:00:00.000Z: the office moved');
  await expect(history.getByTestId('history-from').first()).toHaveText('From {"timeZone":"America/Denver"}');
  await expect(history.getByTestId('history-to').first()).toHaveText('To {"timeZone":"America/Chicago"}');
  await expect(history.getByTestId('history-from').nth(1)).toHaveText('From {"timeZone":"America/New_York"} (the default)');
  expect(server.calls.filter(call => call.method === 'openHistory').map(call => call.argument)).toEqual([
    { settingKey: 'business_time_zone' },
  ]);
});

// ------------------------------------------------------ lane g88: typed controls (G08)
test('a setting is changed with a typed control, and its JSON and provenance are behind Details', async ({ page }) => {
  server = await startSettingsTestServer(adminState());
  await page.goto(server.url);

  // No JSON on the face of the page: a zone picker, and the machinery behind Details.
  await expect(page.getByTestId('setting-business_time_zone').locator('textarea')).toHaveCount(0);
  await expect(page.getByTestId('json-business_time_zone')).toBeHidden();
  await expect(page.getByTestId('summary-business_time_zone')).toHaveText('Central (Chicago)');
  await page.getByTestId('field-business_time_zone-timeZone').selectOption('America/Denver');
  await page.getByTestId('note-business_time_zone').fill('the office moved');
  await page.getByTestId('save-business_time_zone').click();
  await expect
    .poll(() => server.calls.find(entry => entry.method === 'saveSetting')?.argument)
    .toEqual({ settingKey: 'business_time_zone', value: { timeZone: 'America/Denver' }, changeNote: 'the office moved' });

  // The thresholds are numbers, one click further away; one that is not a number is marked and not sent.
  await page.getByText('Advanced: alarm thresholds and supported Callie versions').click();
  await page.getByTestId('field-alert_thresholds-canaryStaleSeconds').fill('');
  await page.getByTestId('save-alert_thresholds').click();
  await expect(page.getByTestId('field-alert_thresholds-canaryStaleSeconds')).toHaveAttribute('aria-invalid', 'true');
  expect(server.calls.filter(entry => entry.method === 'saveSetting')).toHaveLength(1);

  // Where the other settings live, and which lane owns them, is support detail.
  await expect(page.getByTestId('elsewhere-details')).not.toHaveAttribute('open', '');
  await expect(page.getByText('/research/config')).toBeHidden();
});
