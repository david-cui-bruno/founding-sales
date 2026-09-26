import { expect, test, type Page } from 'playwright/test';
import { POSTURE_ID, adminState } from './support/adminFixtures.ts';
import { startAppServer, type AppServer, type BridgeHandle } from './support/appServer.ts';
import type { AdminState } from '../../src/renderer/settingsContract.ts';

/**
 * The postures form in Settings, end to end against the one test harness (lane g84,
 * audit item G04).
 *
 * The renderer is the shipped file and only the bridge is scripted. These prove the
 * typed controls replace the path Settings used to print: a state chosen from a list, the
 * rule quoted for it, dates, one box per statement in the reference's words, and the JSON
 * behind a disclosure. One spec is refused by the server and asserts the form comes back
 * as it was sent, which a spec that only ever succeeded would not notice missing.
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

test('an admin records a posture with typed controls, and the list shows it', async ({ page }) => {
  await openAdmin(page, adminState());

  const section = page.getByTestId('postures');
  await expect(section.getByRole('heading', { name: 'Calling postures' })).toBeVisible();
  await expect(page.getByTestId('postures-summary')).toContainText('In force: RI.');
  await expect(page.getByTestId('posture-row')).toHaveCount(1);
  await expect(page.getByTestId('posture-status')).toHaveText('In force');
  // The path is no longer the only thing Settings can say about postures.
  await expect(page.getByTestId('elsewhere')).toContainText('State postures — edited on this page, under Calling postures');
  await expect(page.getByTestId('elsewhere')).not.toContainText('/postures');

  // The states with a quoted rule come first.
  await expect(page.getByTestId('posture-state').locator('option')).toHaveText([
    'Choose a state',
    'Rhode Island (rule quoted)',
    'Alabama',
    'Texas',
  ]);
  await expect(page.getByTestId('posture-effective-from')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/u);

  await page.getByTestId('posture-state').selectOption('AL');
  await expect(page.getByTestId('posture-rule-none')).toContainText('quotes no rule for this state');
  await page.getByTestId('posture-effective-from').fill('2026-10-01');
  await page.getByTestId('posture-review').fill('2027-04-01');
  await expect(page.getByTestId('posture-statement-federal_rules_apply')).not.toBeChecked();
  await page.getByTestId('posture-statement-federal_rules_apply').check();
  await page.getByTestId('posture-statement-state_rules_checked').check();
  await page.getByTestId('posture-note').fill('Checked the registration page.');
  await page.getByTestId('posture-record').click();

  await expect(page.getByTestId('notice')).toHaveText('Posture recorded.');
  expect(server.calls.find(call => call.method === 'recordPosture')?.argument).toEqual({
    state: 'AL',
    effectiveFromDate: '2026-10-01',
    reviewDate: '2027-04-01',
    confirmedStatements: ['federal_rules_apply', 'state_rules_checked'],
    note: 'Checked the registration page.',
  });
  await expect(page.getByTestId('posture-row')).toHaveCount(2);
  // Recorded, so the form is empty again.
  await expect(page.getByTestId('posture-state')).toHaveValue('');
  await expect(page.getByTestId('posture-note')).toHaveValue('');
});

test('the quoted rule is shown verbatim for a state that has one', async ({ page }) => {
  await openAdmin(page, adminState({ postures: { ...adminState().postures!, records: [] } }));
  await page.getByTestId('posture-state').selectOption('RI');
  await expect(page.getByTestId('posture-rule-summary')).toHaveText('Rhode Island quoted summary.');
  await expect(page.getByTestId('posture-rule')).toContainText('A quoted Rhode Island line.');
});

test('a form missing a statement, or a state already in force, is not sent and says why', async ({ page }) => {
  await openAdmin(page, adminState());

  await page.getByTestId('posture-record').click();
  await expect(page.getByTestId('posture-issue-state')).toHaveText('Choose a state.');
  await expect(page.getByTestId('posture-state')).toHaveAttribute('aria-invalid', 'true');

  await page.getByTestId('posture-state').selectOption('AL');
  await page.getByTestId('posture-statement-federal_rules_apply').check();
  await page.getByTestId('posture-record').click();
  await expect(page.getByTestId('posture-issue-statements')).toHaveText(
    'Tick every statement. A partial confirmation is not a posture.',
  );
  await expect(page.getByTestId('posture-state')).not.toHaveAttribute('aria-invalid', 'true');

  await page.getByTestId('posture-state').selectOption('RI');
  await page.getByTestId('posture-statement-state_rules_checked').check();
  await page.getByTestId('posture-record').click();
  await expect(page.getByTestId('posture-issue-state')).toContainText('RI already has a posture in force');
  expect(server.calls.filter(call => call.method === 'recordPosture')).toHaveLength(0);
});

test('a refused posture comes back as it was sent, with the refusal in words', async ({ page }) => {
  await openAdmin(page, adminState());
  await page.getByTestId('posture-state').selectOption('TX');
  await page.getByTestId('posture-effective-from').fill('2026-11-02');
  await page.getByTestId('posture-statement-federal_rules_apply').check();
  await page.getByTestId('posture-statement-state_rules_checked').check();
  await page.getByTestId('posture-note').fill('Asked counsel.');
  await page.getByTestId('posture-record').click();

  await expect(page.getByTestId('notice')).toContainText('already has a posture in force for part of that time');
  await expect(page.getByTestId('posture-state')).toHaveValue('TX');
  await expect(page.getByTestId('posture-effective-from')).toHaveValue('2026-11-02');
  await expect(page.getByTestId('posture-statement-state_rules_checked')).toBeChecked();
  await expect(page.getByTestId('posture-note')).toHaveValue('Asked counsel.');
});

test('Revoke sends the posture id, and the JSON is behind a disclosure', async ({ page }) => {
  await openAdmin(page, adminState());

  await expect(page.getByTestId('postures-json-body')).toBeHidden();
  await page.getByTestId('postures-json').locator('summary').click();
  await expect(page.getByTestId('postures-json-body')).toContainText(`"id": "${POSTURE_ID}"`);

  await page.getByTestId(`posture-revoke-${POSTURE_ID}`).click();
  // The bridge call reaches the stub after the click resolves, so wait for it (lane g86).
  await expect
    .poll(() => server.calls.filter(call => call.method === 'revokePosture'))
    .toEqual([{ method: 'revokePosture', argument: { postureId: POSTURE_ID } }]);
  await expect(page.getByTestId('posture-status')).toHaveText('Revoked');
  await expect(page.getByTestId(`posture-revoke-${POSTURE_ID}`)).toHaveCount(0);
});

test('a salesperson sees the postures and cannot record or revoke one', async ({ page }) => {
  await openAdmin(page, adminState({ role: 'salesperson' }));
  await expect(page.getByTestId('posture-row')).toHaveCount(1);
  await expect(page.getByTestId('posture-state')).toBeDisabled();
  await expect(page.getByTestId('posture-statement-federal_rules_apply')).toBeDisabled();
  await expect(page.getByTestId('posture-record')).toBeDisabled();
  await expect(page.getByTestId(`posture-revoke-${POSTURE_ID}`)).toHaveCount(0);
  await expect(page.getByTestId('posture-inert')).toHaveText('Only an admin can record or revoke a posture.');
});

test('a failed read says so, with Retry', async ({ page }) => {
  await openAdmin(page, adminState({ postures: { reference: null, records: null, readError: 'offline' } }));
  await expect(page.getByTestId('postures-unread')).toContainText('Callie could not read the postures.');
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
