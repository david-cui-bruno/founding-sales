import { expect, test, type Page } from 'playwright/test';
import { navigateByMenu, startAppServer, type AppServer } from './support/appServer.ts';
import { FIRM_ID, crmState, pipelineView } from './support/crmFixtures.ts';
import { EXAMPLE_WORKSPACE, signedOutState } from './support/sessionFixtures.ts';
import { REPLY_FIRM_ID, expandedFirm, todayState } from './support/homeFixtures.ts';
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

/** Each sidebar row, the heading its view draws, and the route the column reports. */
const HEADINGS: readonly (readonly [string, string, string])[] = [
  ['replies', 'Replies', 'replies'],
  ['firms', 'Pipeline', 'firms'],
  ['sequences', 'Sequences', 'sequences'],
  ['settings', 'Settings', 'settings/administration'],
  ['today', 'Monday, 21 September', 'today'],
];

test('every sidebar row shows its view in the column, beside the same sidebar, in the same document', async ({ page }) => {
  server = await startAppServer();
  await page.goto(server.url());
  await expect(page.getByTestId('heading')).toHaveText('Monday, 21 September');
  await markDocument(page);

  for (const [row, heading, route] of HEADINGS) {
    await page.getByTestId(`nav-${row}`).click();
    await expect(page.getByTestId('heading')).toHaveText(heading);
    await expect(page.getByTestId(`nav-${row}`)).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[aria-current="page"]')).toHaveCount(1);
    // One view at a time: the column never holds two.
    await expect(page.getByTestId('heading')).toHaveCount(1);
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page.getByTestId('column')).toHaveAttribute('data-route', route);
  }
  expect(await stillTheSameDocument(page)).toBe(true);
  await expect(page.getByTestId('tabs')).toHaveCount(0);
});

