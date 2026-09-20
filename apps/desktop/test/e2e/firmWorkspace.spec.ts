import { expect, test } from 'playwright/test';
import {
  FIRM_ID,
  OPPORTUNITY_ID,
  assigneeFirmPage,
  colleagueFirmPage,
  crmState,
  mergeView,
  pipelineView,
  startCrmTestServer,
  type CrmTestServer,
} from './support/crmTestServer.ts';

/**
 * The CRM windows, driven end to end against the generated test server.
 *
 * The renderer is the shipped file; only the bridge is substituted, so what these
 * specs prove is what a person actually sees and can press: the Firm page at two
 * widths, the pipeline with its Lost reason, the contacts editor, and the merge
 * conflict screen that will not submit until every field has been decided.
 *
 * Every scenario runs twice where a role changes the answer. A suite that only ever
 * ran as the assignee would pass with the redaction deleted.
 */

let server: CrmTestServer;

test.afterEach(async () => {
  await server.stop();
});

// ------------------------------------------------------------------- Firm page
test('the assignee sees routes with their eligibility, contacts, history and holds', async ({ page }) => {
  server = await startCrmTestServer(crmState());
  await page.goto(server.url);

  await expect(page.getByTestId('heading')).toHaveText('Firm');
  await expect(page.getByTestId('firm-identity')).toContainText('Northwind Test Holdings');
  await expect(page.getByTestId('firm-identity')).toContainText('9 Sample Street');

  // A route that is not usable is shown and marked, not hidden: "no number" and
  // "a number nobody has confirmed" are different facts (9.1).
  await expect(page.getByTestId('firm-route')).toHaveCount(3);
  await expect(page.getByTestId('route-eligibility').nth(0)).toHaveText('usable');
  await expect(page.getByTestId('route-eligibility').nth(1)).toHaveText('candidate');
  await expect(page.getByTestId('route-version').nth(0)).toHaveText('v3');

  await expect(page.getByTestId('contact-row')).toHaveCount(2);
  await expect(page.getByTestId('stage-event')).toHaveCount(2);
  await expect(page.getByTestId('stage-event-move').nth(1)).toHaveText('new → contacting');

  await expect(page.getByTestId('firm-hold')).toHaveCount(1);
  await expect(page.getByTestId('hold-reason')).toHaveText('reassignment');
  await expect(page.getByTestId('hold-blocks')).toHaveText('email_send, call_task');
  await expect(page.getByTestId('hold-recovery')).toHaveText('resume_after_review');

  await expect(page.getByTestId('firm-redacted')).toHaveCount(0);
});

test('a colleague sees identity, a sentence saying why, and nothing else', async ({ page }) => {
  server = await startCrmTestServer(crmState({ firm: colleagueFirmPage() }));
  await page.goto(server.url);

  await expect(page.getByTestId('firm-identity')).toContainText('Northwind Test Holdings');
  await expect(page.getByTestId('firm-redacted')).toContainText('assigned to somebody else');

  // Not empty sections: no sections. The address, the people and the holds were
  // never sent, and nothing on the page implies the firm has none of them.
  for (const testId of ['firm-routes-phone', 'contacts-panel', 'firm-opportunity', 'firm-holds']) {
    await expect(page.getByTestId(testId), testId).toHaveCount(0);
  }
  await expect(page.locator('body')).not.toContainText('9 Sample Street');
  await expect(page.locator('body')).not.toContainText('Dana Example');
});

test('a firm name that looks like markup is shown as text', async ({ page }) => {
  const firm = assigneeFirmPage();
  server = await startCrmTestServer(
    crmState({
      firm: {
        ...firm,
        read: {
          visibility: 'assigned_or_admin',
          firm: { ...firm.read.firm, name: '<img src=x onerror=alert(1)>' },
        },
      } as typeof firm,
    }),
  );
  await page.goto(server.url);

  await expect(page.getByTestId('firm-identity')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('img')).toHaveCount(0);
});

// ------------------------------------------------------------ contacts editing
test('editing a contact sends exactly what was typed, and the promotion flag', async ({ page }) => {
  server = await startCrmTestServer(crmState());
  await page.goto(server.url);

  await page.getByTestId('contact-name').nth(1).fill('Robin Placeholder-Jones');
  await page.getByTestId('contact-title').nth(1).fill('Head of Operations');
  await page.getByTestId('contact-primary').nth(1).check();
  await page.getByTestId('contact-save').nth(1).click();

  await expect(page.getByTestId('banner-info')).toContainText('Saved.');
  const call = server.calls.find(entry => entry.method === 'saveContact');
  expect(call?.argument).toEqual({
    contactId: '77777777-7777-4777-8777-777777777777',
    fullName: 'Robin Placeholder-Jones',
    title: 'Head of Operations',
    makePrimary: true,
  });
});

test('the current main contact cannot be asked to become the main contact again', async ({ page }) => {
  server = await startCrmTestServer(crmState());
  await page.goto(server.url);
  await expect(page.getByTestId('contact-primary').nth(0)).toBeChecked();
  await expect(page.getByTestId('contact-primary').nth(0)).toBeDisabled();
  await expect(page.getByTestId('contact-primary').nth(1)).toBeEnabled();
});

test('an outage leaves the firm readable and nothing editable', async ({ page }) => {
  server = await startCrmTestServer(crmState({ online: false }));
  await page.goto(server.url);

  await expect(page.getByTestId('banner-warning')).toContainText('cannot reach the server');
  await expect(page.getByTestId('firm-identity')).toContainText('Northwind Test Holdings');
  await expect(page.getByTestId('contact-name').nth(0)).toBeDisabled();
  await expect(page.getByTestId('contact-save').nth(0)).toBeDisabled();
});

