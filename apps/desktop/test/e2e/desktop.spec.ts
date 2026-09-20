import { expect, test } from 'playwright/test';
import {
  EXAMPLE_WORKSPACE,
  signedInState,
  signedOutState,
  startTestServer,
  type TestServer,
} from './support/testServer.ts';

/**
 * The window, driven end to end against the generated test server.
 *
 * The renderer is the shipped file; only the bridge is substituted, so what these
 * specs prove is what a person actually sees: the sign-in form, the device panel, the
 * stale banner with no actionable controls, and the upgrade screen with nothing to
 * press.
 */

let server: TestServer;

test.afterEach(async () => {
  await server.stop();
});

test('signs in through the form and then shows this Mac', async ({ page }) => {
  server = await startTestServer(signedOutState());
  await page.goto(server.url);

  await expect(page.getByTestId('heading')).toHaveText('Sign in with Google');
  await expect(page.getByTestId('sign-in-form')).toBeVisible();

  await page.getByTestId('workspace-id').fill(EXAMPLE_WORKSPACE);
  await page.getByTestId('device-label').fill("David's MacBook");
  await page.getByTestId('sign-in').click();

  await expect(page.getByTestId('heading')).toHaveText('Today');
  await expect(page.getByTestId('device-panel')).toContainText("David's MacBook");
  await expect(page.getByTestId('today-card')).toHaveCount(1);
  await expect(page.getByTestId('card-action')).toBeEnabled();
  expect(server.calls).toContain('signIn');
});

test('an outdated Mac sees only the upgrade instruction', async ({ page }) => {
  server = await startTestServer(
    signedOutState({
      screen: 'upgrade_required',
      clientVersion: '1.0.0',
      supportedClientVersions: { minimum: '1.2.0', maximum: '1.4.0' },
    }),
  );
  await page.goto(server.url);

  await expect(page.getByTestId('heading')).toHaveText('Update Callie');
  await expect(page.getByTestId('banner-blocking')).toContainText('out of date');
  await expect(page.getByTestId('upgrade-only')).toBeVisible();
  // Nothing to press: no sign-in form, no card actions, no refresh.
  await expect(page.getByTestId('sign-in-form')).toHaveCount(0);
  await expect(page.getByTestId('card-action')).toHaveCount(0);
  await expect(page.getByTestId('refresh')).toHaveCount(0);
});

test('an outage shows the cached list, marked stale, with its actions disabled', async ({ page }) => {
  server = await startTestServer(
    signedInState({ online: false, stale: true, mayMutate: false, asOf: '2026-09-21T09:05:00.000Z' }),
  );
  await page.goto(server.url);

  await expect(page.getByTestId('heading')).toHaveText('Today');
  await expect(page.getByTestId('banner-warning').first()).toContainText('cannot reach the server');
  await expect(page.getByTestId('banner-warning').last()).toContainText('earlier read');
  await expect(page.getByTestId('today-card')).toHaveCount(1);
  // The list is readable and nothing on it can be acted on (specification 4.2, 14.2).
  await expect(page.getByTestId('card-action')).toBeDisabled();
});

test('signing out returns to the sign-in form and says so', async ({ page }) => {
  server = await startTestServer(signedInState());
  await page.goto(server.url);
  await expect(page.getByTestId('device-panel')).toBeVisible();

  await page.getByTestId('sign-out').click();

  await expect(page.getByTestId('heading')).toHaveText('Sign in with Google');
  await expect(page.getByTestId('banner-info')).toContainText('Signed out');
  await expect(page.getByTestId('device-panel')).toHaveCount(0);
});

test('a firm name that looks like markup is shown as text', async ({ page }) => {
  const state = signedInState();
  const card = state.today?.cards[0];
  expect(card).toBeDefined();
  server = await startTestServer({
    ...state,
    today:
      state.today === null || card === undefined
        ? null
        : { ...state.today, cards: [{ ...card, firmName: '<img src=x onerror=alert(1)>' }] },
  });
  await page.goto(server.url);

  await expect(page.getByTestId('today-card')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('img')).toHaveCount(0);
});
