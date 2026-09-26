import { expect, test, type Page } from 'playwright/test';
import { navigateByMenu, startAppServer, type AppServer } from './support/appServer.ts';
import { FIRM_ID, crmState, pipelineView } from './support/crmFixtures.ts';
import { EXAMPLE_WORKSPACE, signedOutState } from './support/sessionFixtures.ts';
import { REPLY_FIRM_ID } from './support/homeFixtures.ts';
import { FIRM_ID as REPLY_CARD_FIRM_ID, replyCard, replyState } from './support/replyFixtures.ts';

/**
 * One window (wave 1): the owner's "clicking on a tab opens a new page", fixed.
 *
 * The sidebar stays on the left and the column shows one view at a time. These prove it
 * end to end against the shipped renderer: every route draws in place and lights its
 * row, the Window menu's `callie:navigate` does the same, a Today or reply card opens
 * its firm through the CRM bridge, a firm has a way back to the board, the Dashboard is
 * a route rather than a reload, and a view that was left draws nothing when a late
 * answer arrives.
 */

let server: AppServer;

test.afterEach(async () => {
  await server.stop();
});

/** Mark the document, so a spec can prove it was never loaded again. */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    (globalThis as unknown as { __loadedOnce?: boolean }).__loadedOnce = true;
  });
}

async function stillTheSameDocument(page: Page): Promise<boolean> {
  return await page.evaluate(() => (globalThis as unknown as { __loadedOnce?: boolean }).__loadedOnce === true);
}

const HEADINGS: readonly (readonly [string, string])[] = [
  ['replies', 'Replies'],
  ['firms', 'Pipeline'],
  ['sequences', 'Sequences'],
  ['admin', 'Administration'],
  ['dashboard', 'Administration'],
  ['today', 'Monday, 21 September'],
];

test('every sidebar row shows its view in the column, beside the same sidebar, in the same document', async ({ page }) => {
  server = await startAppServer();
  await page.goto(server.url());
  await expect(page.getByTestId('heading')).toHaveText('Monday, 21 September');
  await markDocument(page);

  for (const [route, heading] of HEADINGS) {
    await page.getByTestId(`nav-${route}`).click();
    await expect(page.getByTestId('heading')).toHaveText(heading);
    await expect(page.getByTestId(`nav-${route}`)).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[aria-current="page"]')).toHaveCount(1);
    // One view at a time: the column never holds two.
    await expect(page.getByTestId('heading')).toHaveCount(1);
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page.getByTestId('column')).toHaveAttribute('data-route', route);
  }
  expect(await stillTheSameDocument(page)).toBe(true);
  await expect(page.getByTestId('tab-dashboard')).toHaveCount(0);
});

test('the Window menu’s ⌘1–⌘6 show each view in the one window, and ⌘6 is never a reload', async ({ page }) => {
  server = await startAppServer();
  await page.goto(server.url());
  await expect(page.getByTestId('heading')).toHaveText('Monday, 21 September');
  await markDocument(page);

  await navigateByMenu(page, 'admin');
  await expect(page.getByTestId('tab-settings')).toHaveClass(/tab-current/u);
  await navigateByMenu(page, 'dashboard');
  await expect(page.getByTestId('tab-dashboard')).toHaveClass(/tab-current/u);
  await expect(page.getByTestId('nav-dashboard')).toHaveAttribute('aria-current', 'page');
  await navigateByMenu(page, 'firms');
  await expect(page.getByTestId('heading')).toHaveText('Pipeline');
  // A name outside the six is ignored, as the preload ignores it.
  await navigateByMenu(page, 'settings.html');
  await expect(page.getByTestId('heading')).toHaveText('Pipeline');
  await navigateByMenu(page, 'today');
  await expect(page.getByTestId('heading')).toHaveText('Monday, 21 September');

  expect(await stillTheSameDocument(page)).toBe(true);
  expect(server.called('admin.show')).toEqual([{ screen: 'settings' }, { screen: 'dashboard' }]);
});

test('a Today card opens its firm through the CRM bridge, and the firm page leads back to the board', async ({ page }) => {
  server = await startAppServer({ crm: crmState({ screen: 'pipeline', firm: null, pipeline: pipelineView() }) });
  await page.goto(server.url());
  await expect(page.getByTestId('today-card')).toHaveCount(4);

  await page.getByTestId('today-card').first().getByTestId('card-open-firm').click();
  // The handoff: the bridge is told which firm, because it holds the open firm.
  await expect.poll(() => server.called('crm.openFirm')).toEqual([{ firmId: REPLY_FIRM_ID }]);
  await expect(page.getByTestId('heading')).toHaveText('Firm');
  await expect(page.getByTestId('nav-firms')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('column')).toHaveAttribute('data-route', `firm/${REPLY_FIRM_ID}`);

  await page.getByTestId('back-to-pipeline').click();
  await expect(page.getByTestId('heading')).toHaveText('Pipeline');
  await expect(page.getByTestId('column')).toHaveAttribute('data-route', 'firms');
  expect(server.called('crm.openPipeline')).toHaveLength(1);
});

test('a reply card opens the firm it is about', async ({ page }) => {
  server = await startAppServer({ replies: replyState({ cards: [replyCard()], open: replyCard() }) });
  await page.goto(server.url('#replies'));
  await expect(page.getByTestId('reply-card')).toBeVisible();

  await page.getByTestId('reply-open-firm').click();
  await expect.poll(() => server.called('crm.openFirm')).toEqual([{ firmId: REPLY_CARD_FIRM_ID }]);
  await expect(page.getByTestId('heading')).toHaveText('Firm');
  await expect(page.getByTestId('nav-firms')).toHaveAttribute('aria-current', 'page');
});

