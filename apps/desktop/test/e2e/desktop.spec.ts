import { expect, test, type Page } from 'playwright/test';
import { startAppServer, type AppServer, type AppServerOptions } from './support/appServer.ts';
import {
  EXAMPLE_WORKSPACE,
  connectedMailbox,
  notConnectedMailbox,
  signedInState,
  signedOutState,
} from './support/sessionFixtures.ts';

/**
 * The window, driven end to end against the generated test server.
 *
 * The renderer is the shipped file; only the bridge is substituted, so what these
 * specs prove is what a person actually sees: the sign-in form, the device panel, the
 * stale lines with no actionable controls, and the upgrade screen with nothing to
 * press.
 *
 * Signed in, the window is the shell on Today. These pages are built without
 * `callieToday` and `callieAdmin`, so Home's lanes and figures say they are unavailable
 * here; the device panel is "This Mac" at the foot of the sidebar, a `<details>` a spec
 * opens before it presses anything in it. `home.spec.ts` drives Home with every bridge.
 */

/** The session and the Mailbox row, and nothing of Home's own reads. */
function session(overrides: AppServerOptions = {}): AppServerOptions {
  return {
    without: ['callieToday', 'callieAdmin'],
    mailbox: notConnectedMailbox(),
    connectAnswer: connectedMailbox(),
    ...overrides,
  };
}

/** "This Mac" is closed until somebody opens it. */
async function openThisMac(page: Page): Promise<void> {
  await page.getByTestId('this-mac-summary').click();
}

let server: AppServer;

test.afterEach(async () => {
  await server.stop();
});

const methods = (): string[] => server.calls.map(call => call.method);

test('signs in through the form and then shows this Mac', async ({ page }) => {
  server = await startAppServer(session({ desktop: signedOutState() }));
  await page.goto(server.url());

  await expect(page.getByTestId('heading')).toHaveText('Sign in with Google');
  await expect(page.getByTestId('sign-in-form')).toBeVisible();

  await page.getByTestId('workspace-id').fill(EXAMPLE_WORKSPACE);
  await page.getByTestId('device-label').fill("David's MacBook");
  await page.getByTestId('sign-in').click();

  // Home, headed by the business date of the list the session holds.
  await expect(page.getByTestId('heading')).toHaveText('Monday, 21 September');
  await expect(page.getByTestId('device-panel')).toContainText("David's MacBook");
  await expect(page.getByTestId('today-unavailable')).toHaveText('Unavailable in this build');
  expect(methods()).toContain('callie.signIn');
});

test('an outdated Mac sees only the upgrade instruction', async ({ page }) => {
  server = await startAppServer(
    session({
      desktop: signedOutState({
        screen: 'upgrade_required',
        clientVersion: '1.0.0',
        supportedClientVersions: { minimum: '1.2.0', maximum: '1.4.0' },
      }),
    }),
  );
  await page.goto(server.url());

  await expect(page.getByTestId('heading')).toHaveText('Update Callie');
  await expect(page.getByTestId('banner-blocking')).toContainText('out of date');
  await expect(page.getByTestId('upgrade-only')).toHaveText('Callie will work again once this Mac is updated.');
  // A sentence, never an address (lane g86): the notice's upgradeUrl is the signed
  // update manifest, which is for the updater, not for a person.
  expect(await page.locator('body').innerText()).not.toMatch(/https?:\/\/|latest\.json/u);
  // Nothing to press: no sign-in form, no card actions, no refresh.
  await expect(page.getByTestId('sign-in-form')).toHaveCount(0);
  await expect(page.getByTestId('card-expand')).toHaveCount(0);
  await expect(page.getByTestId('refresh')).toHaveCount(0);
});

