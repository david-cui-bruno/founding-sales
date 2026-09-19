import { rm } from 'node:fs/promises';
import { expect, test, type Page } from 'playwright/test';
import { startStubWorker, type StubWorker } from './stubWorker';
import { launchClient, newUserData, pairThroughUi, type LaunchedClient } from './support/launchClient';

/**
 * The fresh Google consent of the cutover on the real client (slice S6, build item 4): begin, ready, revoke the
 * old grant. The consent itself belongs to Google's own browser window; this spec runs the client with its
 * browser handoff suppressed, so the address is shown rather than opened and nothing outside the Mac is touched.
 *
 * What it proves: "Continue to Google" reaches the worker's `/v1/google/begin` and comes back with a Google URL
 * and nothing else; the page shows the consent is still to be finished; once the consent is ready the page says
 * so and offers "Revoke the old grant"; revoking reaches `/v1/google/revoke-old` once and the page re-reads
 * Settings; and with no old grant left the button is gone. Nothing here sends, and no command is issued at all.
 */

let stub: StubWorker;
let userData: string;
let client: LaunchedClient | undefined;

test.beforeEach(async () => {
  stub = await startStubWorker();
  userData = await newUserData();
  client = await launchClient({ endpoint: stub.url, userData, noBrowser: true });
  await pairThroughUi(client.page, stub);
  await client.page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(client.page.getByRole('heading', { name: 'Settings', exact: true, level: 1 })).toBeVisible();
});

test.afterEach(async () => {
  await client?.close();
  client = undefined;
  await stub.close();
  await rm(userData, { recursive: true, force: true });
});

const google = (page: Page) => page.locator('.settings__section[data-section="google"]');
const pathsHit = (path: string) => stub.requests.filter((request) => request.path === path);

test('begins the consent, shows the address this Mac could not open, and never sends a command', async () => {
  const { page } = client!;
  await expect(google(page).locator('.google__status')).toContainText('connected');
  await expect(google(page).locator('[data-google="old-grants"]')).toContainText('One old pairing-bound grant is still live.');
  // Before the fresh consent there is nothing to revoke here yet: the first step is the only one offered.
  await expect(google(page).getByRole('button', { name: 'Revoke the old grant', exact: true })).toHaveCount(0);

  await google(page).getByRole('button', { name: 'Continue to Google', exact: true }).click();
  await expect(google(page).locator('[data-google="consent-url"]')).toContainText('https://accounts.google.com/o/oauth2/v2/auth');
  await expect(google(page).getByRole('status')).toContainText('could not open a browser');

  // The route was reached once, with the device token, and nothing was sent or commanded.
  const begins = pathsHit('/v1/google/begin');
  expect(begins).toHaveLength(1);
  expect(begins[0]!.authenticated).toBe(true);
  expect(stub.consentUrls()).toHaveLength(1);
  expect(stub.commands).toHaveLength(0);
  // Beginning a consent is not a consent: the worker still holds the old grant and nothing has been revoked.
  expect(stub.oldGrants()).toBe(1);
  expect(pathsHit('/v1/google/revoke-old')).toHaveLength(0);
});

test('offers the revoke only once the consent is ready, revokes once, and then stops offering it', async () => {
  const { page } = client!;
  await google(page).getByRole('button', { name: 'Continue to Google', exact: true }).click();
  await expect(google(page).locator('[data-google="consent-url"]')).toBeVisible();

  // The callback lands in Google's window, not here. The next Settings read is what tells the page.
  stub.completeConsent();
  await expect(google(page).locator('.google__note')).toContainText('revoke it', { timeout: 90_000 });
  const revoke = google(page).getByRole('button', { name: 'Revoke the old grant', exact: true });
  await expect(revoke).toBeVisible();
  // With a grant in place, the first step is refused rather than quietly started again.
  await expect(google(page).getByRole('button', { name: 'Continue to Google', exact: true })).toBeDisabled();

  await revoke.click();
  await expect(google(page).getByRole('status')).toContainText('Revoked the old grant');
  expect(pathsHit('/v1/google/revoke-old')).toHaveLength(1);
  expect(stub.oldGrants()).toBe(0);
  // The page re-read Settings after the revoke, so the button is gone and the note is the settled one.
  await expect(google(page).getByRole('button', { name: 'Revoke the old grant', exact: true })).toHaveCount(0);
  await expect(google(page).locator('.google__note')).toContainText('bound to the workspace, not to a pairing');
  // Still no command, and still nothing sent.
  expect(stub.commands).toHaveLength(0);
});
