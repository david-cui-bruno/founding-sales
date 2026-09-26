import { expect, test } from 'playwright/test';
import { startAppServer, type AppServer } from './support/appServer.ts';
import { desktopState } from './support/homeFixtures.ts';

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

test('while the launch update installs, Home is on screen and read-only, and says why', async ({ page }) => {
  server = await startAppServer({ update: { kind: 'none' } });
  await page.goto(server.url());
  await expect(page.getByTestId('today-card')).toHaveCount(4);
  await expect(page.getByTestId('updating-banner')).toHaveCount(0);

  server.update.setState({ kind: 'installing', version: '1.0.6' });
  await page.evaluate(() => {
    for (const listener of (globalThis as unknown as { __updateListeners: (() => void)[] }).__updateListeners) listener();
  });
  await expect(page.getByTestId('updating-banner')).toContainText('Updating Callie to 1.0.6…');
  await expect(page.getByTestId('column')).toHaveAttribute('aria-busy', 'true');
  expect(await page.getByTestId('column').evaluate(node => (node as HTMLElement).inert)).toBe(true);
  // Readable: the list is still there.
  await expect(page.getByTestId('today-card')).toHaveCount(4);

  // An install that did not go ahead gives the page back.
  server.update.setState({ kind: 'none' });
  await page.evaluate(() => {
    for (const listener of (globalThis as unknown as { __updateListeners: (() => void)[] }).__updateListeners) listener();
  });
  await expect(page.getByTestId('updating-banner')).toHaveCount(0);
  expect(await page.getByTestId('column').evaluate(node => (node as HTMLElement).inert)).toBe(false);
});