test('an outage is said at the top of Home, marked stale, and in the sidebar', async ({ page }) => {
  server = await startAppServer(
    session({ desktop: signedInState({ online: false, stale: true, mayMutate: false, asOf: '2026-09-21T09:05:00.000Z' }) }),
  );
  await page.goto(server.url());

  await expect(page.getByTestId('heading')).toHaveText('Monday, 21 September');
  await expect(page.getByTestId('banner-warning').first()).toContainText('cannot reach the server');
  await expect(page.getByTestId('banner-warning').last()).toContainText('earlier read');
  await expect(page.getByTestId('status-system')).toHaveText('Callie 1.4.0 · offline');
  // The lanes' outage — readable, nothing pressable (4.2, 14.2) — is home.spec.ts's.
});

test('signing out returns to the sign-in form and says so', async ({ page }) => {
  server = await startAppServer(session({ desktop: signedInState() }));
  await page.goto(server.url());
  await openThisMac(page);
  await expect(page.getByTestId('device-panel')).toBeVisible();

  await page.getByTestId('sign-out').click();

  await expect(page.getByTestId('heading')).toHaveText('Sign in with Google');
  await expect(page.getByTestId('banner-info')).toContainText('Signed out');
  await expect(page.getByTestId('device-panel')).toHaveCount(0);
});

test('a device name that looks like markup is shown as text', async ({ page }) => {
  // A firm name is the lanes' case, in home.spec.ts; on this page it is the device's.
  const state = signedInState();
  server = await startAppServer(
    session({
      desktop: { ...state, device: state.device === null ? null : { ...state.device, deviceLabel: '<img src=x onerror=alert(1)>' } },
    }),
  );
  await page.goto(server.url());

  await expect(page.getByTestId('device-panel')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('img')).toHaveCount(0);
});

/**
 * The Mailbox row (release.md 8.0x). Desktop 1.0.0's "This Mac" card had Sign out and
 * nothing else, and no spec here said what the card should hold — so these name the
 * card's exact buttons in each state, and a build without Connect Gmail fails here.
 */
test('This Mac offers Connect Gmail, and a connected mailbox shows its address and status', async ({ page }) => {
  server = await startAppServer(session({ desktop: signedInState() }));
  const dialogs: string[] = [];
  page.on('dialog', dialog => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await page.goto(server.url());
  await openThisMac(page);

  const panel = page.getByTestId('device-panel');
  await expect(panel.getByTestId('mailbox-status')).toHaveText('Not connected');
  await expect(panel.getByRole('button')).toHaveText(['Connect Gmail', 'Sign out']);
  await expect(page.getByTestId('mailbox-connect')).toBeEnabled();

  await page.getByTestId('mailbox-connect').click();

  await expect(panel.getByTestId('mailbox-status')).toHaveText('sales@example.test · connected · baseline pending');
  // Connected: nothing to press but Sign out. No Disconnect — the thirty-day rule.
  await expect(panel.getByRole('button')).toHaveText(['Sign out']);
  expect(methods()).toContain('mailbox.connect');
  expect(dialogs).toEqual([]);
});

test('a refused connection is plain text on the card, never a dialog', async ({ page }) => {
  server = await startAppServer(
    session({ desktop: signedInState(), connectAnswer: notConnectedMailbox({ notice: 'client_upgrade_required' }) }),
  );
  const dialogs: string[] = [];
  page.on('dialog', dialog => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await page.goto(server.url());
  await openThisMac(page);

  await page.getByTestId('mailbox-connect').click();

  await expect(page.getByTestId('mailbox-notice')).toHaveText(
    'This version of Callie is out of date. Install the current build to continue.',
  );
  await expect(page.getByTestId('mailbox-status')).toHaveText('Not connected');
  await expect(page.getByTestId('mailbox-connect')).toHaveText('Connect Gmail');
  expect(dialogs).toEqual([]);
});

test('a Mac that already has its mailbox shows it on first paint, and Refresh reads it again', async ({ page }) => {
  server = await startAppServer(session({ desktop: signedInState(), mailbox: connectedMailbox() }));
  await page.goto(server.url());

  await expect(page.getByTestId('mailbox-status')).toHaveText('sales@example.test · connected · baseline pending');
  await expect(page.getByTestId('mailbox-connect')).toHaveCount(0);
  await page.getByTestId('refresh').click();
  await expect.poll(() => methods().includes('mailbox.refresh')).toBe(true);
});