// ------------------------------------------------------------------- pipeline
test('the pipeline shows the workspace stages, keeps a retired one that is occupied', async ({ page }) => {
  server = await startCrmTestServer(crmState({ screen: 'pipeline', pipeline: pipelineView(), firm: null }));
  await page.goto(server.url);

  await expect(page.getByTestId('heading')).toHaveText('Pipeline');
  // Six of the seven: the empty retired stage is not on screen, the occupied one is.
  await expect(page.getByTestId('pipeline-column')).toHaveCount(6);
  await expect(page.getByTestId('stage-retired')).toHaveCount(1);
  await expect(page.getByTestId('stage-terminal')).toHaveCount(2);
  await expect(page.getByTestId('pipeline-firm')).toHaveCount(2);
});

test('a Lost change asks for a reason and will not go without one', async ({ page }) => {
  server = await startCrmTestServer(crmState({ screen: 'pipeline', pipeline: pipelineView(), firm: null }));
  await page.goto(server.url);

  const change = page.getByTestId('stage-change').first();
  await expect(change.getByTestId('stage-submit')).toBeDisabled();
  await expect(change.getByTestId('stage-reason')).toBeHidden();

  await change.getByTestId('stage-select').selectOption('engaged');
  await expect(change.getByTestId('stage-reason')).toBeHidden();
  await expect(change.getByTestId('stage-submit')).toBeEnabled();

  await change.getByTestId('stage-select').selectOption('lost');
  await expect(change.getByTestId('stage-reason')).toBeVisible();
  await expect(change.getByTestId('stage-submit')).toBeDisabled();

  await change.getByTestId('stage-reason').fill('   ');
  await expect(change.getByTestId('stage-submit')).toBeDisabled();

  await change.getByTestId('stage-reason').fill('Budget moved to next year');
  await expect(change.getByTestId('stage-submit')).toBeEnabled();
  await change.getByTestId('stage-submit').click();

  await expect(page.getByTestId('banner-info')).toContainText('Stage changed.');
  expect(server.calls.find(entry => entry.method === 'changeStage')?.argument).toEqual({
    opportunityId: OPPORTUNITY_ID,
    toStageKey: 'lost',
    reason: 'Budget moved to next year',
  });
});

test('a retired stage is never offered as a destination', async ({ page }) => {
  server = await startCrmTestServer(crmState({ screen: 'pipeline', pipeline: pipelineView(), firm: null }));
  await page.goto(server.url);
  const options = await page.getByTestId('stage-select').first().locator('option').allTextContents();
  expect(options).toEqual(['Move to…', 'New', 'Contacting', 'Engaged', 'Won', 'Lost']);
});

test('a firm with no open opportunity offers no stage control at all', async ({ page }) => {
  server = await startCrmTestServer(crmState({ screen: 'pipeline', pipeline: pipelineView(), firm: null }));
  await page.goto(server.url);
  // The occupied retired column's firm has no open opportunity in the fixture.
  await expect(page.getByTestId('stage-change-unavailable')).toHaveCount(1);
});

test('opening a firm from the board asks for that firm', async ({ page }) => {
  server = await startCrmTestServer(crmState({ screen: 'pipeline', pipeline: pipelineView(), firm: null }));
  await page.goto(server.url);
  await page.getByTestId('pipeline-open-firm').first().click();
  await expect(page.getByTestId('heading')).toHaveText('Firm');
  expect(server.calls.find(entry => entry.method === 'openFirm')?.argument).toEqual({ firmId: FIRM_ID });
});

// ------------------------------------------------------------ merge resolution
test('a merge will not submit until every conflict has been decided', async ({ page }) => {
  server = await startCrmTestServer(crmState({ screen: 'merge', role: 'admin', merge: mergeView(), firm: null }));
  await page.goto(server.url);

  await expect(page.getByTestId('heading')).toHaveText('Resolve this merge');
  await expect(page.getByTestId('merge-conflict')).toHaveCount(2);
  await expect(page.getByTestId('merge-submit')).toBeDisabled();

  // Nothing is preselected: the API returns source and target in a fixed order and
  // a default would be decided by which way round the merge was started.
  await expect(page.locator('input[type=radio]:checked')).toHaveCount(0);

  await page.getByTestId('merge-conflict').nth(0).locator('input[type=radio]').first().check();
  await expect(page.getByTestId('merge-submit')).toBeDisabled();

  // The second conflict has an empty source: it is shown, and only the one recorded
  // value is offered.
  await expect(page.getByTestId('merge-source-empty')).toHaveCount(1);
  await expect(page.getByTestId('merge-conflict').nth(1).locator('input[type=radio]')).toHaveCount(1);
  await page.getByTestId('merge-conflict').nth(1).locator('input[type=radio]').first().check();

  await expect(page.getByTestId('merge-submit')).toBeEnabled();
  await page.getByTestId('merge-submit').click();
  await expect(page.getByTestId('banner-info')).toContainText('Merged.');
  expect(server.calls.find(entry => entry.method === 'resolveMerge')?.argument).toEqual({
    sourceFirmId: FIRM_ID,
    targetFirmId: '44444444-4444-4444-8444-444444444444',
    resolutions: {
      website: 'https://northwind.example.test',
      locality: 'Providence',
    },
  });
});

test('a salesperson sees the conflicts and cannot commit the merge', async ({ page }) => {
  server = await startCrmTestServer(
    crmState({ screen: 'merge', role: 'salesperson', merge: mergeView(), firm: null }),
  );
  await page.goto(server.url);

  await expect(page.getByTestId('merge-conflict')).toHaveCount(2);
  await expect(page.locator('input[type=radio]').first()).toBeDisabled();
  await expect(page.getByTestId('merge-submit')).toBeDisabled();
});