test('Firms from a firm page is the board: the sidebar never lands on the firm the bridge last held', async ({ page }) => {
  server = await startAppServer({ crm: crmState() });
  await page.goto(server.url(`#firm/${FIRM_ID}`));
  await expect(page.getByTestId('heading')).toHaveText('Firm');

  await page.getByTestId('nav-firms').click();
  await expect(page.getByTestId('heading')).toHaveText('Pipeline');
  expect(server.crm.calls.map(call => call.method)).toEqual(['openFirm', 'state', 'openPipeline']);
});

test('an answer that arrives after its view was left draws nothing', async ({ page }) => {
  server = await startAppServer();
  await page.goto(server.url());
  await expect(page.getByTestId('heading')).toHaveText('Monday, 21 September');

  const release = server.hold('crm.state');
  await page.getByTestId('nav-firms').click();
  await expect.poll(() => server.called('crm.state')).toHaveLength(1);
  await page.getByTestId('nav-replies').click();
  await expect(page.getByTestId('heading')).toHaveText('Replies');

  release();
  await expect.poll(() => server.called('crm.openPipeline').length + server.called('crm.state').length).toBeGreaterThan(0);
  // Give the late answer every chance to draw, then look: still Replies, and only Replies.
  await page.waitForTimeout(300);
  await expect(page.getByTestId('heading')).toHaveText('Replies');
  await expect(page.getByTestId('pipeline-board')).toHaveCount(0);
  await expect(page.getByTestId('nav-replies')).toHaveAttribute('aria-current', 'page');
});

test('a late answer for a view mounted again is dropped: the firm asked for first never covers the board', async ({ page }) => {
  server = await startAppServer({ crm: crmState({ screen: 'pipeline', firm: null, pipeline: pipelineView() }) });
  const release = server.hold('crm.openFirm');
  await page.goto(server.url(`#firm/${FIRM_ID}`));
  await expect.poll(() => server.called('crm.openFirm')).toHaveLength(1);

  // Firms again before the firm has answered: the same view, mounted a second time.
  await page.getByTestId('nav-firms').click();
  await expect(page.getByTestId('heading')).toHaveText('Pipeline');

  release();
  await page.waitForTimeout(300);
  await expect(page.getByTestId('heading')).toHaveText('Pipeline');
  await expect(page.getByTestId('firm-identity')).toHaveCount(0);
  await expect(page.getByTestId('column')).toHaveAttribute('data-route', 'firms');
});

test('many route changes in a row end on the last one, drawn once', async ({ page }) => {
  server = await startAppServer();
  await page.goto(server.url());
  await expect(page.getByTestId('heading')).toHaveText('Monday, 21 September');

  for (let round = 0; round < 3; round += 1) {
    for (const route of ['firms', 'replies', 'sequences', 'admin', 'dashboard', 'today', 'replies']) {
      await page.getByTestId(`nav-${route}`).click();
    }
  }
  await expect(page.getByTestId('heading')).toHaveText('Replies');
  await page.waitForTimeout(300);
  await expect(page.getByTestId('heading')).toHaveCount(1);
  await expect(page.getByTestId('reply-list')).toHaveCount(1);
  await expect(page.getByTestId('sequence-list')).toHaveCount(0);
  await expect(page.getByTestId('tabs')).toHaveCount(0);
});

test('coming back to Today keeps the list on screen and does not read it again within a minute', async ({ page }) => {
  server = await startAppServer();
  await page.goto(server.url());
  await expect.poll(() => server.called('today.refresh').length).toBe(1);

  await page.getByTestId('nav-sequences').click();
  await expect(page.getByTestId('heading')).toHaveText('Sequences');
  await page.getByTestId('nav-today').click();
  await expect(page.getByTestId('today-card')).toHaveCount(4);
  expect(server.called('today.refresh')).toHaveLength(1);
});

test('signing out from another view leaves the shell for the sign-in form', async ({ page }) => {
  server = await startAppServer();
  await page.goto(server.url('#sequences'));
  await expect(page.getByTestId('heading')).toHaveText('Sequences');

  await page.getByTestId('this-mac-summary').click();
  await page.getByTestId('sign-out').click();
  await expect(page.getByTestId('heading')).toHaveText('Sign in with Google');
  await expect(page.getByTestId('sidebar')).toHaveCount(0);
});

test('a deep link that arrives before sign-in is where the window opens once signed in', async ({ page }) => {
  // The main process queues a cold link until the page has loaded (`showRoute`), and the
  // page keeps it until there is a shell to show it in.
  server = await startAppServer({ desktop: signedOutState() });
  await page.goto(server.url());
  await expect(page.getByTestId('heading')).toHaveText('Sign in with Google');
  await navigateByMenu(page, 'dashboard');
  await expect(page.getByTestId('heading')).toHaveText('Sign in with Google');

  await page.getByTestId('workspace-id').fill(EXAMPLE_WORKSPACE);
  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('tab-dashboard')).toHaveClass(/tab-current/u);
  await expect(page.getByTestId('nav-dashboard')).toHaveAttribute('aria-current', 'page');
});

test('the route is in the address, so the View menu’s Reload comes back to the same view', async ({ page }) => {
  server = await startAppServer({ crm: crmState({ screen: 'pipeline', firm: null, pipeline: pipelineView() }) });
  await page.goto(server.url());
  await page.getByTestId('nav-firms').click();
  await expect(page.getByTestId('heading')).toHaveText('Pipeline');
  expect(new URL(page.url()).hash).toBe('#firms');

  await page.reload();
  await expect(page.getByTestId('heading')).toHaveText('Pipeline');
  await expect(page.getByTestId('nav-firms')).toHaveAttribute('aria-current', 'page');
});
