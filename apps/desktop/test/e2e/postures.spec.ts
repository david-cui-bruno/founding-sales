import { expect, test, type Page } from 'playwright/test';
import { POSTURE_ID, adminState } from './support/adminFixtures.ts';
import { startAppServer, type AppServer, type BridgeHandle } from './support/appServer.ts';
import type { AdminState } from '../../src/renderer/settingsContract.ts';

/**
 * "States you call" in Settings, end to end against the one test harness (lane g84,
 * audit item G04; wave 2, S4.2 and D5).
 *
 * The renderer is the shipped file and only the bridge is scripted.
 *
 * Until 1.0.13 this was a form per state: a day it took effect, a review date, and the
 * reference's statements ticked one at a time. A posture has no expiry and no review
 * date now, and `POST /postures/allow` takes several states with one confirmation — so
 * what these prove is the shorter act: tick the states, read the rules quoted for them,
 * confirm once, and the states are on the list. One spec is refused by the server and
 * asserts the form comes back as it was sent, which a spec that only ever succeeded
 * would not notice missing.
 */

let app: AppServer;
let server: BridgeHandle<AdminState>;

test.afterEach(async () => {
  await app.stop();
});

/** Administration on `state`, loaded straight onto `hash` (Settings unless said). */
async function openAdmin(page: Page, state: AdminState, hash = '#admin'): Promise<void> {
  app = await startAppServer({ admin: state });
  server = app.admin;
  await page.goto(app.url(hash));
}

test('an admin adds two states with one confirmation, and the list shows them', async ({ page }) => {
  await openAdmin(page, adminState());

  const section = page.getByTestId('postures');
  await expect(section.getByRole('heading', { name: 'States you call' })).toBeVisible();
  await expect(page.getByTestId('postures-summary')).toContainText('on this list: RI.');
  await expect(page.getByTestId('posture-row')).toHaveCount(1);
  await expect(page.getByTestId('posture-line')).toContainText('Rhode Island (RI)');
  // No path to read and no JSON to open: the page is the list.
  await expect(page.getByTestId('elsewhere')).toHaveCount(0);
  await expect(page.getByTestId('postures-json')).toHaveCount(0);

  // A state already on the list is not offered again.
  await expect(page.getByTestId('posture-state-RI')).toHaveCount(0);
  await page.getByTestId('posture-state-AL').check();
  await page.getByTestId('posture-state-TX').check();
  await expect(page.getByTestId('posture-rule-none').first()).toContainText('this release quotes no rule');
  await expect(page.getByTestId('posture-statement-federal_rules_apply')).toContainText(
    'I understand the federal calling rules apply.',
  );
  await page.getByTestId('posture-confirmed').check();
  await page.getByTestId('posture-note').fill('Checked the registration page.');
  await page.getByTestId('posture-record').click();

  // TX is the refusal the stub scripts, so this one comes back as it was sent.
  await expect(page.getByTestId('notice')).toContainText('Choose at least one state');
  await expect(page.getByTestId('posture-state-AL')).toBeChecked();
  await expect(page.getByTestId('posture-note')).toHaveValue('Checked the registration page.');
});

test('the states added are on the list, and the form is empty again', async ({ page }) => {
  await openAdmin(page, adminState());

  await page.getByTestId('posture-state-AL').check();
  await page.getByTestId('posture-confirmed').check();
  await page.getByTestId('posture-record').click();

  await expect(page.getByTestId('notice')).toHaveText('Added. Callie can call firms in those states now.');
  expect(server.calls.find(call => call.method === 'allowStates')?.argument).toEqual({
    states: ['AL'],
    confirmed: true,
    note: '',
  });
  await expect(page.getByTestId('posture-row')).toHaveCount(2);
  await expect(page.getByTestId('posture-confirmed')).not.toBeChecked();
  await expect(page.getByTestId('posture-note')).toHaveValue('');
});

test('the quoted rule is shown verbatim for a state that has one, before the box is ticked', async ({ page }) => {
  await openAdmin(page, adminState({ postures: { ...adminState().postures!, records: [] } }));
  await page.getByTestId('posture-state-RI').check();
  await expect(page.getByTestId('posture-rule-summary')).toHaveText('RI: Rhode Island quoted summary.');
  await expect(page.getByTestId('posture-rule')).toContainText('A quoted Rhode Island line.');
  await expect(page.getByTestId('posture-confirmed')).not.toBeChecked();
});

test('a list with no state chosen, or with no confirmation, is not sent and says why', async ({ page }) => {
  await openAdmin(page, adminState());

  await page.getByTestId('posture-record').click();
  await expect(page.getByTestId('posture-issue-states')).toHaveText('Choose at least one state.');
  await expect(page.getByTestId('posture-issue-confirmed')).toHaveText(
    'Confirm that you have read the rules quoted for these states.',
  );

  await page.getByTestId('posture-state-AL').check();
  await page.getByTestId('posture-record').click();
  await expect(page.getByTestId('posture-issue-states')).toHaveCount(0);
  await expect(page.getByTestId('posture-issue-confirmed')).toHaveCount(1);
  expect(server.calls.filter(call => call.method === 'allowStates')).toHaveLength(0);
});

test('taking a state off the list sends the posture id', async ({ page }) => {
  await openAdmin(page, adminState());

  await page.getByTestId(`posture-revoke-${POSTURE_ID}`).click();
  // The bridge call reaches the stub after the click resolves, so wait for it (lane g86).
  await expect
    .poll(() => server.calls.filter(call => call.method === 'revokePosture'))
    .toEqual([{ method: 'revokePosture', argument: { postureId: POSTURE_ID } }]);
  await expect(page.getByTestId('posture-row')).toHaveCount(0);
  // Off the list, so the state is offered again.
  await expect(page.getByTestId('posture-state-RI')).toHaveCount(1);
});

test('a salesperson sees the list and cannot change it', async ({ page }) => {
  await openAdmin(page, adminState({ role: 'salesperson' }));
  await expect(page.getByTestId('posture-row')).toHaveCount(1);
  await expect(page.getByTestId('posture-state-AL')).toBeDisabled();
  await expect(page.getByTestId('posture-confirmed')).toBeDisabled();
  await expect(page.getByTestId('posture-record')).toBeDisabled();
  await expect(page.getByTestId(`posture-revoke-${POSTURE_ID}`)).toHaveCount(0);
  await expect(page.getByTestId('posture-inert')).toHaveText('Only an admin can change this list.');
});

test('a failed read says so, with Retry', async ({ page }) => {
  await openAdmin(page, adminState({ postures: { reference: null, records: null, readError: 'offline' } }));
  await expect(page.getByTestId('postures-unread')).toContainText('Callie could not read which states you call.');
  await expect(page.getByTestId('posture-record')).toBeDisabled();
  await page.getByTestId('postures-retry').click();
  // Opening Administration was the first read; Retry is Settings shown again.
  await expect
    .poll(() => server.calls.filter(call => call.method === 'show'))
    .toEqual([
      { method: 'show', argument: { screen: 'settings' } },
      { method: 'show', argument: { screen: 'settings' } },
    ]);
});
