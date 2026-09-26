import { expect, test, type Locator, type Page } from 'playwright/test';
import { startAppServer, type AppServer } from './support/appServer.ts';
import { desktopState } from './support/homeFixtures.ts';
import { notConnectedMailbox } from './support/sessionFixtures.ts';

/**
 * Lane g83: the update line in Home's sidebar, as a person sees and presses it.
 *
 * The shipped renderer with `callieUpdate` substituted: "Updating Callie to 1.0.6…" while
 * an install runs, "Callie 1.0.6 is ready" with Restart to update once one is staged, and
 * the install notice on the upgrade screen, which still has nothing to press.
 */

let server: AppServer;

test.afterEach(async () => {
  await server.stop();
});

const called = (method: string): unknown[] =>
  server.calls.filter(call => call.method === method).map(call => call.argument);

test('a staged update is one line under the version, and Restart to update installs it', async ({ page }) => {
  server = await startAppServer({ update: { kind: 'ready', version: '1.0.6' } });
  await page.goto(server.url());

  const row = page.getByTestId('status-update');
  await expect(row).toContainText('Callie 1.0.6 is ready');
  await expect(page.getByTestId('status').getByRole('listitem').nth(-2)).toHaveText('Callie 1.0.3 · online');
  // The only control in the status list.
  await expect(page.getByTestId('status').getByRole('button')).toHaveCount(1);

  await page.getByTestId('update-restart').click();
  await expect.poll(() => called('update.restart')).toEqual([null]);
  await expect(row).toHaveText('Updating Callie to 1.0.6…');
  await expect(page.getByTestId('update-restart')).toHaveCount(0);
});

test('the line appears when the main process says the state changed', async ({ page }) => {
  server = await startAppServer({ update: { kind: 'none' } });
  await page.goto(server.url());
  await expect(page.getByTestId('status-system')).toHaveText('Callie 1.0.3 · online');
  await expect(page.getByTestId('status-update')).toHaveCount(0);

  server.update.setState({ kind: 'installing', version: '1.0.6' });
  await page.evaluate(() => {
    for (const listener of (globalThis as unknown as { __updateListeners: (() => void)[] }).__updateListeners) listener();
  });
  await expect(page.getByTestId('status-update')).toHaveText('Updating Callie to 1.0.6…');
});

test('the upgrade screen says an install is under way, and still has nothing to press', async ({ page }) => {
  server = await startAppServer({
    desktop: desktopState({ screen: 'upgrade_required', mayMutate: false, supportedClientVersions: { minimum: '1.0.6', maximum: '1.999.999' } }),
    update: { kind: 'installing', version: '1.0.6' },
  });
  await page.goto(server.url());

  await expect(page.getByTestId('upgrade-only')).toBeVisible();
  await expect(page.getByTestId('update-notice')).toHaveText('Updating Callie to 1.0.6…');
  await expect(page.getByRole('button')).toHaveCount(0);
});

test('reading the update state on focus does not empty the sign-in form', async ({ page }) => {
  server = await startAppServer({
    // A first sign-in, so the workspace field is on the form.
    desktop: desktopState({ screen: 'sign_in', device: null, today: null, rememberedWorkspace: null }),
    update: { kind: 'ready', version: '1.0.6' },
  });
  await page.goto(server.url());
  await page.getByTestId('workspace-id').fill('11111111-1111-4111-8111-111111111111');

  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
  await expect.poll(() => called('update.state').length).toBeGreaterThan(1);
  await expect(page.getByTestId('workspace-id')).toHaveValue('11111111-1111-4111-8111-111111111111');
  // A staged update's Restart is Home's; the sign-in screen draws nothing for it.
  await expect(page.getByTestId('update-notice')).toHaveCount(0);
});

test('a page without the update bridge draws no update line', async ({ page }) => {
  server = await startAppServer();
  await page.goto(server.url());
  await expect(page.getByTestId('status-system')).toHaveText('Callie 1.0.3 · online');
  await expect(page.getByTestId('status-update')).toHaveCount(0);
});

// ------------------------------------------------------------- wave 1: Update now
const blocked = () =>
  desktopState({ screen: 'upgrade_required', mayMutate: false, supportedClientVersions: { minimum: '1.0.6', maximum: '1.999.999' } });

test('the upgrade screen has Update now, which checks at once and says when there is nothing yet', async ({ page }) => {
  server = await startAppServer({ desktop: blocked(), update: { kind: 'none' } });
  await page.goto(server.url());

  await expect(page.getByTestId('upgrade-only')).toBeVisible();
  await expect(page.getByRole('button')).toHaveCount(1);
  await page.getByTestId('update-now').click();
  await expect.poll(() => called('update.checkNow')).toEqual([null]);
  await expect(page.getByTestId('update-now-note')).toHaveText('No update is available yet. Callie checks again every six hours.');
  await expect(page.getByTestId('update-now')).toBeEnabled();
});

