import { expect, test, type Page } from 'playwright/test';
import {
  CHECKING_ROUTE_ID,
  FIRM_ID,
  addressesFirmPage,
  OPPORTUNITY_ID,
  SEQUENCE_VERSION_ID,
  assigneeFirmPage,
  colleagueFirmPage,
  crmState,
  firmSequences,
  mergeView,
  pipelineView,
} from './support/crmFixtures.ts';
import { startAppServer, type AppServer, type BridgeHandle } from './support/appServer.ts';
import type { CrmState } from '../../src/renderer/firmWorkspaceContract.ts';

/**
 * The CRM windows, driven end to end against the one test harness.
 *
 * The renderer is the shipped file; only the bridge is substituted, so what these
 * specs prove is what a person actually sees and can press: the Firm page at two
 * widths, the pipeline with its Lost reason, the contacts editor, and the merge
 * conflict screen that will not submit until every field has been decided.
 *
 * Every scenario runs twice where a role changes the answer. A suite that only ever
 * ran as the assignee would pass with the redaction deleted.
 */

let app: AppServer;
let server: BridgeHandle<CrmState>;

test.afterEach(async () => {
  await app.stop();
});

/** The Firms view on `state`: a firm page by its own route, anything else by `firms`. */
async function openCrm(page: Page, state: CrmState): Promise<void> {
  app = await startAppServer({ crm: state });
  server = app.crm;
  await page.goto(app.url(state.screen === 'firm' && state.firm !== null ? `#firm/${state.firm.read.firm.id}` : '#firms'));
}