test('the Window menu shows each view in the one window, and a Settings tab is never a reload', async ({ page }) => {
  server = await startAppServer();
  await page.goto(server.url());
  await expect(page.getByTestId('heading')).toHaveText('Monday, 21 September');
  await markDocument(page);

  await navigateByMenu(page, 'settings/administration');
  await expect(page.getByTestId('tab-settings')).toHaveClass(/tab-current/u);
  await navigateByMenu(page, 'settings/dashboard');
  await expect(page.getByTestId('tab-dashboard')).toHaveClass(/tab-current/u);
  await expect(page.getByTestId('nav-settings')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('column')).toHaveAttribute('data-route', 'settings/dashboard');
  await navigateByMenu(page, 'firms');
  await expect(page.getByTestId('heading')).toHaveText('Pipeline');
  // A target outside the closed set is ignored — the preload drops it first, and the
  // page refuses it again.
  await navigateByMenu(page, 'settings.html');
  await expect(page.getByTestId('heading')).toHaveText('Pipeline');
  // 1.0.11's name still opens the tab it used to: links made before this release exist.
  await navigateByMenu(page, 'admin');
  await expect(page.getByTestId('heading')).toHaveText('Settings');
  await expect(page.getByTestId('tab-settings')).toHaveClass(/tab-current/u);
  await navigateByMenu(page, 'today');
  await expect(page.getByTestId('heading')).toHaveText('Monday, 21 September');

  expect(await stillTheSameDocument(page)).toBe(true);
  expect(server.called('admin.show')).toEqual([{ screen: 'settings' }, { screen: 'dashboard' }, { screen: 'settings' }]);
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
    for (const route of ['firms', 'replies', 'sequences', 'settings', 'today', 'replies']) {
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
  await navigateByMenu(page, 'settings/dashboard');
  await expect(page.getByTestId('heading')).toHaveText('Sign in with Google');

  await page.getByTestId('workspace-id').fill(EXAMPLE_WORKSPACE);
  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('tab-dashboard')).toHaveClass(/tab-current/u);
  await expect(page.getByTestId('nav-settings')).toHaveAttribute('aria-current', 'page');
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

test('leaving Replies while a read is in flight does not leave the next view inert', async ({ page }) => {
  /*
   * The column belongs to the shell, and Replies makes it read-only while a call is on
   * the wire so a second press of Confirm sends nothing. Until 1.0.12 nothing released
   * that hold when the view was left: navigating during the call left `inert` on the
   * column, and every view drawn after it could be read and not touched.
   */
  server = await startAppServer({ replies: replyState() });
  await page.goto(server.url('#replies'));
  await expect(page.getByTestId('reply-list')).toBeVisible();

  const release = server.hold('replies.open');
  await page.getByTestId('reply-open').nth(0).click();
  await expect(page.getByTestId('column')).toHaveAttribute('aria-busy', 'true');

  // Away while it is still holding, and the answer lands in a window that has left.
  await page.getByTestId('nav-today').click();
  release();

  await expect(page.getByTestId('column')).toHaveAttribute('data-route', 'today');
  await expect(page.getByTestId('column')).not.toHaveAttribute('aria-busy', 'true');
  expect(await page.getByTestId('column').evaluate(element => (element as HTMLElement).inert)).toBe(false);
  // And the view drawn there can actually be used.
  await expect(page.getByTestId('refresh')).toBeEnabled();
  await page.getByTestId('refresh').click();
  await expect.poll(() => server.called('today.refresh').length).toBeGreaterThan(0);
});

test('leaving Replies while a command is in flight strands nothing and brings nothing back', async ({ page }) => {
  // The same race with a command rather than a read. A confirmation re-reads the lane
  // when the server answers it, so this is the one that could have put a lane back into
  // a process the view had left — and the hold it took has to be released either way.
  server = await startAppServer({ replies: replyState() });
  await page.goto(server.url('#replies'));
  await page.getByTestId('reply-open').nth(0).click();
  await expect(page.getByTestId('reply-card')).toBeVisible();

  const release = server.hold('replies.confirm');
  await page.getByTestId('confirm').click();
  await expect(page.getByTestId('column')).toHaveAttribute('aria-busy', 'true');

  await page.getByTestId('nav-today').click();
  release();
  await expect.poll(() => server.called('replies.forget').length).toBe(1);

  await expect(page.getByTestId('column')).toHaveAttribute('data-route', 'today');
  await expect(page.getByTestId('column')).not.toHaveAttribute('aria-busy', 'true');
  expect(await page.getByTestId('column').evaluate(element => (element as HTMLElement).inert)).toBe(false);
  // Nothing of the reply is on the page the person is looking at.
  await expect(page.getByTestId('reply-card')).toHaveCount(0);
  await expect(page.getByTestId('refresh')).toBeEnabled();
});

test('a session change empties the window: the cache and everything typed go at once', async ({ page }) => {
  /*
   * The main process says the person, the workspace or the role changed — or that this
   * Mac's registration is over. Until 1.0.12 the renderer found out by noticing that a
   * state it happened to read looked different, so the last person's list, figures and
   * half-written snooze reason stayed on screen until something asked.
   */
  server = await startAppServer({ today: todayState({ expanded: expandedFirm() }) });
  await page.goto(server.url());
  await expect(page.getByTestId('today-card').first()).toBeVisible();
  await page.getByTestId('snooze-reason').nth(1).fill('Waiting on their board');

  // The sidebar's reads are keyed on the person alone, so the only thing that makes
  // them happen again is the cache having been emptied.
  const adminBefore = server.called('admin.state').length;
  const readsBefore = server.called('today.state').length + server.called('today.refresh').length;
  await page.evaluate(() => {
    const listeners = (globalThis as { __sessionListeners?: ((change: unknown) => void)[] }).__sessionListeners ?? [];
    for (const listener of listeners) listener({ generation: 1, identity: null, reason: 'device_revoked' });
  });

  // The list and the sidebar are read again rather than served from the cache the last
  // person filled…
  await expect.poll(() => server.called('admin.state').length).toBeGreaterThan(adminBefore);
  await expect
    .poll(() => server.called('today.state').length + server.called('today.refresh').length)
    .toBeGreaterThan(readsBefore);
  // …and what was typed is not the next person's to read.
  await expect(page.getByTestId('snooze-reason').nth(1)).toHaveValue('');
});