test('Update now that finds the update shows it installing, with nothing left to press', async ({ page }) => {
  server = await startAppServer({ desktop: blocked(), update: { kind: 'none' }, updateFound: '1.0.6' });
  await page.goto(server.url());

  await page.getByTestId('update-now').click();
  await expect(page.getByTestId('update-notice')).toHaveText('Updating Callie to 1.0.6…');
  await expect(page.getByTestId('update-now')).toHaveCount(0);
  await expect(page.getByRole('button')).toHaveCount(0);
});

/** What the main process sends when the update state changes. */
async function updateChanged(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const listener of (globalThis as unknown as { __updateListeners: (() => void)[] }).__updateListeners) listener();
  });
}

/** A real click at the control's centre: what `inert` refuses, unlike `element.click()`. */
async function pressAt(page: Page, control: Locator): Promise<void> {
  const box = await control.boundingBox();
  if (box === null) throw new Error('the control is not on screen');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

const appInert = async (page: Page): Promise<boolean> =>
  await page.locator('#app').evaluate(node => (node as HTMLElement).inert);

test('while the launch update installs, the whole window is read-only — sidebar included — and says why', async ({ page }) => {
  server = await startAppServer({ update: { kind: 'none' }, mailbox: notConnectedMailbox(), connectAnswer: notConnectedMailbox() });
  await page.goto(server.url());
  await expect(page.getByTestId('today-card')).toHaveCount(4);
  await expect(page.getByTestId('updating-banner')).toHaveCount(0);
  // This Mac open, so its Connect Gmail and Sign out are on screen when the install starts.
  await page.getByTestId('this-mac-summary').click();
  await expect(page.getByTestId('mailbox-connect')).toBeVisible();

  server.update.setState({ kind: 'installing', version: '1.0.6' });
  await updateChanged(page);
  await expect(page.getByTestId('updating-banner')).toContainText('Updating Callie to 1.0.6…');
  await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'true');
  expect(await appInert(page)).toBe(true);
  // Readable: the list is still there.
  await expect(page.getByTestId('today-card')).toHaveCount(4);

  // Nothing presses: not the sidebar's Connect Gmail or Sign out, not a view, not a card.
  await pressAt(page, page.getByTestId('mailbox-connect'));
  await pressAt(page, page.getByTestId('sign-out'));
  await pressAt(page, page.getByTestId('nav-firms'));
  await pressAt(page, page.getByTestId('card-expand').first());
  await page.waitForTimeout(200);
  expect(called('mailbox.connect')).toEqual([]);
  expect(called('callie.signOut')).toEqual([]);
  expect(called('today.expand')).toEqual([]);
  await expect(page.getByTestId('column')).toHaveAttribute('data-route', 'today');

  // An install that did not go ahead gives the page back.
  server.update.setState({ kind: 'none' });
  await updateChanged(page);
  await expect(page.getByTestId('updating-banner')).toHaveCount(0);
  expect(await appInert(page)).toBe(false);
  await pressAt(page, page.getByTestId('nav-firms'));
  await expect(page.getByTestId('column')).toHaveAttribute('data-route', 'firms');
});

test('while the launch update installs, the sign-in form is read-only too, and is given back after', async ({ page }) => {
  server = await startAppServer({
    desktop: desktopState({ screen: 'sign_in', device: null, today: null, rememberedWorkspace: null }),
    update: { kind: 'none' },
  });
  await page.goto(server.url());
  await page.getByTestId('workspace-id').fill('11111111-1111-4111-8111-111111111111');

  server.update.setState({ kind: 'installing', version: '1.0.6' });
  await updateChanged(page);
  await expect(page.getByTestId('update-notice')).toHaveText('Updating Callie to 1.0.6…');
  expect(await appInert(page)).toBe(true);
  // The redraw that says so keeps what was typed.
  await expect(page.getByTestId('workspace-id')).toHaveValue('11111111-1111-4111-8111-111111111111');
  await pressAt(page, page.getByTestId('sign-in'));
  await page.waitForTimeout(200);
  expect(called('callie.signIn')).toEqual([]);

  server.update.setState({ kind: 'none' });
  await updateChanged(page);
  await expect(page.getByTestId('update-notice')).toHaveCount(0);
  expect(await appInert(page)).toBe(false);
  await pressAt(page, page.getByTestId('sign-in'));
  await expect.poll(() => called('callie.signIn').length).toBe(1);
});

test('Update now that finds the update leaves the upgrade screen read-only while it installs', async ({ page }) => {
  server = await startAppServer({ desktop: blocked(), update: { kind: 'none' }, updateFound: '1.0.6' });
  await page.goto(server.url());
  await page.getByTestId('update-now').click();
  await expect(page.getByTestId('update-notice')).toHaveText('Updating Callie to 1.0.6…');
  expect(await appInert(page)).toBe(true);
});