// ------------------------------------------------------------------- Firm page
test('the assignee sees routes with their eligibility, contacts, history and holds', async ({ page }) => {
  await openCrm(page, crmState());

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
  await openCrm(page, crmState({ firm: colleagueFirmPage() }));

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
  await openCrm(
    page,
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

  await expect(page.getByTestId('firm-identity')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('img')).toHaveCount(0);
});

// ------------------------------------------------------------ contacts editing
test('editing a contact sends exactly what was typed, and the promotion flag', async ({ page }) => {
  await openCrm(page, crmState());

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
  await openCrm(page, crmState());
  await expect(page.getByTestId('contact-primary').nth(0)).toBeChecked();
  await expect(page.getByTestId('contact-primary').nth(0)).toBeDisabled();
  await expect(page.getByTestId('contact-primary').nth(1)).toBeEnabled();
});

test('an outage is a banner over the firm, and nothing is disabled for it (wave 1)', async ({ page }) => {
  await openCrm(page, crmState({ online: false }));

  await expect(page.getByTestId('banner-warning')).toContainText('cannot reach the server');
  await expect(page.getByTestId('banner-warning')).toContainText('Changes will fail until it reconnects.');
  await expect(page.getByTestId('firm-identity')).toContainText('Northwind Test Holdings');
  await expect(page.getByTestId('contact-name').nth(0)).toBeEnabled();
  await expect(page.getByTestId('contact-save').nth(0)).toBeEnabled();
});

// ------------------------------------------------------------------- pipeline
test('the pipeline shows the workspace stages, keeps a retired one that is occupied', async ({ page }) => {
  await openCrm(page, crmState({ screen: 'pipeline', pipeline: pipelineView(), firm: null }));

  await expect(page.getByTestId('heading')).toHaveText('Pipeline');
  // Six of the seven: the empty retired stage is not on screen, the occupied one is.
  await expect(page.getByTestId('pipeline-column')).toHaveCount(6);
  await expect(page.getByTestId('stage-retired')).toHaveCount(1);
  await expect(page.getByTestId('stage-terminal')).toHaveCount(2);
  await expect(page.getByTestId('pipeline-firm')).toHaveCount(2);
});

test('a Lost change asks for a reason and will not go without one', async ({ page }) => {
  await openCrm(page, crmState({ screen: 'pipeline', pipeline: pipelineView(), firm: null }));

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
  await openCrm(page, crmState({ screen: 'pipeline', pipeline: pipelineView(), firm: null }));
  const options = await page.getByTestId('stage-select').first().locator('option').allTextContents();
  expect(options).toEqual(['Move to…', 'New', 'Contacting', 'Engaged', 'Won', 'Lost']);
});

test('a firm with no open opportunity offers no stage control at all', async ({ page }) => {
  await openCrm(page, crmState({ screen: 'pipeline', pipeline: pipelineView(), firm: null }));
  // The occupied retired column's firm has no open opportunity in the fixture.
  await expect(page.getByTestId('stage-change-unavailable')).toHaveCount(1);
});

test('opening a firm from the board asks for that firm', async ({ page }) => {
  await openCrm(page, crmState({ screen: 'pipeline', pipeline: pipelineView(), firm: null }));
  await page.getByTestId('pipeline-open-firm').first().click();
  await expect(page.getByTestId('heading')).toHaveText('Firm');
  expect(server.calls.find(entry => entry.method === 'openFirm')?.argument).toEqual({ firmId: FIRM_ID });
});

// ------------------------------------------------------------ merge resolution
test('a merge will not submit until every conflict has been decided', async ({ page }) => {
  await openCrm(page, crmState({ screen: 'merge', role: 'admin', merge: mergeView(), firm: null }));

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
  await openCrm(
    page,
    crmState({ screen: 'merge', role: 'salesperson', merge: mergeView(), firm: null }),
  );

  await expect(page.getByTestId('merge-conflict')).toHaveCount(2);
  await expect(page.locator('input[type=radio]').first()).toBeDisabled();
  await expect(page.getByTestId('merge-submit')).toBeDisabled();
});

// ------------------------------------------------------------ lane g88: the Firm page
test('a candidate number is confirmed at the version on screen, and an address has no such button', async ({ page }) => {
  await openCrm(page, crmState({ sequences: firmSequences() }));

  // One candidate number: one button, beside it, and the sentence saying what it does.
  await expect(page.getByTestId('route-confirm')).toHaveCount(1);
  await expect(page.getByTestId('routes-hint-phone')).toContainText('confirm it reaches this firm');
  await expect(page.getByTestId('firm-routes-email').getByTestId('route-confirm')).toHaveCount(0);

  await page.getByTestId('route-confirm').click();
  await expect(page.getByTestId('banner-info')).toHaveText('Number confirmed. It can be called now.');
  expect(server.calls.find(entry => entry.method === 'confirmRoute')?.argument).toEqual({
    routeId: '99999999-9999-4999-8999-999999999999',
    routeVersion: 1,
  });
  await expect(page.getByTestId('route-eligibility').nth(1)).toHaveText('usable');
  await expect(page.getByTestId('route-version').nth(1)).toHaveText('v2');
  await expect(page.getByTestId('route-confirm')).toHaveCount(0);
});

// ------------------------------------------------------------ lane g90: an address's validation
test('each address says where its validation stands, and one being checked can be checked again', async ({ page }) => {
  await openCrm(page, crmState({ firm: addressesFirmPage(), sequences: firmSequences() }));

  const addresses = page.getByTestId('firm-routes-email');
  await expect(addresses.getByTestId('route-validation')).toHaveText([
    'Checking…',
    'Deliverable domain — usable',
    'Mail can’t reach this address — invalid',
  ]);
  // g88's sentence under the addresses is gone; the state beside each one replaced it.
  await expect(page.getByTestId('routes-hint-email')).toHaveCount(0);
  await expect(addresses.getByTestId('route-confirm')).toHaveCount(0);

  // Only the address still being checked offers Check again.
  await expect(addresses.getByTestId('route-check')).toHaveCount(1);
  await addresses.getByTestId('route-check').click();
  await expect(page.getByTestId('banner-info')).toHaveText(
    'Callie will check that address again in a moment. Open the firm again to see the answer.',
  );
  expect(server.calls.find(entry => entry.method === 'checkRoute')?.argument).toEqual({
    routeId: CHECKING_ROUTE_ID,
    routeVersion: 1,
  });
});

test('Check again is not pressable while the window may not change anything', async ({ page }) => {
  await openCrm(page, crmState({ firm: addressesFirmPage(), mayMutate: false }));
  await expect(page.getByTestId('firm-routes-email').getByTestId('route-check')).toBeDisabled();
  await expect(page.getByTestId('firm-routes-email').getByTestId('route-validation').first()).toHaveText('Checking…');
});

test('a contact is enrolled from the Firm page in a published sequence', async ({ page }) => {
  await openCrm(page, crmState({ sequences: firmSequences() }));

  await expect(page.getByTestId('enroll-sequence').locator('option')).toHaveText(['Founder plan v1']);
  await page.getByTestId('enroll-contact').selectOption({ label: 'Robin Placeholder' });
  await page.getByTestId('enroll-submit').click();
  await expect(page.getByTestId('banner-info')).toHaveText('Enrolled. The first step is on its way to Today.');
  expect(server.calls.find(entry => entry.method === 'enroll')?.argument).toEqual({
    sequenceVersionId: SEQUENCE_VERSION_ID,
    contactId: '77777777-7777-4777-8777-777777777777',
  });
  await expect(page.getByTestId('firm-enrollment')).toContainText('Robin Placeholder — Founder plan v1');
});

test('a firm with no opportunity is offered "Add to pipeline" before any enrolment', async ({ page }) => {
  const firm = assigneeFirmPage();
  await openCrm(page, crmState({ firm: { ...firm, opportunity: null } as typeof firm, sequences: firmSequences() }));

  await expect(page.getByTestId('enroll-form')).toHaveCount(0);
  await expect(page.getByTestId('enroll-needs-pipeline')).toHaveText('Put the firm in the pipeline before enrolling anybody here.');
  await page.getByTestId('open-opportunity').click();
  await expect(page.getByTestId('banner-info')).toHaveText('In the pipeline, at the first stage.');
  expect(server.calls.some(entry => entry.method === 'openOpportunity')).toBe(true);
});

test('clearing a contact’s title sends the null that clears it', async ({ page }) => {
  await openCrm(page, crmState());
  await page.getByTestId('contact-title').nth(0).fill('');
  await page.getByTestId('contact-save').nth(0).click();
  await expect(page.getByTestId('banner-info')).toContainText('Saved.');
  expect(server.calls.find(entry => entry.method === 'saveContact')?.argument).toEqual({
    contactId: '66666666-6666-4666-8666-666666666666',
    fullName: 'Dana Example',
    title: null,
    makePrimary: false,
  });
});
