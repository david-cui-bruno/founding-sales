import { expect, test, type Page } from 'playwright/test';
import { startAppServer, type AppServer, type AppServerOptions } from './support/appServer.ts';
import { todayState } from './support/homeFixtures.ts';
import {
  EXAMPLE_DEVICE,
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
 * Signed in, the window is the shell on Today. The device panel is "This Mac" at the
 * foot of the sidebar, a `<details>` a spec opens before it presses anything in it.
 * `home.spec.ts` is what drives Home itself; these only need the shell around it.
 *
 * Until 1.0.13 these pages were built without Today's and Administration's channels, to
 * keep Home's own reads out of the way. There is one bridge now — a page without it has
 * no mailbox either — so the registry is installed and Home simply answers.
 */

/** The session and the Mailbox row. */
function session(overrides: AppServerOptions = {}): AppServerOptions {
  return {
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
    session({
      desktop: signedInState({ online: false, stale: true, mayMutate: false, asOf: '2026-09-21T09:05:00.000Z' }),
      // The sidebar's system line prefers the list's own connection to the session's,
      // because the list is the thing the person is looking at.
      today: todayState({ online: false, stale: true, mayMutate: false }),
    }),
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

/**
 * The workspace's other Macs (wave 3b, S7, A4).
 *
 * Read when "This Mac" is opened and not before: a list of somebody's machines is not
 * something Home needs to draw, and `GET /devices` is a call nobody made until they
 * asked for it. The control is named for what it does to the Mac in the row.
 */
test('This Mac lists the workspace’s other Macs, and signs one of them out', async ({ page }) => {
  const OTHER = '99999999-9999-4999-8999-999999999999';
  server = await startAppServer(
    session({
      desktop: signedInState(),
      devices: [
        {
          deviceId: EXAMPLE_DEVICE,
          deviceLabel: "David's MacBook",
          status: 'active',
          registeredAt: '2026-09-01T12:00:00.000Z',
          lastSeenAt: '2026-09-21T09:00:00.000Z',
          clientVersion: '1.4.0',
          thisDevice: true,
        },
        {
          deviceId: OTHER,
          deviceLabel: 'The office iMac',
          status: 'active',
          registeredAt: '2026-08-01T12:00:00.000Z',
          lastSeenAt: null,
          clientVersion: null,
          thisDevice: false,
        },
      ],
    }),
  );
  await page.goto(server.url());

  // Nothing is asked for until the panel is opened.
  expect(server.called('callie.listDevices')).toHaveLength(0);
  await openThisMac(page);
  await expect.poll(() => server.called('callie.listDevices')).toHaveLength(1);

  // This Mac is not one of "the other Macs": it is the panel.
  await expect(page.getByTestId('other-mac')).toHaveCount(1);
  await expect(page.getByTestId('other-mac-line')).toContainText('The office iMac');
  await expect(page.getByTestId('other-mac-line')).toContainText('signed in');
  // Never seen, so the date it was added — in the Mac's own locale, not an ISO instant.
  await expect(page.getByTestId('other-mac-line')).toContainText('never (added ');
  await expect(page.getByTestId('other-mac-line')).not.toContainText('2026-08-01T');

  await page.getByTestId(`revoke-${OTHER}`).click();
  await expect.poll(() => server.called('callie.revokeDevice')).toEqual([{ deviceId: OTHER }]);
  await expect(page.getByTestId('other-mac-line')).toContainText('signed out');
  await expect(page.getByTestId(`revoke-${OTHER}`)).toHaveCount(0);
  // And this Mac is still signed in: it signed somebody else's out.
  await expect(page.getByTestId('device-panel')).toBeVisible();
  await expect(page.getByTestId('banner-info')).toContainText('That Mac was signed out.');
});

test('a sign-out the server has not been told about says so, and the window is signed out anyway', async ({ page }) => {
  // A2: the Keychain secret is forgotten only once the server has confirmed, so a
  // sign-out pressed offline is shown at once with one line about what is left to do.
  server = await startAppServer(
    session({
      desktop: signedInState(),
      signOutAnswer: signedOutState({ notice: 'sign_out_pending', online: false }),
    }),
  );
  await page.goto(server.url());
  await openThisMac(page);
  await page.getByTestId('sign-out').click();

  await expect(page.getByTestId('heading')).toHaveText('Sign in with Google');
  await expect(page.getByTestId('device-panel')).toHaveCount(0);
  await expect(page.getByTestId('banner-info')).toHaveText(
    'This Mac still has to tell the server it signed out; Callie retries when it is back online.',
  );
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
